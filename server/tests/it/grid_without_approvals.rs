//! A grid needs no owner approval, and a cell never depends on a task.
//!
//! Every grid command applies at once: a draft is a live grid, a re-draft,
//! `change`, `checks` and `template_set` change it straight away, and `na`
//! marks a cell N/A. Changed checks leave a proof stale, not gone, and
//! proving the cell again makes it fresh. A task may reference cells, and
//! many tasks may reference one cell, but creating, starting or cancelling
//! a task never changes a cell, and no grid command asks about tasks.

use atelier::workbench::grids::{self, get_cell, load, proof, search, Prints};
use atelier::workbench::store::Store;
use atelier::workbench::tasks::checks::{Gate, Run};
use crate::gaps::*;
use serde_json::json;

/// `atelier grid draft camera` by chat s1, with no `@matrix` and no owner
/// answer: columns gpu and perf with checks, rows glare and sunstar.
fn draft_camera(store: &Db) {
    let mut draft = request("draft", "agent", Some("s1"), "");
    draft.slug = None;
    draft.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test",
             "checks": [template("gpu", "cargo test {row}_gpu", &["tests/gpu.rs"])]},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark",
             "checks": [template("perf", "cargo test {row}_perf", &["tests/perf.rs"])]},
        ],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare", &["camera/glare.rs"]), found("sunstar", &["camera/sunstar.rs"])], head: Some("h1".into()) }));
    apply(store, &draft).unwrap();
}

/// A live grid camera with its order written and every cell's cases reviewed.
fn ready_camera(store: &Db) {
    draft_camera(store);
    approve_cases(store, "camera");
}

/// `atelier grid prove camera ROW COL` from chat `session`, its checks passing.
fn prove(store: &Db, session: &str, row: &str, col: &str) -> Result<grids::Outcome, atelier::workbench::tasks::TaskError> {
    let mut asked = on(request("prove", "agent", Some(session), "camera"), row, col);
    asked.payload = json!({"summary": "it works"});
    asked.checks = vec![proof::CheckResult { name: col.into(), exit: 0, ms: 1, tail: format!("CASE camera/{row}/{col}/{col} PASS - -") }];
    asked.fingerprint = Some("f1".into());
    asked.head = Some("h1".into());
    apply(store, &asked)
}

fn state(store: &Db, row: &str, col: &str) -> (String, String) {
    let cell = get_cell(store.connection(), "p", "camera", row, col).unwrap().unwrap_or_else(|| panic!("camera.{row}.{col} has no cell"));
    (cell.state, cell.step)
}

/// A task of chat s1 that references camera.glare.gpu, started (its one
/// check red). Returns its number.
fn task_on_glare_gpu(store: &Db) -> i64 {
    owner_says(store, "s1", "@task work on glare");
    let check = shell_check("unit", "cargo test glare", "FAILED", &[]);
    let payload = json!({"type": "chore", "title": "Glare", "why": "Coverage",
        "plan": {"steps": [{"id": "a", "text": "Work on glare", "checks": [check]}]},
        "cells": [{"grid": "camera", "row": "glare", "col": "gpu"}]});
    let number = ask(store, "create", None, payload, None).unwrap().task.number;
    let mut red = Gate::default();
    red.runs.entry("a".into()).or_default().insert("unit".into(),
        Run { command: "cargo test glare".into(), exit: 101, output: "FAILED".into(), output_tail: "FAILED".into(), ..Default::default() });
    ask(store, "start", Some(number), json!({}), Some(red)).unwrap();
    number
}

#[test]
fn a_drafted_grid_is_live_at_once() {
    let (_d, store) = store();
    draft_camera(&store);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(loaded.cell_checks("glare", "gpu")[0]["command"], "cargo test glare_gpu", "the draft's checks are live");
    assert_eq!(state(&store, "glare", "gpu").0, "unchecked", "the draft's cells exist with no owner answer");
}

#[test]
fn drafting_the_grid_again_applies_the_edit_at_once() {
    let (_d, store) = store();
    ready_camera(&store);
    prove(&store, "s1", "glare", "gpu").unwrap();
    let mut again = request("draft", "agent", Some("s2"), "");
    again.slug = None;
    again.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test",
                     "checks": [template("gpu", "cargo test {row}_gpu", &["tests/gpu.rs"])]}],
    });
    again.search = Some(Ok(search::Run { rows: vec![found("glare", &["camera/glare.rs"]), found("bloom", &["camera/bloom.rs"])], head: Some("h2".into()) }));
    apply(&store, &again).unwrap();
    assert_eq!(state(&store, "bloom", "gpu").0, "unchecked", "a new row has cells at once");
    assert_eq!(state(&store, "glare", "gpu").0, "proved", "a kept cell keeps its proof");
}

