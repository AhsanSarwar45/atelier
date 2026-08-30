//! The project registry (`projects.toml`) read natively, and the beads/chat mode
//! it answers for a path — the port of `machinery/join --mode` (bw-oesd.1.2).
//!
//! `join --mode PATH` prints `beads` when the path, or the Git repository it
//! belongs to, is a registered project, and `chat` otherwise. That is a registry
//! lookup and two `git rev-parse` calls, so it needs no Python.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Every registered project, name to on-disk path, dropping any path no longer
/// present — mirrors `project.registry()`.
///
/// `data_dir` is the personal Atelier data home; `machinery` is the rules'
/// machinery folder, holding the legacy registry `project.py` falls back to when
/// the personal one is absent.
pub fn registry(data_dir: &Path, machinery: &Path) -> BTreeMap<String, PathBuf> {
    let primary = data_dir.join("projects.toml");
    let source = if primary.exists() {
        primary
    } else {
        machinery.join("projects.toml")
    };
    let mut out = BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(&source) else {
        return out;
    };
    let Ok(value) = text.parse::<toml::Value>() else {
        return out;
    };
    let Some(projects) = value.get("projects").and_then(|p| p.as_table()) else {
        return out;
    };
    for (name, path) in projects {
        if let Some(raw) = path.as_str() {
            let expanded = expanduser(raw);
            if expanded.exists() {
                out.insert(name.clone(), expanded);
            }
        }
    }
    out
}

/// `beads` when this path (or its Git repository) is a registered project,
/// `chat` otherwise — the string `join --mode` prints.
pub fn mode(root: &Path, data_dir: &Path, machinery: &Path) -> &'static str {
    if registered_root(root, data_dir, machinery).is_some() {
        "beads"
    } else {
        "chat"
    }
}

/// The registered main checkout for a path, including its linked worktrees, or
/// None — mirrors `registered_root`.
fn registered_root(root: &Path, data_dir: &Path, machinery: &Path) -> Option<PathBuf> {
    let root = std::fs::canonicalize(root).ok()?;
    let known = registry(data_dir, machinery);
    for registered in known.values() {
        if std::fs::canonicalize(registered)
            .map(|c| c == root)
            .unwrap_or(false)
        {
            return Some(registered.clone());
        }
    }
    let identity = git_identity(&root)?;
    for registered in known.values() {
        if git_identity(registered)
            .map(|g| g == identity)
            .unwrap_or(false)
        {
            return Some(registered.clone());
        }
    }
    None
}

/// The one Git repository shared by a checkout and its worktrees — the realpath
/// of `git rev-parse --git-common-dir`, or None. Mirrors `git_identity`.
fn git_identity(root: &Path) -> Option<PathBuf> {
    let done = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !done.status.success() {
        return None;
    }
    let common = String::from_utf8_lossy(&done.stdout).trim().to_string();
    if common.is_empty() {
        return None;
    }
    let common = Path::new(&common);
    let joined = if common.is_absolute() {
        common.to_path_buf()
    } else {
        root.join(common)
    };
    std::fs::canonicalize(&joined).ok()
}

fn expanduser(path: &str) -> PathBuf {
    if path == "~" {
        return home().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(args: &[&str], cwd: &Path) {
        let done = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git to run");
        assert!(
            done.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&done.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(&["init", "-q"], dir);
        git(&["config", "user.email", "t@t"], dir);
        git(&["config", "user.name", "t"], dir);
        std::fs::write(dir.join("f"), "x").unwrap();
        git(&["add", "."], dir);
        git(&["commit", "-qm", "one"], dir);
    }

    fn what_join_mode_says(machinery: &Path, data_dir: &Path, target: &Path) -> Option<String> {
        let join = machinery.join("join");
        if !join.is_file() {
            return None;
        }
        let python = crate::routes::find_python()?;
        let done = std::process::Command::new(python)
            .arg(&join)
            .arg("--mode")
            .arg(target)
            .env("ATELIER_DATA_DIR", data_dir)
            .env("HOME", data_dir.join("home"))
            .output()
            .ok()?;
        assert!(
            done.status.success(),
            "join --mode failed: {}",
            String::from_utf8_lossy(&done.stderr)
        );
        Some(String::from_utf8_lossy(&done.stdout).trim().to_string())
    }

    /// The differential case: for a registered project, a linked worktree of it,
    /// and an unrelated repository, the native lookup returns the same word
    /// `machinery/join --mode` prints.
    #[test]
    fn mode_lookup_matches_join_mode_for_every_declared_mode() {
        let machinery =
            std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
                .unwrap()
                .join("machinery");
        let scratch = tempfile::tempdir().expect("a folder");
        let data_dir = scratch.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();

        let main = scratch.path().join("main");
        let other = scratch.path().join("other");
        init_repo(&main);
        init_repo(&other);
        let worktree = scratch.path().join("wt");
        git(
            &["worktree", "add", "-q", worktree.to_str().unwrap()],
            &main,
        );

        // Register the main checkout only. Worktree resolves to it by git
        // identity; `other` is registered nowhere.
        std::fs::write(
            data_dir.join("projects.toml"),
            format!("[projects]\nproj = \"{}\"\n", main.display()),
        )
        .unwrap();

        for target in [&main, &worktree, &other] {
            let Some(theirs) = what_join_mode_says(&machinery, &data_dir, target) else {
                eprintln!("no python on this computer, so the two were not compared");
                return;
            };
            let ours = mode(target, &data_dir, &machinery);
            assert_eq!(
                ours,
                theirs.as_str(),
                "native mode disagrees with join --mode for {}",
                target.display()
            );
        }
    }
}
