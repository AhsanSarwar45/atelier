//! A changed check is proved red against the starting code when the agent
//! files the amend, not when the owner approves it. Approving only checks
//! that the check files are as they were when the amend was filed, so it
//! needs no runs and answers at once.

use super::checks::{Gate, Run};
use super::{apply, Outcome, Request, TaskError};
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
    let owner = matches!(action, "approve_amend" | "reject_amend");
    apply(store, &Request {
        action: action.into(),
        actor: if owner { "owner" } else { "agent" }.into(),
        session: (!owner).then(|| "s1".to_string()),
        project: "p".into(),
        number,
        payload,
        gate,
        now: 1,
        ..Default::default()
    })
}

fn refused(result: Result<Outcome, TaskError>) -> String {
    match result {
        Err(TaskError::Refused(message)) => message,
        Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
        Ok(outcome) => panic!("expected a refusal, got: {}", outcome.summary),
    }
}

fn check(name: &str, command: &str, file: &str) -> Value {
    json!({"name": name, "command": command, "kind": "test", "given": "g", "when": "w", "then": "t",
        "red": "FAILED|panicked", "files": [file]})
}

fn plan() -> Value {
    json!({"outcome": "o", "criteria": [
        {"id": "export", "text": "x", "checks": [check("a", "cargo test a", "tests/a.rs")]},
        {"id": "images", "text": "y", "checks": [check("i", "cargo test i", "tests/i.rs")]},
    ]})
}

/// The same plan with images' check narrowed to one test.
fn amended() -> Value {
    let mut plan = plan();
    plan["criteria"][1]["checks"][0]["command"] = json!("cargo test i -- --exact images_are_linked");
    plan
}

/// A gate as the route measures it: the files' hashes and each run.
fn measured(runs: &[(&str, &str, i32, &str)], hashes: &[(&str, &str)]) -> Gate {
    let mut gate = Gate {
        head: Some("abc1234".into()),
        hashes: hashes.iter().map(|(path, sha)| (path.to_string(), sha.to_string())).collect(),
        ..Default::default()
    };
    for (item, name, exit, output) in runs {
        let run = Run { command: format!("cargo test {name}"), exit: *exit, output: output.to_string(), output_tail: output.to_string(), ..Default::default() };
        gate.runs.entry(item.to_string()).or_default().insert(name.to_string(), run);
    }
    gate
}

const FILES: &[(&str, &str)] = &[("tests/a.rs", "a1"), ("tests/i.rs", "i1")];
const FAILING: &str = "test images_are_linked ... FAILED";

fn started(store: &Store) -> i64 {
    let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan()});
    let one = ask(store, "create", None, payload, Some(measured(&[], FILES))).unwrap().task.number;
    let red = measured(&[("export", "a", 101, FAILING), ("images", "i", 101, FAILING)], FILES);
    ask(store, "start", Some(one), json!({}), Some(red)).unwrap();
    one
}

const REASON: &str = "\"i\" runs every test in the file, and one needs a GPU";

#[test]
fn filing_an_amend_runs_the_changed_checks_against_the_starting_code() {
    let (_d, store) = store();
    let one = started(&store);
    let message = refused(ask(&store, "amend", Some(one), json!({"plan": amended(), "reason": REASON}), None));
    assert!(message.contains("could not run the checks"), "the amend itself needs the run: {message}");
    let passing = measured(&[("images", "i", 0, "ok")], FILES);
    let message = refused(ask(&store, "amend", Some(one), json!({"plan": amended(), "reason": REASON}), Some(passing)));
    assert!(message.contains("images: \"i\" already passes, so it proves nothing"), "{message}");
    let red = measured(&[("images", "i", 101, FAILING)], FILES);
    let outcome = ask(&store, "amend", Some(one), json!({"plan": amended(), "reason": REASON}), Some(red)).unwrap();
    assert_eq!(outcome.task.pending_amend, Some(amended()));
}

#[test]
fn approving_a_filed_amend_needs_no_runs() {
    let (_d, store) = store();
    let one = started(&store);
    let red = measured(&[("images", "i", 101, FAILING)], FILES);
    ask(&store, "amend", Some(one), json!({"plan": amended(), "reason": REASON}), Some(red)).unwrap();
    // The owner's approval carries the files' hashes and no runs at all.
    let outcome = ask(&store, "approve_amend", Some(one), json!({}), Some(measured(&[], FILES))).unwrap();
    assert_eq!(outcome.task.plan, amended());
    let stored = outcome.task.gate.clone().unwrap();
    assert_eq!(stored["runs"]["images"]["i"]["exit"], 101, "the run from filing is kept as the red run: {stored}");
    assert_eq!(stored["met"]["images"], false);
    assert_eq!(stored["hashes"]["files"]["tests/i.rs"], "i1");
}

#[test]
fn approving_is_refused_when_a_check_file_changed_since_filing() {
    let (_d, store) = store();
    let one = started(&store);
    let red = measured(&[("images", "i", 101, FAILING)], FILES);
    ask(&store, "amend", Some(one), json!({"plan": amended(), "reason": REASON}), Some(red)).unwrap();
    let edited = measured(&[], &[("tests/a.rs", "a1"), ("tests/i.rs", "i2")]);
    let message = refused(ask(&store, "approve_amend", Some(one), json!({}), Some(edited)));
    assert!(message.contains("tests/i.rs changed since the amend was filed"), "{message}");
}
