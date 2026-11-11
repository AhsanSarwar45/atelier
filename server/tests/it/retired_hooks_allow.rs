//! A hook the board once needed still runs, from settings a project wrote
//! before the board was retired, until Atelier tidies them away. It must allow
//! every call quietly: no refusal, no words, nothing a provider would read as a
//! verdict.
use serde_json::json;
use std::{
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn a_retired_hook_allows_every_call_and_says_nothing() {
    let root = tempfile::tempdir().unwrap();
    let event = json!({
        "session_id": "s-1", "hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": "git push origin main"}, "cwd": root.path(),
    });
    for name in [
        "workflow-gate", "board-actor", "board-merge-gate", "board-status-gate", "wait-gate",
        "board-touch", "board-prime", "board-push", "completion-gate", "board-gate",
        "landing-gate", "a-gate-that-never-was",
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_atelier"))
            .args(["hook", name])
            .current_dir(root.path())
            .env("ATELIER_DATA_DIR", root.path().join("data"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(event.to_string().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{name}: {}", String::from_utf8_lossy(&out.stderr));
        assert!(out.stdout.is_empty(), "{name} printed {}", String::from_utf8_lossy(&out.stdout));
        assert!(out.stderr.is_empty(), "{name} said {}", String::from_utf8_lossy(&out.stderr));
    }
}
