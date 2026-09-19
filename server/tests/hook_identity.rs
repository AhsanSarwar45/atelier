//! Exercise dispatch, not just lifecycle::actor: the bug was the early bypass return.
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn hook(root: &Path, name: &str, event: &Value, mode: &str) -> (Value, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_atelier"));
    command
        .args(["hook", name])
        .current_dir(root)
        .env_remove("ATELIER_BYPASS")
        .env_remove("ATELIER_HOOKS")
        .env("ATELIER_DATA_DIR", root.join("data"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if mode == "environment" {
        command.env("ATELIER_BYPASS", "test wrong refusal");
    }
    if mode == "off" {
        command.env("ATELIER_HOOKS", "off");
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(event.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let parsed = if out.stdout.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&out.stdout).unwrap()
    };
    (parsed, String::from_utf8_lossy(&out.stderr).into())
}

#[test]
fn bypass_preserves_identity_for_both_providers_and_all_bypass_sources() {
    for (tool, key) in [("Bash", "command"), ("functions.exec_command", "cmd")] {
        for mode in ["command", "environment", "off", "marker"] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            if mode == "marker" {
                std::fs::write(root.join(".atelier-hooks-off"), "test wrong refusal").unwrap();
            }
            let prefix = if mode == "command" {
                "ATELIER_BYPASS='test wrong refusal' "
            } else {
                ""
            };
            for name in ["board-actor", "board-actor.py"] {
                for (command, expected) in [
                    (
                        "bd update x-1 --claim",
                        "bd --actor s-identity-proof update",
                    ),
                    (
                        "atelier tool board/land x-1",
                        "BEADS_ACTOR=s-identity-proof atelier tool board/land",
                    ),
                    (
                        "'/a path/atelier' tool board/land x-1",
                        "BEADS_ACTOR=s-identity-proof '/a path/atelier' tool board/land",
                    ),
                    (
                        "\"/a path/atelier\" tool board/land x-1",
                        "BEADS_ACTOR=s-identity-proof \"/a path/atelier\" tool board/land",
                    ),
                ] {
                    let event = json!({"tool_name":tool,"session_id":"identity-proof","cwd":root,
                        "tool_input":{key:format!("{prefix}{command}"),"workdir":root}});
                    let (out, _) = hook(root, name, &event, mode);
                    let output = &out["hookSpecificOutput"];
                    assert_eq!(
                        output["permissionDecision"], "allow",
                        "{tool} {mode}: {out}"
                    );
                    assert!(
                        output["updatedInput"][key]
                            .as_str()
                            .unwrap()
                            .contains(expected),
                        "{tool} {mode}: {out}"
                    );
                    assert_eq!(output["updatedInput"]["workdir"], json!(root));
                }
            }
            // The bypass still excuses the gate and is logged for either input key.
            let event = json!({"tool_name":tool,"session_id":"identity-proof","cwd":root,
                "tool_input":{key:format!("{prefix}touch file"),"workdir":root}});
            let (_, log) = hook(root, "workflow-gate", &event, mode);
            assert!(log.contains("stood down"), "{tool} {mode}: {log}");
        }
    }
}

#[test]
fn bypass_does_not_authorize_impersonating_another_session() {
    let tmp = tempfile::tempdir().unwrap();
    let event = json!({"tool_name":"Bash","session_id":"identity-proof","cwd":tmp.path(),
        "tool_input":{"command":"ATELIER_BYPASS='wrong refusal' bd --actor somebody-else update x-1 --claim"}});
    let (out, _) = hook(tmp.path(), "board-actor", &event, "command");
    assert_eq!(out["hookSpecificOutput"]["permissionDecision"], "deny");
}
