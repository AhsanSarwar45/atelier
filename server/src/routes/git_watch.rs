//! Telling the Git panel that the repository moved without it (bw-8nwh.2).
//!
//! The panel reads git when it is opened and after each of its own actions, so
//! anything done outside it — a commit or a push from a terminal, an agent
//! writing into the checkout — left the counts on screen describing a
//! repository that no longer existed, until somebody pressed refresh. This is
//! the other half of that: a filesystem watcher on the repository's own git
//! directory, whose every burst becomes one `changed` on the window's wire.
//!
//! The feed goes down `/api/live` under the tag `git`, not down a stream of
//! its own. A browser allows six connections to one address across every
//! window it has and an event stream never gives its slot back, which is what
//! `live.rs` and `src/workbench/live-wire.ts` exist to hold shut (bw-zkh4); a
//! second stream opened for the Git panel would be exactly the fault they end.
//!
//! What is watched is the git directory rather than the working tree:
//!
//! * every commit, checkout, fetch, push, merge and reset writes there —
//!   `HEAD`, `refs/`, `index`, `logs/`, `FETCH_HEAD` — so it catches all of
//!   what the panel's branch line and history are drawn from;
//! * it is small and quiet, where a working tree holds `node_modules` and
//!   `target` and would report a build as a change to the repository.
//!
//! A file merely edited on disk is therefore not seen here. The panel covers
//! that itself with a slow poll while it is on screen (`git-view.tsx`); the
//! costly half — a push somewhere else changing what "2 ahead" means — is what
//! arrives here the moment it happens.
//!
//! Both git directories are watched, because a worktree has two: its own
//! `.git/worktrees/<name>`, which carries its `HEAD` and its index, and the
//! main checkout's, which carries the refs and the objects they point at. This
//! app makes a worktree per card, so watching only one of them would be
//! watching only half of every repository it opens.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{info, warn};

use super::live::Tagged;
use super::validate_path_security;

/// How long a burst of writes must be quiet before it is reported, in ms.
///
/// One commit writes an index lock, the index, a handful of objects, `HEAD`'s
/// reflog and the branch's ref, over several separate `git` invocations when a
/// hook is involved. The panel wants one read at the end of that, not six
/// during it, and a trailing edge is what guarantees the read sees the finished
/// state rather than the middle of it.
const DEBOUNCE_MS: u64 = 200;

/// What this feed ever says, as it goes on the wire.
///
/// Deliberately not "what changed": the panel re-reads the whole of `status`
/// and `log` whatever moved, so naming the file would be telling it something
/// it has no use for — and the path inside a git directory is meaningless to a
/// reader anyway.
fn changed(tag: Option<&'static str>, kind: &str) -> Tagged {
    Tagged::new(tag, format!("{{\"kind\":\"{kind}\"}}"))
}

