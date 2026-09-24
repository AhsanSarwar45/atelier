//! `atelier tool chrome`: one private Chrome per worktree for interactive
//! browser work. Each has its own profile and DevTools port, is recorded in
//! the worktree's own git directory, and is stopped only through the process
//! group it was started in, so one agent can never reach or kill another
//! agent's browser.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DRIVER: &str = include_str!("chrome_driver.mjs");
const PORTS: std::ops::RangeInclusive<u16> = 9400..=9499;

const USAGE: &str = "usage: atelier tool chrome <command>

  up [--headless]   start this worktree's private Chrome (headed by default)
  env               eval \"$(atelier tool chrome env)\" -> ATELIER_CHROME_PORT,
                    CDP_URL, ATELIER_CHROME_DRIVER
  status            running or stopped, port, profile
  down [--wipe]     stop it; --wipe also deletes its profile and state
  driver            print the path of the bundled Node driver

One Chrome per worktree (per directory outside git). It is never shared and
never stopped by name; `down` stops only the process group `up` started.
Set ATELIER_CHROME_STATE=DIR to choose the state directory.
";

pub async fn run(rest: &[String]) -> Result<i32, String> {
    let command = rest.first().map(String::as_str).unwrap_or("help");
    let flag = rest.get(1).map(String::as_str);
    let allowed = match command {
        "up" => matches!(flag, None | Some("--headless")),
        "down" => matches!(flag, None | Some("--wipe")),
        "env" | "status" | "driver" => flag.is_none(),
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            return Ok(0);
        }
        _ => false,
    };
    if !allowed || rest.len() > 2 {
        return Err(USAGE.trim_end().to_string());
    }
    if command == "driver" {
        println!("{}", driver()?.display());
        return Ok(0);
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let state = State::new(state_dir(&cwd)?);
    match command {
        "up" => up(&state, flag == Some("--headless")).await,
        "env" => {
            let port = state.port().ok_or("chrome: none started here — run: atelier tool chrome up")?;
            println!(
                "export ATELIER_CHROME_PORT={port} QA_CDP_PORT={port} CDP_URL=http://127.0.0.1:{port} ATELIER_CHROME_DRIVER={}",
                shell_quote(&driver()?.display().to_string())
            );
            Ok(0)
        }
        "status" => {
            match (state.running(), state.port()) {
                (Some(pid), Some(port)) => println!("running pid {pid} :{port} profile {}", state.profile().display()),
                (_, Some(port)) => println!("stopped (port {port} reserved) profile {}", state.profile().display()),
                _ => println!("not started here"),
            }
            Ok(0)
        }
        "down" => down(&state, flag == Some("--wipe")),
        _ => unreachable!(),
    }
}

/// The worktree's own git directory, so two worktrees of one repository get
/// two browsers; outside git, a directory keyed on the working folder.
fn state_dir(cwd: &Path) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("ATELIER_CHROME_STATE").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let git = std::process::Command::new("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .current_dir(cwd)
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(out) = git {
        let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !dir.is_empty() {
            return Ok(PathBuf::from(dir).join("atelier-chrome"));
        }
    }
    Ok(state_home()?.join("atelier/chrome").join(short_hash(cwd.to_string_lossy().as_bytes())))
}

