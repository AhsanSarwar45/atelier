//! Keeps the per-project Dolt servers consumed by Atelier available.
//!
//! `bd` remains the lifecycle authority: it chooses ports, owns lock/PID files,
//! and starts the compatible Dolt binary. Atelier only asks it to ensure a
//! server after the project's recorded endpoint stops answering.
//!
//! One exception. `bd` trusts its PID file alone to decide whether its server
//! is running. When that file stops naming the live server, `bd dolt start`
//! launches a second server, which fails on the database lock, and then deletes
//! the port file. Every later start repeats this, so one stale record keeps the
//! board offline while its server runs fine. So before starting anything,
//! Atelier looks for the server that is still running and points `bd`'s two
//! records back at it.

use crate::db::Database;
use futures::future::join_all;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::task::JoinHandle;

const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
// This only bounds how long Atelier observes the command. `bd` owns its own,
// configurable startup deadline and is deliberately left alive if ours elapses.
const START_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(120);
const SUPERVISION_INTERVAL: Duration = Duration::from_secs(15);

/// A monitoring task whose lifetime is exactly the lifetime of its owner.
pub struct Supervisor(JoinHandle<()>);

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Starts periodic checks after the startup sweep has completed.
pub fn supervise(db: Arc<Database>, bd: PathBuf) -> Supervisor {
    Supervisor(tokio::spawn(async move {
        loop {
            ensure_registered(&db, &bd).await;
            tokio::time::sleep(SUPERVISION_INTERVAL).await;
        }
    }))
}

/// Ensures every active local Dolt board has an answering server.
pub async fn ensure_registered(db: &Database, bd: &Path) {
    let projects = match db.get_projects_filtered(false, false) {
        Ok(projects) => projects,
        Err(error) => {
            tracing::warn!("Could not inspect projects for Dolt supervision: {error}");
            return;
        }
    };

    let Some(data_dir) = crate::identity::data_dir() else { return; };
    let starts = projects
        .into_iter()
        .filter_map(|project| {
            let raw = project.local_path.as_deref().unwrap_or(&project.path);
            let path = PathBuf::from(raw);
            crate::project_manifest::locate(&path, &data_dir)
                .filter(|found| found.manifest.project.use_beads)
                .map(|_| path)
        })
        .filter(|path| managed_project(path))
        .map(|path| ensure_project(path, bd.to_path_buf()));
    join_all(starts).await;
}

fn managed_project(project: &Path) -> bool {
    !project.as_os_str().is_empty()
        && !project.to_string_lossy().starts_with("dolt://")
        && project.join(".beads").join("dolt").is_dir()
}

async fn ensure_project(project: PathBuf, bd: PathBuf) {
    ensure_project_with_timeout(project, bd, START_OBSERVATION_TIMEOUT).await;
}

async fn ensure_project_with_timeout(project: PathBuf, bd: PathBuf, observation: Duration) {
    let beads = project.join(".beads");
    // bd's own records are checked first: a port that answers is no proof
    // that bd can find its server.
    if adopt_running_server(&beads).await {
        return;
    }
    if endpoint_is_alive(&beads).await {
        return;
    }

    tracing::info!("Restoring Dolt server for {}", project.display());
    let result = tokio::time::timeout(
        observation,
        Command::new(&bd)
            .args(["dolt", "start"])
            .current_dir(&project)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            if endpoint_is_alive(&beads).await {
                tracing::info!("Dolt server restored for {}", project.display());
            } else {
                tracing::warn!(
                    "bd dolt start succeeded for {}, but its endpoint is not answering",
                    project.display()
                );
            }
        }
        Ok(Ok(output)) => tracing::warn!(
            "Could not restore Dolt server for {}: {}",
            project.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Ok(Err(error)) => tracing::warn!(
            "Could not run bd to restore Dolt server for {}: {error}",
            project.display()
        ),
        Err(_) => tracing::warn!(
            "Stopped waiting for bd to restore Dolt server for {} after {:?}; bd remains alive to finish",
            project.display(),
            observation
        ),
    }
}

async fn endpoint_is_alive(beads: &Path) -> bool {
    match crate::routes::beads::resolve_dolt_port(beads) {
        Some(port) => port_answers(port).await,
        None => false,
    }
}

