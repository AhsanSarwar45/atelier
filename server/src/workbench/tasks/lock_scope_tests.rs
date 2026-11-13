//! A check locks its own files and the helpers, fixtures and baselines in
//! its test folder, but not the other test files there: those are other
//! tests, which a task may need to change.

use std::collections::BTreeMap;

use std::path::Path;
use std::process::Command;

use crate::workbench::tasks::checks::{self, Check};
use serde_json::json;

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q", "-b", "main"]);
    root
}

const MINE: &str = "src/__tests__/plan-changed.test.tsx";
const OTHER: &str = "src/__tests__/task-widget.test.tsx";
const HELPER: &str = "src/__tests__/fixtures.ts";

fn check() -> Check {
    checks::parse_check(&json!({"name": "card", "command": "npx vitest run", "kind": "test", "given": "g", "when": "w", "then": "t",
        "red": "FAIL", "files": [MINE]}), "check").unwrap()
}

#[test]
fn approval_locks_the_helpers_beside_a_check_but_not_the_other_tests() {
    let repo = repository();
    std::fs::create_dir_all(repo.path().join("src/__tests__")).unwrap();
    for path in [MINE, OTHER, HELPER] {
        std::fs::write(repo.path().join(path), path).unwrap();
    }
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-q", "-m", "files"]);
    let locked = checks::widened(repo.path(), &[MINE.to_string()]);
    assert!(locked.contains(&MINE.to_string()), "the check's own file is locked: {locked:?}");
    assert!(locked.contains(&HELPER.to_string()), "a helper beside it is locked: {locked:?}");
    assert!(!locked.contains(&OTHER.to_string()), "another test file is not locked: {locked:?}");
}

#[test]
fn a_changed_other_test_does_not_fail_a_check_but_a_changed_helper_does() {
    // Approved before this rule: the other test was locked then too.
    let approved = json!({"files": {MINE: "m1", OTHER: "o1", HELPER: "h1"}, "harness": []});
    let now = |other: &str, helper: &str| -> BTreeMap<String, String> {
        [(MINE, "m1"), (OTHER, other), (HELPER, helper)].into_iter().map(|(p, s)| (p.to_string(), s.to_string())).collect()
    };
    let owned = vec![MINE.to_string()];
    let changed = checks::changed_for(&approved, &[check()], &owned, &now("o2", "h1"));
    assert!(changed.is_empty(), "another test changed, which is not the check's: {changed:?}");
    let changed = checks::changed_for(&approved, &[check()], &owned, &now("o1", "h2"));
    assert_eq!(changed, vec![HELPER.to_string()], "a changed helper still fails the check");
}
