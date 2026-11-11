//! Taking back what older versions wired into a project for the board.
//!
//! Atelier used to join a project to Beads: it ran `bd init`, wrote its board,
//! landing and review gates into `.claude/settings.json` and
//! `.codex/hooks.json` as `atelier hook <name>`, put a Goose plugin carrying the
//! same gates under its own Goose home, and installed a Git
//! `reference-transaction` guard. Beads is gone, so all of that is taken out
//! again — and only that: an entry is removed only when it runs one of the
//! names Atelier itself wrote, so the project's own hooks, and every other key
//! in those files, are left exactly as they were.
//!
//! `doing` is the exception. It is not a board gate: it tells the screen a
//! Claude chat this program does not drive is compacting or waiting on a
//! permission prompt, and it still works, so a project that has it keeps it.
//!
//! Until a project has been tidied, its stale entries still run, and
//! `rules::hook` answers every retired name with a silent allow.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Every hook name an Atelier version ever wrote into a project, except
/// `doing`, which still runs.
const RETIRED: &[&str] = &[
    "workflow-gate", "board-actor", "board-merge-gate", "board-status-gate",
    "wait-gate", "board-touch", "board-prime", "board-push", "completion-gate",
    "board-gate", "landing-gate",
    "workflow-gate.py", "board-actor.py", "board-merge-gate.py",
    "board-status-gate.py", "wait-gate.py", "board-touch.py",
    "board-prime.py", "board-push.py", "completion-gate.py", "board-gate.py",
    "landing-gate.py",
    "report-gate.py", "publish-gate.py", "plan-doc-lint.py", "picture-gate.py",
    "agent-fence.py", "slice-gate.py", "helper-proof.py", "habit-reading.py",
];

/// The one line Beads itself added to Codex beside Atelier's gates, which
/// Atelier always took out with them.
const BD_CODEX_HOOK: &str = "bd codex-hook UserPromptSubmit";

/// The first lines of the Git guard Atelier installed.
const GUARD_MARK: &str = "# Atelier landing guard";

/// Where Goose looks for a plugin of its own, given the home Atelier gives it.
pub fn goose_plugin_dir(path_root: &Path) -> PathBuf {
    path_root.join(".agents").join("plugins").join("atelier")
}

