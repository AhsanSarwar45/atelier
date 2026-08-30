//! Native project joining. This owns only reproducible project state: Beads
//! initialization, provider hook wiring and the Git landing guard.

use crate::project_manifest::ProjectManifest;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const MANAGED: &[&str] = &[
    "workflow-gate", "board-actor", "board-merge-gate", "board-status-gate",
    "wait-gate", "board-touch", "board-prime", "board-push", "completion-gate",
    "board-gate", "landing-gate",
    "workflow-gate.py", "board-actor.py", "board-merge-gate.py",
    "board-status-gate.py", "wait-gate.py", "board-touch.py",
    "board-prime.py", "board-push.py", "completion-gate.py", "board-gate.py",
    "report-gate.py", "publish-gate.py", "plan-doc-lint.py", "picture-gate.py",
    "agent-fence.py", "slice-gate.py", "helper-proof.py", "habit-reading.py",
];

const CLAUDE: &[(&str, &str, &[&str])] = &[
    ("PreToolUse", "Bash|Edit|Write|MultiEdit|NotebookEdit", &["workflow-gate"]),
    ("PreToolUse", "Bash", &["board-actor", "board-merge-gate", "board-status-gate"]),
    ("PostToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash|AskUserQuestion|ExitPlanMode|Agent|Task|Monitor|TaskCreate|SendMessage", &["board-touch"]),
    ("SubagentStop", "", &["board-touch"]),
    ("SessionStart", "", &["board-prime"]),
    ("SessionEnd", "", &["board-push"]),
    ("Stop", "", &["board-gate"]),
];

const CODEX: &[(&str, &str, &[&str])] = &[
    ("PreToolUse", "Bash|apply_patch|Edit|Write", &["workflow-gate"]),
    ("PreToolUse", "Bash", &["board-actor", "board-merge-gate", "board-status-gate"]),
    ("PostToolUse", "Bash|apply_patch|Edit|Write", &["board-touch"]),
    ("SubagentStop", "", &["board-touch"]),
];

const GUARD_MARK: &str = "# Atelier landing guard";

pub fn install(root: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    let bd = crate::routes::find_bd().ok_or_else(|| "Beads is required for this project".to_string())?;
    if !root.join(".beads").is_dir() {
        let status = Command::new(&bd).args(["init", "--prefix", &manifest.beads.issue_id_prefix])
            .current_dir(root).status().map_err(|error| format!("could not start bd: {error}"))?;
        if !status.success() { return Err("bd init did not complete".to_string()); }
    }
    if let Some(git) = crate::routes::find_git() {
        let _ = Command::new(git).args(["config", "beads.role", "maintainer"]).current_dir(root).status();
    }
    wire(&root.join(".claude/settings.json"), CLAUDE)?;
    wire(&root.join(".codex/hooks.json"), CODEX)?;
    guard(root)?;
    Ok(())
}

pub fn remove(root: &Path) -> Result<(), String> {
    strip(&root.join(".claude/settings.json"))?;
    strip(&root.join(".codex/hooks.json"))?;
    let hook = git_hook(root);
    if std::fs::read_to_string(&hook).is_ok_and(|text| text.starts_with(GUARD_MARK)) {
        std::fs::remove_file(&hook).map_err(|error| format!("could not remove {}: {error}", hook.display()))?;
    }
    Ok(())
}

fn command_for(name: &str) -> String { format!("atelier hook {name}") }
fn runs(command: &Value, name: &str) -> bool {
    command.as_str().is_some_and(|command| command.split_whitespace().any(|word|
        Path::new(word).file_name().is_some_and(|file| file == name)))
}

fn read(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("kept {} unchanged because it does not parse: {error}", path.display()))?;
            if !value.is_object() { return Err(format!("kept {} unchanged because it is not an object", path.display())); }
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("could not read {}: {error}", path.display())),
    }
}

fn strip_value(value: &mut Value) {
    let Some(events) = value.get_mut("hooks").and_then(Value::as_object_mut) else { return; };
    for blocks in events.values_mut().filter_map(Value::as_array_mut) {
        for block in blocks.iter_mut().filter_map(Value::as_object_mut) {
            if let Some(hooks) = block.get_mut("hooks").and_then(Value::as_array_mut) {
                hooks.retain(|hook| !MANAGED.iter().any(|name| runs(&hook["command"], name)) &&
                    hook["command"].as_str() != Some("bd codex-hook UserPromptSubmit"));
            }
        }
        blocks.retain(|block| block["hooks"].as_array().is_some_and(|hooks| !hooks.is_empty()));
    }
}

fn strip(path: &Path) -> Result<(), String> {
    if !path.is_file() { return Ok(()); }
    let mut value = read(path)?;
    let before = value.clone();
    strip_value(&mut value);
    if value != before { write(path, &value)?; }
    Ok(())
}

