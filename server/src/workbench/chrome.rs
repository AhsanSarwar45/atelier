//! `atelier tool chrome`: one private Chrome per worktree for browser work.
//! Each has its own profile and DevTools port, is recorded in the worktree's
//! own git directory, and is stopped only through the process group it was
//! started in, so one agent can never reach or kill another agent's browser.
//!
//! `mcp` gives every chat the Chrome DevTools MCP server (maintained by the
//! Chrome team, run through the machine's own Node) pointed at that private
//! Chrome, so no provider needs its own browser configuration.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PORTS: std::ops::RangeInclusive<u16> = 9400..=9499;
/// The one version every chat runs. Moving it is a deliberate change here.
pub const MCP_PACKAGE: &str = "chrome-devtools-mcp@1.10.1";

const USAGE: &str = "usage: atelier tool chrome <command>

  up [--headless]      start this worktree's private Chrome (headed by default)
  env                  eval \"$(atelier tool chrome env)\" -> ATELIER_CHROME_PORT, CDP_URL
  status               running or stopped, port, profile
  down [--wipe]        stop it; --wipe also deletes its profile and state
  mcp [--cwd DIR] [--headless]
                       Chrome DevTools MCP server over stdio for that Chrome;
                       Atelier registers this for every chat. Needs Node (npx).

One Chrome per worktree (per directory outside git). It is never shared with
another worktree and never stopped by name; `down` stops only the process
group `up` started. Set ATELIER_CHROME_STATE=DIR to choose the state directory.
";

pub async fn run(rest: &[String]) -> Result<i32, String> {
    let command = rest.first().map(String::as_str).unwrap_or("help");
    let flags: Vec<&str> = rest.iter().skip(1).map(String::as_str).collect();
    if matches!(command, "help" | "--help" | "-h") {
        print!("{USAGE}");
        return Ok(0);
    }
    let refused = || USAGE.trim_end().to_string();
    let mut cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut headless = false;
    let mut wipe = false;
    let mut at = 0;
    while at < flags.len() {
        match (command, flags[at]) {
            ("up" | "mcp", "--headless") => headless = true,
            ("down", "--wipe") => wipe = true,
            ("mcp", "--cwd") => {
                at += 1;
                cwd = PathBuf::from(flags.get(at).ok_or_else(refused)?);
            }
            _ => return Err(refused()),
        }
        at += 1;
    }
    let state = State::new(state_dir(&cwd)?);
    match command {
        "up" => {
            let (pid, port, _) = ensure_up(&state, headless).await?;
            println!(
                "chrome :{port}  pid {pid}  {}  profile {}\nuse: eval \"$(atelier tool chrome env)\"; connect over CDP_URL",
                if headless { "headless" } else { "headed" },
                state.profile().display()
            );
            Ok(0)
        }
        "env" => {
            let port = state.port().ok_or("chrome: none started here — run: atelier tool chrome up")?;
            println!("export ATELIER_CHROME_PORT={port} CDP_URL=http://127.0.0.1:{port}");
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
        "down" => down(&state, wipe),
        "mcp" => mcp(&state, &cwd, headless).await,
        _ => Err(refused()),
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
    let home = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|h| PathBuf::from(h).join(".local/state")))
        .ok_or("chrome: no home directory")?;
    Ok(home.join("atelier/chrome").join(short_hash(cwd.to_string_lossy().as_bytes())))
}

fn short_hash(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
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
    /// The port this worktree keeps, chosen once from 9400..9499.
    fn reserve_port(&self) -> Result<u16, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("chrome: {}: {e}", self.dir.display()))?;
        let _lock = Lock::take(&self.dir)?;
        if let Some(port) = self.port() {
            // Keep it only while this worktree still holds the claim.
            if claim(port, &self.dir) {
                return Ok(port);
            }
            if self.running().is_some() {
                return Err(format!("chrome: port {port} is claimed by another worktree; run `atelier tool chrome down --wipe` here"));
            }
            let _ = std::fs::remove_file(self.dir.join("port"));
        }
        let port = PORTS
            .clone()
            .find(|p| port_free(*p) && claim(*p, &self.dir))
            .ok_or("chrome: no free port in 9400..9499")?;
        std::fs::write(self.dir.join("port"), port.to_string()).map_err(|e| e.to_string())?;
        Ok(port)
    }
    /// Chats using this Chrome through `mcp`, one file per live wrapper.
    fn users(&self) -> PathBuf {
        self.dir.join("mcp-users")
    }
    fn started_by_mcp(&self) -> PathBuf {
        self.dir.join("started-by-mcp")
    }
}

