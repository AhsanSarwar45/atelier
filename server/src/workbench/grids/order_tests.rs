//! A grid has no default order. Before any cell is worked, an agent writes
//! the grid's order: every row and every column, in the sequence cells are
//! handed out, each with what it comes after and a reason. Cells of a row or
//! column with no order sit at step order, and nothing else is allowed for
//! them. A new order may not drop a prerequisite that is not done yet.

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

fn owner(action: &str) -> Request {
    let mut asked = request(action);
    asked.actor = "owner".into();
    asked.session = None;
    asked
}

fn found(id: &str) -> search::Found {
    search::Found { id: id.into(), name: id.to_uppercase(), paths: vec![format!("camera/{id}.rs")], kind: "feature".into(), of: Vec::new() }
}

fn template(col: &str) -> Value {
    json!([{"name": col, "command": format!("atelier case camera/{{row}}/{col}/{col} -- cargo test {{row}}_{col}"), "kind": "test",
        "given": "the {row} feature", "when": "it runs", "then": "it works"}])
}

/// An approved grid camera: rows glare and sunstar, columns gpu and perf.
fn camera(store: &Store) {
    let mut draft = request("draft");
    draft.slug = None;
    draft.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": template("gpu")},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark", "checks": template("perf")},
        ],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare"), found("sunstar")], head: Some("h1".into()) }));
    apply(store.connection(), &draft).unwrap();
    apply(store.connection(), &owner("approve")).unwrap();
}

fn order(store: &Store, payload: Value) -> Result<Outcome, TaskError> {
    let mut asked = request("order");
    asked.payload = payload;
    apply(store.connection(), &asked)
}

const WHY: &str = "it shares the pass the others build on";

fn entry(id: &str, after: &[&str]) -> Value {
    json!({"id": id, "after": after, "reason": WHY})
}

fn step(store: &Store, row: &str, col: &str) -> (String, Option<String>) {
    let cell = get_cell(store.connection(), "p", "camera", row, col).unwrap().unwrap();
    (cell.step, cell.next)
}

fn refused<T>(result: Result<T, TaskError>) -> String {
    match result {
        Err(error) => error.message().to_string(),
        Ok(_) => panic!("expected a refusal, but it was accepted"),
    }
}

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

/// No order, no work: every cell is at step order, and `grid cases`, `task
/// create` and `grid next` name `atelier grid order`.
#[test]
fn a_grid_without_an_order_refuses_cases_and_claims() {
    let (_d, store) = store();
    camera(&store);
    assert_eq!(step(&store, "glare", "gpu"), ("order".to_string(), Some("atelier grid order camera".to_string())));
    let mut asked = request("cases");
    asked.row = Some("glare".into());
    asked.col = Some("gpu".into());
    asked.payload = json!({"cases": []});
    let message = refused(apply(store.connection(), &asked));
    assert!(message.contains("no order") && message.contains("`atelier grid order camera`"), "atelier grid cases said: {message}");
    approve_all_cases(store.connection(), "p", "camera");
    clear_order(store.connection(), "p", "camera");
    let message = refused(create(&store, &[("glare", "gpu")]));
    assert!(message.contains("no order") && message.contains("`atelier grid order camera`"), "atelier task create said: {message}");
    let next = next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap();
    assert!(next["create"].is_null(), "grid next handed out a cell of an unordered grid: {next}");
    assert_eq!(next["finished"], false, "{next}");
    let text = cli::next_text(&next);
    assert!(text.contains("atelier grid order camera"), "grid next does not name the order command:\n{text}");
}

