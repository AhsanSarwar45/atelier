//! The optional deeper test at done: the server breaks the task's changed
//! lines in small ways (flip a comparison or operator, change a constant,
//! delete a line) in a scratch copy, runs each item's checks against every
//! break, reports how many each item catches, and flags an item whose checks
//! catch almost none as weak.

mod gaps;

use atelier::workbench::tasks::checks;
use gaps::*;
use serde_json::{json, Value};

fn flags_of<'a>(flags: &'a [Value], kind: &str) -> Vec<&'a Value> {
    flags.iter().filter(|flag| flag["kind"] == kind).collect()
}

fn setup() -> (tempfile::TempDir, String) {
    let root = repository();
    let dir = root.path();
    commit(dir, "src/calc.sh", "avg() { echo 0; }\n");
    commit(dir, "tests/avg.sh", ". src/calc.sh\nfor case in '4 6 5' '3 3 3' '10 0 5' '0 4 2'; do set -- $case; got=$(avg $1 $2); \
        [ \"$got\" = \"$3\" ] || { echo \"avg FAILED: avg $1 $2 gave '$got', expected $3\"; exit 1; }; done; echo ok\n");
    commit(dir, "tests/exists.sh", ". src/calc.sh\ntype avg >/dev/null 2>&1 || { echo 'avg FAILED: not defined'; exit 1; }; echo ok\n");
    let start = git(dir, &["rev-parse", "HEAD"]);
    commit(dir, "src/calc.sh", "avg() {\n  if [ $1 -ge 0 ]; then echo $(( ($1 + $2) / 2 )); fi\n}\n");
    (root, start)
}

fn plan(mutants: bool) -> Value {
    json!({"outcome": "o", "mutants": mutants, "criteria": [
        {"id": "strong", "text": "averages", "checks": [shell_check("avg", "sh tests/avg.sh", "avg FAILED", &["tests/avg.sh"])]},
        {"id": "weak", "text": "defined", "checks": [shell_check("exists", "sh tests/exists.sh", "avg FAILED", &["tests/exists.sh"])]},
    ]})
}

#[tokio::test]
async fn done_reports_how_many_deliberate_breaks_each_items_checks_catch() {
    let (root, start) = setup();
    let dir = root.path();
    let stored = json!({"hashes": {"files": {}, "harness": []}, "startCommit": start});
    let gate = checks::measure(dir, "feature", &plan(true), &stored, checks::Measure::Done { test_command: None }, 1).await;
    let scores = flags_of(&gate.flags, "mutants");
    let score = |item: &str| scores.iter().find(|flag| flag["item"] == item).copied().unwrap_or_else(|| panic!("no score for {item}: {:?}", gate.flags));
    let (strong, weak) = (score("strong"), score("weak"));
    let total = strong["total"].as_u64().unwrap();
    assert!(total >= 4, "too few breaks made: {strong}");
    assert!(strong["caught"].as_u64().unwrap() * 10 >= total * 8, "the averaging checks catch nearly every break: {strong}");
    assert!(weak["caught"].as_u64().unwrap() * 4 < total, "{weak}");
    assert!(strong["text"].as_str().unwrap().contains(&format!("of {total}")), "{strong}");
    let weak_flags = flags_of(&gate.flags, "weak-checks");
    assert_eq!(weak_flags.len(), 1, "{:?}", gate.flags);
    assert_eq!(weak_flags[0]["item"], "weak");
    assert_eq!(git(dir, &["status", "--porcelain"]), "", "the checkout is untouched");
    assert_eq!(git(dir, &["worktree", "list"]).lines().count(), 1, "the scratch copy is gone");
}

#[tokio::test]
async fn breaks_are_only_made_when_the_plan_asks_and_only_on_changed_lines() {
    let (root, start) = setup();
    let dir = root.path();
    let stored = json!({"hashes": {"files": {}, "harness": []}, "startCommit": start});
    let gate = checks::measure(dir, "feature", &plan(false), &stored, checks::Measure::Done { test_command: None }, 1).await;
    assert!(flags_of(&gate.flags, "mutants").is_empty(), "{:?}", gate.flags);
    let gate = checks::measure(dir, "feature", &plan(true), &stored, checks::Measure::Done { test_command: None }, 1).await;
    assert_eq!(flags_of(&gate.flags, "mutants").len(), 2, "one score per item: {:?}", gate.flags);
    for flag in flags_of(&gate.flags, "mutants") {
        for broken in flag["breaks"].as_array().unwrap() {
            assert_eq!(broken["file"], "src/calc.sh", "only changed code is broken: {broken}");
            assert!(broken["line"].as_u64().unwrap() <= 3, "{broken}");
        }
    }
}

#[test]
fn a_plan_may_ask_for_breaks() {
    let (_d, store) = task_store();
    let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan(true)});
    let root = repository();
    commit(root.path(), "tests/avg.sh", "exit 1\n");
    commit(root.path(), "tests/exists.sh", "exit 1\n");
    let draft = checks::draft_gate(root.path(), "feature", &plan(true), &[]);
    let outcome = ask(&store, "create", None, payload, Some(draft)).unwrap();
    assert_eq!(outcome.task.plan["mutants"], true);
}
