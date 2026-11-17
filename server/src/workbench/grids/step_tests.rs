//! Cell steps: every cell stores where it is (open → red → work → proved,
//! or N/A), every reply names the step and the one command that moves it
//! on, and the server refuses anything out of order with that same step and
//! command. A cell may also wait on named cells in any row
//! (`grid order` `cells`), and every command that claims, starts, proves or
//! ticks it refuses while those are not proved or N/A.

use super::*;
use crate::workbench::store::Store;
use crate::workbench::tasks;

fn store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("workbench.db")).unwrap();
    store.open_message("s1", "m0", "user", "2026-01-01T00:00:00Z").unwrap();
    store.grow_message("s1", "m0", "@matrix the camera area").unwrap();
    (directory, store)
}

fn request(action: &str) -> Request {
    Request {
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        slug: Some("camera".into()),
        now: 1,
        ..Default::default()
    }
}

fn found(id: &str) -> search::Found {
    search::Found { id: id.into(), name: id.to_uppercase(), paths: vec![format!("camera/{id}.rs")], kind: "feature".into(), of: Vec::new() }
}

/// An approved grid camera: rows glare and sunstar, columns gpu and perf, each with a check.
fn camera(store: &Store) {
    let check = |name: &str| json!([{"name": name, "command": format!("cargo test {{row}}_{name}"), "kind": "test",
        "given": "g", "when": "w", "then": "t"}]);
    let mut draft = request("draft");
    draft.slug = None;
    draft.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": check("gpu")},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark", "checks": check("perf")},
        ],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare"), found("sunstar")], head: Some("h1".into()) }));
    apply(store.connection(), &draft).unwrap();
    let mut approve = request("approve");
    approve.actor = "owner".into();
    approve.session = None;
    apply(store.connection(), &approve).unwrap();
    super::approve_all_cases(store.connection(), "p", "camera");
}

fn refused<T>(result: Result<T, TaskError>) -> String {
    match result {
        Err(error) => error.message().to_string(),
        Ok(_) => panic!("expected a refusal, but it was accepted"),
    }
}

fn step(store: &Store, row: &str, col: &str) -> String {
    store
        .connection()
        .query_row(
            "SELECT step FROM grid_cell WHERE project_id = 'p' AND slug = 'camera' AND row = ?1 AND col = ?2",
            params![row, col],
            |found| found.get(0),
        )
        .unwrap_or_else(|error| panic!("grid_cell has no stored step for camera.{row}.{col}: {error}"))
}

/// `atelier grid order camera` with these cell prerequisites: every row and
/// column as drawn, and each entry with a reason.
fn order(store: &Store, mut payload: Value) -> Result<Outcome, TaskError> {
    let why = "it shares the pass the others build on";
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    payload["rows"] = loaded.rows.iter().filter(|row| row.counts()).map(|row| json!({"id": row.id, "after": [], "reason": why})).collect();
    payload["columns"] = loaded.columns.iter().map(|col| json!({"id": col.id, "after": [], "reason": why})).collect();
    for cell in payload["cells"].as_array_mut().into_iter().flatten() {
        cell["reason"] = json!(why);
    }
    let mut asked = request("order");
    asked.payload = payload;
    apply(store.connection(), &asked)
}

fn prove(store: &Store, row: &str, col: &str) -> Result<Outcome, TaskError> {
    let mut asked = request("prove");
    asked.row = Some(row.into());
    asked.col = Some(col.into());
    asked.payload = json!({"summary": "it works"});
    asked.checks = vec![proof::CheckResult { name: col.into(), exit: 0, ms: 1, tail: format!("CASE camera/{row}/{col}/{col} PASS - -") }];
    asked.fingerprint = Some("f1".into());
    asked.head = Some("h1".into());
    apply(store.connection(), &asked)
}

/// `atelier task create` for these cells, with the payload `grid next` prints
/// (one item per cell, id `ROW.COL`, the cell's approved checks).
fn create(store: &Store, cells: &[(&str, &str)]) -> Result<tasks::Outcome, TaskError> {
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let picked: Vec<(String, String)> = cells.iter().map(|(row, col)| (row.to_string(), col.to_string())).collect();
    let label = Label { name: None, count: picked.len(), noun: "cell", shaped: false };
    let payload = task_payload(&loaded, &picked, &label);
    tasks::apply(store, &tasks::Request {
        action: "create".into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        payload: tasks::decided(payload),
        cwd: Some("/repo".into()),
        now: 2,
        ..Default::default()
    })
}

