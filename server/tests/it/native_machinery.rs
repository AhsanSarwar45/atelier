use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

fn commands(path: &Path) -> BTreeSet<String> {
    let settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    settings["hooks"]
        .as_object()
        .into_iter()
        .flat_map(|events| events.values())
        .filter_map(Value::as_array)
        .flatten()
        .flat_map(|block| block["hooks"].as_array().into_iter().flatten())
        .filter_map(|hook| hook["command"].as_str())
        .map(str::to_string)
        .collect()
}

/// The board, its landing and its checks are gone, and this repository's own
/// provider wiring runs none of their gates any more.
#[test]
fn this_repository_runs_none_of_the_retired_board_gates() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for file in [".claude/settings.json", ".codex/hooks.json"] {
        let found = commands(&root.join(file));
        let left: Vec<&String> = found
            .iter()
            .filter(|command| {
                command.starts_with("atelier hook ") && command.as_str() != "atelier hook doing"
            })
            .collect();
        assert!(left.is_empty(), "{file} still runs retired gates: {left:?}");
    }
}

#[test]
fn native_machinery_installed_hooks_name_the_binary_not_an_interpreter() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    for file in [".claude/settings.json", ".codex/hooks.json"] {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        assert!(!text.contains("python"), "{file} still dispatches Python");
        for command in text.lines().filter(|line| {
            line.contains("machinery") || line.contains("board-") || line.contains("workflow-gate")
        }) {
            assert!(
                !command.contains("machinery/"),
                "{file} still dispatches a machinery file: {command}"
            );
        }
    }
}