async fn port_answers(port: u16) -> bool {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

/// Finds this board's running server and makes sure `bd`'s port and PID files
/// name it, repairing them when they do not. Returns true when that server
/// answers.
async fn adopt_running_server(beads: &Path) -> bool {
    let Some((pid, port)) = running_server(beads) else {
        return false;
    };
    if !port_answers(port).await {
        return false;
    }
    let recorded = |name: &str| std::fs::read_to_string(beads.join(name)).ok().map(|text| text.trim().to_owned());
    if recorded("dolt-server.port") == Some(port.to_string()) && recorded("dolt-server.pid") == Some(pid.to_string()) {
        return true;
    }
    let written = write_record(&beads.join("dolt-server.port"), &port.to_string())
        .and_then(|()| write_record(&beads.join("dolt-server.pid"), &pid.to_string()));
    match written {
        Ok(()) => {
            tracing::info!(
                "Dolt server for {} was still running (PID {pid}, port {port}); repaired bd's records instead of starting another",
                beads.display()
            );
            true
        }
        Err(error) => {
            tracing::warn!(
                "Found the running Dolt server for {} but could not repair bd's records: {error}",
                beads.display()
            );
            false
        }
    }
}

/// Replaces a record in one step, so `bd` never reads half of it.
fn write_record(path: &Path, value: &str) -> std::io::Result<()> {
    let staged = path.with_extension("atelier-repair");
    std::fs::write(&staged, value)?;
    std::fs::rename(&staged, path)
}

/// The one running Dolt server started with this board's config, and its one
/// listening port. Anything ambiguous returns None and is left to `bd`.
#[cfg(target_os = "linux")]
fn running_server(beads: &Path) -> Option<(u32, u16)> {
    let config = beads.join("dolt-server-config.yaml");
    let mut found = None;
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if !serves_config(&cmdline, &config) {
            continue;
        }
        let ports = listening_ports(pid);
        if ports.len() != 1 || found.is_some() {
            return None;
        }
        found = Some((pid, ports[0]));
    }
    found
}

#[cfg(not(target_os = "linux"))]
fn running_server(_beads: &Path) -> Option<(u32, u16)> {
    None
}

/// Whether a process command line is `... sql-server ... --config CONFIG`.
#[cfg(any(target_os = "linux", test))]
fn serves_config(cmdline: &[u8], config: &Path) -> bool {
    let args: Vec<&[u8]> = cmdline.split(|byte| *byte == 0).collect();
    let wanted = config.as_os_str().as_encoded_bytes();
    args.iter().any(|arg| *arg == b"sql-server")
        && (args.windows(2).any(|pair| pair[0] == b"--config" && pair[1] == wanted)
            || args.iter().any(|arg| arg.strip_prefix(b"--config=") == Some(wanted)))
}