/// Ports are claimed machine-wide before any Chrome listens on them, so two
/// chats that reserve a port before their first tool call never pick the same
/// one. A claim whose worktree no longer records that port is stale.
fn claims() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|h| PathBuf::from(h).join(".local/state")))?;
    Some(base.join("atelier/chrome-ports"))
}

fn claim(port: u16, dir: &Path) -> bool {
    let Some(claims) = claims() else { return true };
    if std::fs::create_dir_all(&claims).is_err() {
        return true;
    }
    let path = claims.join(port.to_string());
    for _ in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                return file.write_all(dir.to_string_lossy().as_bytes()).is_ok();
            }
            Err(_) => {
                let holder = std::fs::read_to_string(&path).unwrap_or_default();
                let held = !holder.is_empty()
                    && std::fs::read_to_string(Path::new(&holder).join("port"))
                        .is_ok_and(|p| p.trim() == port.to_string());
                if held || holder == dir.to_string_lossy() {
                    return holder == dir.to_string_lossy();
                }
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    false
}

fn release(port: u16, dir: &Path) {
    if let Some(path) = claims().map(|c| c.join(port.to_string())) {
        if std::fs::read_to_string(&path).is_ok_and(|holder| holder == dir.to_string_lossy()) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Serialises starting and stopping within one worktree, so two chats that
/// ask at once get one Chrome rather than two on the same profile.
struct Lock(#[allow(dead_code)] std::fs::File);
impl Lock {
    fn take(dir: &Path) -> Result<Self, String> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("lock"))
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(format!("chrome: lock: {}", std::io::Error::last_os_error()));
            }
        }
        Ok(Self(file))
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
    alive(pid)
}

