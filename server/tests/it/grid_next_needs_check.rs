//! `grid next` never calls a grid finished while cells still need a check:
//! it says how many need one and how to add it, and its JSON says the grid
//! is not finished.


use atelier::workbench::grids::{cli::next_text, next_cells, Prints, Scope};
use crate::gaps::*;

#[test]
fn next_on_a_grid_whose_open_cells_all_need_a_check_does_not_say_it_is_finished() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    let next = next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap();
    assert_eq!(next["needsCheckInGrid"], 4, "{next}");
    assert_eq!(next["finished"], false, "{next}");
    let text = next_text(&next);
    assert!(!text.contains("No gaps left"), "next calls the grid finished:\n{text}");
    assert!(!text.contains("Every cell is proved or N/A"), "next calls the grid finished:\n{text}");
    assert!(text.contains("4 cells need a check"), "{text}");
    assert!(text.contains("atelier grid checks camera"), "it names the command that adds column checks:\n{text}");
}

#[test]
fn next_on_a_finished_grid_says_so() {
    let (_d, store) = store();
    grid_without_checks(&store, "camera");
    for (row, col) in [("glare", "gpu"), ("glare", "perf"), ("sunstar", "gpu"), ("sunstar", "perf")] {
        let mut prove = on(request("prove", "agent", Some("s1"), "camera"), row, col);
        prove.payload = serde_json::json!({"summary": "s", "checks": [{"name": "unit", "command": "true"}]});
        prove.checks = vec![atelier::workbench::grids::proof::CheckResult { name: "unit".into(), exit: 0, ms: 1, tail: String::new() }];
        prove.fingerprint = Some("f".into());
        apply(&store, &prove).unwrap();
    }
    let next = next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap();
    assert_eq!(next["finished"], true, "{next}");
    assert!(next_text(&next).contains("No gaps left in camera"));
}