/// The order lists every row and column, each with a reason, and an `after`
/// that names only entries earlier in the list.
#[test]
fn an_order_lists_every_row_and_column_with_a_reason() {
    let (_d, store) = store();
    camera(&store);
    let columns = json!([entry("gpu", &[]), entry("perf", &["gpu"])]);
    let message = refused(order(&store, json!({"rows": [entry("glare", &[])], "columns": columns})));
    assert!(message.contains("sunstar"), "an order missing row sunstar said: {message}");
    let message = refused(order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &[])], "columns": [entry("gpu", &[])]})));
    assert!(message.contains("perf"), "an order missing column perf said: {message}");
    let message = refused(order(&store, json!({"rows": [entry("glare", &[]), {"id": "sunstar", "after": []}], "columns": columns})));
    assert!(message.contains("sunstar") && message.contains("reason"), "an entry without a reason said: {message}");
    let message = refused(order(&store, json!({"rows": [entry("glare", &[]), {"id": "sunstar", "after": [], "reason": "later"}], "columns": columns})));
    assert!(message.contains("sunstar") && message.contains("reason"), "a one-word reason said: {message}");
    let message = refused(order(&store, json!({"rows": [entry("glare", &["sunstar"]), entry("sunstar", &[])], "columns": columns})));
    assert!(message.contains("glare") && message.contains("sunstar") && message.contains("earlier"), "an after naming a later row said: {message}");
    let message = refused(order(&store, json!({"rows": [entry("glare", &[]), entry("glare", &[]), entry("sunstar", &[])], "columns": columns})));
    assert!(message.contains("glare") && message.contains("twice"), "a row listed twice said: {message}");
    assert_eq!(step(&store, "glare", "gpu").0, "order", "a refused order changes nothing");
    order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &[])], "columns": columns})).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), ("cases".to_string(), Some("atelier grid cases camera glare gpu".to_string())));
}

/// Cells are handed out in the written order, not as drawn: rows in their
/// order, and in each row the columns in theirs.
#[test]
fn cells_are_handed_out_in_the_written_order() {
    let (_d, store) = store();
    camera(&store);
    order(&store, json!({"rows": [entry("sunstar", &[]), entry("glare", &[])], "columns": [entry("perf", &[]), entry("gpu", &[])]})).unwrap();
    approve_all_cases(store.connection(), "p", "camera");
    let next = next_batch(store.connection(), "p", "camera", &Prints::new(), &Scope::First, 4).unwrap();
    let handed: Vec<String> = next["create"]["cells"].as_array().unwrap().iter()
        .map(|c| format!("{}.{}", c["row"].as_str().unwrap(), c["col"].as_str().unwrap())).collect();
    assert_eq!(handed, ["sunstar.perf", "sunstar.gpu", "glare.perf", "glare.gpu"], "grid next --batch 4 handed out {handed:?}");
}

/// A new order may add prerequisites, but not drop one that is not proved
/// or N/A, so reordering cannot skip a step.
#[test]
fn an_order_cannot_drop_a_prerequisite_that_is_not_done() {
    let (_d, store) = store();
    camera(&store);
    let columns = json!([entry("gpu", &[]), entry("perf", &[])]);
    order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &["glare"])], "columns": columns})).unwrap();
    let message = refused(order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &[])], "columns": columns})));
    assert!(message.contains("sunstar.gpu") && message.contains("glare.gpu") && message.contains("not proved or N/A"),
        "dropping sunstar after glare said: {message}");
    order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &["glare"])], "columns": [entry("gpu", &[]), entry("perf", &["gpu"])]}))
        .unwrap();
}

/// A row added after the order sits at step order until the order names it;
/// the rows already ordered keep their steps.
#[test]
fn a_row_added_later_waits_for_the_order() {
    let (_d, store) = store();
    camera(&store);
    let columns = json!([entry("gpu", &[]), entry("perf", &[])]);
    order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &[])], "columns": columns})).unwrap();
    let mut change = request("change");
    change.payload = json!({"addRows": [{"id": "bloom", "name": "Bloom", "paths": ["camera/bloom.rs"]}]});
    apply(store.connection(), &change).unwrap();
    apply(store.connection(), &owner("approve")).unwrap();
    assert_eq!(step(&store, "bloom", "gpu").0, "order");
    assert_eq!(step(&store, "glare", "gpu").0, "cases");
    order(&store, json!({"rows": [entry("glare", &[]), entry("sunstar", &[]), entry("bloom", &[])], "columns": columns})).unwrap();
    assert_eq!(step(&store, "bloom", "gpu").0, "cases");
}
