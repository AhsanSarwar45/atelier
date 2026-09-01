use std::path::Path;

#[test]
fn no_node_runtime_is_started_extracted_or_downloaded_by_the_server() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(
        !root.join("src/helper.rs").exists(),
        "the former runtime helper source still exists"
    );
    assert!(
        !root.join("../workbench").exists(),
        "the former Node backend still exists"
    );
    let production = [
        "src/main.rs",
        "src/routes/workbench.rs",
        "src/routes/live.rs",
        "src/rules.rs",
        "src/needs.rs",
        "build.rs",
    ];
    let forbidden = [
        "spawn_sidecar",
        "fetch_kit",
        "BEADS_WORKBENCH_ENTRY",
        "BEADS_WORKBENCH_URL",
        "Command::new(\"node\")",
        "Command::new(\"npm\")",
        "Command::new(\"python\")",
        "Command::new(\"python3\")",
        "../workbench\"",
    ];
    for relative in production {
        let text = std::fs::read_to_string(root.join(relative)).unwrap();
        for needle in forbidden {
            assert!(
                !text.contains(needle),
                "{relative} still contains production Node runtime seam {needle}"
            );
        }
    }
}

#[test]
fn installed_machinery_contains_no_interpreter_scripts() {
    let machinery = Path::new(env!("CARGO_MANIFEST_DIR")).join("../machinery");
    let mut pending = vec![machinery];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().and_then(|name| name.to_str()) != Some("__pycache__") {
                    pending.push(path);
                }
                continue;
            }
            assert!(
                !matches!(
                    path.extension().and_then(|part| part.to_str()),
                    Some("py" | "pyc" | "pyo" | "js" | "mjs" | "cjs" | "ts")
                ),
                "runtime interpreter source remains: {}",
                path.display()
            );
        }
    }
}
