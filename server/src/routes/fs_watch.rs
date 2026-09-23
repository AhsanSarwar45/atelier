//! Telling an open file tree that the folder under it moved (bw-g3o3.3).
//!
//! The Files tab draws a directory it read once. A file written from a
//! terminal, by an agent working in the checkout, or by a build, left that
//! drawing describing a folder that no longer existed until somebody collapsed
//! and reopened it. This is the other half: a filesystem watcher on the folder
//! the tab is showing, whose every burst becomes one `changed` naming the paths
//! that moved, so the tab re-reads only the directories concerned.
//!
//! The feed goes down `/api/live` under the tag `fs`, not down a stream of its
//! own. A browser allows six connections to one address across every window it
//! has and an event stream never gives its slot back, which is what `live.rs`
//! and `src/workbench/live-wire.ts` exist to hold shut (bw-zkh4).
//!
//! ## Why this is not `git_watch.rs` with another path
//!
//! The git watcher deliberately does *not* watch the working tree, and says so:
//! a tree holds `node_modules` and `target`, and a build there would report
//! itself as a change to the repository. A file tree, though, is a drawing of
//! exactly that working tree, so it has to be watched — and the noise has to be
//! turned away here instead:
//!
//! * the names a checkout is always full of and nobody wants a tree redrawn
//!   for — `.git`, `node_modules`, `target`, `.next`, `dist`, `build`, `out`,
//!   and this app's own `worktrees`;
//! * whatever the project's own `.gitignore` already says to forget, read with
//!   the `ignore` crate.
//!
//! ## Why the folders are added one at a time
//!
//! On Linux a watch is one inotify watch *per directory*, whatever
//! `RecursiveMode::Recursive` looks like from here — and the number of them one
//! user may hold is finite (`max_user_watches`, commonly 8192). A recursive
//! watch on a monorepo would therefore spend the whole allowance on
//! `node_modules` before it reached anything a reader is looking at. So the
//! folders worth watching are walked first, by the rules above, and each is
//! watched on its own; a folder created later is picked up as it appears, and a
//! ceiling caps what one window can ever cost.
//!
//! The debounce is hand-rolled, the way `git_watch.rs` does it, rather than
//! `notify-debouncer-full`: that crate's cache is built around recursive roots,
//! which is the one thing this watcher deliberately does not use.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeSet, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::live::Tagged;
use super::validate_path_security;

/// How long a burst of writes must be quiet before it is reported, in ms.
///
/// The same trailing edge, and for the same reason, as the git watcher's: one
/// `npm install`, one `git checkout` or one editor save writes a great many
/// files in a moment, and the tree wants one re-read at the end of that rather
/// than one per file.
const DEBOUNCE_MS: u64 = 200;

/// The most paths one `changed` frame ever names.
///
/// A branch switch can move ten thousand files. Naming them all would send a
/// megabyte of JSON to say something the tab answers by re-reading the named
/// directories anyway, so the frame is cut here; a reader that sees a full one
/// has more than enough to know its drawing is stale.
const MOST_PATHS: usize = 200;

/// The most paths held between two frames, so a runaway build cannot grow this
/// without bound while nothing is reading.
const MOST_HELD: usize = 2_000;

/// The most directories one window's watch ever costs.
///
/// Well under the usual `max_user_watches`, because several windows may be open
/// on several projects at once and none of them may spend the whole allowance.
const MOST_FOLDERS: usize = 4_096;

/// The directory names never watched and never reported.
///
/// Not a matter of taste: every one of these is either not part of the project
/// (`.git`, `worktrees`) or is written by the hundred by a tool the reader
/// started on purpose, and a tree redrawn for each write of a build is worse
/// than a tree that waits.
const NEVER: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    "out",
    "worktrees",
];

/// What a path has to get past to be watched, or to be worth naming.
struct Rules {
    root: PathBuf,
    /// The root's own `.gitignore`, if it has one. Nested ones are not read:
    /// this decides whether to *watch* a folder and whether to *mention* a
    /// file, and the root's rules are what carry the build output of every
    /// project this app opens.
    ignored: Gitignore,
}

