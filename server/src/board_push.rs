//! Best-effort board remote push at the end of a provider session.
//!
//! This is the native form of `machinery/hooks/board-push.py`. The hook must
//! never delay or fail session shutdown merely because the board or its remote
//! is unavailable.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const GATE: &str = "board-push";

pub fn is_ours(name: &str) -> bool {
    name == GATE || name == "board-push.py"
}

pub fn run(data: &Value) -> i32 {
    act(data, crate::routes::find_bd())
}

fn act(data: &Value, bd: Option<PathBuf>) -> i32 {
    let cwd = data
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok());
    if let (Some(cwd), Some(bd)) = (cwd, bd) {
        let _ = start(&bd, &board_root(&cwd));
    }
    0
}

fn board_root(cwd: &Path) -> PathBuf {
    let here = if cwd.is_dir() {
        cwd
    } else {
        cwd.parent().unwrap_or(cwd)
    };
    let common = crate::routes::find_git().and_then(|git| Command::new(git)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(here)
        .output()
        .ok())
        .filter(|output| output.status.success())
        .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        .filter(|path| !path.as_os_str().is_empty());
    common
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| here.to_path_buf())
}

fn start(bd: &Path, root: &Path) -> std::io::Result<()> {
    let mut command = Command::new(bd);
    command
        .args(["dolt", "push"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command.spawn().map(drop)
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // `start_new_session=True` in the Python hook: the push must not receive
    // the provider shell's terminal signals after SessionEnd returns.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn detach(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn board_push_starts_bd_from_the_board_root() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        let repo = tempfile::tempdir().unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        let nested = repo.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let record = repo.path().join("called");
        let fake = repo.path().join("bd");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf '%s|%s' \"$PWD\" \"$*\" > '{}'\n",
                record.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&fake).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake, permissions).unwrap();

        assert!(start(&fake, &board_root(&nested)).is_ok());
        let until = Instant::now() + Duration::from_secs(2);
        while !record.is_file() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            std::fs::read_to_string(record).unwrap(),
            format!("{}|dolt push", repo.path().display())
        );
    }

    #[test]
    fn board_push_failure_is_best_effort() {
        use serde_json::json;

        let cwd = tempfile::tempdir().unwrap();
        let missing = cwd.path().join("no-such-bd");
        let event = json!({ "cwd": cwd.path() });
        assert_eq!(act(&event, None), 0, "a missing bd must not fail shutdown");
        assert_eq!(
            act(&event, Some(missing)),
            0,
            "a failed detached launch must not fail shutdown"
        );
    }
}
