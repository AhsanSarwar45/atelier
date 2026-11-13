//! An agent's plan change applies at once; the owner does not approve it.
//! A changed check must still fail on the starting code. When the change may
//! weaken what the owner approved (an item or check removed, an approved
//! check changed), it still applies, and the agent is asked to make sure it
//! does not. The owner can undo the last change.

use atelier::workbench::tasks::{self, checks::{Gate, Run}, git::MergeState, Outcome, TaskError};
use crate::gaps::*;
use serde_json::{json, Value};

fn check(name: &str, command: &str, file: &str) -> Value {
    shell_check(name, command, "FAILED|panicked", &[file])
}

fn plan() -> Value {
    json!({"outcome": "o", "criteria": [
        {"id": "export", "text": "x", "checks": [check("a", "cargo test a", "tests/a.rs")]},
        {"id": "images", "text": "y", "checks": [check("i", "cargo test i", "tests/i.rs")]},
    ]})
}

/// The same plan with images' approved check changed.
fn changed() -> Value {
    let mut plan = plan();
    plan["criteria"][1]["checks"][0]["command"] = json!("cargo test i -- --exact images_are_linked");
    plan
}

/// The same plan with a new item and check added, nothing else touched.
fn added() -> Value {
    let mut plan = plan();
    plan["criteria"].as_array_mut().unwrap().push(json!({"id": "pdf", "text": "z", "checks": [check("p", "cargo test p", "tests/p.rs")]}));
    plan
}

/// The same plan without the images item.
fn removed() -> Value {
    let mut plan = plan();
    plan["criteria"].as_array_mut().unwrap().remove(1);
    plan
}

const FILES: &[(&str, &str)] = &[("tests/a.rs", "a1"), ("tests/i.rs", "i1"), ("tests/p.rs", "p1")];
const FAILING: &str = "test it ... FAILED";
const REASON: &str = "\"i\" runs every test in the file, and one needs a GPU";

fn measured(runs: &[(&str, &str, i32, &str)]) -> Gate {
    let mut gate = Gate {
        head: Some("abc1234".into()),
        hashes: FILES.iter().map(|(path, sha)| (path.to_string(), sha.to_string())).collect(),
        ..Default::default()
    };
    for (item, name, exit, output) in runs {
        let run = Run { command: format!("cargo test {name}"), exit: *exit, output: output.to_string(), output_tail: output.to_string(), ..Default::default() };
        gate.runs.entry(item.to_string()).or_default().insert(name.to_string(), run);
    }
    gate
}

fn started(store: &Db) -> i64 {
    let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan()});
    let one = ask(store, "create", None, payload, Some(measured(&[]))).unwrap().task.number;
    let red = measured(&[("export", "a", 101, "start run a FAILED"), ("images", "i", 101, "start run i FAILED")]);
    ask(store, "start", Some(one), json!({}), Some(red)).unwrap();
    one
}

fn amend(store: &Db, number: i64, plan: Value, gate: Gate) -> Result<Outcome, TaskError> {
    ask(store, "amend", Some(number), json!({"plan": plan, "reason": REASON}), Some(gate))
}

fn owner(store: &Db, action: &str, number: i64, gate: Option<Gate>) -> Result<Outcome, TaskError> {
    tasks::apply(&store.store, &tasks::Request {
        action: action.into(),
        actor: "owner".into(),
        project: "p".into(),
        number: Some(number),
        payload: json!({}),
        gate,
        now: 2,
        ..Default::default()
    })
}

#[test]
fn an_amend_applies_at_once_and_its_checks_count_from_then() {
    let (_d, store) = task_store();
    let one = started(&store);
    let outcome = amend(&store, one, changed(), measured(&[("images", "i", 101, FAILING)])).unwrap();
    assert_eq!(outcome.task.plan, changed(), "the new plan is the task's plan at once: {}", outcome.summary);
    assert_eq!(outcome.task.pending_amend, None, "nothing waits for the owner");
    let stored = outcome.task.gate.clone().unwrap();
    assert_eq!(stored["runs"]["images"]["i"]["exit"], 101, "the amend's run is the changed check's red run: {stored}");
    assert_eq!(stored["met"]["images"], false, "{stored}");
    assert_eq!(stored["hashes"]["files"]["tests/i.rs"], "i1", "the changed check's file is locked: {stored}");
    let ticked = ask(&store, "check", Some(one), json!({"item": "images"}), Some(measured(&[("images", "i", 0, "ok")]))).unwrap();
    assert_eq!(ticked.task.gate.unwrap()["met"]["images"], true, "check runs the new check: {}", ticked.summary);
}

#[test]
fn an_amend_that_may_weaken_the_checks_applies_and_asks_the_agent_to_make_sure() {
    let (_d, store) = task_store();
    let one = started(&store);
    let outcome = amend(&store, one, changed(), measured(&[("images", "i", 101, FAILING)])).unwrap();
    assert_eq!(outcome.task.plan, changed(), "it applies even so");
    assert!(outcome.summary.contains("may weaken"), "{}", outcome.summary);
    assert!(outcome.summary.contains("changes check \"i\""), "it names the changed check: {}", outcome.summary);
    assert!(outcome.summary.contains("Make sure"), "it asks the agent to make sure: {}", outcome.summary);

    let (_d, store) = task_store();
    let one = started(&store);
    let outcome = amend(&store, one, removed(), measured(&[])).unwrap();
    assert_eq!(outcome.task.plan, removed(), "it applies even so");
    assert!(outcome.summary.contains("removes item \"images\""), "it names the removed item: {}", outcome.summary);
}

#[test]
fn an_amend_that_only_adds_says_nothing_of_weakening() {
    let (_d, store) = task_store();
    let one = started(&store);
    let outcome = amend(&store, one, added(), measured(&[("pdf", "p", 101, FAILING)])).unwrap();
    assert_eq!(outcome.task.plan, added());
    assert!(!outcome.summary.contains("weaken"), "{}", outcome.summary);
}

#[test]
fn the_owner_can_undo_the_last_plan_change() {
    let (_d, store) = task_store();
    let one = started(&store);
    amend(&store, one, changed(), measured(&[("images", "i", 101, FAILING)])).unwrap();
    let undone = owner(&store, "undo_amend", one, None).unwrap();
    assert_eq!(undone.task.plan, plan(), "the plan is as it was: {}", undone.summary);
    let stored = undone.task.gate.clone().unwrap();
    assert_eq!(stored["runs"]["images"]["i"]["outputTail"], "start run i FAILED", "the start's red run is back: {stored}");
    assert!(undone.task.pending_amend.is_none());
    assert_eq!(tasks::told_chat("owner", "undo_amend", &undone.task), Some("s1"), "the holding chat is told");
    assert_eq!(
        tasks::owner_prompt("undo_amend", &undone.task, "", &MergeState::Unknown).as_deref(),
        Some("Owner undid the plan change for task #1 \"T\": continue with the plan as it was before."),
    );
    let message = refused(owner(&store, "undo_amend", one, None));
    assert!(message.contains("no plan change to undo"), "{message}");
}
