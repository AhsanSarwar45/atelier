//! Route handlers for the atelier API.
//!
//! This module contains all HTTP route handlers.
//! Additional handlers will be added as API endpoints are implemented.

pub mod beads;
pub mod cli;
pub mod dolt;
pub mod environment;
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
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;

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
static TOOL_OVERRIDES: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

pub fn set_tool_override(name: &str, path: Option<PathBuf>) {
    let overrides = TOOL_OVERRIDES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut overrides) = overrides.lock() {
        match path {
            Some(path) => { overrides.insert(name.to_string(), path); }
            None => { overrides.remove(name); }
        }
    }
    forget_tools();
}

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

/// The endings a name may be worn with here, as this computer's PATHEXT gives
/// them.
///
/// Windows keeps what counts as runnable in that one variable and the reader
/// never types the ending: `npm` means `npm.cmd`, `node` means `node.exe`.
/// The text is handed in rather than read here so the rule can be put to a
/// list of our own, and a computer that hands us no PATHEXT at all — which is
/// what a service started with a stripped environment gets — falls back to the
/// endings Windows ships with rather than to nothing.
fn endings(pathext: Option<&OsStr>) -> Vec<String> {
    const SHIPPED: &str = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
    let text = pathext
        .map(|text| text.to_string_lossy().into_owned())
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| SHIPPED.to_string());
    text.split(';')
        .map(|end| end.trim().to_ascii_lowercase())
        .filter(|end| end.len() > 1 && end.starts_with('.'))
        .collect()
}

/// A name written out under every ending it may wear, the bare name last.
///
/// A name that already carries one of the endings is left alone: `npm.cmd` is
/// a whole file name and not a stem to hang `.exe` off. The bare name stays on
/// the end because everywhere but Windows it is the only spelling there is.
fn spellings_of(name: &str, endings: &[String]) -> Vec<String> {
    let worn = name
        .rsplit_once('.')
        .is_some_and(|(_, end)| endings.iter().any(|known| known[1..].eq_ignore_ascii_case(end)));
    if worn {
        return vec![name.to_string()];
    }
    let mut spellings: Vec<String> = endings.iter().map(|end| format!("{name}{end}")).collect();
    spellings.push(name.to_string());
    spellings
}

/// The endings this computer wears on a name: what PATHEXT says on Windows,
/// and nothing at all everywhere else, where the name is the whole file name.
///
/// Handing the endings to the search rather than asking `cfg!(windows)` inside
/// it is what lets the Windows rule be read back on a machine that is not
/// Windows: `spellings_of` given no endings answers with the bare name, which
/// is exactly what every other computer wants (bw-dwxw).
fn here_endings() -> Vec<String> {
    if cfg!(windows) {
        endings(std::env::var_os("PATHEXT").as_deref())
    } else {
        vec![]
    }
}

/// The places the reader's own list names, as the PATH text spells them.
///
/// This used to be a `which`/`where` we started, which is the one thing a
/// search on a computer with no list of places cannot do: the helper is itself
/// only findable through that list, so with PATH emptied it could not be
/// started and this step silently found nothing — for every tool, on every
/// call (bw-oxrg.6). The text is handed in so the walk can be put to an
/// emptied list without touching the environment every other test shares.
///
/// An empty entry is dropped rather than read as "here": on both platforms it
/// historically means the working directory, and a server that searches its
/// own working directory for `git` is a way to be handed somebody else's.
fn places_on(path: Option<&OsStr>) -> Vec<PathBuf> {
    let Some(path) = path else {
        return vec![];
    };
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .collect()
}

/// The places a tool is looked for beyond the reader's own PATH.
///
/// Two kinds sit here. The first is where an installer puts a program without
/// asking anybody to touch a shell profile, which is the case a service
/// started outside a shell cannot otherwise see. The second is the ordinary
/// system folders — `/usr/bin` and its neighbours, `System32` — where git and
/// python actually live on a plain machine: without them, a copy started at
/// login with no PATH at all reported every dependency missing while all of
/// them were installed (bw-oxrg.6).
fn tool_dirs() -> Vec<PathBuf> {
    let home = UserDirs::new().map(|d| d.home_dir().to_path_buf());
    let told = |name: &str| std::env::var_os(name).map(PathBuf::from);
    if cfg!(windows) {
        windows_dirs(home.as_deref(), &told)
    } else {
        unix_dirs(home.as_deref(), cfg!(target_os = "macos"))
    }
}

