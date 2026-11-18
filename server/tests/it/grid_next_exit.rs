//! `atelier grid next` exits non-zero when it hands out nothing and the grid
//! is not finished (cells need a check, cases or an order, or wait on others).

use atelier::workbench::grids::cli::next_exit;
use serde_json::json;

#[test]
fn next_exits_non_zero_when_cells_need_a_check() {
    let blocked = json!({"grid": "camera", "scope": null, "cells": [], "left": 0,
        "needsCheck": [], "needsCheckInGrid": 2530, "finished": false});
    assert_ne!(next_exit(&blocked), 0);
    let finished = json!({"grid": "camera", "scope": null, "cells": [], "left": 0,
        "needsCheck": [], "needsCheckInGrid": 0, "finished": true});
    assert_eq!(next_exit(&finished), 0);
    let handed = json!({"grid": "camera", "scope": {"kind": "row", "id": "glare"},
        "cells": [{"row": "glare", "col": "gpu", "next": "atelier grid prove camera glare gpu"}], "left": 1, "finished": false});
    assert_eq!(next_exit(&handed), 0);
}
