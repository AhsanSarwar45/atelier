//! The gate is followed from the outside in, the way the tool calls it.
//!
//! Every other test of this walks in at a private helper with a folder handed
//! to it, which leaves the two steps the tool itself takes unproven: the word
//! `doing` being answered by the program rather than looked for as a script
//! beside the data, and the folder being found from the environment the tool
//! sets. Take the first of those out and every one of those tests stays green
//! while `atelier hook doing` writes nothing at all — which is the bug this
//! whole feature exists to fix, back again and invisible (bw-14ij.3).

use std::io::Write;
use std::process::{Command, Stdio};

/// A chat's name, which is what the line is filed under.
const CHAT: &str = "a-conversation";

#[test]
fn a_compaction_beginning_reaches_the_file_the_screens_read() {
    let home = tempfile::tempdir().expect("a folder");

    let mut running = Command::new(env!("CARGO_BIN_EXE_atelier"))
        .args(["hook", "doing"])
        .env("CLAUDE_CONFIG_DIR", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the program to start");

    running
        .stdin
        .take()
        .expect("somewhere to say it")
        .write_all(
            br#"{"session_id":"a-conversation","hook_event_name":"PreCompact","trigger":"auto"}"#,
        )
        .expect("the event to be heard");

    let done = running.wait_with_output().expect("the gate to finish");

    // A gate that fails, or says anything at all, interrupts the session it is
    // describing. No status line is worth that.
    assert!(
        done.status.success(),
        "the gate ended badly ({}), which stops the chat it is describing",
        done.status
    );
    assert!(
        done.stdout.is_empty() && done.stderr.is_empty(),
        "the gate said something to the session: {}{}",
        String::from_utf8_lossy(&done.stdout),
        String::from_utf8_lossy(&done.stderr)
    );

    let line = home
        .path()
        .join("sessions")
        .join(format!("{CHAT}.doing.json"));
    let text = std::fs::read_to_string(&line).unwrap_or_else(|_| {
        panic!(
            "nothing was written to {}, so every screen reading it keeps saying Working",
            line.display()
        )
    });
    let said: serde_json::Value = serde_json::from_str(&text).expect("a line the screens can read");

    assert_eq!(said["doing"], "summarising");
    assert_eq!(said["detail"], "auto");
}