fn wire(path: &Path, table: &[(&str, &str, &[&str])]) -> Result<(), String> {
    let mut value = read(path)?;
    wire_value(&mut value, table, path.ends_with("settings.json"));
    write(path, &value)
}

fn wire_value(value: &mut Value, table: &[(&str, &str, &[&str])], claude: bool) {
    strip_value(value);
    if !value["hooks"].is_object() { value["hooks"] = json!({}); }
    for (event, matcher, names) in table {
        if !value["hooks"][event].is_array() { value["hooks"][event] = json!([]); }
        let blocks = value["hooks"][event].as_array_mut().unwrap();
        let at = blocks.iter().position(|block| block["matcher"].as_str().unwrap_or("") == *matcher)
            .unwrap_or_else(|| { blocks.push(if matcher.is_empty() { json!({"hooks":[]}) } else { json!({"matcher":matcher,"hooks":[]}) }); blocks.len() - 1 });
        if !blocks[at]["hooks"].is_array() { blocks[at]["hooks"] = json!([]); }
        let hooks = blocks[at]["hooks"].as_array_mut().unwrap();
        for name in *names { hooks.push(json!({"type":"command","command":command_for(name)})); }
    }
    if claude {
        value.as_object_mut().unwrap().entry("autoCompactWindow").or_insert(json!(200000));
    }
}

fn write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("{} has no parent", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("atelier-new");
    std::fs::write(&temporary, [bytes, b"\n".to_vec()].concat())
        .map_err(|error| format!("could not write {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("could not replace {}: {error}", path.display()))
}

fn git_hook(root: &Path) -> PathBuf {
    let output = crate::routes::find_git().and_then(|git| Command::new(git)
        .args(["rev-parse", "--git-path", "hooks/reference-transaction"])
        .current_dir(root).output().ok());
    output.filter(|output| output.status.success())
        .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        .map(|path| if path.is_absolute() { path } else { root.join(path) })
        .unwrap_or_else(|| root.join(".git/hooks/reference-transaction"))
}

fn guard(root: &Path) -> Result<(), String> {
    let path = git_hook(root);
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !existing.starts_with(GUARD_MARK) {
            return Err(format!("kept {} unchanged because it is a project-owned Git hook", path.display()));
        }
    }
    let body = format!("{GUARD_MARK}\n#!/bin/sh\n[ \"$1\" = prepared ] || exit 0\ncommand -v atelier >/dev/null 2>&1 || exit 0\nexec atelier hook landing-gate \"$@\"\n");
    std::fs::write(&path, body).map_err(|error| format!("could not write {}: {error}", path.display()))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path).map_err(|error| error.to_string())?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_machinery_hook_wiring_preserves_neighboring_commands() {
        let mut value = json!({"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[
            {"type":"command","command":"my-project-hook"},
            {"type":"command","command":"python3 /old/machinery/hooks/board-status-gate.py"}
        ]}]}});
        strip_value(&mut value);
        let commands = value["hooks"]["PreToolUse"][0]["hooks"].as_array().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["command"], "my-project-hook");
    }

    fn pretool(value: &Value) -> Vec<&str> {
        value["hooks"]["PreToolUse"].as_array().into_iter().flatten()
            .flat_map(|block| block["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str()).collect()
    }

    #[test]
    fn native_machinery_provider_wiring_has_equivalent_repository_gates() {
        let mut claude = json!({});
        let mut codex = json!({});
        wire_value(&mut claude, CLAUDE, true);
        wire_value(&mut codex, CODEX, false);
        let required = ["atelier hook workflow-gate", "atelier hook board-actor",
            "atelier hook board-merge-gate", "atelier hook board-status-gate"];
        for command in required {
            assert!(pretool(&claude).contains(&command), "Claude lacks {command}");
            assert!(pretool(&codex).contains(&command), "Codex lacks {command}");
        }
    }

    #[test]
    fn native_machinery_wiring_preserves_neighboring_user_hooks() {
        for (table, claude) in [(CLAUDE, true), (CODEX, false)] {
            let mut value = json!({"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[
                {"type":"command","command":"my-project-hook"}
            ]}]}});
            wire_value(&mut value, table, claude);
            assert!(pretool(&value).contains(&"my-project-hook"));
        }
    }

    #[test]
    fn native_machinery_guard_refuses_to_overwrite_a_project_hook() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        let hooks = root.path().join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let path = hooks.join("reference-transaction");
        std::fs::write(&path, "#!/bin/sh\necho project\n").unwrap();
        let error = guard(root.path()).unwrap_err();
        assert!(error.contains("project-owned"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "#!/bin/sh\necho project\n");
    }
}
