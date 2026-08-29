//! Route handlers for the atelier API.
//!
//! This module contains all HTTP route handlers.
//! Additional handlers will be added as API endpoints are implemented.

pub mod beads;
pub mod cli;
pub mod dolt;
pub mod fs;
pub mod git;
pub mod live;
pub mod projects;
pub mod version;
pub mod watch;
pub mod workbench;
pub mod worktree;

pub use projects::project_routes;
pub use watch::watch_beads;

use axum::{response::IntoResponse, Json};
use directories::UserDirs;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Health check response structure.
///
/// It used to answer `ok` and nothing else, which is true of any copy of any
/// build and so cannot settle the one question that actually gets asked: which
/// copy is this? A reader with two builds installed had no way to tell which
/// of them was serving, and the program starting up beside it had no way to
/// name the copy already holding the port (bw-8um.3.10.3).
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    /// Whose answer this is, so a stranger on the port is not mistaken for us.
    pub product: &'static str,
    pub version: &'static str,
    /// The exact file, where the version alone cannot tell two builds apart.
    pub build: &'static str,
    /// The program behind this copy, as this computer names it.
    pub program: Option<String>,
    pub since: &'static str,
}

/// Health check endpoint handler.
///
/// Returns a JSON response indicating the server is running, and which copy of
/// it is doing the running.
pub async fn health() -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok",
        product: crate::identity::NAME,
        version: env!("CARGO_PKG_VERSION"),
        build: crate::handover::fingerprint(),
        program: crate::handover::program().map(|p| p.display().to_string()),
        since: crate::handover::started_at(),
    })
}

/// Every answer the search has given, one to a tool name.
///
/// This was a single `OnceLock` holding the one answer about `bd`, so the first
/// "not on this computer" outlived the install that fixed it: a reader who
/// installed the tool while Atelier was up had to restart it before their
/// boards would load (bw-oxrg). An answer kept here can be dropped.
static TOOLS: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();

/// Drop every remembered answer, so the next lookup searches this computer
/// afresh.
///
/// This is what makes a tool installed after startup findable without one:
/// the reader is told what to install, and the attempt after they have done it
/// must go and look rather than repeat what we knew before.
pub fn forget_tools() {
    if let Some(tools) = TOOLS.get() {
        if let Ok(mut tools) = tools.lock() {
            tools.clear();
        }
    }
}

/// The remembered answer about a tool, or the one a fresh search gives.
///
/// The lock is not held while the search runs: it starts programs and reads
/// the disk, and two callers asking at once should wait on each other for
/// neither.
fn remembered(name: &str, look: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let tools = TOOLS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(seen) = tools.lock() {
        if let Some(answer) = seen.get(name) {
            return answer.clone();
        }
    }
    let found = look();
    if let Ok(mut seen) = tools.lock() {
        seen.insert(name.to_string(), found.clone());
    }
    found
}

/// A tool's name as this computer spells the file behind it: on Windows the
/// ending is part of the name, and everywhere else it is not.
fn spelt_here(name: &str) -> Vec<String> {
    let ending = std::env::consts::EXE_SUFFIX;
    if ending.is_empty() || name.ends_with(ending) {
        vec![name.to_string()]
    } else {
        vec![format!("{name}{ending}"), name.to_string()]
    }
}

