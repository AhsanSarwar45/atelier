//! A proof made in a worktree on a branch main does not have yet is judged
//! in a checkout that has its commit, not in the main checkout, so it is not
//! stale the moment it is recorded.

use atelier::workbench::grids::{self, load, proof, Loaded};
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

/// Records glare/gpu as proved in `folder` at its HEAD, the way prove does.
async fn proved_in(store: &Db, folder: &Path) -> Loaded {
    let head = git(folder, &["rev-parse", "HEAD"]);
    let loaded = load(store.connection(), "p", "cam").unwrap().unwrap();
    let paths = loaded.covered("glare");
    let print = proof::fingerprint(folder, &head, &paths).await.unwrap();
    let proof = json!({"summary": "s", "checks": [{"name": "unit", "command": "true"}]});
    let last_check = json!({"at": 1, "head": head, "passed": true, "results": []});
    store.connection().execute(
        "UPDATE grid_cell SET state = 'proved', fingerprint = ?1, proof = ?2, last_check = ?3, proved_by = 's1', proved_at = 1, step = 'proved'
         WHERE project_id = 'p' AND slug = 'cam' AND row = 'glare' AND col = 'gpu'",
        rusqlite::params![print, proof.to_string(), last_check.to_string()],
    ).unwrap();
    load(store.connection(), "p", "cam").unwrap().unwrap()
}

async fn stale(main: &Path, loaded: &Loaded) -> bool {
    let (prints, _) = grids::prints_at(main, std::slice::from_ref(loaded)).await;
    grids::is_stale("cam", loaded.cell("glare", "gpu").unwrap(), &prints)
}

#[tokio::test]
async fn a_proof_made_in_a_worktree_ahead_of_main_is_fresh() {
    let (_root, main, tree) = main_and_worktree();
    commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    let (_d, store) = store();
    grid_with_cam_rows(&store);
    let loaded = proved_in(&store, &tree).await;
    assert!(!stale(&main, &loaded).await, "a proof made on a branch main lacks is judged in that branch's worktree");
}

#[tokio::test]
async fn a_worktree_proof_goes_stale_when_its_covered_code_changes_there() {
    let (_root, main, tree) = main_and_worktree();
    commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    let (_d, store) = store();
    grid_with_cam_rows(&store);
    let loaded = proved_in(&store, &tree).await;
    commit(&tree, "cam/glare.rs", "fn glare() { changed(); }\n");
    assert!(stale(&main, &loaded).await, "the covered file changed in the worktree after the proof");
}

#[tokio::test]
async fn a_proof_main_already_has_is_still_judged_in_main() {
    let (_root, main, tree) = main_and_worktree();
    let (_d, store) = store();
    grid_with_cam_rows(&store);
    let loaded = proved_in(&store, &main).await;
    commit(&tree, "cam/glare.rs", "fn glare() { only_on_the_branch(); }\n");
    assert!(!stale(&main, &loaded).await, "a change on another branch does not touch a proof made on main");
    commit(&main, "cam/glare.rs", "fn glare() { changed_on_main(); }\n");
    assert!(stale(&main, &loaded).await, "a change on main makes main's proof stale");
}

#[tokio::test]
async fn the_checkout_for_a_branch_commit_is_its_worktree() {
    let (_root, main, tree) = main_and_worktree();
    let head = commit(&tree, "cam/glare.rs", "fn glare() { better(); }\n");
    let found = proof::checkout_for(&main, &head).await;
    assert_eq!(found.canonicalize().unwrap(), tree.canonicalize().unwrap());
    let on_main = git(&main, &["rev-parse", "HEAD"]);
    assert_eq!(proof::checkout_for(&main, &on_main).await.canonicalize().unwrap(), main.canonicalize().unwrap());
}

/// An approved grid "cam" with column gpu and row glare covering cam/glare.rs.
fn grid_with_cam_rows(store: &Db) {
    owner_says(store, "s1", "@matrix the cam area");
    let mut draft = request("draft", "agent", Some("s1"), "");
    draft.slug = None;
    draft.payload = json!({
        "slug": "cam", "title": "Cam", "area": "An area.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["cam/"]},
        "columns": [{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test"}],
    });
    draft.search = Some(Ok(atelier::workbench::grids::search::Run { rows: vec![found("glare", &["cam/glare.rs"])], head: Some("h1".into()) }));
    apply(store, &draft).unwrap();
    apply(store, &request("approve", "owner", None, "cam")).unwrap();
    approve_cases(store, "cam");
}
