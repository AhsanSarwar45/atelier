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
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, watch};
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

/// How often a folder with no repository is looked at for one, in ms.
const WAIT_FOR_INIT_MS: u64 = 1_000;

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

/// How long the watcher waits before looking again, after looking `futile`
/// times in a row and finding the repository the same each time.
///
/// A write inside the git directory is a reason to look, not a change. Most
/// are both: a commit, a checkout, a push. Some are not, and some never stop:
/// a `core.fsmonitor` hook that keeps a stamp there writes on every git
/// command, the watcher's own look included, so each look is the cause of the
/// next. Looking is therefore spaced out for as long as it keeps finding
/// nothing, which makes what such a repository costs a few looks a minute
/// whatever is writing to it. The first write after a quiet spell, or after a
/// look that did find a change, is still looked at straight away.
fn wait_after(futile: u32) -> Duration {
    match futile {
        0 => Duration::ZERO,
        1 => Duration::from_secs(4),
        2 => Duration::from_secs(8),
        3 => Duration::from_secs(16),
        4 => Duration::from_secs(32),
        _ => Duration::from_secs(60),
    }
}

/// Everything a window draws from a repository, as one value to compare.
///
/// The status covers the working tree, the index, `HEAD` and where the branch
/// stands against its upstream; the refs cover every other branch, tag and
/// stash. The status is read through the shared reader
/// (`repository_reads.rs`), which is what tells the windows when it has
/// changed and hands them this same answer rather than running git again.
async fn what_it_says(repo: &Path, fresh: bool) -> (Said, bool) {
    let status = if fresh { super::git::status_now(repo).await } else { super::git::status_held(repo).await };
    let (status, told) = match status {
        Ok((body, told)) => (Ok(body.to_vec()), told),
        Err(refused) => (Err(refused.said().to_string()), false),
    };
    let refs = match super::git_output(repo, &["for-each-ref", "--format=%(objectname) %(refname)"]).await {
        Ok(said) => said.stdout,
        Err(_) => Vec::new(),
    };
    ((status, refs), told)
}

/// The status, or why it could not be read, and the refs.
type Said = (Result<Vec<u8>, String>, Vec<u8>);

/// One repository being watched, for every window that draws it.
struct Watched {
    /// Says `changed` to every window, when the repository really did.
    said: broadcast::Sender<()>,
    /// Becomes true once the watcher is watching.
    ready: watch::Receiver<bool>,
}

fn all_watched() -> &'static Mutex<HashMap<PathBuf, Watched>> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Watched>>> = OnceLock::new();
    ALL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Join the watch on `repo`, starting it if no window is watching yet.
fn join(repo: &Path, dirs: Vec<PathBuf>) -> (broadcast::Receiver<()>, watch::Receiver<bool>) {
    let key = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let mut all = all_watched().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(watched) = all.get(&key) {
        return (watched.said.subscribe(), watched.ready.clone());
    }
    let (said, heard) = broadcast::channel(16);
    let (now_ready, ready) = watch::channel(false);
    all.insert(key.clone(), Watched { said: said.clone(), ready: ready.clone() });
    tokio::spawn(async move {
        if let Err(e) = run(key.clone(), dirs, said, now_ready).await {
            warn!("Git watcher error: {}", e);
            // Nobody is watching this repository now; the next window to ask
            // starts again from nothing.
            all_watched().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&key);
        }
    });
    (heard, ready)
}