/// Take the retired gates out of a project: its Claude and Codex hook files,
/// and the Git guard. Nothing is written when nothing needs to change.
pub fn tidy(root: &Path) -> Result<(), String> {
    let mut errors = Vec::new();
    for path in [root.join(".claude/settings.json"), root.join(".codex/hooks.json")] {
        if let Err(error) = strip(&path) {
            errors.push(error);
        }
    }
    if let Err(error) = remove_guard(root) {
        errors.push(error);
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

/// Take the retired gates out of the Goose plugin under `path_root`, and the
/// plugin itself when nothing else is left in it.
pub fn tidy_goose_plugin(path_root: &Path) -> Result<(), String> {
    let plugin = goose_plugin_dir(path_root);
    let hooks_dir = plugin.join("hooks");
    let hooks = hooks_dir.join("hooks.json");
    if !plugin.exists() {
        return Ok(());
    }
    strip(&hooks)?;
    let empty = match std::fs::read(&hooks) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().is_some_and(|value| {
            value.as_object().is_some_and(|object| {
                object.iter().all(|(key, value)| key == "hooks" && value.as_object().is_some_and(|events| events.is_empty()))
            })
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    };
    if !empty {
        return Ok(());
    }
    let ours = std::fs::read(plugin.join("plugin.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_none_or(|manifest| manifest["name"] == "atelier");
    if !ours {
        return Ok(());
    }
    for file in [hooks.clone(), plugin.join("plugin.json")] {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not remove {}: {error}", file.display())),
        }
    }
    let _ = std::fs::remove_dir(&hooks_dir);
    let _ = std::fs::remove_dir(&plugin);
    Ok(())
}

fn runs(command: &Value, name: &str) -> bool {
    command.as_str().is_some_and(|command| command.split_whitespace().any(|word|
        Path::new(word).file_name().is_some_and(|file| file == name)))
}

fn retired(hook: &Value) -> bool {
    RETIRED.iter().any(|name| runs(&hook["command"], name))
        || hook["command"].as_str() == Some(BD_CODEX_HOOK)
}

fn strip_value(value: &mut Value) {
    let Some(events) = value.get_mut("hooks").and_then(Value::as_object_mut) else { return; };
    for blocks in events.values_mut().filter_map(Value::as_array_mut) {
        let mut emptied = Vec::new();
        for (at, block) in blocks.iter_mut().enumerate() {
            let Some(hooks) = block.get_mut("hooks").and_then(Value::as_array_mut) else { continue; };
            let before = hooks.len();
            hooks.retain(|hook| !retired(hook));
            if hooks.is_empty() && before > 0 {
                emptied.push(at);
            }
        }
        // Only a block this took the last entry out of goes; one the project
        // left empty itself is the project's business.
        for at in emptied.into_iter().rev() {
            blocks.remove(at);
        }
    }
    events.retain(|_, blocks| blocks.as_array().is_none_or(|blocks| !blocks.is_empty()));
}

fn strip(path: &Path) -> Result<(), String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
    };
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("kept {} unchanged because it does not parse: {error}", path.display()))?;
    if !value.is_object() {
        return Ok(());
    }
    let before = value.clone();
    strip_value(&mut value);
    if value != before { write(path, &value)?; }
    Ok(())
}

fn write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("{} has no parent", path.display()))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("atelier-new");
    std::fs::create_dir_all(parent).map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    std::fs::write(&temporary, [bytes, b"\n".to_vec()].concat())
        .map_err(|error| format!("could not write {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("could not replace {}: {error}", path.display()))
}

fn git_hook(root: &Path) -> Option<PathBuf> {
    if !root.join(".git").exists() {
        return None;
    }
    let output = crate::routes::find_git().and_then(|git| Command::new(git)
        .args(["rev-parse", "--git-path", "hooks/reference-transaction"])
        .current_dir(root).output().ok());
    Some(output.filter(|output| output.status.success())
        .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        .map(|path| if path.is_absolute() { path } else { root.join(path) })
        .unwrap_or_else(|| root.join(".git/hooks/reference-transaction")))
}

fn remove_guard(root: &Path) -> Result<(), String> {
    let Some(hook) = git_hook(root) else { return Ok(()); };
    if std::fs::read_to_string(&hook).is_ok_and(|text| text.lines().take(2).any(|line| line == GUARD_MARK)) {
        std::fs::remove_file(&hook).map_err(|error| format!("could not remove {}: {error}", hook.display()))?;
    }
    Ok(())
}

/// Tidy every project this computer has registered, in the background, once
/// per start. A project that cannot be read is skipped; it is tidied the next
/// time it is set up or the app starts.
pub fn tidy_registered(db: std::sync::Arc<crate::db::Database>) {
    std::thread::spawn(move || {
        let Ok(projects) = db.get_projects_filtered(true, false) else { return; };
        for project in projects {
            let raw = project.local_path.as_deref().unwrap_or(&project.path);
            let root = Path::new(raw);
            if !root.is_dir() {
                continue;
            }
            if let Err(error) = tidy(root) {
                tracing::warn!(project = %project.name, %error, "could not take retired board hooks out");
            }
        }
        if let Some(goose) = crate::identity::data_dir().map(|dir| dir.join("goose")) {
            if let Err(error) = tidy_goose_plugin(&goose) {
                tracing::warn!(%error, "could not take the retired Goose gate plugin out");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn commands(value: &Value) -> Vec<String> {
        value["hooks"].as_object().into_iter().flatten()
            .flat_map(|(_, blocks)| blocks.as_array().into_iter().flatten())
            .flat_map(|block| block["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str().map(str::to_string)).collect()
    }

    /// What `atelier init` wrote into a Beads project, beside the project's own.
    fn old_settings() -> Value {
        json!({
            "permissions": {"allow": ["Bash(npm test)"]},
            "autoCompactWindow": 200000,
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit", "hooks": [
                        {"type": "command", "command": "atelier hook workflow-gate"}]},
                    {"matcher": "Bash", "hooks": [
                        {"type": "command", "command": "my-project-hook"},
                        {"type": "command", "command": "atelier hook board-actor"},
                        {"type": "command", "command": "atelier hook board-merge-gate"},
                        {"type": "command", "command": "python3 /old/machinery/hooks/board-status-gate.py"}]}
                ],
                "SessionStart": [{"hooks": [{"type": "command", "command": "atelier hook board-prime"}]}],
                "Stop": [{"hooks": [{"type": "command", "command": "atelier hook board-gate"}]}],
                "PreCompact": [{"hooks": [{"type": "command", "command": "atelier hook doing"}]}],
                "Notification": [{"hooks": [{"type": "command", "command": "atelier hook doing"}]}],
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "bd codex-hook UserPromptSubmit"}]}]
            }
        })
    }

    #[test]
    fn tidying_takes_out_only_the_retired_gates() {
        let mut value = old_settings();
        strip_value(&mut value);
        let mut left = commands(&value);
        left.sort();
        assert_eq!(left, vec!["atelier hook doing", "atelier hook doing", "my-project-hook"]);
        assert_eq!(value["permissions"]["allow"][0], "Bash(npm test)");
        assert_eq!(value["autoCompactWindow"], 200000);
        assert!(value["hooks"].get("SessionStart").is_none());
        assert!(value["hooks"].get("Stop").is_none());
        assert_eq!(value["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_tidy_project_file_is_not_rewritten() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".claude/settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"mine\"}]}]}}";
        std::fs::write(&path, text).unwrap();
        tidy(root.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn tidying_a_project_cleans_both_providers_and_the_guard() {
        let root = tempfile::tempdir().unwrap();
        Command::new("git").arg("init").arg("-q").arg(root.path()).status().unwrap();
        for file in [".claude/settings.json", ".codex/hooks.json"] {
            let path = root.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, serde_json::to_string(&old_settings()).unwrap()).unwrap();
        }
        let guard = root.path().join(".git/hooks/reference-transaction");
        std::fs::write(&guard, format!("#!/bin/sh\n{GUARD_MARK}\nexec atelier hook landing-gate \"$@\"\n")).unwrap();
        tidy(root.path()).unwrap();
        for file in [".claude/settings.json", ".codex/hooks.json"] {
            let value: Value = serde_json::from_str(&std::fs::read_to_string(root.path().join(file)).unwrap()).unwrap();
            assert!(commands(&value).iter().all(|command| !command.contains("board") && !command.contains("workflow")));
        }
        assert!(!guard.exists());
    }

    #[test]
    fn a_project_owned_git_hook_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        Command::new("git").arg("init").arg("-q").arg(root.path()).status().unwrap();
        let path = root.path().join(".git/hooks/reference-transaction");
        std::fs::write(&path, "#!/bin/sh\necho project\n").unwrap();
        tidy(root.path()).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "#!/bin/sh\necho project\n");
    }

    #[test]
    fn a_file_that_does_not_parse_is_kept_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".claude/settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(tidy(root.path()).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{ not json");
    }

    #[test]
    fn the_goose_plugin_goes_when_only_retired_gates_were_in_it() {
        let root = tempfile::tempdir().unwrap();
        let plugin = goose_plugin_dir(root.path());
        std::fs::create_dir_all(plugin.join("hooks")).unwrap();
        std::fs::write(plugin.join("plugin.json"), r#"{"name":"atelier","version":"1"}"#).unwrap();
        std::fs::write(plugin.join("hooks/hooks.json"), serde_json::to_string(&json!({"hooks":{
            "PreToolUse":[{"matcher":"developer__shell","hooks":[{"type":"command","command":"atelier hook workflow-gate"}]}],
            "Stop":[{"hooks":[{"type":"command","command":"atelier hook board-gate"}]}]
        }})).unwrap()).unwrap();
        tidy_goose_plugin(root.path()).unwrap();
        assert!(!plugin.exists());
        // And twice is once.
        tidy_goose_plugin(root.path()).unwrap();
    }
}