impl Rules {
    fn of(root: &Path) -> Self {
        let mut building = GitignoreBuilder::new(root);
        // `add` answers with the error rather than failing, and a project with
        // no `.gitignore` is an ordinary project — the name list still applies.
        building.add(root.join(".gitignore"));
        let ignored = building.build().unwrap_or_else(|_| Gitignore::empty());
        Rules {
            root: root.to_path_buf(),
            ignored,
        }
    }

    /// Whether `path` lies under a name this never looks at, or is one the
    /// project itself has said to forget.
    fn skipped(&self, path: &Path, is_dir: bool) -> bool {
        let Ok(under) = path.strip_prefix(&self.root) else {
            // Not inside the folder asked about at all, so not this watcher's
            // business — a link out of the tree, or an event for a sibling.
            return true;
        };
        if under.components().any(|c| never(c.as_os_str())) {
            return true;
        }
        self.ignored
            .matched_path_or_any_parents(path, is_dir)
            .is_ignore()
    }
}

/// Whether a directory name is one of the never-watched ones.
fn never(name: &OsStr) -> bool {
    NEVER.contains(&name.to_string_lossy().as_ref())
}

/// Said once, so a reader knows the feed is really behind it rather than merely
/// asked for — and so a test can wait for the watcher to be watching before it
/// changes anything.
fn watching(tag: Option<&'static str>) -> Tagged {
    Tagged::new(tag, "{\"kind\":\"watching\"}".to_string())
}

/// One burst, as it goes on the wire: the absolute paths that moved.
fn changed(tag: Option<&'static str>, paths: &BTreeSet<PathBuf>) -> Tagged {
    let named: Vec<String> = paths
        .iter()
        .take(MOST_PATHS)
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Tagged::new(
        tag,
        serde_json::json!({ "kind": "changed", "paths": named }).to_string(),
    )
}

/// Every folder at or under `from` worth watching, breadth first, up to `room`.
///
/// Breadth first on purpose: if a project is large enough to reach the ceiling,
/// what a reader is looking at is far likelier to be near the top of it than at
/// the bottom of its deepest branch.
fn folders(from: &Path, rules: &Rules, room: usize) -> Vec<PathBuf> {
    let mut found = vec![from.to_path_buf()];
    let mut queue = VecDeque::from([from.to_path_buf()]);

    while let Some(dir) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= room {
                return found;
            }
            // `read_dir` does not follow links, so a symlinked directory is not
            // a directory here — which is also what keeps a link pointing at an
            // ancestor from walking for ever.
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if never(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            if rules.skipped(&path, true) {
                continue;
            }
            found.push(path.clone());
            queue.push_back(path);
        }
    }
    found
}

/// Watch one folder and name what moves in it down `tx`.
///
/// `tag` names the feed on a connection carrying more than one, exactly as the
/// board and git watchers take it. Returns when the window goes away — which
/// `tx.closed()` notices even on a folder nobody touches again, so no watcher
/// outlives the tab that asked for it.
pub(super) async fn watch_folder(
    root: PathBuf,
    tx: mpsc::Sender<Tagged>,
    tag: Option<&'static str>,
) {
    if let Err(e) = validate_path_security(&root) {
        warn!("Folder watch rejected for invalid path: {}", e);
        return;
    }
    let root = root.canonicalize().unwrap_or(root);
    if !root.is_dir() {
        // The tab draws what the read routes say about it, which is the same
        // "no such folder"; there is simply nothing here to watch.
        info!("Nothing to watch: {:?} is not a folder", root);
        return;
    }
    if let Err(e) = run(root, tx, tag).await {
        warn!("Folder watcher error: {}", e);
    }
}

