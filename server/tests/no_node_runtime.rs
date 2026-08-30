use std::path::Path;

#[test]
fn no_node_runtime_is_started_extracted_or_downloaded_by_the_server() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(!root.join("src/helper.rs").exists(), "the former runtime helper source still exists");
    let production = [
        "src/main.rs", "src/routes/workbench.rs", "src/routes/live.rs",
        "src/rules.rs", "src/needs.rs", "build.rs",
    ];
    let forbidden = [
        "spawn_sidecar", "fetch_kit", "BEADS_WORKBENCH_ENTRY",
        "BEADS_WORKBENCH_URL", "Command::new(\"node\")", "../workbench\"",
    ];
    for relative in production {
        let text = std::fs::read_to_string(root.join(relative)).unwrap();
        for needle in forbidden {
            assert!(!text.contains(needle), "{relative} still contains production Node runtime seam {needle}");
        }
    }
}
