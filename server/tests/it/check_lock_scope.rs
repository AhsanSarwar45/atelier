//! Approval records what a check depends on, not only the files it names:
//! the whole test folder its files live in (shared helpers, fixtures,
//! tolerances). Nothing is locked, but done flags each of those that
//! changed for the owner. And a check that runs fewer tests than it did at
//! start fails.


use atelier::workbench::tasks::{checks, get};
use crate::gaps::*;
use serde_json::json;

const CAMERA: &str = ". tests/common/tolerance.sh\ngot=$(cat src/value.txt)\n\
    if within 2 \"$got\"; then echo 'test result: ok. 1 passed; 0 failed'; else echo \"value FAILED: got $got\"; echo 'test result: FAILED. 0 passed; 1 failed'; exit 1; fi\n";
const TOLERANCE: &str = "within() { [ \"$1\" = \"$2\" ]; }\n";

/// Creates and starts a task whose one check is `check`, in `dir`.
async fn started(store: &Db, dir: &std::path::Path, check: serde_json::Value) -> i64 {
    let plan = json!({"outcome": "o", "criteria": [{"id": "value", "text": "x", "checks": [check]}]});
    let draft = checks::draft_gate(dir, "feature", &plan, &[]);
    let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan});
    let number = ask(store, "create", None, payload, Some(draft)).unwrap().task.number;
    let task = get(store.connection(), "p", number).unwrap().unwrap();
    let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), checks::Measure::Start, 1).await;
    ask(store, "start", Some(number), json!({}), Some(gate)).unwrap();
    number
}

async fn check_item(store: &Db, dir: &std::path::Path, number: i64) -> atelier::workbench::tasks::Outcome {
    let task = get(store.connection(), "p", number).unwrap().unwrap();
    let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), checks::Measure::Item("value".into()), 2).await;
    ask(store, "check", Some(number), json!({"item": "value"}), Some(gate)).unwrap()
}

#[test]
fn approval_records_the_whole_test_folder_a_check_file_lives_in() {
    let root = repository();
    let dir = root.path();
    commit(dir, "src/value.txt", "1\n");
    commit(dir, "tests/common/tolerance.sh", TOLERANCE);
    commit(dir, "tests/fixtures/reference.txt", "2\n");
    commit(dir, "tests/suite/camera.sh", CAMERA);
    let plan = json!({"outcome": "o", "criteria": [{"id": "value", "text": "x",
        "checks": [shell_check("camera", "sh tests/suite/camera.sh", "value FAILED", &["tests/suite/camera.sh"])]}]});
    let gate = checks::draft_gate(dir, "feature", &plan, &[]);
    for path in ["tests/suite/camera.sh", "tests/common/tolerance.sh", "tests/fixtures/reference.txt"] {
        assert!(gate.hashes.contains_key(path), "{path} is not recorded: {:?}", gate.hashes.keys().collect::<Vec<_>>());
    }
    assert!(!gate.hashes.contains_key("src/value.txt"), "the code under work is not recorded");
}

#[tokio::test]
async fn a_loosened_shared_helper_is_flagged_for_the_owner_at_done() {
    let root = repository();
    let dir = root.path();
    commit(dir, "src/value.txt", "1\n");
    commit(dir, "tests/common/tolerance.sh", TOLERANCE);
    commit(dir, "tests/suite/camera.sh", CAMERA);
    let (_d, store) = task_store();
    let number = started(&store, dir, shell_check("camera", "sh tests/suite/camera.sh", "value FAILED", &["tests/suite/camera.sh"])).await;
    // The helper is loosened so anything passes; camera.sh itself is untouched.
    commit(dir, "tests/common/tolerance.sh", "within() { true; }\n");
    let outcome = check_item(&store, dir, number).await;
    assert_eq!(outcome.detail["met"], true, "the check runs as it is: {}", outcome.summary);
    let task = get(store.connection(), "p", number).unwrap().unwrap();
    let done = checks::Measure::Done { test_command: None };
    let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), done, 3).await;
    ask(&store, "done", Some(number), json!({"summary": "s", "commits": ["abcdef1"], "result": {}}), Some(gate)).unwrap();
    let flags = get(store.connection(), "p", number).unwrap().unwrap().gate.unwrap()["flags"].clone();
    let flagged = flags.as_array().unwrap().iter().any(|flag| flag["kind"] == "check-file-changed" && flag["path"] == "tests/common/tolerance.sh");
    assert!(flagged, "the loosened helper is flagged: {flags}");
}

#[tokio::test]
async fn a_check_that_runs_fewer_tests_than_at_start_fails() {
    let root = repository();
    let dir = root.path();
    // The suite runs one test per line of src/cases.txt, not a check file.
    commit(dir, "src/cases.txt", "a\nb\nc\n");
    commit(dir, "src/value.txt", "1\n");
    commit(dir, "tests/suite/cases.sh", "n=$(wc -l < src/cases.txt); if grep -qx 2 src/value.txt; then echo \"test result: ok. $n passed; 0 failed\"; \
        else echo 'value FAILED'; echo \"test result: FAILED. 0 passed; $n failed\"; exit 1; fi\n");
    let (_d, store) = task_store();
    let number = started(&store, dir, shell_check("cases", "sh tests/suite/cases.sh", "value FAILED", &["tests/suite/cases.sh"])).await;
    // Two of the three cases are dropped and the value is fixed: the check exits 0.
    commit(dir, "src/cases.txt", "a\n");
    commit(dir, "src/value.txt", "2\n");
    let outcome = check_item(&store, dir, number).await;
    assert_eq!(outcome.detail["met"], false, "{}", outcome.summary);
    assert!(outcome.summary.contains("ran 1 test, 3 at start"), "{}", outcome.summary);
    // Put back, all three run and it is met.
    commit(dir, "src/cases.txt", "a\nb\nc\n");
    let outcome = check_item(&store, dir, number).await;
    assert_eq!(outcome.detail["met"], true, "{}", outcome.summary);
}
