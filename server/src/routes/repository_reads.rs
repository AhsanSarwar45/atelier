//! One reader per repository.
//!
//! Every window that draws a repository asks for the same things: its status
//! and its last commit, again every few seconds for as long as it is on
//! screen, and again whenever the repository is said to have moved. Each
//! window asked for itself and each question ran git, so what an idle
//! repository cost was multiplied by the windows looking at it and by the
//! parts of each window drawn from it.
//!
//! Here a question about a repository is answered once and the answer is
//! shared:
//!
//! * Two askers at the same moment wait on one run of git, not two.
//! * An answer stands for [`HELD_FOR`], so every window's slow look inside
//!   that time is given it without git being run at all.
//! * An answer is dropped the moment there is a reason to think it is out of
//!   date ([`moved`]): this server wrote to the repository (every write route
//!   says so when it finishes, see `git::repo_lock`), or the watcher on the git
//!   directory found that the repository changed (`git_watch.rs`).
//! * An asker with a reason of its own, a reader who pressed refresh, says
//!   `fresh` and is given a new run.
//!
//! And because every answer passes through here, this is also where a change
//! is noticed: when a question is answered differently from the last time it
//! was asked, everything else held about the repository is dropped and the
//! windows watching it are told ([`tell`]). One window's slow look finding an
//! edited file is then news for every window, not only the one that looked.

use axum::{
    body::Bytes,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

use super::git::{Answer, Refused};

/// How long an answer stands in for the next asker's.
///
/// Just under the five seconds between a window's slow looks
/// (`WORKING_TREE_MS` in `use-repository-reads.ts`): one window on its own
/// still gets a new run on every look, exactly as before, and any number of
/// windows together cost what one does.
pub const HELD_FOR: Duration = Duration::from_millis(4_500);

/// How long a question nobody has asked again is remembered for comparing.
const FORGOTTEN_AFTER: Duration = Duration::from_secs(600);

/// One answer, and what makes it still good.
struct Held {
    at: Instant,
    body: Bytes,
}

#[derive(Default)]
struct Repository {
    /// How many times this repository has been said to have moved. A run that
    /// started before the news is not an answer to it, so it is not kept.
    moves: u64,
    held: HashMap<String, Held>,
    /// One turn per question, so askers of the same thing share a run.
    turns: HashMap<String, Arc<AsyncMutex<()>>>,
    /// What each question was last answered with, as a hash, to tell an
    /// answer that changed from one that was only read again; with it, when
    /// that was and how many moves the repository had made by then.
    last_said: HashMap<String, (u64, Instant, u64)>,
    /// Who to tell when an answer changes: the windows watching this
    /// repository, while there are any.
    listeners: Option<broadcast::Sender<()>>,
}

fn repositories() -> &'static Mutex<HashMap<PathBuf, Repository>> {
    static ALL: OnceLock<Mutex<HashMap<PathBuf, Repository>>> = OnceLock::new();
    ALL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key_of(repo: &Path) -> PathBuf {
    repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf())
}

fn with<T>(repo: &Path, f: impl FnOnce(&mut Repository) -> T) -> T {
    let mut all = repositories().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(all.entry(key_of(repo)).or_default())
}

/// The repository at `repo` changed, so nothing held about it is true any more.
pub fn moved(repo: &Path) {
    with(repo, |repository| {
        repository.moves += 1;
        repository.held.clear();
    });
}

/// [`moved`], for a caller that has just read the answer to `question` and
/// knows it to be true of the repository as it is now.
pub fn moved_keeping(repo: &Path, question: &str) {
    with(repo, |repository| {
        repository.moves += 1;
        repository.held.retain(|asked, _| asked == question);
    });
}

/// Have `listeners` told whenever a question about `repo` is answered
/// differently from the last time, or nobody with `None`.
pub fn tell(repo: &Path, listeners: Option<broadcast::Sender<()>>) {
    with(repo, |repository| repository.listeners = listeners);
}

fn hash_of(body: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut hasher);
    hasher.finish()
}

fn held_now(repo: &Path, question: &str) -> Option<Bytes> {
    with(repo, |repository| {
        // Answers past their time go whenever anything is looked up, so a
        // search typed into the history does not leave its pages here forever.
        repository.held.retain(|_, held| held.at.elapsed() < HELD_FOR);
        repository.held.get(question).map(|held| held.body.clone())
    })
}

