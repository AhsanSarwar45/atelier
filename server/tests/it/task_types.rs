//! Editable task types: the install's types, inherited by each project, with
//! default items every task of the type must answer. Agents create and edit
//! types with the CLI; the owner can undo a change. Every create and propose
//! gives a reason for each type it chose or declined.

use std::path::Path;

use atelier::workbench::tasks::{self, catalog::{self, Catalog}, checks::Gate, Outcome, TaskError};
use crate::gaps::*;
use serde_json::{json, Value};

const BUILT_IN: &[&str] = &[
    "bug", "feature", "ui_change", "ui_feature", "ui_bug", "render_bug", "render_change", "render_feature",
    "optimization", "plan", "investigation", "refactor", "tests", "review", "qa", "docs", "chore", "general",
];

fn check(name: &str) -> Value {
    shell_check(name, &format!("cargo test {name}"), "FAILED|panicked", &[])
}

/// A reason for every name, the chosen one first.
fn decisions(names: &[&str], chosen: &str) -> Value {
    let mut out = serde_json::Map::new();
    for name in names {
        let reason = if *name == chosen { "the change is to a screen that is there" } else { "the work is not this kind" };
        out.insert(name.to_string(), json!(reason));
    }
    Value::Object(out)
}

fn feature_plan() -> Value {
    json!({"outcome": "o", "criteria": [{"id": "a", "text": "x", "checks": [check("a")]}]})
}

fn ui_plan(requirements: Value) -> Value {
    json!({"screens": [{"id": "home", "name": "Home", "how_to_reach": "open the app", "change": "c", "checks": [check("home")]}],
        "requirements": requirements})
}

fn ask_with(store: &Db, types: &Catalog, action: &str, number: Option<i64>, payload: Value) -> Result<Outcome, TaskError> {
    tasks::apply(&store.store, &tasks::Request {
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        number,
        payload,
        gate: Some(Gate::default()),
        types: types.clone(),
        now: 1,
        ..Default::default()
    })
}

fn change(global: &Path, project: Option<&Path>, body: Value) -> String {
    catalog::change(global, project, &body).unwrap_or_else(|message| panic!("refused: {message}"))
}

fn load(global: &Path, project: Option<&Path>) -> Catalog {
    Catalog::load(global, project).unwrap()
}

fn folders() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let global = root.path().join("install");
    let project = root.path().join("project");
    std::fs::create_dir_all(&global).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    (root, global, project)
}

const API_TYPE: &str = "api_change";

fn api_type() -> Value {
    json!({"action": "create", "scope": "install", "type": {
        "name": API_TYPE, "description": "A change to an HTTP endpoint", "code": true, "review": false,
        "items": [{"id": "bad-input", "text": "Bad input gets a 4xx with a clear message"}]}})
}

/// Declined answers for a type's built-in default items other than `keep`,
/// for a test about other items.
fn decline_built_in(name: &str, keep: &[&str]) -> Vec<Value> {
    let kind = atelier::workbench::tasks::types::find(name).unwrap();
    kind.items.iter().filter(|(id, _)| !keep.contains(id))
        .map(|(id, text)| json!({"id": id, "text": text, "declined": "not what this test is about"}))
        .collect()
}

// --- catalog: inheritance -------------------------------------------------

#[test]
fn a_project_inherits_the_install_types_and_can_turn_one_off() {
    let (_root, global, project) = folders();
    change(&global, None, api_type());
    let inherited = load(&global, Some(&project));
    for name in BUILT_IN.iter().copied().chain([API_TYPE]) {
        assert!(inherited.names().contains(&name.to_string()), "{name} is inherited: {:?}", inherited.names());
    }
    change(&global, Some(&project), json!({"action": "disable", "scope": "project", "name": "render_change"}));
    let names = load(&global, Some(&project)).names();
    assert!(!names.contains(&"render_change".to_string()), "turned off in the project: {names:?}");
    assert!(load(&global, None).names().contains(&"render_change".to_string()), "still on for the install");
}

#[test]
fn a_project_adds_its_own_items_and_turns_inherited_items_off() {
    let (_root, global, project) = folders();
    // chore has no built-in items, so the list is only what this test sets.
    change(&global, None, json!({"action": "edit", "scope": "install", "name": "chore",
        "items": [{"id": "existing-components", "text": "Uses the app's existing components"},
                  {"id": "long-text", "text": "Long text does not break the layout"}]}));
    change(&global, Some(&project), json!({"action": "edit", "scope": "project", "name": "chore",
        "items": [{"id": "phone", "text": "Fits a 390 pixel wide screen"}]}));
    change(&global, Some(&project), json!({"action": "disable", "scope": "project", "name": "chore", "item": "long-text"}));
    let items = load(&global, Some(&project)).items("chore");
    assert_eq!(items, vec!["existing-components".to_string(), "phone".to_string()], "inherited, minus the one turned off, plus the project's own");
}