/// The places a tool is looked for on Windows.
///
/// The reader's home and the environment are handed in rather than read here,
/// because none of this had ever been run: every folder below was written from
/// documentation on a Linux machine, and a rule only Windows reaches is a rule
/// nobody has read back (bw-dwxw). `told` is what the computer says a variable
/// holds; where it says nothing, Windows' own default stands in, which is the
/// case a service started with a stripped environment is actually in.
fn windows_dirs(home: Option<&Path>, told: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = vec![];
    if let Some(home) = home {
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".beads").join("bin"));
        // Where npm puts what it installs for one person, and where Git for
        // Windows lands when it is installed without an administrator.
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("Git")
                .join("cmd"),
        );
    }
    // Git for Windows and Node install here and put nothing on a minimal
    // PATH, which is why git could not be started at all (bw-oxrg.4).
    let programs = told("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    dirs.push(programs.join("Git").join("cmd"));
    dirs.push(programs.join("nodejs"));
    if let Some(older) = told("ProgramFiles(x86)") {
        dirs.push(older.join("Git").join("cmd"));
        dirs.push(older.join("nodejs"));
    }
    let windows = told("SystemRoot").unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    dirs.push(windows.join("System32"));
    dirs.push(windows);
    dirs
}

/// The places a tool is looked for everywhere that is not Windows.
///
/// `mac` is handed in for the same reason the Windows folders are: Homebrew's
/// own folder on an Apple Silicon machine is a line no test on a Linux
/// computer would otherwise reach (bw-dwxw).
fn unix_dirs(home: Option<&Path>, mac: bool) -> Vec<PathBuf> {
    let mut dirs = vec![];
    if let Some(home) = home {
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".beads").join("bin"));
    }
    if mac {
        // Homebrew on an Apple Silicon machine. On an Intel one it is
        // `/usr/local`, which is already below.
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/sbin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/usr/local/sbin"));
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));
    dirs.push(PathBuf::from("/usr/sbin"));
    dirs.push(PathBuf::from("/sbin"));
    dirs
}

/// Whether a file found under a tool's name is one this computer can start.
///
/// A name in a place is not a tool. Everywhere but Windows the runnable bit is
/// the whole difference between `git` and a note somebody left called `git`,
/// and the check follows a link, because `/usr/bin/python3` is usually one.
#[cfg(unix)]
fn runnable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|about| {
        about.is_file() && about.permissions().mode() & 0o111 != 0
    })
}

/// Whether a file found under a tool's name is one this computer can start.
///
/// Windows carries no runnable bit; the ending is what says so, and the name
/// was already spelt with one.
#[cfg(not(unix))]
fn runnable(file: &Path) -> bool {
    file.is_file()
}

/// The search itself, over places handed in rather than the ones this computer
/// happens to have, so it can be put to a directory a test owns.
///
/// A spelling is tried everywhere before the next one is tried anywhere: a
/// reader with both `python3` and `python` gets the one asked for first,
/// wherever it sits, rather than whichever of them the earlier directory holds.
/// Within one spelling the places are walked in turn and each ending tried
/// there before moving on, which is the order Windows itself resolves a name
/// in — the nearest directory wins, and inside it the runnable ending does.
///
/// `endings` are the ones names are worn with here: PATHEXT's on Windows, and
/// none anywhere else, where a name is already the whole file name.
fn search_in(endings: &[String], dirs: &[PathBuf], spellings: &[&str]) -> Option<PathBuf> {
    for name in spellings {
        let spelt = spellings_of(name, endings);
        for dir in dirs {
            for spelling in &spelt {
                let file = dir.join(spelling);
                if runnable(&file) {
                    return Some(file);
                }
            }
        }
    }
    None
}

/// Every place a tool is held in, given the reader's own list as text: their
/// places first, the usual install and system folders after them.
///
/// The text is handed in so the whole list can be built with the reader's
/// places emptied — the case this search exists for — without emptying the
/// PATH that every other test in this process shares.
fn places_from(path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs = places_on(path);
    dirs.extend(tool_dirs());
    dirs
}

