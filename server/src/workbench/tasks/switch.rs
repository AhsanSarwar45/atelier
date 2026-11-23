//! The owner's "Use tasks" switch (docs/tasks.md, "Turning tasks off").
//!
//! The install's choice lives in `tasks.json` in the data folder, a project's
//! in `tasks.json` beside its task types (`catalog::project_dir`). A project's
//! choice wins; with neither set, tasks are on. Where tasks are off, a chat
//! is told nothing of tasks or grids and `atelier task` and `atelier grid`
//! refuse.
//!
//! The same file keeps the owner's "Require approval" choice under
//! `approval`, scoped the same way: with it off, an agent creates the task it
//! needs itself, with no `@task` and no proposal waiting on the owner.

use serde_json::json;
use std::{fs, path::{Path, PathBuf}};

const FILE: &str = "tasks.json";

/// What `atelier task` and `atelier grid` print where tasks are off, naming
/// the switch that turned them off: the project's own, or the app's.
pub fn off_message(data: &Path, root: Option<&Path>) -> String {
    let project = root.and_then(|root| project_folder(data, root)).and_then(|folder| read(&folder));
    let scope = if project == Some(false) { "this project" } else { "this app" };
    format!("Tasks are turned off for {scope}. The owner can turn them on in Settings → Tasks.")
}

/// The Use tasks choice saved in `folder`, if one is.
pub fn read(folder: &Path) -> Option<bool> {
    read_key(folder, ENABLED)
}

/// Saves the Use tasks choice in `folder`, or forgets it when it is `None`.
pub fn write(folder: &Path, enabled: Option<bool>) -> Result<(), String> {
    write_key(folder, ENABLED, enabled)
}

/// Use tasks, saved as `enabled`.
pub const ENABLED: &str = "enabled";
/// Require approval, saved as `approval`.
pub const APPROVAL: &str = "approval";

/// The choice saved under `key` in `folder`, if one is.
pub fn read_key(folder: &Path, key: &str) -> Option<bool> {
    saved(folder).get(key)?.as_bool()
}

/// Saves `value` under `key` in `folder`, or forgets it when it is `None`,
/// keeping the file's other choices. A file left with no choice is removed.
pub fn write_key(folder: &Path, key: &str, value: Option<bool>) -> Result<(), String> {
    let path = folder.join(FILE);
    let mut choices = saved(folder);
    match value {
        Some(on) => { choices.insert(key.to_string(), json!(on)); }
        None => { choices.remove(key); }
    }
    if choices.is_empty() {
        return match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        };
    }
    fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    crate::workbench::provider_defaults::atomic_write(&path, serde_json::Value::Object(choices).to_string().as_bytes())
}

fn saved(folder: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read_to_string(folder.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// The folder a project's choice is saved in.
pub fn project_folder(data: &Path, root: &Path) -> Option<PathBuf> {
    super::catalog::project_dir(data, root)
}

/// Whether tasks are on for the project in `root` (or the install alone).
pub fn enabled(data: &Path, root: Option<&Path>) -> bool {
    applies(data, root, ENABLED)
}

/// Whether an agent must ask the owner before it creates a task, for the
/// project in `root` (or the install alone).
pub fn approval(data: &Path, root: Option<&Path>) -> bool {
    applies(data, root, APPROVAL)
}

/// The project's choice under `key`, else the install's; on when neither is set.
fn applies(data: &Path, root: Option<&Path>, key: &str) -> bool {
    root.and_then(|root| project_folder(data, root))
        .and_then(|folder| read_key(&folder, key))
        .or_else(|| read_key(data, key))
        .unwrap_or(true)
}

/// `off_message` for where this process runs.
pub fn off_here() -> String {
    let data = crate::workbench::library::data_dir().unwrap_or_default();
    off_message(&data, std::env::current_dir().ok().as_deref())
}

/// Whether tasks are on where this process runs: the CLI's check, made
/// before it reaches the app.
pub fn here() -> bool {
    let Ok(data) = crate::workbench::library::data_dir() else { return true };
    enabled(&data, std::env::current_dir().ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_unless_a_scope_says_otherwise_and_the_project_wins() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        assert!(enabled(data.path(), Some(root.path())));
        write(data.path(), Some(false)).unwrap();
        assert!(!enabled(data.path(), Some(root.path())));
        let project = project_folder(data.path(), root.path()).unwrap();
        write(&project, Some(true)).unwrap();
        assert!(enabled(data.path(), Some(root.path())));
        write(&project, None).unwrap();
        write(&project, None).unwrap();
        assert!(!enabled(data.path(), Some(root.path())));
        assert!(off_message(data.path(), Some(root.path())).contains("for this app"));
        write(&project, Some(false)).unwrap();
        assert!(off_message(data.path(), Some(root.path())).contains("for this project"));
    }
}