#[cfg(not(unix))]
fn owns(_pid: i32, _profile: &Path) -> bool {
    false
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Start this worktree's Chrome unless it is already running. Returns its
/// process ID, its port, and whether this call started it.
async fn ensure_up(state: &State, headless: bool) -> Result<(i32, u16, bool), String> {
    if !cfg!(unix) {
        return Err("chrome: this platform is not supported yet".into());
    }
    let port = state.reserve_port()?;
    let _lock = Lock::take(&state.dir)?;
    if let Some(pid) = state.running() {
        return Ok((pid, port, false));
    }
    if !port_free(port) {
        return Err(format!(
            "chrome: port {port} is held by a process this worktree did not start; it is left alone. Run `atelier tool chrome down --wipe`, then `up` to take a new port."
        ));
    }
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
    let _ = std::fs::remove_file(state.started_by_mcp());
    // Reap it when it exits. A long-lived parent (the `mcp` wrapper) would
    // otherwise keep a zombie that still counts as a live process group.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = reqwest::Client::new();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        let answered = client.get(&url).timeout(Duration::from_secs(1)).send().await;
        if answered.is_ok_and(|r| r.status().is_success()) && state.running().is_some() {
            return Ok((pid, port, true));
        }
        if !alive(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let log = std::fs::read_to_string(state.dir.join("chrome.log")).unwrap_or_default();
    let tail: Vec<_> = log.lines().rev().take(20).collect();
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

/// Stop one process group and wait until it has gone, so the profile is never
/// deleted under a browser that is still writing it.
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
    if state.dir.exists() {
        let _lock = Lock::take(&state.dir)?;
        stop_chrome(state)?;
    }
    if wipe && state.dir.exists() {
        if let Some(port) = state.port() {
            release(port, &state.dir);
        }
        std::fs::remove_dir_all(&state.dir).map_err(|e| format!("chrome: {}: {e}", state.dir.display()))?;
        println!("chrome stopped; profile and state deleted");
    } else {
        println!("chrome stopped");
    }
    Ok(0)
}

/// Caller holds the lock.
fn stop_chrome(state: &State) -> Result<(), String> {
    if let Some(pid) = state.running() {
        if !stop_group(pid) {
            return Err(format!("chrome: process group {pid} did not exit; profile kept at {}", state.profile().display()));
        }
    }
    let _ = std::fs::remove_file(state.dir.join("chrome.pid"));
    let _ = std::fs::remove_file(state.started_by_mcp());
    Ok(())
}

/// The command line every chat's `chrome` MCP server runs.
fn mcp_command(port: u16, cwd: &Path) -> Vec<String> {
    let mut args: Vec<String> = [
        "-y",
        MCP_PACKAGE,
        "--browserUrl",
        &format!("http://127.0.0.1:{port}"),
        // Local development URLs stay on this computer.
        "--no-usage-statistics",
        "--no-performance-crux",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    // Screenshots and traces may be saved in the chat's folder or a
    // temporary directory, where the presenter can read them.
    let mut roots = vec![cwd.to_path_buf(), std::env::temp_dir()];
    if cfg!(unix) {
        roots.push(PathBuf::from("/tmp"));
    }
    roots.dedup();
    for root in roots {
        args.push("--workspace".into());
        args.push(root.display().to_string());
    }
    args
}

pub fn npx() -> Option<PathBuf> {
    crate::routes::find_tool("npx", &[])
}

/// Stdio MCP server for this worktree's Chrome. Messages pass through to the
/// Chrome DevTools MCP server unchanged; the only thing added is that Chrome
/// is started before the first tool call, so a chat that never opens a page
/// never starts a browser. When the chat ends, a Chrome that a chat started
/// is stopped once no other chat in this worktree is still using it.
async fn mcp(state: &State, cwd: &Path, headless: bool) -> Result<i32, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let npx = npx().ok_or("chrome mcp: needs Node's npx on PATH; Atelier does not bundle Node")?;
    let port = state.reserve_port()?;
    let users = state.users();
    std::fs::create_dir_all(&users).map_err(|e| e.to_string())?;
    let me = users.join(std::process::id().to_string());
    std::fs::write(&me, "").map_err(|e| e.to_string())?;

    let mut command = tokio::process::Command::new(&npx);
    command
        .args(mcp_command(port, cwd))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| format!("chrome mcp: {}: {e}", npx.display()))?;
    let child_group = child.id().map(|id| id as i32);
    let mut to_child = child.stdin.take().ok_or("chrome mcp: no stdin")?;
    // The server's replies and our own refusals share one writer, so a line
    // is never interleaved with another.
    let out = std::sync::Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let from_child = child.stdout.take().ok_or("chrome mcp: no stdout")?;
    let relay = {
        let out = out.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(from_child).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut out = out.lock().await;
                if out.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
                let _ = out.flush().await;
            }
        })
    };
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut ready = false;

    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
    loop {
        #[cfg(unix)]
        let next = tokio::select! {
            line = lines.next_line() => line,
            _ = terminate.recv() => Ok(None),
            _ = tokio::signal::ctrl_c() => Ok(None),
            _ = child.wait() => Ok(None),
        };
        #[cfg(not(unix))]
        let next = lines.next_line().await;
        let Ok(Some(line)) = next else { break };
        if !ready && is_tool_call(&line) {
            match ensure_up(state, headless).await {
                Ok((_, _, started)) => {
                    if started {
                        let _ = std::fs::write(state.started_by_mcp(), "");
                    }
                    ready = true;
                }
                Err(error) => {
                    // Never forward a call while the port may belong to
                    // someone else's browser; answer it here instead.
                    eprintln!("{error}");
                    let reply = refusal(&line, &error);
                    let mut out = out.lock().await;
                    let _ = out.write_all(format!("{reply}\n").as_bytes()).await;
                    let _ = out.flush().await;
                    continue;
                }
            }
        }
        if to_child.write_all(format!("{line}\n").as_bytes()).await.is_err() {
            break;
        }
        let _ = to_child.flush().await;
    }

    drop(to_child);
    if tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_err() {
        #[cfg(unix)]
        if let Some(group) = child_group {
            stop_group(group);
        }
        let _ = child.kill().await;
    }
    relay.abort();
    let _ = std::fs::remove_file(&me);
    let _lock = Lock::take(&state.dir)?;
    let others = std::fs::read_dir(&users)
        .map(|entries| {
            entries.flatten().any(|e| {
                e.file_name().to_string_lossy().parse::<i32>().is_ok_and(|pid| {
                    let live = alive(pid);
                    if !live {
                        let _ = std::fs::remove_file(e.path());
                    }
                    live
                })
            })
        })
        .unwrap_or(false);
    if !others && state.started_by_mcp().exists() {
        stop_chrome(state)?;
    }
    Ok(0)
}