#[test]
fn a_change_applies_at_once() {
    let (_d, store) = store();
    ready_camera(&store);
    let mut change = request("change", "agent", Some("s1"), "camera");
    change.payload = json!({"addRows": [{"id": "bloom", "name": "Bloom", "paths": ["camera/bloom.rs"]}]});
    apply(&store, &change).unwrap();
    // A second change straight after: nothing is waiting.
    let mut again = request("change", "agent", Some("s1"), "camera");
    again.payload = json!({"removeColumns": ["perf"]});
    apply(&store, &again).unwrap();
    assert_eq!(state(&store, "bloom", "gpu").0, "unchecked");
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(loaded.columns.iter().find(|c| c.id == "perf").unwrap().retired_at.is_some(), "perf is removed at once");
}

#[test]
fn new_checks_apply_at_once_and_leave_proofs_stale_until_proved_again() {
    let (_d, store) = store();
    ready_camera(&store);
    prove(&store, "s1", "glare", "gpu").unwrap();
    prove(&store, "s1", "glare", "perf").unwrap();
    let mut checks = request("checks", "agent", Some("s1"), "camera");
    checks.payload = json!({"columns": [{"id": "gpu", "checks": [template("gpu", "cargo test {row}_gpu_v2", &["tests/gpu.rs"])]}]});
    apply(&store, &checks).unwrap();
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(loaded.cell_checks("glare", "gpu")[0]["command"], "cargo test glare_gpu_v2", "the new checks are live");
    let gpu = get_cell(store.connection(), "p", "camera", "glare", "gpu").unwrap().unwrap();
    assert_eq!(gpu.state, "proved", "the proof is kept");
    assert!(grids::is_stale("camera", &gpu, &Prints::new()), "a proof made under the old checks is stale");
    let perf = get_cell(store.connection(), "p", "camera", "glare", "perf").unwrap().unwrap();
    assert!(!grids::is_stale("camera", &perf, &Prints::new()), "a column whose checks did not change stays fresh");
    prove(&store, "s1", "glare", "gpu").unwrap();
    let gpu = get_cell(store.connection(), "p", "camera", "glare", "gpu").unwrap().unwrap();
    assert!(!grids::is_stale("camera", &gpu, &Prints::new()), "proving it under the new checks makes it fresh");
}

#[test]
fn na_is_set_at_once() {
    let (_d, store) = store();
    ready_camera(&store);
    let mut na = on(request("na", "agent", Some("s1"), "camera"), "sunstar", "perf");
    na.payload = json!({"reason": "sunstar has no frame cost"});
    apply(&store, &na).unwrap();
    assert_eq!(state(&store, "sunstar", "perf"), ("na".to_string(), "na".to_string()));
}

