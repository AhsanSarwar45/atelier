//! The owner's "Use tasks" switch (docs/tasks.md, "Turning tasks off").
//!
//! The install's choice lives in `tasks.json` in the data folder, a project's
//! in `tasks.json` beside its task types (`catalog::project_dir`). A project's
//! choice wins; with neither set, tasks are on. Where tasks are off, a chat
//! is told nothing of tasks or grids and `atelier task` and `atelier grid`
//! refuse.

use serde_json::json;
use std::{fs, path::{Path, PathBuf}};

const FILE: &str = "tasks.json";

/// What `atelier task` and `atelier grid` print where tasks are off.
pub const OFF: &str = "Tasks are turned off for this project. The owner can turn them on in Settings → Tasks.";

/// The choice saved in `folder`, if one is.
pub fn read(folder: &Path) -> Option<bool> {
    let text = fs::read_to_string(folder.join(FILE)).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("enabled")?.as_bool()
}

/// Saves `enabled` in `folder`, or forgets the choice when it is `None`.
pub fn write(folder: &Path, enabled: Option<bool>) -> Result<(), String> {
    let path = folder.join(FILE);
    match enabled {
        Some(on) => {
            fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
            crate::workbench::provider_defaults::atomic_write(&path, json!({"enabled": on}).to_string().as_bytes())
        }
        None => match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
            _ => Ok(()),
        },
    }
}

/// The folder a project's choice is saved in.
pub fn project_folder(data: &Path, root: &Path) -> Option<PathBuf> {
    super::catalog::project_dir(data, root)
}

/// Whether tasks are on for the project in `root` (or the install alone).
pub fn enabled(data: &Path, root: Option<&Path>) -> bool {
    root.and_then(|root| project_folder(data, root))
        .and_then(|folder| read(&folder))
        .or_else(|| read(data))
        .unwrap_or(true)
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
    }
}