fn task(store: &Store, action: &str, number: i64, payload: Value) -> Result<tasks::Outcome, TaskError> {
    let held = tasks::get(store.connection(), "p", number).unwrap();
    tasks::apply(store, &tasks::Request {
        gate: tasks::gate::tests::simulated(held.as_ref(), action),
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        number: Some(number),
        payload,
        cwd: Some("/repo".into()),
        now: 3,
        ..Default::default()
    })
}

fn handed(next: &Value) -> Vec<String> {
    next["create"]["cells"]
        .as_array()
        .map(|cells| cells.iter().map(|c| format!("{}.{}", c["row"].as_str().unwrap(), c["col"].as_str().unwrap())).collect())
        .unwrap_or_default()
}

/// Rule 1: each cell's step is stored, and moves approved → red → work → proved.
#[test]
fn a_cell_stores_its_step_as_it_moves() {
    let (_d, store) = store();
    camera(&store);
    assert_eq!(step(&store, "glare", "gpu"), "approved");
    let number = create(&store, &[("glare", "gpu")]).unwrap().task.number;
    assert_eq!(step(&store, "glare", "gpu"), "red", "a claimed cell waits for its task to start");
    task(&store, "start", number, json!({})).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "work", "a started task's cell is being worked");
    prove(&store, "glare", "gpu").unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "proved");
}

/// Rule 1: every grid and task reply names the cell's step and the next command.
#[test]
fn every_reply_names_the_cells_step_and_next_command() {
    let (_d, store) = store();
    camera(&store);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let shown = cell_json(loaded.cell("glare", "gpu").unwrap(), false, true);
    assert_eq!((shown["step"].as_str(), shown["next"].as_str()), (Some("approved"), Some("atelier grid next camera")), "grid show: {shown}");
    let created = create(&store, &[("glare", "gpu")]).unwrap();
    let number = created.task.number;
    let wanted = format!("camera.glare.gpu: step red, next `atelier task start {number}`");
    assert!(created.summary.contains(&wanted), "task create says {:?}, not {wanted:?}", created.summary);
    let started = task(&store, "start", number, json!({})).unwrap();
    let wanted = "camera.glare.gpu: step work, next `atelier grid prove camera glare gpu`";
    assert!(started.summary.contains(wanted), "task start says {:?}, not {wanted:?}", started.summary);
    let proved = prove(&store, "glare", "gpu").unwrap();
    let wanted = format!("camera.glare.gpu: step proved, next `atelier task check {number} glare.gpu`");
    assert!(proved.summary.contains(&wanted), "grid prove says {:?}, not {wanted:?}", proved.summary);
}

/// Rule 1: `grid prove` on a cell no started task holds is refused with its step and the next command.
#[test]
fn prove_is_refused_for_a_cell_no_started_task_holds() {
    let (_d, store) = store();
    camera(&store);
    let message = refused(prove(&store, "glare", "gpu"));
    assert!(
        message.contains("camera.glare.gpu is at step approved; prove needs step work. Next: `atelier grid next camera`"),
        "atelier grid prove camera glare gpu (unclaimed) said: {message}"
    );
    let number = create(&store, &[("glare", "gpu")]).unwrap().task.number;
    let message = refused(prove(&store, "glare", "gpu"));
    assert!(
        message.contains(&format!("camera.glare.gpu is at step red; prove needs step work. Next: `atelier task start {number}`")),
        "atelier grid prove camera glare gpu (task not started) said: {message}"
    );
    assert_eq!(step(&store, "glare", "gpu"), "red", "a refused prove changes nothing");
}

/// Rule 5: `grid order` takes cell prerequisites in any row, and `grid next` holds the cell back.
#[test]
fn order_takes_cell_prerequisites_and_next_holds_the_cell_back() {
    let (_d, store) = store();
    camera(&store);
    order(&store, json!({"cells": [{"row": "sunstar", "col": "gpu", "after": [["glare", "perf"]]}]})).unwrap();
    let next = next_batch(store.connection(), "p", "camera", &Prints::new(), &Scope::First, 4).unwrap();
    assert_eq!(handed(&next), ["glare.gpu", "glare.perf", "sunstar.perf"], "sunstar.gpu waits for glare.perf: {next}");
    let waiting = next["waiting"].as_array().cloned().unwrap_or_default();
    let held = waiting.iter().find(|c| c["row"] == "sunstar" && c["col"] == "gpu").unwrap_or_else(|| panic!("sunstar.gpu is not waiting: {next}"));
    assert_eq!(held["after"], json!(["glare.perf"]), "{next}");
}

