//! The owner can answer a proposal with Request changes and a note. The
//! proposal closes, and the chat's agent is told the note and to propose
//! again.

use atelier::workbench::grids::Prints;
use atelier::workbench::tasks::{self, catalog::Catalog};
use crate::gaps::*;
use serde_json::{json, Value};

fn proposed(store: &Db) -> i64 {
    let types = Catalog::default();
    let requirements: Vec<Value> = types.find("bug").unwrap().items.iter()
        .map(|item| json!({"id": item["id"], "text": item["text"], "declined": "not what this test is about"}))
        .collect();
    let plan = json!({"symptom": "s", "repro_steps": ["r"], "expected": "e", "actual": "a",
        "checks": [shell_check("repro", "cargo test repro", "FAILED", &[])], "requirements": requirements});
    let payload = decided(json!({"type": "bug", "title": "T", "why": "W", "plan": plan}));
    let (proposal, _) = tasks::propose(&store.store, "p", "s1", &payload, &Prints::new(), None, 1, &types)
        .unwrap_or_else(|error| panic!("propose refused: {error:?}"));
    proposal.id
}

#[test]
fn asking_for_changes_tells_the_agent_the_note() {
    let (_d, store) = task_store();
    let id = proposed(&store);
    let note = "The LOD chain must work for any grass type, not one task per species";
    let answered = tasks::request_changes(&store.store, "p", id, note, 2).unwrap_or_else(|error| panic!("refused: {error:?}"));
    assert_eq!((answered.status.as_str(), answered.decided_at), ("changes_requested", Some(2)));
    let prompt = tasks::answer_prompt(&answered);
    assert!(prompt.contains(note), "the agent is not told the note: {prompt}");
    assert!(prompt.contains("atelier task propose"), "the agent is not told to propose again: {prompt}");
    assert!(tasks::pending_proposals(store.connection(), "s1").unwrap().is_empty(), "the proposal still waits");
    let again = tasks::answer_proposal(&store.store, "p", id, "create", &Prints::new(), None, 3);
    assert!(refused(again).contains("already answered"), "a proposal sent back can still be made a task");
}

#[test]
fn a_change_request_needs_a_note() {
    let (_d, store) = task_store();
    let id = proposed(&store);
    let message = refused(tasks::request_changes(&store.store, "p", id, "  ", 2));
    assert!(message.contains("note"), "an empty note was not refused: {message}");
    assert_eq!(tasks::get_proposal(store.connection(), "p", id).unwrap().unwrap().status, "pending");
}