/// The places a tool is looked for beyond the reader's own PATH.
///
/// Every one of them is somewhere an installer puts a program without asking
/// anybody to touch a shell profile, which is the case a service started
/// outside a shell cannot otherwise see.
fn tool_dirs() -> Vec<PathBuf> {
    let Some(home) = UserDirs::new().map(|d| d.home_dir().to_path_buf()) else {
        return vec![];
    };
    let mut dirs = vec![
        home.join(".cargo").join("bin"),
        home.join(".local").join("bin"),
        home.join(".beads").join("bin"),
    ];
    if !cfg!(windows) {
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// The search itself, over places handed in rather than the ones this computer
/// happens to have, so it can be put to a directory a test owns.
///
/// A spelling is tried everywhere before the next one is tried anywhere: a
/// reader with both `python3` and `python` gets the one asked for first,
/// wherever it sits, rather than whichever of them the earlier directory holds.
fn search_in(dirs: &[PathBuf], spellings: &[&str]) -> Option<PathBuf> {
    for name in spellings {
        for spelt in spelt_here(name) {
            for dir in dirs {
                let file = dir.join(&spelt);
                if file.is_file() {
                    return Some(file);
                }
            }
        }
    }
    None
}

/// The reader's own list of places, asked in the way this computer answers it.
///
/// The question goes to `which`/`where` rather than being walked here because
/// on Windows the file behind a name is not the name: `bd` installed the way
/// we tell people to install it, with npm, is `bd.cmd`, and only that lookup
/// knows every ending a name may be worn with.
fn on_path(spellings: &[&str]) -> Option<PathBuf> {
    let lookup = if cfg!(windows) { "where" } else { "which" };
    for name in spellings {
        let Ok(output) = std::process::Command::new(lookup).arg(name).output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let path = PathBuf::from(text.lines().next().unwrap_or("").trim());
        if path.exists() {
            return Some(path);
        }
    }
    None
}

/// Where a named tool is on this computer, if it is here at all.
///
/// `name` is what we call the tool and what its answer is remembered under;
/// `others` are the other spellings the same tool wears. PATH is asked first,
/// then the usual install places.
pub fn find_tool(name: &str, others: &[&str]) -> Option<PathBuf> {
    remembered(name, || {
        let mut spellings = vec![name];
        spellings.extend_from_slice(others);
        let dirs = tool_dirs();
        let found = on_path(&spellings).or_else(|| search_in(&dirs, &spellings));
        match &found {
            Some(path) => tracing::info!("Found {} at: {}", name, path.display()),
            None => tracing::warn!(
                "{} not found. Searched PATH and: {}",
                name,
                dirs.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
            ),
        }
        found
    })
}

/// What to tell a reader whose computer has no `bd` on it.
///
/// One wording, because the two routes that write cards and the one that runs
/// the tool outright all answer the same question when the answer is no.
pub const BD_MISSING: &str =
    "bd CLI not found. Install beads (https://github.com/gastownhall/beads) or add bd to PATH.";

/// Where the `bd` CLI is, if this computer has it.
pub fn find_bd() -> Option<PathBuf> {
    find_tool("bd", &[])
}

/// Where python is, if this computer has it.
///
/// Both spellings are tried, because the one on a Windows path is usually the
/// shorter. With only `python3` asked for, `atelier init` succeeds there and
/// then every board lifecycle transition is denied by a gate that could not be
/// started (bw-oxrg).
pub fn find_python() -> Option<PathBuf> {
    find_tool("python3", &["python"])
}

/// Where the chat helper's runtime is, if this computer has it.
pub fn find_node() -> Option<PathBuf> {
    find_tool("node", &[])
}

/// Where npm is, if this computer has it.
///
/// The Windows spelling is asked for by name as well. There the file behind
/// `npm` is `npm.cmd`, and while the lookup this computer answers with knows
/// that, the install places are walked by file name and would not.
pub fn find_npm() -> Option<PathBuf> {
    find_tool("npm", &["npm.cmd"])
}

/// Validates that a path is safe to access.
///
/// # Security
///
/// This function ensures that:
/// - The path can be canonicalized (no path traversal attacks)
/// - On Windows: the path is on a local drive (not a UNC network path)
/// - On Unix: the path is within the user's home directory
///
/// # Returns
///
/// - `Ok(())` if the path is valid and within allowed directories
/// - `Err(String)` with an error message if validation fails
pub fn validate_path_security(path: &Path) -> Result<(), String> {
    // Reject dolt:// virtual paths — these are not filesystem paths
    if path.to_string_lossy().starts_with("dolt://") {
        return Err("dolt:// paths cannot be used for filesystem operations".to_string());
    }

    // Canonicalize paths for comparison (resolves symlinks and ..)
    let canonical_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // If path doesn't exist yet, check the parent
            if let Some(parent) = path.parent() {
                match parent.canonicalize() {
                    Ok(p) => p.join(path.file_name().unwrap_or_default()),
                    Err(_) => return Err("Invalid path".to_string()),
                }
            } else {
                return Err("Invalid path".to_string());
            }
        }
    };

    // On Windows, allow any local drive but block UNC network paths.
    // On Unix, restrict to the user's home directory.
    if cfg!(windows) {
        let path_str = canonical_path.to_string_lossy();
        // Windows canonicalize produces \\?\C:\... (extended-length path prefix).
        // Strip that prefix before checking for actual UNC paths.
        let normalized = path_str
            .strip_prefix("\\\\?\\")
            .unwrap_or(&path_str);
        // Real UNC paths: \\server\share or \\?\UNC\server\share
        if normalized.starts_with("\\\\") || normalized.starts_with("UNC\\") {
            return Err("Access denied: network (UNC) paths are not allowed".to_string());
        }
        // Must start with a drive letter like C:\
        if !normalized.starts_with(|c: char| c.is_ascii_alphabetic()) {
            return Err("Access denied: invalid path".to_string());
        }
    } else {
        let user_dirs = match UserDirs::new() {
            Some(u) => u,
            None => return Err("Could not determine user directories".to_string()),
        };

        let home_dir = user_dirs.home_dir();

        let canonical_home = match home_dir.canonicalize() {
            Ok(h) => h,
            Err(_) => return Err("Could not canonicalize home directory".to_string()),
        };

        if !canonical_path.starts_with(&canonical_home) {
            return Err("Access denied: path must be within home directory".to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_validate_home_path() {
        if let Some(user_dirs) = UserDirs::new() {
            let test_path = user_dirs.home_dir().join("test");
            // This might fail if test doesn't exist, but the parent check should work
            let result = validate_path_security(&test_path);
            // Should either succeed or fail with "Invalid path" (if test doesn't exist)
            assert!(result.is_ok() || result.unwrap_err().contains("Invalid"));
        }
    }

    /// A file standing in for an installed tool, in a place the test owns.
    fn install(dir: &Path, name: &str) -> PathBuf {
        let file = dir.join(name);
        std::fs::write(&file, "#!/bin/sh\nexit 0\n").expect("write the tool out");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
                .expect("make the tool runnable");
        }
        file
    }

    /// A tool installed after the first look is found once the remembered
    /// answer is dropped, with no restart in between (bw-oxrg).
    #[test]
    fn a_tool_installed_late_is_found_once_the_answer_is_dropped() {
        let place = tempfile::tempdir().expect("a directory of our own");
        let name = "atelier-tool-installed-late";
        let look = || search_in(&[place.path().to_path_buf()], &[name]);

        assert_eq!(remembered(name, look), None, "nothing is there to find yet");

        let tool = install(place.path(), name);
        assert_eq!(
            remembered(name, look),
            None,
            "the answer we gave first is the one we keep giving"
        );

        forget_tools();
        assert_eq!(
            remembered(name, look),
            Some(tool),
            "and dropping it sends the next caller looking again"
        );
    }

    /// The scripting tool answers to two names, and a computer holding only
    /// the shorter one still has python on it.
    #[test]
    fn the_scripting_tool_is_found_under_either_spelling() {
        let place = tempfile::tempdir().expect("a directory of our own");
        let dirs = [place.path().to_path_buf()];

        let shorter = install(place.path(), "python");
        assert_eq!(
            search_in(&dirs, &["python3", "python"]),
            Some(shorter),
            "the spelling a Windows computer usually has is the only one here"
        );

        let asked_for = install(place.path(), "python3");
        assert_eq!(
            search_in(&dirs, &["python3", "python"]),
            Some(asked_for),
            "and where both are here, the spelling asked for first wins"
        );
    }

    /// The fetcher answers to two names too: on Windows the file behind `npm`
    /// is `npm.cmd`, and a place is walked by the file names in it.
    #[test]
    fn the_fetcher_is_found_under_its_windows_spelling() {
        let place = tempfile::tempdir().expect("a directory of our own");
        let dirs = [place.path().to_path_buf()];

        let windows = install(place.path(), "npm.cmd");
        assert_eq!(
            search_in(&dirs, &["npm", "npm.cmd"]),
            Some(windows),
            "the only npm here is the one wearing the ending Windows gives it"
        );
    }

    /// A place that holds nothing is not an answer.
    #[test]
    fn an_empty_place_finds_nothing() {
        let place = tempfile::tempdir().expect("a directory of our own");
        assert_eq!(search_in(&[place.path().to_path_buf()], &["bd"]), None);
    }

    #[test]
    fn test_reject_unsafe_paths() {
        if cfg!(windows) {
            // UNC paths should be rejected
            let result = validate_path_security(&PathBuf::from("\\\\server\\share\\file"));
            assert!(result.is_err());
            let err_msg = result.unwrap_err();
            assert!(err_msg.contains("denied") || err_msg.contains("Invalid") || err_msg.contains("network"));
        } else {
            // Unix: paths outside home should be rejected
            let result = validate_path_security(&PathBuf::from("/etc/passwd"));
            assert!(result.is_err());
            let err_msg = result.unwrap_err();
            assert!(err_msg.contains("denied") || err_msg.contains("Invalid"));
        }
    }
}