/// The git directories of the repository at `repo`, absolute, without repeats.
///
/// Asked of git itself rather than assembled from `.git`, because `.git` is a
/// directory in a plain checkout and a *file* pointing elsewhere in a worktree
/// or a submodule — and this app's own agents work in worktrees. `--git-dir` is
/// the per-worktree one and `--git-common-dir` the shared one; they are the
/// same path in a plain checkout, which is why the result is deduplicated.
pub(super) async fn git_dirs(repo: &Path) -> Vec<PathBuf> {
    let asked = super::git_output(
        repo,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ],
    )
    .await;

    let Ok(asked) = asked else { return Vec::new() };
    if !asked.status.success() {
        return Vec::new();
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    for line in String::from_utf8_lossy(&asked.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let dir = PathBuf::from(line);
        let dir = dir.canonicalize().unwrap_or(dir);
        if dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Whether a write inside a git directory is worth telling the panel about.
///
/// Objects are excluded: writing one is how git says nothing has happened yet.
/// `git add`, a fetch and a commit all pour objects in before the ref that
/// makes them part of the repository is moved, and nothing the panel draws
/// changes until that ref moves — so reporting them would mean re-reading the
/// repository several times during one commit and once for every object of a
/// fetch, all to draw the same numbers. The ref, the index and `HEAD` come
/// through, and they are what the panel is made of.
///
/// Lock files go the same way, for a nearer reason: `index.lock` exists only
/// while git holds the index, so a read started from it would race the very
/// command that made it. The unlocked write that follows is what is reported.
fn worth_reporting(path: &Path) -> bool {
    if path.components().any(|c| c.as_os_str() == "objects") {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    !name.ends_with(".lock")
}

/// Watch one repository and say `changed` down `tx` whenever it moves.
///
/// `tag` names the feed on a connection carrying more than one, exactly as the
/// board watcher takes it (`watch.rs`). Returns when the window goes away —
/// which `tx.closed()` notices even on a repository nobody ever touches again,
/// so no watcher outlives the panel that asked for it.
pub(super) async fn watch_repo(repo: PathBuf, tx: mpsc::Sender<Tagged>, tag: Option<&'static str>) {
    if let Err(e) = validate_path_security(&repo) {
        warn!("Git watch rejected for invalid path: {}", e);
        return;
    }

    let dirs = git_dirs(&repo).await;
    if dirs.is_empty() {
        // Not a repository, or git could not say. The panel shows what the
        // read routes say about it, which is the same "not a repository";
        // there is simply nothing here to watch.
        info!("Nothing to watch: {:?} is not a git repository", repo);
        return;
    }

    if let Err(e) = run(dirs, tx, tag).await {
        warn!("Git watcher error: {}", e);
    }
}

/// The watcher itself, once the directories to watch are known.
async fn run(
    dirs: Vec<PathBuf>,
    tx: mpsc::Sender<Tagged>,
    tag: Option<&'static str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (notify_tx, mut notify_rx) = mpsc::channel(100);

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = notify_tx.blocking_send(event);
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )?;

    for dir in &dirs {
        watcher.watch(dir, RecursiveMode::Recursive)?;
    }
    info!("Git watcher active on: {:?}", dirs);

    // Said once, so the panel knows the feed is really behind it rather than
    // merely asked for — and so a test can wait for the watcher to be watching
    // before it changes anything.
    let _ = tx.send(changed(tag, "watching")).await;

    let debounce = Duration::from_millis(DEBOUNCE_MS);
    let mut pending = false;

    loop {
        tokio::select! {
            // A queued write always beats a timer that is already due, so the
            // quiet period is measured from the last write of a burst.
            biased;

            // The window went away. Handing something down `tx` is the only
            // other thing that would notice, and a repository nobody touches
            // again never produces one — that is how the board watcher used to
            // leak one task and one operating-system handle per window
            // (bw-zkh4.12), and it is not repeated here.
            _ = tx.closed() => break,

            received = notify_rx.recv() => {
                let Some(event) = received else { break };
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {}
                    _ => continue,
                }
                if event.paths.iter().any(|p| worth_reporting(p)) {
                    pending = true;
                }
            }

            _ = tokio::time::sleep(debounce), if pending => {
                pending = false;
                if tx.send(changed(tag, "changed")).await.is_err() {
                    break;
                }
            }
        }
    }

    info!("Git watcher stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Run git and insist it worked.
    fn git(at: &Path, args: &[&str]) -> String {
        let done = Command::new("git")
            .args(args)
            .current_dir(at)
            .output()
            .expect("git is on the path");
        assert!(
            done.status.success(),
            "git {args:?} failed:\n{}",
            String::from_utf8_lossy(&done.stderr)
        );
        String::from_utf8_lossy(&done.stdout).trim().to_string()
    }

    /// A repository with one commit in it, with the person running the tests
    /// kept out of it: their name, their signing key and their hooks.
    fn a_repository(at: &Path) {
        git(at, &["init", "-b", "main", "."]);
        for (key, value) in [
            ("user.name", "Git Watch Fixture"),
            ("user.email", "git-watch@example.invalid"),
            ("commit.gpgsign", "false"),
        ] {
            git(at, &["config", "--local", key, value]);
        }
        std::fs::write(at.join("notes.md"), "first\n").unwrap();
        git(at, &["add", "-A"]);
        git(at, &["commit", "-m", "the first saved change"]);
    }

    /// Objects are the noise a commit makes on its way to the ref that matters.
    #[test]
    fn a_written_object_is_not_a_change_to_the_repository() {
        assert!(!worth_reporting(Path::new("/p/.git/objects/ab/cdef")));
        assert!(!worth_reporting(Path::new("/p/.git/index.lock")));
        assert!(worth_reporting(Path::new("/p/.git/index")));
        assert!(worth_reporting(Path::new("/p/.git/HEAD")));
        assert!(worth_reporting(Path::new("/p/.git/refs/heads/main")));
    }

    /// A worktree's own git directory and the one it shares, both found.
    ///
    /// This is the shape every card in this app is worked in, and the reason
    /// the directories are asked of git rather than assumed to be `.git`: in a
    /// worktree `.git` is a file, so a watcher pointed at it watches nothing.
    #[tokio::test]
    async fn a_worktree_is_watched_at_both_of_its_git_directories() {
        let held = tempfile::tempdir().unwrap();
        let main = held.path().join("main");
        std::fs::create_dir(&main).unwrap();
        a_repository(&main);

        let side = held.path().join("side");
        git(&main, &["worktree", "add", side.to_str().unwrap(), "-b", "side"]);

        let dirs = git_dirs(&side).await;
        assert_eq!(dirs.len(), 2, "a worktree has two git directories: {dirs:?}");
        assert!(dirs.iter().any(|d| d.ends_with("worktrees/side")));
        assert!(dirs.iter().any(|d| d.ends_with(".git")));

        // And a plain checkout has one, said once rather than twice.
        assert_eq!(git_dirs(&main).await.len(), 1);
    }

    /// A commit made behind the panel's back reaches it.
    ///
    /// The whole card in one case: nothing here goes near the app, a real
    /// commit is made with the real `git` binary the way a terminal would make
    /// it, and the watcher has to say so on its own.
    #[tokio::test]
    async fn a_commit_made_outside_the_app_is_reported() {
        let held = tempfile::tempdir().unwrap();
        let repo = held.path().to_path_buf();
        a_repository(&repo);

        let (tx, mut rx) = mpsc::channel::<Tagged>(16);
        let dirs = git_dirs(&repo).await;
        assert!(!dirs.is_empty());
        let watching = tokio::spawn(run(dirs, tx, Some("git")));

        // The watcher says it is watching first, so what follows is a change
        // made to a repository that is really being watched.
        let hello = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("the watcher never said it was watching")
            .expect("the feed closed");
        assert_eq!(hello.data, "{\"kind\":\"watching\"}");

        std::fs::write(repo.join("notes.md"), "second\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-m", "made from a terminal"]);

        let said = tokio::time::timeout(Duration::from_secs(15), rx.recv())
            .await
            .expect("a commit made outside the app was never reported")
            .expect("the feed closed");
        assert_eq!(said.tag.as_deref(), Some("git"));
        assert_eq!(said.data, "{\"kind\":\"changed\"}");

        // The window goes away and the watcher stops with it, rather than
        // outliving the panel that asked for it.
        drop(rx);
        tokio::time::timeout(Duration::from_secs(10), watching)
            .await
            .expect("the watcher went on watching after the window closed")
            .unwrap()
            .unwrap();
    }
}
