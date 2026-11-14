//! The role each side of an orchestrator and its workers is given in its
//! system prompt (docs/designs/orchestrator-workers.md, Role guidance).

use atelier::workbench::store::Session;
use serde_json::{json, Value};

fn chat(id: &str, folder: &str, extra: Value) -> Session {
    let mut row = json!({
        "id": id, "brand": "claude", "externalId": null, "projectId": "project-1",
        "projectPath": folder, "cwd": folder, "model": null, "permissionMode": "default",
        "effort": null, "collaborationMode": null, "profile": null, "title": id,
        "state": "idle", "origin": "app",
        "createdAt": "2026-11-14T00:00:00.000Z", "lastActiveAt": "2026-11-14T00:00:00.000Z",
        "lastSpokeAt": null, "begunBy": "person",
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        row[key] = value;
    }
    serde_json::from_value(row).unwrap()
}

fn choice() -> Value {
    json!({"workers": {"brand": "codex", "profileId": "work-account", "model": "gpt-test"}})
}

#[test]
fn an_orchestrator_is_told_how_to_orchestrate() {
    let folder = "/tmp/project";
    let orchestrator = chat("orch-a", folder, choice());
    let section = atelier::workbench::session_policy::role_section(&orchestrator);
    for needed in ["atelier tool worker start", "end your turn", "Never just say \"continue\""] {
        assert!(section.contains(needed), "the orchestrator section misses {needed:?}: {section}");
    }
}

#[test]
fn a_worker_is_told_it_works_for_an_orchestrator() {
    let folder = "/tmp/project";
    let worker = chat("worker-1", folder, json!({"parentSessionId": "orch-a"}));
    let section = atelier::workbench::session_policy::role_section(&worker);
    for needed in ["orchestrator", "Done", "Left", "Blocked", "Files changed", "Checks run"] {
        assert!(section.contains(needed), "the worker section misses {needed:?}: {section}");
    }
    let plain = atelier::workbench::session_policy::role_section(&chat("plain", folder, json!({})));
    assert!(plain.is_empty(), "a plain chat was given a role: {plain}");
}
