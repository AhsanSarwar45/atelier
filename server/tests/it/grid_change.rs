//! `grid change`: add or remove a few rows and columns of a grid by naming
//! only the change. The agent never resends the grid; the change is live at
//! once, and every cell that stays keeps its proof.

use atelier::workbench::grids::{self, get_cell, load};
use crate::gaps::*;
use serde_json::{json, Value};

fn change(store: &Db, slug: &str, payload: Value) -> Result<grids::Outcome, atelier::workbench::tasks::TaskError> {
    let mut asked = request("change", "agent", Some("s1"), slug);
    asked.payload = payload;
    asked.hashes = Some(json!({"files": {"scripts/scenes.py": "c3"}}));
    apply(store, &asked)
}

fn live_columns(store: &Db, slug: &str) -> Vec<String> {
    let mut columns: Vec<_> = load(store.connection(), "p", slug).unwrap().unwrap().columns.into_iter().filter(|c| c.retired_at.is_none()).collect();
    columns.sort_by_key(|c| c.position);
    columns.into_iter().map(|c| c.id).collect()
}

fn live_rows(store: &Db, slug: &str) -> Vec<String> {
    load(store.connection(), "p", slug).unwrap().unwrap().rows.into_iter().filter(|r| r.removed_at.is_none()).map(|r| r.id).collect()
}

fn prove_glare_perf(store: &Db) {
    old_proof(store, "camera", "glare", "perf", "f1");
}

#[test]
fn a_column_is_added_after_the_one_named_without_resending_the_grid() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    prove_glare_perf(&store);
    change(&store, "camera", json!({"addColumns": [{"id": "scenes", "name": "Saved scenes", "after": "gpu",
        "checks": [template("scenes", "python scripts/scenes.py {row}", &["scripts/scenes.py"])]}]})).unwrap();
    assert_eq!(live_columns(&store, "camera"), ["gpu", "scenes", "perf"], "the new column sits after gpu");
    assert_eq!(live_rows(&store, "camera"), ["glare", "sunstar"], "rows are untouched");
    let after = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(after.cell_checks("glare", "scenes")[0]["command"], "python scripts/scenes.py glare");
    let proved = get_cell(store.connection(), "p", "camera", "glare", "perf").unwrap().unwrap();
    assert_eq!(proved.state, "proved", "a kept cell keeps its proof");
}

#[test]
fn rows_and_columns_are_added_and_removed_by_name() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    change(&store, "camera", json!({
        "removeColumns": ["perf"], "removeRows": ["sunstar"],
        "addRows": [{"id": "bloom", "name": "Bloom", "paths": ["camera/bloom.rs"]}],
    })).unwrap();
    assert_eq!(live_columns(&store, "camera"), ["gpu"]);
    assert_eq!(live_rows(&store, "camera"), ["glare", "bloom"]);
}

#[test]
fn a_change_refuses_unknown_ids_and_applies_at_once() {
    let (_d, store) = store();
    assert!(refused(change(&store, "nope", json!({"removeColumns": ["gpu"]}))).contains("nope"));
    grid_without_checks(&store, "camera");
    assert!(refused(change(&store, "camera", json!({"removeColumns": ["lens"]}))).contains("lens"));
    assert!(refused(change(&store, "camera", json!({"addColumns": [{"id": "gpu", "name": "Again"}]}))).contains("gpu"));
    assert!(refused(change(&store, "camera", json!({"addColumns": [{"id": "x", "name": "X", "after": "lens"}]}))).contains("lens"));
    assert!(refused(change(&store, "camera", json!({}))).contains("addColumns"));
    change(&store, "camera", json!({"removeColumns": ["perf"]})).unwrap();
    // No change waits for another: the next one applies on top.
    change(&store, "camera", json!({"addRows": [{"id": "bloom", "name": "Bloom"}]})).unwrap();
    assert_eq!(live_columns(&store, "camera"), ["gpu"]);
    assert!(refused(change(&store, "camera", json!({"removeColumns": ["perf"]}))).contains("perf"));
}

#[test]
fn the_grid_help_names_change() {
    let help = atelier::workbench::grids::cli::USAGE;
    assert!(help.contains("change SLUG"), "the grid help does not offer `change`: {help}");
}
