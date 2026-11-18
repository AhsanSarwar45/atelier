//! Grids across branches. A grid's checks, cases and cell states belong to
//! the project, not to a branch: every checkout sees the same checks the
//! moment they are written. `grid prove` runs the checks in the chat's own
//! checkout (the project's folder or a worktree on a branch), with no task
//! and no extra step. A proof is judged, and re-checked, in the checkout
//! that has its commit, and in the project's folder once its branch is
//! merged. One proof per cell: the latest one counts.

use atelier::workbench::grids::{self, get_cell, load, proof, search, Loaded};
use crate::gaps::*;
use serde_json::json;
use std::path::{Path, PathBuf};

/// A repository on main, and a worktree on branch `work` beside it.
fn main_and_worktree() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let main = root.path().join("main");
    std::fs::create_dir_all(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    commit(&main, "cam/glare.rs", "fn glare() {}\n");
    let tree = root.path().join("work");
    git(&main, &["worktree", "add", "-q", "-b", "work", tree.to_str().unwrap()]);
    (root, main, tree)
}

/// A live grid cam (drafted by an agent, nothing approved): column gpu with
/// one check, row glare covering cam/glare.rs, its cases reviewed.
fn cam(store: &Db) {
    let mut draft = request("draft", "agent", Some("s1"), "");
    draft.slug = None;
    draft.payload = json!({
        "slug": "cam", "title": "Cam", "area": "An area.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["cam/"]},
        "columns": [{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test",
                     "checks": [template("gpu", "cargo test {row}_gpu", &["tests/gpu.rs"])]}],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare", &["cam/glare.rs"])], head: Some("h1".into()) }));
    apply(store, &draft).unwrap();
    approve_cases(store, "cam");
}

/// `atelier grid prove cam glare gpu` from chat `session` working in
/// `folder`: the check passes there, and the proof records that checkout's
/// HEAD and fingerprint, as the prove route does.
async fn prove_in(store: &Db, session: &str, folder: &Path) {
    let head = git(folder, &["rev-parse", "HEAD"]);
    let loaded = load(store.connection(), "p", "cam").unwrap().unwrap();
    let print = proof::fingerprint(folder, &head, &loaded.covered("glare")).await.unwrap();
    let mut asked = on(request("prove", "agent", Some(session), "cam"), "glare", "gpu");
    asked.payload = json!({"summary": "it works"});
    asked.checks = vec![proof::CheckResult { name: "gpu".into(), exit: 0, ms: 1, tail: "CASE cam/glare/gpu/gpu PASS - -".into() }];
    asked.fingerprint = Some(print);
    asked.head = Some(head);
    apply(store, &asked).unwrap();
}

async fn stale(store: &Db, main: &Path) -> bool {
    let loaded: Loaded = load(store.connection(), "p", "cam").unwrap().unwrap();
    let (prints, _) = grids::prints_at(main, std::slice::from_ref(&loaded)).await;
    grids::is_stale("cam", loaded.cell("glare", "gpu").unwrap(), &prints)
}

#[tokio::test]
async fn a_cell_proved_on_a_branch_needs_no_task_and_is_fresh_from_main() {
    let (_root, main, tree) = main_and_worktree();
    commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    let (_d, store) = store();
    cam(&store);
    prove_in(&store, "s2", &tree).await;
    assert_eq!(get_cell(store.connection(), "p", "cam", "glare", "gpu").unwrap().unwrap().state, "proved");
    assert!(!stale(&store, &main).await, "a branch proof is judged in the branch's worktree");
}

#[tokio::test]
async fn a_branch_proof_stays_fresh_after_the_branch_merges_and_its_worktree_goes() {
    let (_root, main, tree) = main_and_worktree();
    commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    let (_d, store) = store();
    cam(&store);
    prove_in(&store, "s2", &tree).await;
    git(&main, &["merge", "-q", "--ff-only", "work"]);
    git(&main, &["worktree", "remove", tree.to_str().unwrap()]);
    assert!(!stale(&store, &main).await, "once merged, the proof is judged on main and its code is the same");
}

#[tokio::test]
async fn main_and_a_branch_both_prove_the_same_cell_and_the_latest_counts() {
    let (_root, main, tree) = main_and_worktree();
    let (_d, store) = store();
    cam(&store);
    prove_in(&store, "s1", &main).await;
    let branch_head = commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    prove_in(&store, "s2", &tree).await;
    let cell = get_cell(store.connection(), "p", "cam", "glare", "gpu").unwrap().unwrap();
    assert_eq!(grids::checked_at(&cell), Some(branch_head.as_str()), "the branch's proof is the cell's proof now");
    assert!(!stale(&store, &main).await);
}

#[tokio::test]
async fn changed_checks_make_the_proof_stale_on_every_branch_and_a_recheck_restores_it() {
    let (_root, main, tree) = main_and_worktree();
    commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    let (_d, store) = store();
    cam(&store);
    prove_in(&store, "s2", &tree).await;
    let mut checks = request("checks", "agent", Some("s1"), "cam");
    checks.payload = json!({"columns": [{"id": "gpu", "checks": [template("gpu", "cargo test {row}_gpu_v2", &["tests/gpu.rs"])]}]});
    apply(&store, &checks).unwrap();
    assert!(stale(&store, &main).await, "the checks are the project's, so the change reaches the branch's proof too");
    // Re-check: the new checks pass in the proof's checkout.
    let loaded = load(store.connection(), "p", "cam").unwrap().unwrap();
    let (prints, _) = grids::prints_at(&main, std::slice::from_ref(&loaded)).await;
    let mut verify = on(request("verify", "agent", Some("s1"), "cam"), "glare", "gpu");
    verify.checks = vec![proof::CheckResult { name: "gpu".into(), exit: 0, ms: 1, tail: "CASE cam/glare/gpu/gpu PASS - -".into() }];
    verify.fingerprint = grids::print_for("cam", "glare", "gpu", &prints).cloned();
    verify.head = Some(git(&tree, &["rev-parse", "HEAD"]));
    verify.prints = prints;
    apply(&store, &verify).unwrap();
    assert!(!stale(&store, &main).await, "a passing re-check under the new checks makes the proof fresh");
}