fn state_home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        return Ok(dir.into());
    }
    home().map(|h| h.join(".local/state")).ok_or_else(|| "chrome: no home directory".into())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn short_hash(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// The driver is written once per content, so every worktree imports the same
/// bytes the binary carries and an upgrade never edits a file in use.
fn driver() -> Result<PathBuf, String> {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".cache")))
        .ok_or("chrome: no home directory")?;
    let dir = cache.join("atelier/chrome-driver").join(short_hash(DRIVER.as_bytes()));
    let path = dir.join("cdp.mjs");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(DRIVER) {
        std::fs::create_dir_all(&dir).map_err(|e| format!("chrome: {}: {e}", dir.display()))?;
        let temp = dir.join(format!(".cdp.mjs.{}", std::process::id()));
        std::fs::write(&temp, DRIVER).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

struct State {
    dir: PathBuf,
}

impl State {
    fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
    fn profile(&self) -> PathBuf {
        self.dir.join("profile")
    }
    fn port(&self) -> Option<u16> {
        std::fs::read_to_string(self.dir.join("port")).ok()?.trim().parse().ok()
    }
    fn pid(&self) -> Option<i32> {
        std::fs::read_to_string(self.dir.join("chrome.pid")).ok()?.trim().parse().ok()
    }
    /// The recorded Chrome, only while that process is still the one started
    /// with this profile. A reused process ID never counts as ours.
    fn running(&self) -> Option<i32> {
        let pid = self.pid()?;
        owns(pid, &self.profile()).then_some(pid)
    }
}

#[cfg(target_os = "linux")]
fn owns(pid: i32, profile: &Path) -> bool {
    let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else { return false };
    let want = format!("--user-data-dir={}", profile.display());
    // Chrome rewrites its process title, which can join its arguments with
    // spaces, so match the argument followed by either separator.
    let text = String::from_utf8_lossy(&cmdline);
    text.split(['\0', ' ']).any(|arg| arg == want)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn owns(pid: i32, _profile: &Path) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(not(unix))]
fn owns(_pid: i32, _profile: &Path) -> bool {
    false
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

async fn up(state: &State, headless: bool) -> Result<i32, String> {
    if !cfg!(unix) {
        return Err("chrome: this platform is not supported yet".into());
    }
    std::fs::create_dir_all(&state.dir).map_err(|e| format!("chrome: {}: {e}", state.dir.display()))?;
    if let (Some(pid), Some(port)) = (state.running(), state.port()) {
        println!("chrome already running (pid {pid}) on :{port}  profile {}", state.profile().display());
        return Ok(0);
    }
    let port = match state.port() {
        Some(port) if port_free(port) => port,
        Some(port) => {
            return Err(format!(
                "chrome: port {port} is held by a process this worktree did not start; it is left alone. Run `atelier tool chrome down --wipe`, then `up` to take a new port."
            ))
        }
        None => {
            let port = PORTS.clone().find(|p| port_free(*p)).ok_or("chrome: no free port in 9400..9499")?;
            std::fs::write(state.dir.join("port"), port.to_string()).map_err(|e| e.to_string())?;
            port
        }
    };
    let executable = super::browser::browser_executable().ok_or("chrome: no Chrome or Chromium found")?;
    let log = std::fs::File::create(state.dir.join("chrome.log")).map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(&executable);
    if headless {
        command.arg("--headless=new");
    } else {
        headed_display(&mut command);
    }
    command
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--remote-debugging-address=127.0.0.1")
        .arg(format!("--user-data-dir={}", state.profile().display()))
        .args(["--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "about:blank"])
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own session, so it outlives this command and the whole browser
        // is one process group that `down` can stop without naming anything.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child = command.spawn().map_err(|e| format!("chrome: {}: {e}", executable.display()))?;
    let pid = child.id() as i32;
    std::fs::write(state.dir.join("chrome.pid"), pid.to_string()).map_err(|e| e.to_string())?;
    drop(child);
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::new();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        let answered = client.get(&url).timeout(Duration::from_secs(1)).send().await;
        if answered.is_ok_and(|r| r.status().is_success()) && state.running().is_some() {
            println!(
                "chrome :{port}  pid {pid}  {}  profile {}\ndrive: eval \"$(atelier tool chrome env)\"; node script.mjs  (import from \"$ATELIER_CHROME_DRIVER\")",
                if headless { "headless" } else { "headed" },
                state.profile().display()
            );
            return Ok(0);
        }
        if state.pid().is_some_and(|p| !alive(p)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let tail = std::fs::read_to_string(state.dir.join("chrome.log")).unwrap_or_default();
    let tail: Vec<_> = tail.lines().rev().take(20).collect();
    stop_group(pid);
    let _ = std::fs::remove_file(state.dir.join("chrome.pid"));
    Err(format!(
        "chrome: did not come up on :{port}; log {}:\n{}",
        state.dir.join("chrome.log").display(),
        tail.into_iter().rev().collect::<Vec<_>>().join("\n")
    ))
}

/// A headed browser needs the person's display even when the agent's shell
/// was started without one.
fn headed_display(command: &mut std::process::Command) {
    if !cfg!(target_os = "linux") {
        return;
    }
    let uid = unsafe { libc::getuid() };
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{uid}")));
    if std::env::var_os("DISPLAY").is_none() {
        command.env("DISPLAY", ":0");
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_none() && runtime.join("wayland-0").exists() {
        command.env("WAYLAND_DISPLAY", "wayland-0");
    }
    if std::env::var_os("XAUTHORITY").is_none() {
        let found = std::fs::read_dir(&runtime).ok().and_then(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("xauth_")))
                .min()
        });
        if let Some(path) = found {
            command.env("XAUTHORITY", path);
        }
    }
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}
#[cfg(not(unix))]
fn alive(_pid: i32) -> bool {
    false
}

#[cfg(unix)]
fn group_alive(pgid: i32) -> bool {
    unsafe { libc::kill(-pgid, 0) == 0 }
}

/// Stop the process group `up` created and wait until it has gone, so the
/// profile is never deleted under a browser that is still writing it.
#[cfg(unix)]
fn stop_group(pgid: i32) -> bool {
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
    let started = Instant::now();
    while group_alive(pgid) && started.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if group_alive(pgid) {
        unsafe { libc::kill(-pgid, libc::SIGKILL) };
        let started = Instant::now();
        while group_alive(pgid) && started.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    !group_alive(pgid)
}
#[cfg(not(unix))]
fn stop_group(_pgid: i32) -> bool {
    true
}

fn down(state: &State, wipe: bool) -> Result<i32, String> {
    if let Some(pid) = state.running() {
        if !stop_group(pid) {
            return Err(format!("chrome: process group {pid} did not exit; profile kept at {}", state.profile().display()));
        }
    }
    let _ = std::fs::remove_file(state.dir.join("chrome.pid"));
    if wipe && state.dir.exists() {
        std::fs::remove_dir_all(&state.dir).map_err(|e| format!("chrome: {}: {e}", state.dir.display()))?;
        println!("chrome stopped; profile and state deleted");
    } else {
        println!("chrome stopped");
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_driver_reads_the_port_env_prints() {
        assert!(DRIVER.contains("process.env.ATELIER_CHROME_PORT"));
        assert!(DRIVER.contains("export async function newContext"));
        assert!(DRIVER.contains("export class Session"));
    }

    /// Every session is told to use this Chrome for browser work, and told
    /// when screen-check's own throwaway Chrome applies instead.
    #[test]
    fn the_built_in_guidance_names_this_one_route() {
        let text = include_str!("../../../machinery/skills/atelier/SKILL.md");
        for want in [
            "All Chrome work goes through `atelier tool chrome`",
            "atelier tool chrome up --headless",
            "atelier tool chrome down --wipe",
            "process.env.ATELIER_CHROME_DRIVER",
            "Do not point it at `atelier tool chrome`",
            "its own temporary profile",
        ] {
            assert!(text.contains(want), "guidance lacks {want:?}");
        }
    }

    #[test]
    fn a_recorded_pid_that_is_not_our_chrome_is_not_ours() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::new(dir.path().to_path_buf());
        // This test process is alive but was not started with that profile.
        std::fs::write(dir.path().join("chrome.pid"), std::process::id().to_string()).unwrap();
        assert_eq!(state.running(), None);
    }

    #[test]
    fn unknown_commands_and_flags_are_refused() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for args in [vec!["kill"], vec!["up", "--port=9333"], vec!["down", "--all"], vec!["env", "x"]] {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            assert!(rt.block_on(run(&args)).is_err(), "{args:?} was accepted");
        }
    }
}
