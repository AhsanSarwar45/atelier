//! `grid next` hands out one cell at a time, in the grid's order: rows as
//! drawn, columns by position, and a row or column may name what must come
//! first (`after`). A cell whose prerequisites are not proved or N/A waits.
//! `--batch N` hands out up to N ready cells in that order.

use atelier::workbench::grids::{self, cli::{next_exit, next_text}, next_batch, next_cells, Prints, Scope};
use crate::gaps::*;
use serde_json::{json, Value};

/// The camera grid (rows glare, sunstar; columns gpu, perf) with an approved
/// check on both columns, so every cell can be claimed.
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

fn prove(store: &Db, row: &str, col: &str) {
    let mut prove = on(request("prove", "agent", Some("s1"), "camera"), row, col);
    prove.payload = json!({"summary": "s"});
    prove.checks = vec![grids::proof::CheckResult { name: col.into(), exit: 0, ms: 1, tail: String::new() }];
    prove.fingerprint = Some("f".into());
    apply(store, &prove).unwrap();
}

fn order(store: &Db, payload: Value) -> Result<grids::Outcome, atelier::workbench::tasks::TaskError> {
    let mut asked = request("order", "agent", Some("s1"), "camera");
    asked.payload = payload;
    apply(store, &asked)
}

fn handed(next: &Value) -> Vec<String> {
    next["create"]["cells"]
        .as_array()
        .map(|cells| cells.iter().map(|c| format!("{}.{}", c["row"].as_str().unwrap(), c["col"].as_str().unwrap())).collect())
        .unwrap_or_default()
}

fn next(store: &Db) -> Value {
    next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap()
}

#[test]
fn next_hands_out_one_cell_in_drawn_order() {
    let (_d, store) = store();
    grid_with_checks(&store);
    let first = next(&store);
    assert_eq!(handed(&first), ["glare.gpu"], "one cell, the first in drawn order: {first}");
    assert_eq!(first["claimable"].as_array().map(Vec::len), Some(1), "{first}");
    assert_eq!(first["create"]["plan"]["done_when"].as_array().map(Vec::len), Some(1), "{first}");
    prove(&store, "glare", "gpu");
    assert_eq!(handed(&next(&store)), ["glare.perf"], "then the next cell along the row");
    prove(&store, "glare", "perf");
    assert_eq!(handed(&next(&store)), ["sunstar.gpu"], "then the next row");
}

#[test]
fn a_cell_waits_for_the_cells_its_column_or_row_comes_after() {
    let (_d, store) = store();
    grid_with_checks(&store);
    order(&store, json!({"columns": [{"id": "gpu", "after": ["perf"]}]})).unwrap();
    let first = next(&store);
    assert_eq!(handed(&first), ["glare.perf"], "glare.gpu waits for glare.perf: {first}");
    let waiting = first["waiting"].as_array().cloned().unwrap_or_default();
    let glare_gpu = waiting.iter().find(|c| c["row"] == "glare" && c["col"] == "gpu").unwrap_or_else(|| panic!("glare.gpu is not listed as waiting: {first}"));
    assert_eq!(glare_gpu["after"], json!(["glare.perf"]), "{first}");
    prove(&store, "glare", "perf");
    assert_eq!(handed(&next(&store)), ["glare.gpu"], "once glare.perf is proved, glare.gpu is ready");

    order(&store, json!({"rows": [{"id": "glare", "after": ["sunstar"]}], "columns": [{"id": "gpu", "after": []}]})).unwrap();
    // glare.gpu now waits for sunstar.gpu, which nothing holds back.
    assert_eq!(handed(&next(&store)), ["sunstar.gpu"], "a row's after holds back its cells until the same column of that row is done");
}

#[test]
fn order_refuses_unknown_ids_and_cycles() {
    let (_d, store) = store();
    grid_with_checks(&store);
    assert!(refused(order(&store, json!({"columns": [{"id": "lens", "after": ["gpu"]}]}))).contains("lens"));
    assert!(refused(order(&store, json!({"columns": [{"id": "gpu", "after": ["lens"]}]}))).contains("lens"));
    assert!(refused(order(&store, json!({"rows": [{"id": "glare", "after": ["nope"]}]}))).contains("nope"));
    let cycle = refused(order(&store, json!({"columns": [{"id": "gpu", "after": ["perf"]}, {"id": "perf", "after": ["gpu"]}]})));
    assert!(cycle.contains("cycle"), "{cycle}");
    assert_eq!(handed(&next(&store)), ["glare.gpu"], "a refused order changes nothing");
}

#[test]
fn batch_hands_out_up_to_n_ready_cells_in_order() {
    let (_d, store) = store();
    grid_with_checks(&store);
    let three = next_batch(store.connection(), "p", "camera", &Prints::new(), &Scope::First, 3).unwrap();
    assert_eq!(handed(&three), ["glare.gpu", "glare.perf", "sunstar.gpu"], "{three}");
    order(&store, json!({"columns": [{"id": "gpu", "after": ["perf"]}]})).unwrap();
    let ready = next_batch(store.connection(), "p", "camera", &Prints::new(), &Scope::First, 4).unwrap();
    assert_eq!(handed(&ready), ["glare.perf", "sunstar.perf"], "waiting cells stay out of a batch: {ready}");
    let row = next_batch(store.connection(), "p", "camera", &Prints::new(), &Scope::Row("sunstar".into()), 4).unwrap();
    assert_eq!(handed(&row), ["sunstar.perf"], "a batch keeps to the named row: {row}");
}

#[test]
fn next_says_what_cells_wait_for_when_none_is_ready() {
    let (_d, store) = store();
    grid_with_checks(&store);
    // Every gpu cell waits for its perf cell, and a task claims each perf
    // cell as next hands it out, so the only free cells are waiting ones.
    order(&store, json!({"columns": [{"id": "gpu", "after": ["perf"]}]})).unwrap();
    for expected in ["glare.perf", "sunstar.perf"] {
        let handing = next(&store);
        assert_eq!(handed(&handing), [expected], "{handing}");
        ask(&store, "create", None, handing["create"].clone(), None).unwrap();
    }
    let blocked = next(&store);
    assert!(blocked["create"].is_null(), "nothing is ready: {blocked}");
    assert_eq!(blocked["finished"], false, "{blocked}");
    assert_eq!(next_exit(&blocked), 3);
    let text = next_text(&blocked);
    assert!(!text.contains("No gaps left"), "{text}");
    assert!(text.contains("2 cells wait"), "it says how many cells wait:\n{text}");
    assert!(text.contains("camera.glare.gpu") && text.contains("after camera.glare.perf"), "it names what each waits for:\n{text}");
}