/// Watch one repository and say `changed` down `tx` whenever it changes.
///
/// `tag` names the feed on a connection carrying more than one, exactly as the
/// board watcher takes it (`watch.rs`). Returns when the window goes away —
/// which `tx.closed()` notices even on a repository nobody ever touches again,
/// so no window is held on to after it has gone.
///
/// The watching itself is done once per repository however many windows ask
/// ([`join`]), and a window is told only when what it draws has changed
/// ([`run`]).
pub(super) async fn watch_repo(repo: PathBuf, tx: mpsc::Sender<Tagged>, tag: Option<&'static str>) {
    if let Err(e) = validate_path_security(&repo) {
        warn!("Git watch rejected for invalid path: {}", e);
        return;
    }

    let mut dirs = git_dirs(&repo).await;
    if dirs.is_empty() {
        // Not a repository yet. The panel offers to make one, and somebody
        // can run `git init` in a terminal, so this waits for a `.git` to
        // appear rather than leaving the panel unwatched for the rest of the
        // window's life. It still ends when the window goes away.
        info!("Nothing to watch yet: {:?} is not a git repository", repo);
        while dirs.is_empty() {
            tokio::select! {
                _ = tx.closed() => return,
                _ = tokio::time::sleep(Duration::from_millis(WAIT_FOR_INIT_MS)) => {}
            }
            if repo.join(".git").exists() {
                dirs = git_dirs(&repo).await;
            }
        }
        super::repository_reads::moved(&repo);
        if tx.send(changed(tag, "changed")).await.is_err() {
            return;
        }
    }

    let (mut heard, mut ready) = join(&repo, dirs);

    // Said once, so the panel knows the feed is really behind it rather than
    // merely asked for — and so a test can wait for the watcher to be watching
    // before it changes anything.
    tokio::select! {
        _ = tx.closed() => return,
        watching = ready.wait_for(|watching| *watching) => {
            if watching.is_err() {
                return;
            }
        }
    }
    if tx.send(changed(tag, "watching")).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            // The window went away. Handing something down `tx` is the only
            // other thing that would notice, and a repository nobody touches
            // again never produces one — that is how the board watcher used to
            // leak one task and one operating-system handle per window
            // (bw-zkh4.12), and it is not repeated here.
            _ = tx.closed() => break,
            news = heard.recv() => match news {
                // Falling behind loses nothing: every `changed` says the same.
                Ok(()) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    if tx.send(changed(tag, "changed")).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
}

/// How often a watch with nothing to report checks that a window still wants
/// it.
const STILL_WANTED_EVERY: Duration = Duration::from_secs(5);

/// The watcher itself, once the directories to watch are known.
///
/// A burst of writes is not passed on as it is. The repository is read once
/// the burst is over, and the windows are told only if what they draw from it
/// is different from the last time it was read. So a write that changes
/// nothing — and above all a write made by this very read — is where it ends,
/// instead of every window reading the repository again to find the same.
async fn run(
    repo: PathBuf,
    dirs: Vec<PathBuf>,
    said: broadcast::Sender<()>,
    now_ready: watch::Sender<bool>,
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

    // What the repository says before anything is reported, so the first
    // write has something to be compared with. Whatever a window has just
    // been given is good enough, and usually there is one.
    let (mut last, _) = what_it_says(&repo, false).await;
    super::repository_reads::tell(&repo, Some(said.clone()));
    let _ = now_ready.send(true);

    let debounce = Duration::from_millis(DEBOUNCE_MS);
    let mut pending = false;
    // How many looks in a row found nothing, and when the last look was.
    let mut futile: u32 = 0;
    let mut looked_at = Instant::now();

    loop {
        // The quiet a burst must have before it is looked at, and on top of it
        // however long is left of the wait that futile looks have earned.
        let not_before = looked_at + wait_after(futile);
        let wait = debounce.max(not_before.saturating_duration_since(Instant::now()));

        tokio::select! {
            // A queued write always beats a timer that is already due, so the
            // quiet period is measured from the last write of a burst.
            biased;

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

            _ = tokio::time::sleep(wait), if pending => {
                pending = false;
                // A wait that grew while this slept (it cannot shrink) is
                // kept: the write is looked at when its time comes.
                let (now_says, told_already) = what_it_says(&repo, true).await;
                looked_at = Instant::now();
                if now_says == last {
                    futile = futile.saturating_add(1);
                    if futile == 3 {
                        info!(
                            "Something keeps writing to the git directory of {:?} without changing the repository; \
                             it is now looked at once a minute at most",
                            repo
                        );
                    }
                } else {
                    futile = 0;
                    // A status the reader found changed has been told to
                    // the windows by the reader. Anything else is told here:
                    // refs that moved on their own (a fetch, a branch made
                    // elsewhere), and the change that follows a write this
                    // server made, which the reader takes as expected.
                    last = now_says;
                    if !told_already {
                        super::repository_reads::moved_keeping(&repo, super::git::STATUS);
                        let _ = said.send(());
                    }
                }
            }

            // No window has been taken away from a repository nobody writes
            // to unless something looks, so this does.
            _ = tokio::time::sleep(STILL_WANTED_EVERY), if !pending => {}
        }

        // Stopped under the same lock a window joins under, so a window that
        // arrives as the last one leaves is never left with a dead watch.
        let mut all = all_watched().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if said.receiver_count() == 0 {
            all.remove(&repo);
            super::repository_reads::tell(&repo, None);
            break;
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

    /// A folder for a repository where the watch will take it: the routes
    /// refuse anything outside the home directory.
    fn under_home() -> tempfile::TempDir {
        let home = directories::UserDirs::new().unwrap().home_dir().to_path_buf();
        tempfile::Builder::new().prefix(".atelier-git-watch-").tempdir_in(home).unwrap()
    }

    /// The next thing the watch says, or nothing within `within`.
    async fn next(rx: &mut mpsc::Receiver<Tagged>, within: Duration) -> Option<String> {
        tokio::time::timeout(within, rx.recv()).await.ok().flatten().map(|said| said.data)
    }

    /// Looking is spaced further apart the longer it keeps finding nothing,
    /// and never further than a minute.
    #[test]
    fn looks_that_find_nothing_are_spaced_out() {
        assert_eq!(wait_after(0), Duration::ZERO);
        let mut before = wait_after(0);
        for futile in 1..5 {
            assert!(wait_after(futile) > before, "the wait did not grow at {futile}");
            before = wait_after(futile);
        }
        assert_eq!(wait_after(1_000), Duration::from_secs(60));
    }

    /// A write inside the git directory that changes nothing a window draws is
    /// not passed on, however often it comes; a real change after it still is.
    #[tokio::test]
    async fn writes_that_change_nothing_are_not_reported() {
        let held = under_home();
        let repo = held.path().to_path_buf();
        a_repository(&repo);

        let (tx, mut rx) = mpsc::channel::<Tagged>(16);
        let watching = tokio::spawn(watch_repo(repo.clone(), tx, Some("git")));
        assert_eq!(next(&mut rx, Duration::from_secs(10)).await.as_deref(), Some("{\"kind\":\"watching\"}"));

        // What a hook keeping a stamp in the git directory does, a few times.
        for n in 0..4 {
            std::fs::write(repo.join(".git").join("a-stamp"), format!("{n}")).unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert_eq!(
            next(&mut rx, Duration::from_secs(2)).await,
            None,
            "a write that changed nothing was reported as a change"
        );

        std::fs::write(repo.join("notes.md"), "second\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-m", "made from a terminal"]);
        assert_eq!(
            next(&mut rx, Duration::from_secs(30)).await.as_deref(),
            Some("{\"kind\":\"changed\"}"),
            "a commit made after writes that changed nothing was never reported"
        );

        drop(rx);
        tokio::time::timeout(Duration::from_secs(10), watching).await.unwrap().unwrap();
    }

    /// Two windows on one repository are one watch, and both hear of a change.
    #[tokio::test]
    async fn two_windows_share_one_watch_and_both_hear() {
        let held = under_home();
        let repo = held.path().to_path_buf();
        a_repository(&repo);
        let key = repo.canonicalize().unwrap();

        let (tx_a, mut rx_a) = mpsc::channel::<Tagged>(16);
        let (tx_b, mut rx_b) = mpsc::channel::<Tagged>(16);
        let a = tokio::spawn(watch_repo(repo.clone(), tx_a, Some("git")));
        let b = tokio::spawn(watch_repo(repo.clone(), tx_b, Some("git")));
        assert_eq!(next(&mut rx_a, Duration::from_secs(10)).await.as_deref(), Some("{\"kind\":\"watching\"}"));
        assert_eq!(next(&mut rx_b, Duration::from_secs(10)).await.as_deref(), Some("{\"kind\":\"watching\"}"));
        let listeners = all_watched().lock().unwrap().get(&key).map(|watched| watched.said.receiver_count());
        assert_eq!(listeners, Some(2), "two windows on one repository were not one watch");

        std::fs::write(repo.join("notes.md"), "second\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-m", "made from a terminal"]);
        assert_eq!(next(&mut rx_a, Duration::from_secs(15)).await.as_deref(), Some("{\"kind\":\"changed\"}"));
        assert_eq!(next(&mut rx_b, Duration::from_secs(15)).await.as_deref(), Some("{\"kind\":\"changed\"}"));

        // Both windows go away, and the watch goes with the last of them.
        drop(rx_a);
        drop(rx_b);
        tokio::time::timeout(Duration::from_secs(10), a).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(10), b).await.unwrap().unwrap();
        let mut gone = false;
        for _ in 0..40 {
            gone = !all_watched().lock().unwrap().contains_key(&key);
            if gone {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert!(gone, "the watch outlived every window that asked for it");
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
        let held = under_home();
        let repo = held.path().to_path_buf();
        a_repository(&repo);

        let (tx, mut rx) = mpsc::channel::<Tagged>(16);
        let watching = tokio::spawn(watch_repo(repo.clone(), tx, Some("git")));

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
            .unwrap();
    }
}
