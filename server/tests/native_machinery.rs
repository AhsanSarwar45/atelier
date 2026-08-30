use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

fn preflight(path: &Path) -> BTreeSet<String> {
    let settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    settings["hooks"]["PreToolUse"].as_array().unwrap().iter()
        .flat_map(|block| block["hooks"].as_array().into_iter().flatten())
        .filter_map(|hook| hook["command"].as_str())
        .filter_map(|command| command.split_whitespace().last())
        .map(str::to_string).collect()
}

#[test]
fn native_machinery_keeps_provider_preflight_invariants_equivalent() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let required = BTreeSet::from([
        "workflow-gate".to_string(), "board-actor".to_string(),
        "board-merge-gate".to_string(), "board-status-gate".to_string(),
    ]);
    for file in [".claude/settings.json", ".codex/hooks.json"] {
        let found = preflight(&root.join(file));
        assert!(required.is_subset(&found), "{file} is missing native preflight gates: {:?}",
            required.difference(&found).collect::<Vec<_>>());
    }
}

#[test]
fn native_machinery_installed_hooks_name_the_binary_not_an_interpreter() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for file in [".claude/settings.json", ".codex/hooks.json"] {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        assert!(!text.contains("python"), "{file} still dispatches Python");
        for command in text.lines().filter(|line| line.contains("machinery") || line.contains("board-") || line.contains("workflow-gate")) {
            assert!(!command.contains("machinery/"), "{file} still dispatches a machinery file: {command}");
        }
    }
}
