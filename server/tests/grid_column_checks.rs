//! A grid approved before checks existed gets check templates on its columns
//! without a full re-draft: the agent sends only `columns[].checks`, the owner
//! approves just those, and rows, columns, cells and their history stay.

mod gaps;

use atelier::workbench::grids::{self, get_cell, load, Prints, Scope};
use gaps::*;
use serde_json::{json, Value};

fn add_checks(store: &Db, slug: &str, payload: Value) -> Result<grids::Outcome, atelier::workbench::tasks::TaskError> {
    let mut asked = request("checks", "agent", Some("s1"), slug);
    asked.payload = payload;
    asked.hashes = Some(json!({"files": {"tests/gpu_glare.rs": "a1", "tests/gpu_sunstar.rs": "b2"}}));
    apply(store, &asked)
}

fn gpu_checks() -> Value {
    json!({"columns": [{"id": "gpu", "checks": [template("gpu", "cargo test --test gpu_{row}", &["tests/gpu_{row}.rs"])]}]})
}

#[test]
fn checks_attach_to_the_columns_of_an_approved_grid_and_keep_its_history() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    // History from before checks: a proved cell.
    let mut prove = on(request("prove", "agent", Some("s1"), "camera"), "glare", "perf");
    prove.payload = json!({"summary": "s", "checks": [{"name": "unit", "command": "cargo test glare"}]});
    prove.checks = vec![atelier::workbench::grids::proof::CheckResult { name: "unit".into(), exit: 0, ms: 5, tail: String::new() }];
    prove.fingerprint = Some("f1".into());
    apply(&store, &prove).unwrap();
    let before = load(store.connection(), "p", "camera").unwrap().unwrap();
    let rows_before: Vec<String> = before.rows.iter().map(|row| row.id.clone()).collect();

    add_checks(&store, "camera", gpu_checks()).unwrap();
    // Nothing changes until the owner approves.
    let pending = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(pending.cell_checks("glare", "gpu").is_empty(), "checks wait for the owner");
    assert_eq!(pending.grid.status, "approved", "the grid stays approved while its checks wait");

    apply(&store, &request("approve", "owner", None, "camera")).unwrap();
    let after = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(after.cell_checks("sunstar", "gpu")[0]["command"], "cargo test --test gpu_sunstar");
    assert!(after.cell_checks("glare", "perf").is_empty(), "a column not named keeps no checks");
    let rows_after: Vec<String> = after.rows.iter().map(|row| row.id.clone()).collect();
    assert_eq!(rows_before, rows_after, "rows are untouched");
    let proved = get_cell(store.connection(), "p", "camera", "glare", "perf").unwrap().unwrap();
    assert_eq!((proved.state.as_str(), proved.fingerprint.as_deref()), ("proved", Some("f1")), "cell history is kept");
    let hashes = after.grid.hashes.clone().expect("the new check files are locked");
    assert_eq!(hashes["files"]["tests/gpu_glare.rs"], "a1");

    // `grid next` now hands out the gpu cells.
    let next = grids::next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap();
    assert!(next["left"].as_u64().unwrap() > 0, "{next}");
    assert!(!next["create"].is_null(), "{next}");
}

#[test]
fn adding_checks_refuses_anything_but_column_checks() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    assert!(refused(add_checks(&store, "camera", json!({"columns": [{"id": "lens", "checks": [template("x", "true", &["tests/x.rs"])]}]}))).contains("lens"));
    assert!(refused(add_checks(&store, "camera", json!({"columns": [{"id": "gpu", "name": "Renamed", "checks": [template("x", "true", &["tests/x.rs"])]}]}))).contains("only"));
    assert!(refused(add_checks(&store, "camera", json!({"columns": gpu_checks()["columns"], "rows": []}))).contains("only"));
    assert!(refused(add_checks(&store, "camera", json!({"columns": [{"id": "gpu", "checks": []}]}))).contains("gpu"));
}

#[test]
fn adding_checks_needs_an_approved_grid_and_the_owner_can_reject() {
    let (_d, store) = store();
    assert!(refused(add_checks(&store, "nope", gpu_checks())).contains("nope"));
    grid_without_checks(&store, "camera");
    add_checks(&store, "camera", gpu_checks()).unwrap();
    apply(&store, &request("discard", "owner", None, "camera")).unwrap();
    let kept = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(kept.grid.status, "approved", "discarding the checks keeps the approved grid");
    assert!(kept.cell_checks("glare", "gpu").is_empty());
}
