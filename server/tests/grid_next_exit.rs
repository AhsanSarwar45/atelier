//! `atelier grid next` exits non-zero when it hands out nothing and the grid
//! is not finished (cells need a check, or are all claimed).

use atelier::workbench::grids::cli::next_exit;
use serde_json::json;

#[test]
fn next_exits_non_zero_when_cells_need_a_check() {
    let blocked = json!({"grid": "camera", "scope": null, "claimable": [], "left": 0, "takenInGrid": 0, "naPending": 0,
        "needsCheck": [], "needsCheckInGrid": 2530, "create": null, "finished": false});
    assert_ne!(next_exit(&blocked), 0);
    let finished = json!({"grid": "camera", "scope": null, "claimable": [], "left": 0, "takenInGrid": 0, "naPending": 0,
        "needsCheck": [], "needsCheckInGrid": 0, "create": null, "finished": true});
    assert_eq!(next_exit(&finished), 0);
    let handed = json!({"grid": "camera", "scope": {"kind": "row", "id": "glare"}, "claimable": [{"row": "glare", "col": "gpu"}],
        "left": 1, "create": {"type": "tests"}, "finished": false});
    assert_eq!(next_exit(&handed), 0);
}