fn as_json(body: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// The answer to `question` about `repo`: a held one, the one already being
/// read for somebody else, or a new run of `read`.
///
/// Only a plain success is held. A refusal is given to its asker and read
/// again for the next one, because what it says (no repository here, the
/// folder is gone) is exactly what a reader is about to change.
pub async fn shared<Fut>(repo: &Path, question: &str, fresh: bool, read: impl FnOnce() -> Fut) -> Answer
where
    Fut: Future<Output = Answer>,
{
    shared_bytes(repo, question, fresh, read).await.map(|(body, _)| as_json(body))
}

/// [`shared`], as the bytes of the answer rather than a response, and whether
/// reading it was news that the watchers were told of.
pub async fn shared_bytes<Fut>(
    repo: &Path,
    question: &str,
    fresh: bool,
    read: impl FnOnce() -> Fut,
) -> Result<(Bytes, bool), Refused>
where
    Fut: Future<Output = Answer>,
{
    if !fresh {
        if let Some(body) = held_now(repo, question) {
            return Ok((body, false));
        }
    }
    let turn = with(repo, |repository| {
        Arc::clone(repository.turns.entry(question.to_string()).or_default())
    });
    let _mine = turn.lock().await;
    // Whoever had the turn before this may have just read the very answer.
    if !fresh {
        if let Some(body) = held_now(repo, question) {
            return Ok((body, false));
        }
    }

    let moves_before = with(repo, |repository| repository.moves);
    let answer = read().await?;
    let status = answer.status();
    let body = axum::body::to_bytes(answer.into_body(), usize::MAX)
        .await
        .map_err(|e| Refused::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut told = false;
    if status == StatusCode::OK {
        told = with(repo, |repository| {
            let says = hash_of(&body);
            // News is an answer that differs from the last one while nothing
            // has said the repository moved in between. After a move every
            // answer is expected to differ, and that has been told already.
            let news = repository
                .last_said
                .get(question)
                .is_some_and(|(before, _, moves)| *before != says && *moves == repository.moves);
            if news {
                // This answer is the news, so it alone is kept.
                repository.moves += 1;
                repository.held.clear();
            }
            if news || repository.moves == moves_before {
                repository.held.insert(question.to_string(), Held { at: Instant::now(), body: body.clone() });
            }
            repository.last_said.insert(question.to_string(), (says, Instant::now(), repository.moves));
            // A history searched a hundred ways is a hundred questions; the
            // ones nobody has asked again are forgotten.
            if repository.last_said.len() > 256 {
                repository.last_said.retain(|_, (_, at, _)| at.elapsed() < FORGOTTEN_AFTER);
            }
            news && repository.listeners.as_ref().is_some_and(|listeners| listeners.send(()).is_ok())
        });
    }
    Ok((body, told))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Json;
    use std::sync::atomic::{AtomicU32, Ordering};

    async fn counted(runs: &AtomicU32) -> Answer {
        let n = runs.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::time::sleep(Duration::from_millis(30)).await;
        Ok(Json(serde_json::json!({ "run": n })).into_response())
    }

    /// Many askers at once, and askers a moment later, are one run of git.
    #[tokio::test]
    async fn askers_of_the_same_thing_share_one_run() {
        let held = tempfile::tempdir().unwrap();
        let repo = held.path();
        let runs = AtomicU32::new(0);

        let (a, b, c) = tokio::join!(
            shared_bytes(repo, "status", false, || counted(&runs)),
            shared_bytes(repo, "status", false, || counted(&runs)),
            shared_bytes(repo, "status", false, || counted(&runs)),
        );
        let later = shared_bytes(repo, "status", false, || counted(&runs)).await;

        assert_eq!(runs.load(Ordering::SeqCst), 1, "the same question ran more than once");
        let first = a.unwrap();
        assert_eq!(first, b.unwrap());
        assert_eq!(first, c.unwrap());
        assert_eq!(first, later.unwrap());
        assert!(!first.1, "a first answer was told as news");
    }

    /// A repository that moved, and an asker who says fresh, both get a new run.
    #[tokio::test]
    async fn news_and_an_asker_who_wants_it_fresh_both_run_again() {
        let held = tempfile::tempdir().unwrap();
        let repo = held.path();
        let runs = AtomicU32::new(0);

        shared_bytes(repo, "status", false, || counted(&runs)).await.unwrap();
        moved(repo);
        shared_bytes(repo, "status", false, || counted(&runs)).await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 2, "a held answer outlived the news that it was out of date");

        shared_bytes(repo, "status", true, || counted(&runs)).await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 3, "an asker who wanted a fresh answer was given a held one");

        // A different question about the same repository is its own answer.
        shared_bytes(repo, "log", false, || counted(&runs)).await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 4);
    }

    /// An answer that differs from the last one is news: the watchers are
    /// told, and what else was held about the repository is dropped.
    #[tokio::test]
    async fn a_changed_answer_is_told_and_drops_the_rest() {
        let held = tempfile::tempdir().unwrap();
        let repo = held.path();
        let runs = AtomicU32::new(0);
        let (listeners, mut heard) = broadcast::channel(4);
        tell(repo, Some(listeners));
        let same = || async { Ok(Json(serde_json::json!({ "branch": "main" })).into_response()) };

        shared_bytes(repo, "log", false, || counted(&runs)).await.unwrap();
        shared_bytes(repo, "status", true, same).await.unwrap();
        shared_bytes(repo, "status", true, same).await.unwrap();
        assert!(heard.try_recv().is_err(), "an answer that did not change was told as news");
        shared_bytes(repo, "log", false, || counted(&runs)).await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 1, "an unchanged answer dropped what else was held");

        let other = || async { Ok(Json(serde_json::json!({ "branch": "side" })).into_response()) };
        shared_bytes(repo, "status", true, other).await.unwrap();
        assert!(heard.try_recv().is_ok(), "a changed answer was not told");
        shared_bytes(repo, "log", false, || counted(&runs)).await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 2, "what was held outlived the news that it was out of date");
        // That read differed too, but it was the same news, already told.
        assert!(heard.try_recv().is_err(), "one change was told twice");
    }

    /// A run that began before the repository moved is not kept as current.
    #[tokio::test]
    async fn a_run_overtaken_by_news_is_not_held() {
        let held = tempfile::tempdir().unwrap();
        let repo = held.path();
        let runs = AtomicU32::new(0);

        let reading = shared_bytes(repo, "status", false, || counted(&runs));
        let news = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            moved(repo);
        };
        let (answer, ()) = tokio::join!(reading, news);
        answer.unwrap();

        shared_bytes(repo, "status", false, || counted(&runs)).await.unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 2, "an answer read before the news was handed out after it");
    }
}