/// Rule 5: `grid order` refuses a cell prerequisite that names no cell, or makes a cycle.
#[test]
fn order_refuses_unknown_cells_and_cycles_in_cell_prerequisites() {
    let (_d, store) = store();
    camera(&store);
    let message = refused(order(&store, json!({"cells": [{"row": "sunstar", "col": "gpu", "after": [["lens", "perf"]]}]})));
    assert!(message.contains("lens.perf is not a cell of camera"), "atelier grid order camera (unknown cell) said: {message}");
    let message = refused(order(&store, json!({"cells": [
        {"row": "sunstar", "col": "gpu", "after": [["glare", "perf"]]},
        {"row": "glare", "col": "perf", "after": [["sunstar", "gpu"]]},
    ]})));
    assert!(message.contains("cycle"), "atelier grid order camera (cycle) said: {message}");
}

/// Rule 5: `task create` refuses a cell whose prerequisites are not proved or N/A.
#[test]
fn task_create_refuses_a_cell_whose_prerequisites_are_not_done() {
    let (_d, store) = store();
    camera(&store);
    order(&store, json!({"cells": [{"row": "sunstar", "col": "gpu", "after": [["glare", "perf"]]}]})).unwrap();
    let message = refused(create(&store, &[("sunstar", "gpu")]));
    assert!(
        message.contains("camera.sunstar.gpu waits for camera.glare.perf, which is not proved or N/A. Next: `atelier grid next camera`"),
        "atelier task create (cells sunstar.gpu) said: {message}"
    );
    assert_eq!(step(&store, "sunstar", "gpu"), "approved", "a refused create claims nothing");
}

/// Rule 5: `task start` refuses a task holding a cell whose prerequisites are not done.
#[test]
fn task_start_refuses_a_cell_whose_prerequisites_are_not_done() {
    let (_d, store) = store();
    camera(&store);
    let number = create(&store, &[("sunstar", "gpu")]).unwrap().task.number;
    order(&store, json!({"cells": [{"row": "sunstar", "col": "gpu", "after": [["glare", "perf"]]}]})).unwrap();
    let message = refused(task(&store, "start", number, json!({})));
    assert!(
        message.contains("camera.sunstar.gpu waits for camera.glare.perf, which is not proved or N/A"),
        "atelier task start {number} said: {message}"
    );
    assert_eq!(step(&store, "sunstar", "gpu"), "red", "a refused start leaves the cell at red");
}

/// Rule 5: `grid prove` refuses a cell whose prerequisites are not done.
#[test]
fn prove_refuses_a_cell_whose_prerequisites_are_not_done() {
    let (_d, store) = store();
    camera(&store);
    let number = create(&store, &[("sunstar", "gpu")]).unwrap().task.number;
    task(&store, "start", number, json!({})).unwrap();
    order(&store, json!({"cells": [{"row": "sunstar", "col": "gpu", "after": [["glare", "perf"]]}]})).unwrap();
    let message = refused(prove(&store, "sunstar", "gpu"));
    assert!(
        message.contains("camera.sunstar.gpu waits for camera.glare.perf, which is not proved or N/A"),
        "atelier grid prove camera sunstar gpu said: {message}"
    );
    assert_eq!(step(&store, "sunstar", "gpu"), "work");
}

/// Rule 5: `task check` refuses a cell's item while the cell's prerequisites are not done.
#[test]
fn task_check_refuses_a_cell_item_whose_prerequisites_are_not_done() {
    let (_d, store) = store();
    camera(&store);
    let number = create(&store, &[("sunstar", "gpu")]).unwrap().task.number;
    task(&store, "start", number, json!({})).unwrap();
    order(&store, json!({"cells": [{"row": "sunstar", "col": "gpu", "after": [["glare", "perf"]]}]})).unwrap();
    let message = refused(task(&store, "check", number, json!({"item": "sunstar.gpu"})));
    assert!(
        message.contains("camera.sunstar.gpu waits for camera.glare.perf, which is not proved or N/A"),
        "atelier task check {number} sunstar.gpu said: {message}"
    );
}
