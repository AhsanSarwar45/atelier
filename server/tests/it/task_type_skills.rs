//! A task type can name the skills an agent should read before it works a
//! task of that type, like `ui-copy` for the UI types. The install sets them,
//! a project can change them, the owner can undo the change, and creating a
//! task tells the agent which skills to read.

use std::path::Path;

use atelier::workbench::tasks::{self, catalog::{self, Catalog}, checks::Gate, Outcome, TaskError};
use crate::gaps::*;
use serde_json::{json, Value};

fn folders() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let (global, project) = (root.path().join("install"), root.path().join("project"));
    std::fs::create_dir_all(&global).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    (root, global, project)
}

fn change(global: &Path, project: Option<&Path>, body: Value) -> String {
    catalog::change(global, project, &body).unwrap_or_else(|message| panic!("refused: {message}"))
}

/// The skills the listing gives a type.
fn skills(catalog: &Catalog, name: &str) -> Vec<String> {
    let listing = catalog.listing();
    let kind = listing["types"].as_array().unwrap().iter().find(|kind| kind["name"] == name).cloned().unwrap_or_default();
    kind["skills"].as_array().map(|list| list.iter().filter_map(|id| id.as_str().map(str::to_string)).collect())
        .unwrap_or_else(|| panic!("no skills in the listing for {name}: {kind}"))
}

#[test]
fn a_type_names_skills_and_a_project_can_change_them() {
    let (_root, global, project) = folders();
    change(&global, None, json!({"action": "edit", "scope": "install", "name": "ui_feature", "skills": ["ui-copy", "web-qa"]}));
    assert_eq!(skills(&Catalog::load(&global, Some(&project)).unwrap(), "ui_feature"), ["ui-copy", "web-qa"], "the project inherits the install's skills");

    change(&global, Some(&project), json!({"action": "edit", "scope": "project", "name": "ui_feature", "skills": ["ui-copy"]}));
    assert_eq!(skills(&Catalog::load(&global, Some(&project)).unwrap(), "ui_feature"), ["ui-copy"], "the project's own list wins");
    assert_eq!(skills(&Catalog::load(&global, None).unwrap(), "ui_feature"), ["ui-copy", "web-qa"], "the install keeps its list");

    catalog::undo(&global, Some(&project), "project").unwrap();
    assert_eq!(skills(&Catalog::load(&global, Some(&project)).unwrap(), "ui_feature"), ["ui-copy", "web-qa"], "undo puts the install's list back");
}

#[test]
fn a_skill_must_be_named_by_its_id() {
    let (_root, global, _project) = folders();
    let refused = catalog::change(&global, None, &json!({"action": "edit", "scope": "install", "name": "bug", "skills": ["Not a skill id!"]}));
    let message = refused.err().unwrap_or_else(|| "accepted".into());
    assert!(message.contains("Not a skill id!"), "a bad skill id was not refused by name: {message}");
}

fn create(store: &Db, types: &Catalog) -> Result<Outcome, TaskError> {
    let names = types.names();
    let decisions: serde_json::Map<String, Value> = names.iter()
        .map(|name| (name.clone(), json!(if name == "bug" { "wrong behaviour with nothing to see" } else { "not this kind" })))
        .collect();
    let requirements: Vec<Value> = types.find("bug").unwrap().items.iter()
        .map(|item| json!({"id": item["id"], "text": item["text"], "declined": "not what this test is about"}))
        .collect();
    tasks::apply(&store.store, &tasks::Request {
        action: "create".into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        payload: json!({"type": "bug", "title": "T", "why": "W", "decisions": decisions, "plan": {
            "symptom": "s", "repro_steps": ["r"], "expected": "e", "actual": "a",
            "checks": [shell_check("repro", "cargo test repro", "FAILED", &[])], "requirements": requirements}}),
        gate: Some(Gate::default()),
        types: types.clone(),
        now: 1,
        ..Default::default()
    })
}

#[test]
fn creating_a_task_tells_the_agent_which_skills_to_read() {
    let (_root, global, _project) = folders();
    change(&global, None, json!({"action": "edit", "scope": "install", "name": "bug", "skills": ["web-bug-fix"]}));
    let (_d, store) = task_store();
    let made = create(&store, &Catalog::load(&global, None).unwrap()).unwrap_or_else(|error| panic!("create refused: {error:?}"));
    assert!(made.summary.contains("web-bug-fix"), "the reply does not name the skill to read: {}", made.summary);
}
