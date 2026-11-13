//! A proof goes stale when anything it depends on changes, not only the
//! row's listed files: files the covered code pulls in (Rust `include_str!`
//! and macros like `wgsl!("x.wgsl")`, WGSL `#include "x.wgsl"`), the cell's
//! check files, and extra paths a check names in `watch`.

mod gaps;

use atelier::workbench::grids::{load, proof::fingerprint};
use gaps::*;
use serde_json::json;

async fn print(dir: &std::path::Path, paths: &[&str]) -> String {
    let head = git(dir, &["rev-parse", "HEAD"]);
    let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
    fingerprint(dir, &head, &paths).await.expect("a fingerprint")
}

#[tokio::test]
async fn the_fingerprint_follows_what_rust_and_wgsl_files_pull_in() {
    let root = repository();
    let dir = root.path();
    commit(dir, "post/spike.rs", "let m = module(concat!(wgsl!(\"iris.wgsl\"), include_str!(\"spike.wgsl\")));\n");
    commit(dir, "post/spike.wgsl", "#include \"common.wgsl\"\nfn spike() {}\n");
    commit(dir, "post/iris.wgsl", "fn iris() {}\n");
    commit(dir, "post/common.wgsl", "fn common() {}\n");
    commit(dir, "post/unrelated.wgsl", "fn other() {}\n");
    let covered = ["post/spike.rs"];
    let first = print(dir, &covered).await;
    commit(dir, "post/unrelated.wgsl", "fn other() { changed(); }\n");
    assert_eq!(print(dir, &covered).await, first, "a file nothing includes does not matter");
    commit(dir, "post/iris.wgsl", "fn iris() { changed(); }\n");
    let second = print(dir, &covered).await;
    assert_ne!(second, first, "iris.wgsl, pulled in by wgsl!(), is covered");
    commit(dir, "post/common.wgsl", "fn common() { changed(); }\n");
    assert_ne!(print(dir, &covered).await, second, "common.wgsl, pulled in by spike.wgsl's #include, is covered");
}

#[test]
fn a_rows_coverage_includes_its_cells_check_files_and_watched_paths() {
    let (_d, store) = store();
    owner_says(&store, "s1", "@matrix the camera area");
    let mut draft = request("draft", "agent", Some("s1"), "");
    draft.slug = None;
    let mut gpu = template("gpu", "cargo test --test gpu_{row}", &["tests/gpu_{row}.rs"]);
    gpu["watch"] = json!(["post/iris.wgsl", "tests/baselines/{row}.png"]);
    draft.payload = json!({
        "slug": "camera", "title": "Camera", "area": "An area.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["post/"]},
        "columns": [{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": [gpu]}],
    });
    draft.search = Some(Ok(atelier::workbench::grids::search::Run { rows: vec![found("sunstar", &["post/spike.rs"])], head: Some("h1".into()) }));
    apply(&store, &draft).unwrap();
    apply(&store, &request("approve", "owner", None, "camera")).unwrap();
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let covered = loaded.covered("sunstar");
    for path in ["post/spike.rs", "tests/gpu_sunstar.rs", "post/iris.wgsl", "tests/baselines/sunstar.png"] {
        assert!(covered.iter().any(|c| c == path), "{path} is not covered: {covered:?}");
    }
}