/// A tool result that says why Chrome could not start, for each call in the
/// message.
fn refusal(line: &str, error: &str) -> String {
    let one = |id: &serde_json::Value| {
        serde_json::json!({"jsonrpc":"2.0","id":id,"result":{
            "content":[{"type":"text","text":error}],"isError":true}})
    };
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(serde_json::Value::Array(batch)) => serde_json::Value::Array(
            batch.iter().filter(|m| m.get("id").is_some()).map(|m| one(&m["id"])).collect(),
        )
        .to_string(),
        Ok(message) => one(&message["id"]).to_string(),
        Err(_) => one(&serde_json::Value::Null).to_string(),
    }
}

fn is_tool_call(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line).is_ok_and(|message| {
        let one = |m: &serde_json::Value| m["method"] == "tools/call";
        message.as_array().map_or_else(|| one(&message), |batch| batch.iter().any(one))
    })
}

/// The `chrome` MCP server Atelier hands every chat, or none when this
/// computer lacks Node or Chrome and the server could not start.
pub fn session_server(cwd: &Path) -> Option<serde_json::Value> {
    npx()?;
    super::browser::browser_executable()?;
    let exe = std::env::current_exe().ok()?;
    Some(serde_json::json!({
        "name": "chrome",
        "command": exe,
        "args": ["tool", "chrome", "mcp", "--cwd", cwd],
        "env": [],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every session is told to use this Chrome for browser work, and told
    /// when screen-check's own throwaway Chrome applies instead.
    #[test]
    fn the_built_in_guidance_names_this_one_route() {
        let text = include_str!("../../../machinery/skills/atelier/SKILL.md");
        for want in [
            "All Chrome work goes through Atelier's `chrome` MCP server",
            "atelier tool chrome up --headless",
            "atelier tool chrome down --wipe",
            "isolatedContext",
            "connectOverCDP",
            "Do not point it at `atelier tool chrome`",
            "reuse it for every\n  page that user opens",
            "`background: true`",
            "Close each page with `close_page`",
            "run `atelier tool chrome down` when the browser work is\n  finished",
        ] {
            assert!(text.contains(want), "guidance lacks {want:?}");
        }
    }

    #[test]
    fn the_mcp_server_is_pinned_and_pointed_at_this_chrome_only() {
        let args = mcp_command(9412, Path::new("/work/tree"));
        assert_eq!(args[1], MCP_PACKAGE);
        assert!(!MCP_PACKAGE.ends_with("@latest"));
        assert_eq!(args[2..4], ["--browserUrl".to_string(), "http://127.0.0.1:9412".to_string()]);
        assert!(args.windows(2).any(|w| w[0] == "--workspace" && w[1] == "/work/tree"));
        // Never a mode that launches or finds a browser of its own.
        for other in ["--isolated", "--autoConnect", "--userDataDir", "--wsEndpoint"] {
            assert!(!args.iter().any(|a| a == other), "{other}");
        }
    }

    #[test]
    fn only_a_tool_call_starts_chrome() {
        assert!(is_tool_call(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"new_page"}}"#));
        assert!(is_tool_call(r#"[{"jsonrpc":"2.0","id":3,"method":"tools/call"}]"#));
        assert!(!is_tool_call(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#));
        assert!(!is_tool_call(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#));
        assert!(!is_tool_call("not json"));
    }

    #[test]
    fn a_failed_start_answers_the_call_instead_of_forwarding_it() {
        let reply: serde_json::Value =
            serde_json::from_str(&refusal(r#"{"jsonrpc":"2.0","id":7,"method":"tools/call"}"#, "no chrome")).unwrap();
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(reply["result"]["content"][0]["text"], "no chrome");
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
        for args in [vec!["kill"], vec!["up", "--port=9333"], vec!["down", "--all"], vec!["env", "x"], vec!["mcp", "--cwd"], vec!["driver"]] {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            assert!(rt.block_on(run(&args)).is_err(), "{args:?} was accepted");
        }
    }
}
