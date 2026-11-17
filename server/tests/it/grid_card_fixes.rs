//! What testing grids turned up: approving a new draft records the row
//! search its drafting ran, and `atelier grid show SLUG ROW COL` prints the
//! checks that prove the cell.

use atelier::workbench::grids::{cli, load};
use crate::gaps::*;
use serde_json::json;

#[test]
fn approving_a_new_draft_records_the_row_search_it_ran() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    let grid = load(store.connection(), "p", "camera").unwrap().unwrap().grid;
    let discovery = grid.discovery.unwrap_or_else(|| panic!("the approved grid says its row search never ran"));
    assert_eq!(discovery["ok"], true, "the row search is recorded as failed: {discovery}");
    assert!(discovery["at"].is_i64(), "the row search has no time: {discovery}");
}

#[test]
fn a_cell_shown_alone_prints_its_checks() {
    let value = json!({
        "cell": {"row": "glare", "col": "gpu", "state": "gap", "step": "open", "next": "atelier grid next camera",
            "checks": [{"name": "gpu", "kind": "test", "command": "cargo test gpu_glare"}], "needsCheck": false},
        "row": {"name": "Glare", "paths": ["camera/glare.rs"]},
        "column": {"name": "Runs on the GPU", "proofRule": "a GPU test"},
        "notes": [], "events": [],
    });
    let text = cli::cell_text("camera", &value);
    assert!(text.contains("Checks:"), "the cell shows no checks: {text}");
    assert!(text.contains("cargo test gpu_glare"), "the cell's check command is missing: {text}");
    assert!(text.contains("Step: open. Next: `atelier grid next camera`"), "the cell's step is missing: {text}");
}
