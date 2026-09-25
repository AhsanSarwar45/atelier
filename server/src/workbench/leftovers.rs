//! What this Atelier started for its chats goes when it goes.
//!
//! Closing a chat kills its adapter's process group, and that is all it can
//! reach. A provider that runs each command in a session of its own — Codex
//! does, so that a command's terminal is its own — puts the command outside
//! that group, and it ran on after the server had stopped (bw-s78t.1).
//!
//! What every such process does keep is the environment it was started with,
//! and every adapter is started with this server's own token (`OWNER_ENV`),
//! which its provider and every command below that inherit. So the one rule,
//! the same for every provider: when the server is asked to stop, every
//! process carrying its token is asked to stop too, and whatever is still
//! there after a moment is killed. Another Atelier's processes carry another
//! token and are never touched.

use std::path::Path;
use std::time::{Duration, Instant};

use super::external::{owner_token, OWNER_ENV};

/// How long a process asked to stop is given before it is killed. Long enough
/// for a provider to write the end of its record, short enough that a stop
/// still feels like one.
const GRACE: Duration = Duration::from_secs(2);

/// Stop everything this server started for a chat. Answers how many processes
/// were asked to stop.
pub fn stop_what_this_server_started() -> usize {
    stop_carrying(owner_token(), Path::new("/proc"), GRACE)
}

#[cfg(target_os = "linux")]
fn stop_carrying(token: &str, proc_root: &Path, grace: Duration) -> usize {
    let asked = carrying(token, proc_root);
    for pid in &asked {
        signal(*pid, libc::SIGTERM);
    }
    let until = Instant::now() + grace;
    let mut left = carrying(token, proc_root);
    while !left.is_empty() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
        left = carrying(token, proc_root);
    }
    for pid in left {
        signal(pid, libc::SIGKILL);
    }
    asked.len()
}

#[cfg(not(target_os = "linux"))]
fn stop_carrying(_token: &str, _proc_root: &Path, _grace: Duration) -> usize {
    0
}

#[cfg(target_os = "linux")]
fn signal(pid: u32, signal: libc::c_int) {
    // The pid was read a moment ago and may have exited since; a process that
    // is already gone is exactly what was wanted.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
}

/// Every live process whose environment carries this token, this one aside.
/// A process that has exited but not been reaped reads as having no
/// environment, so it is not counted as still running.
#[cfg(target_os = "linux")]
fn carrying(token: &str, proc_root: &Path) -> Vec<u32> {
    let ours = std::process::id();
    let wanted = format!("{OWNER_ENV}={token}");
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| *pid != ours)
        .filter(|pid| {
            std::fs::read(proc_root.join(pid.to_string()).join("environ")).is_ok_and(|environ| {
                environ
                    .split(|byte| *byte == 0)
                    .any(|entry| entry == wanted.as_bytes())
            })
        })
        .collect()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn alive(pid: u32) -> bool {
        // Signal 0 checks without signalling; a zombie still answers, so look
        // at its state as well.
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let state = stat.rsplit(')').next().and_then(|rest| rest.split_whitespace().next());
        let answers = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
        answers && !matches!(state, Some("Z" | "X"))
    }

    /// The shape that escaped: a command in a session of its own, below a
    /// parent that carries the token, and one that ignores the polite ask.
    #[test]
    fn a_command_in_its_own_session_stops_with_the_server_that_started_it() {
        let token = uuid::Uuid::new_v4().to_string();
        let pids = tempfile::tempdir().unwrap();
        let written = pids.path().join("pids");
        let mut parent = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "setsid sh -c 'echo $$ >> {0}; exec sleep 30' & \
                 setsid sh -c 'trap \"\" TERM; echo $$ >> {0}; while :; do sleep 1; done' & \
                 wait",
                written.display()
            ))
            .env(OWNER_ENV, &token)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        let commands: Vec<u32> = loop {
            let found: Vec<u32> = std::fs::read_to_string(&written)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.trim().parse().ok())
                .collect();
            if found.len() == 2 || Instant::now() > until {
                break found;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(commands.len(), 2, "the commands never started");
        // Both really are outside the parent's process group.
        for pid in &commands {
            assert_ne!(unsafe { libc::getpgid(*pid as libc::pid_t) }, parent.id() as libc::pid_t);
        }
        // A process of another Atelier, which must be left alone.
        let mut stranger = Command::new("sleep")
            .arg("30")
            .env(OWNER_ENV, "another-atelier")
            .spawn()
            .unwrap();

        let asked = stop_carrying(&token, Path::new("/proc"), Duration::from_millis(500));

        let until = Instant::now() + Duration::from_secs(3);
        while commands.iter().any(|pid| alive(*pid)) && Instant::now() < until {
            let _ = parent.try_wait();
            std::thread::sleep(Duration::from_millis(20));
        }
        let outlived: Vec<u32> = commands.iter().copied().filter(|pid| alive(*pid)).collect();
        let stranger_left = stranger.try_wait().unwrap().is_none();
        // Nothing this test started is left behind, whatever it finds.
        for pid in &outlived {
            signal(*pid, libc::SIGKILL);
        }
        let _ = parent.kill();
        let _ = parent.wait();
        let _ = stranger.kill();
        let _ = stranger.wait();

        assert!(asked >= 3, "asked only {asked} to stop");
        assert!(outlived.is_empty(), "{outlived:?} outlived the server that started them");
        assert!(stranger_left, "another Atelier's process was stopped");
    }
}