/// TCP ports a process is listening on, from its socket handles and the
/// kernel's socket tables.
#[cfg(target_os = "linux")]
fn listening_ports(pid: u32) -> Vec<u16> {
    let Ok(handles) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return Vec::new();
    };
    let sockets: std::collections::HashSet<String> = handles
        .flatten()
        .filter_map(|handle| std::fs::read_link(handle.path()).ok())
        .filter_map(|target| {
            let target = target.to_string_lossy().into_owned();
            target
                .strip_prefix("socket:[")
                .and_then(|rest| rest.strip_suffix(']'))
                .map(str::to_owned)
        })
        .collect();
    let mut ports = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(table) else { continue };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // local_address is field 1, state is field 3 (0A = listening),
            // inode is field 9.
            if fields.len() < 10 || fields[3] != "0A" || !sockets.contains(fields[9]) {
                continue;
            }
            let port = fields[1]
                .rsplit(':')
                .next()
                .and_then(|hex| u16::from_str_radix(hex, 16).ok());
            if let Some(port) = port.filter(|port| !ports.contains(port)) {
                ports.push(port);
            }
        }
    }
    ports
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateProjectInput;
    use std::fs;

    #[test]
    fn dolt_lifecycle_only_manages_existing_local_dolt_boards() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        fs::create_dir_all(local.join(".beads/dolt")).unwrap();
        let jsonl = temp.path().join("jsonl");
        fs::create_dir_all(jsonl.join(".beads")).unwrap();

        assert!(managed_project(&local));
        assert!(!managed_project(&jsonl));
        assert!(!managed_project(Path::new("dolt://remote")));
        assert!(!managed_project(Path::new("")));
    }

    #[cfg(unix)]
    fn fake_bd(temp: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = temp.join("bd");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' \"$PWD $*\" >> \"$0.calls\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dolt_lifecycle_starts_each_dead_eligible_project_once() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let jsonl = temp.path().join("jsonl");
        for project in [&first, &second] {
            fs::create_dir_all(project.join(".beads/dolt")).unwrap();
        }
        fs::create_dir_all(jsonl.join(".beads")).unwrap();

        let db = Database::new_in_memory().unwrap();
        for (name, path) in [("first", &first), ("second", &second), ("jsonl", &jsonl)] {
            db.create_project(CreateProjectInput {
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
                local_path: None,
                is_test: false,
            })
            .unwrap();
            let mut manifest = crate::project_manifest::infer(path);
            manifest.project.use_beads = true;
            crate::project_manifest::create(path, temp.path(), crate::project_manifest::ManifestStorage::Repository, &manifest).unwrap();
        }

        let bd = fake_bd(temp.path());
        ensure_registered(&db, &bd).await;

        let mut invoked: Vec<_> = fs::read_to_string(temp.path().join("bd.calls"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        invoked.sort();
        assert_eq!(invoked.len(), 2);
        assert!(invoked[0].ends_with(" dolt start"));
        assert!(invoked[1].ends_with(" dolt start"));
        assert!(invoked.iter().all(|line| !line.contains("jsonl")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dolt_lifecycle_ignores_a_board_when_project_settings_disable_beads() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("disabled");
        fs::create_dir_all(project.join(".beads/dolt")).unwrap();
        let mut manifest = crate::project_manifest::infer(&project);
        manifest.project.use_beads = false;
        crate::project_manifest::create(&project, temp.path(), crate::project_manifest::ManifestStorage::Repository, &manifest).unwrap();
        let db = Database::new_in_memory().unwrap();
        db.create_project(CreateProjectInput { name: "disabled".into(), path: project.to_string_lossy().into_owned(),
            local_path: None, is_test: false }).unwrap();
        let bd = fake_bd(temp.path());

        ensure_registered(&db, &bd).await;

        assert!(!temp.path().join("bd.calls").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dolt_lifecycle_leaves_an_answering_server_alone() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("live");
        fs::create_dir_all(project.join(".beads/dolt")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::write(project.join(".beads/dolt-server.port"), port.to_string()).unwrap();

        let bd = fake_bd(temp.path());
        ensure_project(project, bd).await;
        assert!(!temp.path().join("bd.calls").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dolt_lifecycle_retries_when_start_did_not_restore_the_endpoint() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("still-dead");
        fs::create_dir_all(project.join(".beads/dolt")).unwrap();
        let bd = fake_bd(temp.path());

        ensure_project(project.clone(), bd.clone()).await;
        ensure_project(project, bd).await;

        assert_eq!(
            fs::read_to_string(temp.path().join("bd.calls"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dolt_lifecycle_does_not_kill_bd_when_our_wait_ends_first() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("slow");
        fs::create_dir_all(project.join(".beads/dolt")).unwrap();
        let bd = temp.path().join("slow-bd");
        let finished = temp.path().join("finished");
        let half_written = temp.path().join("half-written");
        // The child writes elsewhere and renames into place, so the file
        // appears only once it is whole. A plain `> finished` creates the file
        // empty at the moment the shell opens the redirection, which is before
        // `printf` puts anything in it — a watcher would then find the name and
        // read nothing.
        fs::write(
            &bd,
            format!(
                "#!/bin/sh\nsleep 0.1\nprintf finished > '{}'\nmv '{}' '{}'\n",
                half_written.display(),
                half_written.display(),
                finished.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&bd, fs::Permissions::from_mode(0o755)).unwrap();

        ensure_project_with_timeout(project, bd, Duration::from_millis(10)).await;

        // Waited for rather than slept past. This used to sleep 150ms and then
        // read, which is a bet that a machine with nothing else to do finishes
        // a 100ms child in time; on a busy one it does not, and the test went
        // red for a reason that had nothing to do with what it proves. What is
        // being proved is that the child outlives our wait, not how quick it is.
        tokio::time::timeout(Duration::from_secs(30), async {
            while !finished.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("bd was killed when our wait ended, instead of being left to finish");

        assert_eq!(fs::read_to_string(finished).unwrap(), "finished");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dolt_lifecycle_first_restore_does_not_block_server_startup() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("slow");
        fs::create_dir_all(project.join(".beads/dolt")).unwrap();
        let bd = temp.path().join("slow-bd");
        let started = temp.path().join("started");
        fs::write(
            &bd,
            format!(
                "#!/bin/sh\nprintf started > '{}'\nsleep 0.2\n",
                started.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&bd, fs::Permissions::from_mode(0o755)).unwrap();
        let db = Arc::new(Database::new_in_memory().unwrap());
        db.create_project(CreateProjectInput {
            name: "slow".to_string(),
            path: project.to_string_lossy().into_owned(),
            local_path: None,
            is_test: false,
        })
        .unwrap();
        let mut manifest = crate::project_manifest::infer(&project);
        manifest.project.use_beads = true;
        crate::project_manifest::create(
            &project,
            temp.path(),
            crate::project_manifest::ManifestStorage::Repository,
            &manifest,
        )
        .unwrap();

        let began = std::time::Instant::now();
        let supervisor = supervise(db, bd);
        assert!(began.elapsed() < Duration::from_millis(20));
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(supervisor);
    }

    #[test]
    fn dolt_lifecycle_recognises_only_this_boards_server() {
        let config = Path::new("/p/.beads/dolt-server-config.yaml");
        let line = |args: &[&str]| args.join("\0").into_bytes();
        assert!(serves_config(&line(&["/bin/dolt", "sql-server", "--config", "/p/.beads/dolt-server-config.yaml"]), config));
        assert!(serves_config(&line(&["dolt", "sql-server", "--config=/p/.beads/dolt-server-config.yaml"]), config));
        assert!(!serves_config(&line(&["dolt", "sql-server", "--config", "/q/.beads/dolt-server-config.yaml"]), config));
        assert!(!serves_config(&line(&["vim", "/p/.beads/dolt-server-config.yaml"]), config));
    }

    /// A stand-in Dolt server: its command line names this board's config, and
    /// it holds a listening socket it inherited. Returns it and its port.
    #[cfg(target_os = "linux")]
    fn fake_running_server(temp: &Path, beads: &Path) -> (std::process::Child, u16) {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::io::AsRawFd;
        use std::os::unix::process::CommandExt;

        let fake_dolt = temp.join("dolt");
        fs::write(&fake_dolt, "#!/bin/sh\nwhile :; do sleep 1; done\n").unwrap();
        fs::set_permissions(&fake_dolt, fs::Permissions::from_mode(0o755)).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let fd = listener.as_raw_fd();
        // spawn() returns only after exec, so the command line is already set.
        let server = unsafe {
            std::process::Command::new(&fake_dolt)
                .arg("sql-server")
                .arg("--config")
                .arg(beads.join("dolt-server-config.yaml"))
                .pre_exec(move || {
                    if libc::dup2(fd, 3) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()
                .unwrap()
        };
        (server, port)
    }

    /// The case that kept boards offline: the server is running, but bd's port
    /// and PID files no longer name it. Starting another server would fail on
    /// the database lock and wipe the port file, so it must not happen.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn dolt_lifecycle_repairs_records_of_a_running_server_instead_of_starting_another() {
        let temp = tempfile::tempdir().unwrap();
        let beads = temp.path().join("orphaned/.beads");
        fs::create_dir_all(beads.join("dolt")).unwrap();
        fs::write(beads.join("dolt-server.port"), "1").unwrap();
        fs::write(beads.join("dolt-server.pid"), "999999999").unwrap();
        let (mut server, port) = fake_running_server(temp.path(), &beads);

        let bd = fake_bd(temp.path());
        ensure_project(temp.path().join("orphaned"), bd).await;
        let recorded_port = fs::read_to_string(beads.join("dolt-server.port")).unwrap();
        let recorded_pid = fs::read_to_string(beads.join("dolt-server.pid")).unwrap();
        server.kill().unwrap();
        server.wait().unwrap();

        assert_eq!(recorded_port, port.to_string());
        assert_eq!(recorded_pid, server.id().to_string());
        assert!(!temp.path().join("bd.calls").exists(), "bd dolt start ran beside a live server");
    }

    /// A port that answers is not enough: bd decides from its PID file alone,
    /// so a wrong PID file breaks every bd command even while the port works.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn dolt_lifecycle_repairs_a_stale_pid_file_while_the_port_still_answers() {
        let temp = tempfile::tempdir().unwrap();
        let beads = temp.path().join("stale-pid/.beads");
        fs::create_dir_all(beads.join("dolt")).unwrap();
        let (mut server, port) = fake_running_server(temp.path(), &beads);
        fs::write(beads.join("dolt-server.port"), port.to_string()).unwrap();
        fs::write(beads.join("dolt-server.pid"), "999999999").unwrap();

        ensure_project(temp.path().join("stale-pid"), fake_bd(temp.path())).await;
        let recorded_pid = fs::read_to_string(beads.join("dolt-server.pid")).unwrap();
        server.kill().unwrap();
        server.wait().unwrap();

        assert_eq!(recorded_pid, server.id().to_string());
        assert!(!temp.path().join("bd.calls").exists());
    }

    #[tokio::test]
    async fn dolt_lifecycle_supervisor_is_cancelled_when_dropped() {
        let db = Arc::new(Database::new_in_memory().unwrap());
        let supervisor = supervise(db, PathBuf::from("unused-bd"));
        let abort = supervisor.0.abort_handle();
        assert!(!abort.is_finished());
        drop(supervisor);
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
    }
}