/// Every place this computer holds a tool in.
fn every_place() -> Vec<PathBuf> {
    places_from(std::env::var_os("PATH").as_deref())
}

/// Where a named tool is on this computer, if it is here at all.
///
/// `name` is what we call the tool and what its answer is remembered under;
/// `others` are the other spellings the same tool wears. The reader's own list
/// of places is walked first, then the usual install and system folders — one
/// walk over one list, so that nothing in the search needs a tool to find a
/// tool.
pub fn find_tool(name: &str, others: &[&str]) -> Option<PathBuf> {
    if let Some(path) = TOOL_OVERRIDES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock().ok()
        .and_then(|overrides| overrides.get(name).cloned())
        .filter(|path| runnable(path))
    {
        return Some(path);
    }
    remembered(name, || {
        let mut spellings = vec![name];
        spellings.extend_from_slice(others);
        let dirs = every_place();
        let found = search_in(&here_endings(), &dirs, &spellings);
        match &found {
            Some(path) => tracing::info!("Found {} at: {}", name, path.display()),
            None => tracing::warn!(
                "{} not found. Searched: {}",
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

/// What to tell a reader whose computer has no git on it.
///
/// git is not optional the way `bd` is: the whole Git panel and every worktree
/// is git and nothing else, so there is no reduced version of the answer to
/// give. Saying so outright beats letting the bare "No such file or directory"
/// of a failed start surface as the reason a push did not go (bw-oxrg.4).
pub const GIT_MISSING: &str =
    "git not found. Install git (https://git-scm.com/downloads) or add git to PATH.";

/// Where git is, if this computer has it.
pub fn find_git() -> Option<PathBuf> {
    find_tool("git", &[])
}

/// A git invocation, aimed at the file git actually is on this computer.
///
/// Every git this server starts is built here, so that no call site can be
/// written — or left behind — spelling the bare name, which is the lookup a
/// copy the machine starts at login does not have. On Windows that is the
/// everyday case rather than the corner one: Git for Windows installs to
/// `C:\Program Files\Git\cmd`, which is on nobody's minimal PATH.
///
/// With no git here at all this refuses instead of handing back a command that
/// will fail later, and the refusal carries [`GIT_MISSING`] as its message, so
/// the callers that already print what went wrong print that. The remembered
/// answer is dropped on the way out, the way every caller reporting a missing
/// tool drops it: a reader who installs git while Atelier is up is found on
/// their next click rather than after a restart.
pub fn git_command() -> std::io::Result<Command> {
    match find_git() {
        Some(git) => Ok(Command::new(git)),
        None => {
            forget_tools();
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                GIT_MISSING,
            ))
        }
    }
}

/// Run git in `dir` and hand back everything it produced.
pub async fn git_output(dir: impl AsRef<Path>, args: &[&str]) -> std::io::Result<Output> {
    git_command()?.args(args).current_dir(dir).output().await
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
        let look = || search_in(&here_endings(), &[place.path().to_path_buf()], &[name]);

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
            search_in(&here_endings(), &dirs, &["python3", "python"]),
            Some(shorter),
            "the spelling a Windows computer usually has is the only one here"
        );

        let asked_for = install(place.path(), "python3");
        assert_eq!(
            search_in(&here_endings(), &dirs, &["python3", "python"]),
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
            search_in(&here_endings(), &dirs, &["npm", "npm.cmd"]),
            Some(windows),
            "the only npm here is the one wearing the ending Windows gives it"
        );
    }

    /// The git this server starts is the file git is, not the name it is
    /// called by. A copy the machine starts at login has no shell's list of
    /// places to look that name up on, and on Windows the file is somewhere
    /// no minimal list holds (bw-oxrg.4).
    #[test]
    fn git_is_started_by_its_file_and_not_by_its_name() {
        let git = find_git().expect("git on the computer running these tests");
        assert!(
            git.is_absolute(),
            "{} is not somewhere in particular",
            git.display()
        );
        assert!(git.is_file(), "{} is not a file to start", git.display());
        assert_eq!(
            git_command().expect("a git to run").as_std().get_program(),
            git.as_os_str(),
            "the command we hand out has to be aimed at that file"
        );
    }

    /// A place that holds nothing is not an answer.
    #[test]
    fn an_empty_place_finds_nothing() {
        let place = tempfile::tempdir().expect("a directory of our own");
        assert_eq!(search_in(&here_endings(), &[place.path().to_path_buf()], &["bd"]), None);
    }

    /// A computer whose list of places is empty still has its tools on it.
    ///
    /// This is the case the whole search exists for: a copy the machine starts
    /// at login inherits no list. Until bw-oxrg.6 that step asked `which` —
    /// a helper itself only findable through the list it was standing in for —
    /// so with the list emptied nothing was found, for any tool, and the app
    /// called every dependency missing while all of them were installed.
    #[test]
    fn a_tool_is_found_with_the_readers_places_emptied() {
        let emptied = places_from(None);
        assert_eq!(
            emptied,
            places_from(Some(OsStr::new(""))),
            "no list at all and a list naming nothing are the same list"
        );

        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        let found = search_in(&here_endings(), &emptied, &[shell]).unwrap_or_else(|| {
            let looked = emptied
                .iter()
                .map(|dir| dir.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            panic!("every computer has {shell} on it, and none of {looked} held it")
        });
        assert!(
            found.is_absolute() && found.is_file(),
            "{} is not a file to start",
            found.display()
        );
    }

    /// An entry naming nothing is dropped rather than read as "here": on both
    /// platforms an empty one historically means the working directory, and a
    /// server that searches its own for `git` can be handed somebody else's.
    #[test]
    fn a_place_named_by_nothing_is_not_the_working_directory() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let text = format!("/one{sep}{sep}/two");
        assert_eq!(
            places_on(Some(OsStr::new(&text))),
            vec![PathBuf::from("/one"), PathBuf::from("/two")]
        );
        assert_eq!(places_on(None), Vec::<PathBuf>::new());
    }

    /// Windows keeps what counts as runnable in one variable, and a copy
    /// started with a stripped environment is handed none of it.
    #[test]
    fn the_endings_come_from_the_computer_or_else_from_windows() {
        assert_eq!(
            endings(Some(OsStr::new(".COM;.EXE;.CMD"))),
            vec![".com", ".exe", ".cmd"],
            "the reader's own answer, spelt the way a file name is"
        );
        for silent in [None, Some(OsStr::new("")), Some(OsStr::new("   "))] {
            let shipped = endings(silent);
            assert!(
                shipped.contains(&".exe".to_string()) && shipped.contains(&".cmd".to_string()),
                "a computer that tells us nothing still runs .exe and .cmd"
            );
        }
    }

    /// The endings a Windows computer wears names with, for a test standing on
    /// a computer that is not one.
    fn windows_endings() -> Vec<String> {
        endings(Some(OsStr::new(".COM;.EXE;.BAT;.CMD")))
    }

    /// A Windows computer is looked at where Git, Node and npm actually put
    /// themselves, and none of those folders is on a minimal PATH.
    ///
    /// Every line of this was written from documentation on a Linux machine
    /// and had never once been run (bw-dwxw). Handing the home folder and the
    /// environment in is what lets it be read back here.
    ///
    /// The folders are built up the same way the code builds them rather than
    /// written out as `C:\...` text, because a separator is the platform's
    /// business — a Linux `Path` joins with `/` whatever the root looks like.
    /// What is being read back is which roots are used and which folders hang
    /// off them, which is the part that was written from documentation.
    #[test]
    fn a_windows_computer_is_looked_at_where_its_programs_install() {
        let home = PathBuf::from(r"C:\Users\reader");
        let programs = PathBuf::from(r"C:\Program Files");
        let older = PathBuf::from(r"C:\Program Files (x86)");
        let windows = PathBuf::from(r"C:\Windows");
        let told = |name: &str| match name {
            "ProgramFiles" => Some(programs.clone()),
            "ProgramFiles(x86)" => Some(older.clone()),
            "SystemRoot" => Some(windows.clone()),
            _ => None,
        };
        let dirs = windows_dirs(Some(&home), &told);
        for wanted in [
            home.join("AppData").join("Roaming").join("npm"),
            home.join("AppData").join("Local").join("Programs").join("Git").join("cmd"),
            programs.join("Git").join("cmd"),
            programs.join("nodejs"),
            older.join("Git").join("cmd"),
            windows.join("System32"),
        ] {
            assert!(
                dirs.contains(&wanted),
                "{} is not among the places a Windows computer is looked at",
                wanted.display()
            );
        }
        assert!(
            dirs.iter().position(|d| d.starts_with(&home))
                < dirs.iter().position(|d| d == &windows.join("System32")),
            "the reader's own folders are looked in before the system's"
        );
    }

    /// A Windows computer that tells us nothing about itself still gets the
    /// folders Windows itself ships with — which is the case a service started
    /// with a stripped environment is actually in.
    #[test]
    fn a_silent_windows_computer_falls_back_to_what_windows_ships() {
        let dirs = windows_dirs(None, &|_| None);
        assert!(dirs.contains(&PathBuf::from(r"C:\Program Files").join("Git").join("cmd")));
        assert!(dirs.contains(&PathBuf::from(r"C:\Windows").join("System32")));
        assert!(
            !dirs.iter().any(|d| d.starts_with(r"C:\Program Files (x86)")),
            "a folder the computer never named is not invented for it"
        );
    }

    /// Asking for `git` on a Windows computer has to find the file `git.exe`,
    /// in the folder Git for Windows installs into. The reader never types the
    /// ending, and no minimal PATH names that folder.
    #[test]
    fn git_is_found_as_an_exe_in_the_folder_git_installs_into() {
        let root = tempfile::tempdir().expect("a directory of our own");
        let installed = root.path().join("Program Files").join("Git").join("cmd");
        std::fs::create_dir_all(&installed).expect("make the folder Git installs into");
        let file = install(&installed, "git.exe");

        assert_eq!(
            search_in(&windows_endings(), &[installed.clone()], &["git"]),
            Some(file),
            "the bare name has to reach the file wearing the ending"
        );
        assert_eq!(
            search_in(&[], &[installed], &["git"]),
            None,
            "and without the endings — the way every other computer searches — \
             the same folder holds no git at all"
        );
    }

    /// npm on Windows is `npm.cmd`, and asking for `npm` has to reach it.
    ///
    /// The older test here installed `npm.cmd` and then asked for `npm.cmd`,
    /// which never exercised the rule (bw-dwxw). This asks the way the app
    /// asks.
    #[test]
    fn npm_is_reached_by_its_bare_name_on_windows() {
        let place = tempfile::tempdir().expect("a directory of our own");
        let file = install(place.path(), "npm.cmd");
        assert_eq!(
            search_in(&windows_endings(), &[place.path().to_path_buf()], &["npm"]),
            Some(file),
            "PATHEXT is what says .cmd counts, and it is why we ask it"
        );
    }

    /// Homebrew's own folder on an Apple Silicon machine, which no test on a
    /// Linux computer would otherwise reach, and which is not invented for a
    /// computer that is not one.
    #[test]
    fn an_apple_silicon_computer_is_looked_at_in_homebrews_folder() {
        let apple = unix_dirs(None, true);
        assert!(apple.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(
            apple.iter().position(|d| d == &PathBuf::from("/opt/homebrew/bin"))
                < apple.iter().position(|d| d == &PathBuf::from("/usr/bin")),
            "what the reader installed is preferred to what the system shipped"
        );

        let other = unix_dirs(None, false);
        assert!(!other.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(other.contains(&PathBuf::from("/usr/bin")) && other.contains(&PathBuf::from("/bin")));
    }

    /// A name is written out under every ending it may wear, and one already
    /// wearing an ending is left whole: `npm.cmd` is a file name, not a stem.
    #[test]
    fn a_name_already_wearing_an_ending_is_not_given_another() {
        let known = endings(Some(OsStr::new(".EXE;.CMD")));
        assert_eq!(
            spellings_of("npm", &known),
            vec!["npm.exe", "npm.cmd", "npm"],
            "the bare name stays last, because off Windows it is the only one"
        );
        assert_eq!(spellings_of("npm.cmd", &known), vec!["npm.cmd"]);
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
