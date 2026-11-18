//! A grid made before checks existed gets check templates on its columns
//! without a full re-draft: the agent sends only `columns[].checks`, they are
//! live at once, and rows, columns, cells and their history stay.


use atelier::workbench::grids::{self, get_cell, load, Prints, Scope};
use crate::gaps::*;
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
fn checks_attach_to_the_columns_of_a_grid_and_keep_its_history() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    // History from before checks: a proved cell.
    old_proof(&store, "camera", "glare", "perf", "f1");
    let before = load(store.connection(), "p", "camera").unwrap().unwrap();
    let rows_before: Vec<String> = before.rows.iter().map(|row| row.id.clone()).collect();

    add_checks(&store, "camera", gpu_checks()).unwrap();
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
    assert!(!next["cells"].as_array().unwrap().is_empty(), "{next}");
}

/// New checks for a column raise the bar for proof: its cells proved under
/// the old checks stay proved but are stale until proved again; other
/// columns keep theirs.
#[test]
fn new_column_checks_make_the_cells_proved_under_the_old_ones_stale() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    for col in ["gpu", "perf"] {
        old_proof(&store, "camera", "glare", col, "f1");
    }
    let set = add_checks(&store, "camera", gpu_checks()).unwrap();
    assert!(set.summary.contains("1 proved cell is stale until it is proved again"), "{}", set.summary);
    let gpu = get_cell(store.connection(), "p", "camera", "glare", "gpu").unwrap().unwrap();
    assert_eq!(gpu.state, "proved");
    assert!(grids::is_stale("camera", &gpu, &Prints::new()), "the column's checks changed, so its proof is stale");
    let perf = get_cell(store.connection(), "p", "camera", "glare", "perf").unwrap().unwrap();
    assert_eq!(perf.state, "proved");
    assert!(!grids::is_stale("camera", &perf, &Prints::new()), "a column whose checks did not change keeps its proof fresh");
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
fn adding_checks_needs_an_existing_grid() {
    let (_d, store) = store();
    assert!(refused(add_checks(&store, "nope", gpu_checks())).contains("nope"));
}