// --- edit: agents change types with the CLI, the owner can undo --------------

#[test]
fn an_agent_creates_a_type_and_the_owner_can_undo_the_change() {
    let (_root, global, project) = folders();
    let summary = change(&global, Some(&project), json!({"action": "create", "scope": "project", "type": {
        "name": "migration", "description": "A change to stored data", "code": true, "review": true, "items": []}}));
    assert!(summary.contains("migration"), "the change is named back: {summary}");
    assert!(load(&global, Some(&project)).names().contains(&"migration".to_string()));
    let undone = catalog::undo(&global, Some(&project), "project").unwrap();
    assert!(undone.contains("migration"), "{undone}");
    assert!(!load(&global, Some(&project)).names().contains(&"migration".to_string()), "the change is undone");
}

#[test]
fn a_built_in_type_cannot_be_removed_or_reshaped() {
    let (_root, global, _project) = folders();
    let message = catalog::change(&global, None, &json!({"action": "create", "scope": "install", "type": {
        "name": "bug", "description": "d", "code": false, "review": false, "items": []}})).unwrap_err();
    assert!(message.contains("built-in"), "{message}");
}

// --- decisions: a reason for every type -------------------------------------

#[test]
fn create_is_refused_until_every_type_has_a_reason() {
    let (_d, store) = task_store();
    let types = Catalog::default();
    let mut partial = decisions(BUILT_IN, "feature");
    partial.as_object_mut().unwrap().remove("refactor");
    let message = refused(ask_with(&store, &types, "create", None,
        json!({"type": "feature", "title": "T", "why": "W", "plan": feature_plan(), "decisions": partial})));
    assert!(message.contains("refactor"), "the missing type is named: {message}");

    let mut blank = decisions(BUILT_IN, "feature");
    blank["docs"] = json!("  ");
    let message = refused(tasks::propose(&store.store, "p", "s1",
        &json!({"type": "feature", "title": "T", "why": "W", "plan": feature_plan(), "decisions": blank}),
        &atelier::workbench::grids::Prints::new(), None, 1, &types));
    assert!(message.contains("docs"), "the blank reason is named: {message}");

    let made = ask_with(&store, &types, "create", None,
        json!({"type": "feature", "title": "T", "why": "W", "plan": feature_plan(), "decisions": decisions(BUILT_IN, "feature")})).unwrap();
    assert_eq!(made.task.decisions["feature"], "the change is to a screen that is there", "the reasons are kept on the task");
}

#[test]
fn a_type_turned_off_need_not_be_listed() {
    let (_root, global, project) = folders();
    change(&global, Some(&project), json!({"action": "disable", "scope": "project", "name": "render_change"}));
    let types = load(&global, Some(&project));
    let names: Vec<&str> = BUILT_IN.iter().copied().filter(|name| *name != "render_change").collect();
    let (_d, store) = task_store();
    let mut plan = feature_plan();
    plan["requirements"] = json!(decline_built_in("feature", &[]));
    ask_with(&store, &types, "create", None,
        json!({"type": "feature", "title": "T", "why": "W", "plan": plan, "decisions": decisions(&names, "feature")})).unwrap();
}

// --- defaults: a type's items must be answered -------------------------------

fn with_ui_items(global: &Path) -> Catalog {
    change(global, None, json!({"action": "edit", "scope": "install", "name": "ui_change",
        "items": [{"id": "existing-components", "text": "Uses the app's existing components"},
                  {"id": "long-text", "text": "Long text does not break the layout"}]}));
    load(global, None)
}

#[test]
fn a_types_default_items_must_each_have_checks_or_a_reason() {
    let (_root, global, _project) = folders();
    let types = with_ui_items(&global);
    let (_d, store) = task_store();
    let payload = |requirements: Value| json!({"type": "ui_change", "title": "T", "why": "W",
        "plan": ui_plan(requirements), "decisions": decisions(BUILT_IN, "ui_change")});

    let message = refused(ask_with(&store, &types, "create", None,
        payload(json!([{"id": "existing-components", "text": "Uses the app's existing components", "checks": [check("reuse")]}]))));
    assert!(message.contains("long-text"), "the missing default item is named: {message}");

    let message = refused(ask_with(&store, &types, "create", None, payload(json!([
        {"id": "existing-components", "text": "Uses the app's existing components", "checks": [check("reuse")]},
        {"id": "long-text", "text": "Long text does not break the layout", "declined": " "}]))));
    assert!(message.contains("long-text"), "a blank reason is refused: {message}");

    let mut answered = vec![
        json!({"id": "existing-components", "text": "Uses the app's existing components", "checks": [check("reuse")]}),
        json!({"id": "long-text", "text": "Long text does not break the layout", "declined": "the screen shows no user text"})];
    answered.extend(decline_built_in("ui_change", &["existing-components"]));
    ask_with(&store, &types, "create", None, payload(json!(answered))).unwrap();
}