/// The watcher itself, once the folder is known to be one.
async fn run(
    root: PathBuf,
    tx: mpsc::Sender<Tagged>,
    tag: Option<&'static str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let rules = Rules::of(&root);
    let (notify_tx, mut notify_rx) = mpsc::channel(1_000);

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = notify_tx.blocking_send(event);
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )?;

    let mut watched: BTreeSet<PathBuf> = BTreeSet::new();
    for dir in folders(&root, &rules, MOST_FOLDERS) {
        // A folder that vanished between the walk and here is not a failure
        // worth ending the whole watch for.
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
            watched.insert(dir);
        }
    }
    info!(
        "Folder watcher active on {:?} across {} folders",
        root,
        watched.len()
    );

    let _ = tx.send(watching(tag)).await;

    let debounce = Duration::from_millis(DEBOUNCE_MS);
    // A set rather than a list: one save writes the same path several times,
    // and a reader wants each directory named once.
    let mut moved: BTreeSet<PathBuf> = BTreeSet::new();

    loop {
        tokio::select! {
            // A queued write always beats a timer that is already due, so the
            // quiet period is measured from the last write of a burst.
            biased;

            // The window went away. Handing something down `tx` is the only
            // other thing that would notice, and a folder nobody touches again
            // never produces one — the leak of one task and one operating-system
            // handle per window that bw-zkh4.12 was (see `git_watch.rs`).
            _ = tx.closed() => break,

            received = notify_rx.recv() => {
                let Some(event) = received else { break };
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
                    _ => continue,
                }
                for path in event.paths {
                    let is_dir = path.is_dir();
                    if rules.skipped(&path, is_dir) {
                        continue;
                    }
                    // A folder made while we are watching — `mkdir -p`, a
                    // checkout, an unpacked archive — is watched as it appears,
                    // along with whatever it already holds. Without this a tree
                    // would follow a new directory once and then go deaf to it.
                    if is_dir && !watched.contains(&path) && watched.len() < MOST_FOLDERS {
                        for dir in folders(&path, &rules, MOST_FOLDERS - watched.len()) {
                            if !watched.contains(&dir)
                                && watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok()
                            {
                                watched.insert(dir);
                            }
                        }
                    }
                    if moved.len() < MOST_HELD {
                        moved.insert(path);
                    }
                }
            }

            _ = tokio::time::sleep(debounce), if !moved.is_empty() => {
                let burst = std::mem::take(&mut moved);
                if tx.send(changed(tag, &burst)).await.is_err() {
                    break;
                }
            }
        }
    }

    info!("Folder watcher stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the watcher said next, or nothing if it stayed quiet for `within`.
    async fn heard(rx: &mut mpsc::Receiver<Tagged>, within: Duration) -> Option<String> {
        tokio::time::timeout(within, rx.recv())
            .await
            .ok()
            .flatten()
            .map(|said| said.data)
    }

    /// A watcher on `root`, already watching by the time this returns — so what
    /// a case does next is a change made to a folder really being watched.
    async fn watching_on(root: &Path) -> (mpsc::Receiver<Tagged>, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::channel::<Tagged>(64);
        let root = root.to_path_buf();
        let running = tokio::spawn(async move {
            run(root, tx, Some("fs")).await.unwrap();
        });
        let hello = heard(&mut rx, Duration::from_secs(10))
            .await
            .expect("the watcher never said it was watching");
        assert_eq!(hello, "{\"kind\":\"watching\"}");
        (rx, running)
    }

    /// A file written from a shell reaches the tree, by name, and the watcher
    /// stops when the window does.
    #[tokio::test]
    async fn a_file_written_outside_the_app_is_named() {
        let held = tempfile::tempdir().unwrap();
        let root = held.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("src")).unwrap();

        let (mut rx, running) = watching_on(&root).await;

        std::fs::write(root.join("src").join("new.ts"), "export {};\n").unwrap();

        let said = heard(&mut rx, Duration::from_secs(5))
            .await
            .expect("a file written outside the app was never reported");
        let frame: serde_json::Value = serde_json::from_str(&said).unwrap();
        assert_eq!(frame["kind"], "changed");
        let named = frame["paths"].as_array().unwrap();
        let wanted = root.join("src").join("new.ts").to_string_lossy().into_owned();
        assert!(
            named.iter().any(|p| p.as_str() == Some(wanted.as_str())),
            "the new file was not named: {named:?}"
        );

        // The window goes away and the watcher stops with it, rather than
        // outliving the tab that asked for it.
        drop(rx);
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("the watcher went on watching after the window closed")
            .unwrap();
    }

    /// A build writing into `node_modules`, into an ignored folder, or an
    /// ignored file says nothing at all.
    #[tokio::test]
    async fn the_noisy_folders_are_not_reported() {
        let held = tempfile::tempdir().unwrap();
        let root = held.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("left-pad")).unwrap();
        std::fs::write(root.join(".gitignore"), "coverage/\n*.log\n").unwrap();
        std::fs::create_dir(root.join("coverage")).unwrap();

        let (mut rx, running) = watching_on(&root).await;

        std::fs::write(
            root.join("node_modules").join("left-pad").join("index.js"),
            "module.exports = 1;\n",
        )
        .unwrap();
        std::fs::write(root.join("coverage").join("lcov.info"), "TN:\n").unwrap();
        std::fs::write(root.join("debug.log"), "noise\n").unwrap();

        assert_eq!(
            heard(&mut rx, Duration::from_secs(2)).await,
            None,
            "a write nobody wants to hear about was reported"
        );

        drop(rx);
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .unwrap()
            .unwrap();
    }

    /// The rules themselves, away from a watcher.
    #[test]
    fn what_is_never_watched() {
        let held = tempfile::tempdir().unwrap();
        let root = held.path().canonicalize().unwrap();
        std::fs::write(root.join(".gitignore"), "build-output/\n*.tmp\n").unwrap();
        let rules = Rules::of(&root);

        assert!(rules.skipped(&root.join(".git").join("HEAD"), false));
        assert!(rules.skipped(&root.join("node_modules").join("x"), true));
        assert!(rules.skipped(&root.join("app").join("target").join("debug"), true));
        assert!(rules.skipped(&root.join("worktrees").join("bw-1").join("a.ts"), false));
        assert!(rules.skipped(&root.join("build-output").join("app.js"), false));
        assert!(rules.skipped(&root.join("notes.tmp"), false));
        assert!(rules.skipped(Path::new("/elsewhere/a.ts"), false));

        assert!(!rules.skipped(&root.join("src").join("index.ts"), false));
        assert!(!rules.skipped(&root.join("src"), true));
    }

    /// The noisy names are not walked into either, so a monorepo's whole
    /// `node_modules` never costs a watch.
    #[test]
    fn the_walk_stops_at_the_noisy_names() {
        let held = tempfile::tempdir().unwrap();
        let root = held.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("left-pad")).unwrap();
        std::fs::create_dir_all(root.join("src").join("workbench")).unwrap();
        std::fs::write(root.join(".gitignore"), "generated/\n").unwrap();
        std::fs::create_dir(root.join("generated")).unwrap();

        let found = folders(&root, &Rules::of(&root), MOST_FOLDERS);

        assert!(found.contains(&root));
        assert!(found.contains(&root.join("src")));
        assert!(found.contains(&root.join("src").join("workbench")));
        assert!(!found.iter().any(|d| d.starts_with(root.join("node_modules"))));
        assert!(!found.contains(&root.join("generated")));
    }

    /// A folder made after the watch started is watched too.
    #[tokio::test]
    async fn a_folder_made_later_is_watched() {
        let held = tempfile::tempdir().unwrap();
        let root = held.path().canonicalize().unwrap();

        let (mut rx, running) = watching_on(&root).await;

        let made = root.join("fresh");
        std::fs::create_dir(&made).unwrap();
        // The folder itself is a change, and arrives first.
        let _ = heard(&mut rx, Duration::from_secs(5)).await;
        std::fs::write(made.join("inside.ts"), "export {};\n").unwrap();

        let wanted = made.join("inside.ts").to_string_lossy().into_owned();
        let mut named = false;
        for _ in 0..5 {
            let Some(said) = heard(&mut rx, Duration::from_secs(3)).await else {
                break;
            };
            if said.contains(&wanted) {
                named = true;
                break;
            }
        }
        assert!(
            named,
            "a file in a folder made after the watch started was never named"
        );

        drop(rx);
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .unwrap()
            .unwrap();
    }
}
