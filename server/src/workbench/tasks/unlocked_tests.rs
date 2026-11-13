//! Nothing is locked while a task is worked (docs/tasks.md, "Approval and
//! review"). Editing a check file, a helper beside it or the harness never
//! refuses start, check or done; done flags each changed file for the
//! owner, and break-it still catches a check that was weakened.
//!
//! Each assertion that the old lock would break says `LOCKED:`.

use super::gate::tests::check;
use super::checks::{self, Gate, Run};
use super::{apply, get, Outcome, Request, TaskError};
use crate::workbench::store::Store;
use serde_json::{json, Value};

fn store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("workbench.db")).unwrap();
    store.open_message("s1", "m0", "user", "2026-01-01T00:00:00Z").unwrap();
    store.grow_message("s1", "m0", "@task do it").unwrap();
    (directory, store)
}

fn ask(store: &Store, action: &str, number: Option<i64>, payload: Value, gate: Option<Gate>) -> Result<Outcome, TaskError> {
    apply(store, &Request {
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        number,
        payload,
        gate,
        now: 1,
        ..Default::default()
    })
}

/// The outcome, or a panic that names the refusal.
fn allowed(action: &str, result: Result<Outcome, TaskError>) -> Outcome {
    match result {
        Ok(outcome) => outcome,
        Err(TaskError::Refused(message) | TaskError::Failed(message)) => panic!("LOCKED: {action} was refused: {message}"),
    }
}

/// A feature with criteria export (check a in tests/a.rs) and images (check
/// i in tests/i.rs). tests/common.rs is a helper beside them and Cargo.toml
/// the harness.
fn plan() -> Value {
    json!({"outcome": "o", "criteria": [
        {"id": "export", "text": "x", "checks": [check("a", "tests/a.rs")]},
        {"id": "images", "text": "y", "checks": [check("i", "tests/i.rs")]},
    ]})
}

fn measured(exit: i32, output: &str, changed: &[&str]) -> Gate {
    let hashes = ["tests/a.rs", "tests/i.rs", "tests/common.rs", "Cargo.toml"]
        .iter()
        .map(|path| (path.to_string(), if changed.contains(path) { "changed" } else { "approved" }.to_string()))
        .collect();
    let mut gate = Gate { head: Some("abc1234".into()), hashes, harness: vec!["Cargo.toml".into()], ..Default::default() };
    for (item, name) in [("export", "a"), ("images", "i")] {
        let run = Run { command: format!("cargo test {name}"), exit, output: output.into(), output_tail: output.into(), ..Default::default() };
        gate.runs.entry(item.to_string()).or_default().insert(name.to_string(), run);
    }
    gate
}

#[test]
fn a_changed_check_file_helper_or_harness_refuses_nothing_and_is_flagged_at_done() {
    let (_d, store) = store();
    let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan()});
    let number = ask(&store, "create", None, payload, Some(measured(0, "", &[]))).unwrap().task.number;

    // The agent edits a helper and the check file before starting.
    let red = measured(101, "test a ... FAILED", &["tests/common.rs", "tests/a.rs"]);
    allowed("start", ask(&store, "start", Some(number), json!({}), Some(red)));

    let green = measured(0, "test result: ok. 1 passed", &["tests/common.rs", "tests/a.rs"]);
    let outcome = allowed("check", ask(&store, "check", Some(number), json!({"item": "export"}), Some(green)));
    assert_eq!(outcome.detail["met"], true, "LOCKED: the item was not ticked: {}", outcome.summary);

    let green = measured(0, "test result: ok. 1 passed", &["tests/common.rs", "tests/a.rs", "Cargo.toml"]);
    allowed("check", ask(&store, "check", Some(number), json!({"item": "images"}), Some(green.clone())));
    let done = json!({"summary": "s", "commits": ["abcdef1"], "result": {}});
    allowed("done", ask(&store, "done", Some(number), done, Some(green)));

    let task = get(store.connection(), "p", number).unwrap().unwrap();
    let flagged: Vec<String> = task.gate.as_ref().unwrap()["flags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|flag| flag["kind"] == "check-file-changed")
        .filter_map(|flag| flag["path"].as_str().map(str::to_string))
        .collect();
    for path in ["tests/a.rs", "tests/common.rs", "Cargo.toml"] {
        assert!(flagged.iter().any(|one| one == path), "the owner is not told {path} changed: {flagged:?}");
    }
    assert!(!flagged.iter().any(|one| one == "tests/i.rs"), "an unchanged file is not flagged: {flagged:?}");
}

/// The whole path in a real repository: the agent weakens its own check to
/// `true`. Nothing refuses it, and done shows the owner both the edit and
/// break-it's verdict that the check now proves nothing.
#[tokio::test]
async fn a_weakened_check_runs_but_the_owner_sees_the_edit_and_that_it_proves_nothing() {
    use crate::workbench::grids::proof::tests::{commit_file, repository};
    let root = repository();
    let dir = root.path();
    commit_file(dir, "src/value.txt", "1\n");
    commit_file(dir, "tests/value.sh", "grep -qx 2 src/value.txt || { echo 'value FAILED'; exit 1; }\n");
    let real = json!({"name": "two", "command": "sh tests/value.sh", "kind": "test", "given": "g", "when": "w", "then": "t",
        "red": "value FAILED", "files": ["tests/value.sh"]});
    let plan = json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [real]}]});
    let (_d, store) = store();
    let draft = checks::draft_gate(dir, "feature", &plan, &[]);
    let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan});
    let number = ask(&store, "create", None, payload, Some(draft)).unwrap().task.number;
    let task = || get(store.connection(), "p", number).unwrap().unwrap();
    let measure = |measure: checks::Measure| {
        let task = task();
        async move { checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), measure, 1).await }
    };
    let gate = measure(checks::Measure::Start).await;
    allowed("start", ask(&store, "start", Some(number), json!({}), Some(gate)));

    // The code is not fixed; the check is weakened instead.
    commit_file(dir, "tests/value.sh", "true\n");
    let gate = measure(checks::Measure::Item("export".into())).await;
    let outcome = allowed("check", ask(&store, "check", Some(number), json!({"item": "export"}), Some(gate)));
    assert_eq!(outcome.detail["met"], true, "LOCKED: the edited check was not run as it is: {}", outcome.summary);

    let gate = measure(checks::Measure::Done { test_command: None }).await;
    allowed("done", ask(&store, "done", Some(number), json!({"summary": "s", "commits": ["abcdef1"], "result": {}}), Some(gate)));
    let flags = task().gate.unwrap()["flags"].clone();
    let kinds: Vec<(String, String)> = flags
        .as_array()
        .into_iter()
        .flatten()
        .map(|flag| (flag["kind"].as_str().unwrap_or("").to_string(), flag["path"].as_str().or(flag["check"].as_str()).unwrap_or("").to_string()))
        .collect();
    assert!(kinds.contains(&("check-file-changed".into(), "tests/value.sh".into())), "the edit is not flagged: {kinds:?}");
    assert!(kinds.contains(&("proves-nothing".into(), "two".into())), "break-it does not catch the weakened check: {kinds:?}");
}