#[test]
fn a_task_keeps_the_items_it_was_created_with() {
    let (_root, global, _project) = folders();
    let (_d, store) = task_store();
    let made = ask_with(&store, &Catalog::default(), "create", None, json!({"type": "ui_change", "title": "T", "why": "W",
        "plan": ui_plan(json!([])), "decisions": decisions(BUILT_IN, "ui_change")})).unwrap();
    let types = with_ui_items(&global);
    let mut plan = made.task.plan.clone();
    plan["screens"][0]["change"] = json!("a clearer change");
    ask_with(&store, &types, "amend", Some(made.task.number), json!({"plan": plan, "reason": "the change was unclear"}))
        .unwrap_or_else(|error| panic!("an item added to the type later is not asked of this task: {error:?}"));
}

// --- custom: tasks of a type an agent made -----------------------------------

#[test]
fn a_task_of_a_custom_type_is_planned_like_general_and_listed_in_decisions() {
    let (_root, global, _project) = folders();
    change(&global, None, api_type());
    let types = load(&global, None);
    let names: Vec<&str> = BUILT_IN.iter().copied().chain([API_TYPE]).collect();
    let (_d, store) = task_store();
    let plan = json!({"outcome": "o", "done_when": [{"id": "route", "text": "x", "checks": [check("route")]}],
        "requirements": [{"id": "bad-input", "text": "Bad input gets a 4xx with a clear message", "checks": [check("bad")]}]});

    let message = refused(ask_with(&store, &types, "create", None,
        json!({"type": "feature", "title": "T", "why": "W", "plan": feature_plan(), "decisions": decisions(BUILT_IN, "feature")})));
    assert!(message.contains(API_TYPE), "the custom type needs a reason too: {message}");

    let made = ask_with(&store, &types, "create", None,
        json!({"type": API_TYPE, "title": "T", "why": "W", "plan": plan, "decisions": decisions(&names, API_TYPE)})).unwrap();
    assert_eq!(made.task.kind, API_TYPE);
}

// --- grid: a task the owner makes from grid cells gets the type's items ------

/// The camera grid (rows glare, sunstar; columns gpu, perf) with an approved
/// check on both columns, so every cell can be picked.
fn grid_with_checks(store: &Db) {
    grid_without_checks(store, "camera");
    let mut asked = request("checks", "agent", Some("s1"), "camera");
    asked.payload = json!({"columns": [
        {"id": "gpu", "checks": [template("gpu", "cargo test --test gpu_{row}", &["tests/gpu_{row}.rs"])]},
        {"id": "perf", "checks": [template("perf", "cargo bench {row}", &["benches/{row}.rs"])]},
    ]});
    asked.hashes = Some(json!({"files": {}}));
    apply(store, &asked).unwrap();
    apply(store, &request("approve", "owner", None, "camera")).unwrap();
}

#[test]
fn a_task_the_owner_makes_from_a_grid_gets_the_types_items_and_waits_for_their_checks() {
    let (_root, global, _project) = folders();
    change(&global, None, json!({"action": "edit", "scope": "install", "name": "general", "items": [
        {"id": "lint", "text": "Lint passes", "checks": [check("lint")]},
        {"id": "long-text", "text": "Long text does not break the layout"}]}));
    let types = load(&global, None);
    let (_d, store) = store();
    grid_with_checks(&store);
    let pick = atelier::workbench::grids::Pick::parse(&json!({"slug": "camera", "rows": ["glare"], "cols": "*", "onlyGaps": false})).unwrap();
    let (task, _, _) = tasks::create_from_pick(&store.store, "p", "s1", &pick, &atelier::workbench::grids::Prints::new(), None, 5, &types).unwrap();
    let requirements = task.plan["requirements"].as_array().cloned().unwrap_or_default();
    let ids: Vec<&str> = requirements.iter().filter_map(|item| item["id"].as_str()).collect();
    assert_eq!(ids, ["lint", "long-text"], "the type's items are on the task: {}", task.plan);
    assert_eq!(requirements[0]["checks"][0]["name"], "lint", "an item's own checks are copied in");
    let message = refused(ask_with(&store, &types, "start", Some(task.number), json!({})));
    assert!(message.contains("long-text"), "start waits until the item has checks or a reason: {message}");
}
