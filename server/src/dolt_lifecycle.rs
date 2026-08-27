//! Keeps the per-project Dolt servers consumed by Atelier available.
//!
//! `bd` remains the lifecycle authority: it chooses ports, owns lock/PID files,
//! and starts the compatible Dolt binary. Atelier only asks it to ensure a
//! server after the project's recorded endpoint stops answering.

use crate::db::Database;
use futures::future::join_all;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::task::JoinHandle;

const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const START_TIMEOUT: Duration = Duration::from_secs(20);
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
            tokio::time::sleep(SUPERVISION_INTERVAL).await;
            ensure_registered(&db, &bd).await;
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

    let starts = projects
        .into_iter()
        .map(|project| PathBuf::from(project.path))
        .filter(|path| managed_project(path))
        .map(|path| ensure_project(path, bd.to_path_buf()));
    join_all(starts).await;
}

fn managed_project(project: &Path) -> bool {
    !project.to_string_lossy().starts_with("dolt://")
        && project.join(".beads").join("dolt").is_dir()
}

async fn ensure_project(project: PathBuf, bd: PathBuf) {
    let beads = project.join(".beads");
    if endpoint_is_alive(&beads).await {
        return;
    }

    tracing::info!("Restoring Dolt server for {}", project.display());
    let result = tokio::time::timeout(
        START_TIMEOUT,
        Command::new(&bd)
            .args(["dolt", "start"])
            .current_dir(&project)
            .kill_on_drop(true)
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
            "Timed out restoring Dolt server for {} after {:?}",
            project.display(),
            START_TIMEOUT
        ),
    }
}

async fn endpoint_is_alive(beads: &Path) -> bool {
    let Some(port) = crate::routes::beads::resolve_dolt_port(beads) else {
        return false;
    };
    tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
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