#[test]
fn a_template_change_applies_at_once() {
    let (_d, store) = store();
    let mut set = request("template_set", "agent", Some("s1"), "renderer");
    set.payload = json!({"columns": [{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test"}]});
    apply(&store, &set).unwrap();
    let template = grids::get_template(store.connection(), "p", "renderer").unwrap().unwrap();
    assert_eq!(template.columns.len(), 1, "the template's columns are live");
    assert!(template.pending.is_none(), "nothing waits for the owner");
}

#[test]
fn the_owner_approval_actions_are_gone() {
    let (_d, store) = store();
    ready_camera(&store);
    for action in ["approve", "discard", "approve_na", "reject_na"] {
        let mut asked = on(request(action, "owner", None, "camera"), "glare", "gpu");
        asked.payload = json!({"reason": "r"});
        refused(apply(&store, &asked));
    }
    for action in ["approve_template", "reject_template"] {
        refused(apply(&store, &request(action, "owner", None, "renderer")));
    }
}

#[test]
fn an_audit_needs_no_owner_request() {
    let (_d, store) = store();
    ready_camera(&store);
    prove(&store, "s1", "glare", "gpu").unwrap();
    let mut pass = on(request("pass", "agent", Some("s2"), "camera"), "glare", "gpu");
    pass.payload = json!({"note": "looks right"});
    apply(&store, &pass).unwrap();
    let mut own = on(request("pass", "agent", Some("s1"), "camera"), "glare", "gpu");
    own.payload = json!({});
    assert!(refused(apply(&store, &own)).contains("did not prove it"), "the chat that proved a cell still cannot pass it");
}

#[test]
fn a_task_referencing_a_cell_does_not_change_it() {
    let (_d, store) = task_store();
    ready_camera(&store);
    let before = state(&store, "glare", "gpu");
    let number = task_on_glare_gpu(&store);
    assert_eq!(state(&store, "glare", "gpu"), before, "creating and starting a task leaves its cells as they were");
    ask(&store, "cancel", Some(number), json!({"reason": "done with it"}), None).unwrap();
    assert_eq!(state(&store, "glare", "gpu"), before, "cancelling a task leaves its cells as they were");
}

#[test]
fn any_chat_proves_a_cell_a_task_references() {
    let (_d, store) = task_store();
    ready_camera(&store);
    task_on_glare_gpu(&store);
    prove(&store, "s2", "glare", "gpu").unwrap();
    assert_eq!(state(&store, "glare", "gpu").0, "proved");
}

#[test]
fn two_tasks_may_reference_the_same_cell() {
    let (_d, store) = task_store();
    ready_camera(&store);
    task_on_glare_gpu(&store);
    owner_says(&store, "s1", "@task another look at glare");
    let payload = json!({"type": "chore", "title": "Glare again", "why": "Coverage",
        "plan": {"steps": [{"id": "a", "text": "Look again", "checks": [shell_check("unit", "cargo test glare", "FAILED", &[])]}]},
        "cells": [{"grid": "camera", "row": "glare", "col": "gpu"}]});
    ask(&store, "create", None, payload, None).unwrap();
}

#[test]
fn cases_change_while_a_task_references_the_cell() {
    let (_d, store) = task_store();
    ready_camera(&store);
    task_on_glare_gpu(&store);
    let mut cases = on(request("cases", "agent", Some("s1"), "camera"), "glare", "gpu");
    cases.payload = json!({"cases": [{"id": "dark-room", "given": "a dark room", "when": "the frame renders", "then": "the glare shows",
        "command": "atelier case camera/glare/gpu/dark-room -- cargo test glare_dark_room"}]});
    apply(&store, &cases).unwrap();
}

#[test]
fn a_task_with_cells_needs_the_owners_task_like_any_task() {
    let (_d, store) = store();
    ready_camera(&store);
    let payload = json!({"type": "chore", "title": "Glare", "why": "Coverage",
        "plan": {"steps": [{"id": "a", "text": "Work on glare", "checks": [shell_check("unit", "cargo test glare", "FAILED", &[])]}]},
        "cells": [{"grid": "camera", "row": "glare", "col": "gpu"}]});
    assert!(refused(ask(&store, "create", None, payload, None)).contains("@task"), "only tasks need the owner's approval");
}

#[test]
fn next_hands_out_cells_with_no_task_payload() {
    let (_d, store) = store();
    ready_camera(&store);
    let next = grids::next_cells(store.connection(), "p", "camera", &Prints::new(), &grids::Scope::First).unwrap();
    assert!(next["create"].is_null(), "next names cells to prove, not a task to create: {next}");
    assert!(next["cells"].as_array().is_some_and(|cells| !cells.is_empty()), "{next}");
    assert_eq!(state(&store, "glare", "gpu").1, "reviewed");
    let cell = get_cell(store.connection(), "p", "camera", "glare", "gpu").unwrap().unwrap();
    assert_eq!(cell.next.as_deref(), Some("atelier grid prove camera glare gpu"), "a reviewed cell's next command proves it");
}

/// A database from before: a grid draft waiting for the owner, a cell a task
/// claimed, and a cell waiting for an N/A answer. Opening it brings each over.
#[test]
fn a_database_from_before_is_brought_over() {
    let (directory, store) = store();
    ready_camera(&store);
    let pending = json!({"title": "Lens", "area": "The lens.", "template": null,
        "rowSearch": {"command": "scripts/rows.sh", "watch": ["lens/"]},
        "columns": [{"id": "gpu", "name": "Runs on the GPU", "proofRule": "a GPU test", "fromTemplate": false,
            "checks": [{"name": "gpu", "command": "cargo test {row}_gpu", "kind": "test", "given": "g", "when": "w", "then": "t",
                "files": ["tests/gpu.rs"], "case": "lens/{row}/gpu/gpu", "red": "CASE lens/{row}/gpu/gpu FAIL"}]}],
        "cells": [], "rows": [{"id": "iris", "name": "IRIS", "kind": "feature", "paths": ["lens/iris.rs"], "of": [], "ref": null, "source": "search"}],
        "draftedBy": "s1", "draftedAt": 1, "edit": false, "diff": null, "searched": {"at": 1, "head": "h1"}});
    store.connection().execute(
        "INSERT INTO grid (project_id, slug, title, area, status, row_search, pending, created_by, drafted_by, created_at, updated_at)
         VALUES ('p', 'lens', 'Lens', 'The lens.', 'draft', ?1, ?2, 's1', 's1', 1, 1)",
        rusqlite::params![json!({"command": "scripts/rows.sh", "watch": ["lens/"]}).to_string(), pending.to_string()],
    ).unwrap();
    store.connection().execute_batch(
        "UPDATE grid_cell SET state = 'in_progress', claimed_task = 7, claimed_from = 'gap' WHERE slug = 'camera' AND row = 'glare' AND col = 'gpu';
         UPDATE grid_cell SET state = 'na_pending', reason = 'no frame cost' WHERE slug = 'camera' AND row = 'sunstar' AND col = 'perf';",
    ).unwrap();
    drop(store);
    let path = directory.path().join("workbench.db");
    let _reopened = Store::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    let lens = get_cell(&connection, "p", "lens", "iris", "gpu").unwrap();
    assert!(lens.is_some_and(|cell| cell.state == "unchecked"), "a draft that waited for the owner is a live grid");
    let glare = get_cell(&connection, "p", "camera", "glare", "gpu").unwrap().unwrap();
    assert_eq!(glare.state, "gap", "a claimed cell is back to the state it had before the claim");
    let sunstar = get_cell(&connection, "p", "camera", "sunstar", "perf").unwrap().unwrap();
    assert_eq!(sunstar.state, "na", "an N/A that waited for the owner is N/A");
}
