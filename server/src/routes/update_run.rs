//! What an update is doing, while it is doing it.
//!
//! Replacing the running program used to be one request that said nothing
//! until it was over: the screen showed a spinner labelled "Downloading…" and,
//! some minutes later on a slow line, either a restart or a refusal. Nothing
//! told anybody whether the download had moved at all.
//!
//! This holds the state of the one update that may be in flight, and hands
//! every change to whoever is watching. The download reports real bytes,
//! because `published::download_watched` already hashes the body chunk by
//! chunk and only had to be asked to count as it went. The Homebrew path
//! reports lines instead, because `brew` does not say how many bytes a
//! download will be.
//!
//! Only one update may run at a time. A second start is refused rather than
//! doubled: two downloads writing the same staged file would race each other
//! onto the program about to be swapped.

use serde::Serialize;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

/// How far along an update is.
///
/// The order is the order they happen in, and a screen may rely on that: the
/// bar is only meaningful during `Downloading`, and every later phase is work
/// with no byte count to report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Nothing has been started in this process.
    Idle,
    /// The release archive is arriving, or `brew` is fetching it.
    Downloading,
    /// The bytes are being proved against the release's published checksum.
    Verifying,
    /// The proved archive is being unpacked and staged.
    Unpacking,
    /// The new files are in place and the program is going down to come back.
    Restarting,
    /// The update was taken. The process is about to exit.
    Done,
    /// Nothing was replaced. `failed` says why, in the words the refusal used.
    Failed,
}

/// The state of the one update that may be in flight.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateRun {
    pub phase: Phase,
    /// Bytes of the release archive received so far.
    pub received: u64,
    /// Bytes expected, when the server said. `None` leaves the bar
    /// indeterminate rather than inventing a denominator.
    pub total: Option<u64>,
    /// The newest line of detail — a `brew` line, or what is being staged.
    pub note: Option<String>,
    /// Why nothing was replaced, in the refusal's own words.
    pub failed: Option<String>,
    /// The version being moved to.
    pub version: Option<String>,
}

impl UpdateRun {
    /// Nothing started, nothing to report.
    fn idle() -> Self {
        Self {
            phase: Phase::Idle,
            received: 0,
            total: None,
            note: None,
            failed: None,
            version: None,
        }
    }

    /// Whether an update is under way, and so whether a second start has to be
    /// refused. `Done` counts as busy: the process is on its way out, and a
    /// fresh download would be writing files nobody will run.
    pub fn busy(&self) -> bool {
        matches!(
            self.phase,
            Phase::Downloading | Phase::Verifying | Phase::Unpacking | Phase::Restarting | Phase::Done
        )
    }
}

/// The state, and everyone watching it.
///
/// Watchers are sent every change. A watcher that joins mid-update is sent the
/// state as it stands first, so a screen opened halfway through draws the right
/// thing rather than waiting for the next chunk to arrive.
#[derive(Debug)]
pub struct UpdateWatcher {
    now: RwLock<UpdateRun>,
    changes: broadcast::Sender<UpdateRun>,
}

/// Shared handle, injected as an axum `Extension` beside the version cache.
pub type UpdateWatch = Arc<UpdateWatcher>;

/// A watcher with nothing running.
pub fn new_watch() -> UpdateWatch {
    let (changes, _) = broadcast::channel(64);
    Arc::new(UpdateWatcher {
        now: RwLock::new(UpdateRun::idle()),
        changes,
    })
}

impl UpdateWatcher {
    /// The state as it stands.
    pub async fn now(&self) -> UpdateRun {
        self.now.read().await.clone()
    }

    /// Watch every change from here on. Pair with [`now`](Self::now) to get the
    /// state a watcher joined at.
    pub fn watch(&self) -> broadcast::Receiver<UpdateRun> {
        self.changes.subscribe()
    }

    /// Take the run, if nothing else holds it.
    ///
    /// Returns false when an update is already under way. The check and the
    /// claim happen under one write lock, so two requests arriving together
    /// cannot both be told they may start.
    pub async fn claim(&self, version: Option<String>) -> bool {
        let mut now = self.now.write().await;
        if now.busy() {
            return false;
        }
        *now = UpdateRun {
            phase: Phase::Downloading,
            received: 0,
            total: None,
            note: None,
            failed: None,
            version,
        };
        let _ = self.changes.send(now.clone());
        true
    }

    /// Move to a phase that has no byte count of its own.
    pub async fn phase(&self, phase: Phase, note: Option<String>) {
        let mut now = self.now.write().await;
        now.phase = phase;
        now.note = note;
        let _ = self.changes.send(now.clone());
    }

    /// Say what is happening now, without changing the phase.
    ///
    /// The Homebrew path reports lines rather than bytes, because `brew` never
    /// says how big a download will be.
    pub async fn note(&self, note: impl Into<String>) {
        let mut now = self.now.write().await;
        now.note = Some(note.into());
        let _ = self.changes.send(now.clone());
    }

    /// Report how much of the archive has arrived.
    ///
    /// Called once per chunk, which on a fast line is often enough that sending
    /// every one would be noise. Only a change of whole percent, or the first
    /// and last chunk, is published; the stored figure is always exact, so a
    /// watcher that asks for the state gets the true count.
    pub async fn arrived(&self, received: u64, total: Option<u64>) {
        let mut now = self.now.write().await;
        let was = percent_of(now.received, now.total);
        now.received = received;
        now.total = total;
        let is = percent_of(received, total);
        if was != is || total.is_none_or(|t| received >= t) {
            let _ = self.changes.send(now.clone());
        }
    }

    /// Nothing was replaced, and this is why.
    pub async fn failed(&self, why: impl Into<String>) {
        let mut now = self.now.write().await;
        now.phase = Phase::Failed;
        now.failed = Some(why.into());
        let _ = self.changes.send(now.clone());
    }

    /// The update was taken; the process is about to exit.
    pub async fn done(&self) {
        let mut now = self.now.write().await;
        now.phase = Phase::Done;
        let _ = self.changes.send(now.clone());
    }
}

/// Whole percent, or `None` when there is no total to be a percent of.
fn percent_of(received: u64, total: Option<u64>) -> Option<u64> {
    match total {
        Some(total) if total > 0 => Some(received.saturating_mul(100) / total),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn nothing_is_running_to_begin_with() {
        let watch = new_watch();
        let now = watch.now().await;
        assert_eq!(now.phase, Phase::Idle);
        assert!(!now.busy(), "an idle watcher is not holding an update");
    }

    #[tokio::test]
    async fn a_second_update_is_refused_rather_than_doubled() {
        let watch = new_watch();
        assert!(watch.claim(Some("0.23.0".into())).await);
        assert!(
            !watch.claim(Some("0.23.0".into())).await,
            "a download already under way must not be started twice"
        );
    }

    #[tokio::test]
    async fn a_failure_frees_the_run_for_a_retry() {
        let watch = new_watch();
        assert!(watch.claim(None).await);
        watch.failed("Refused: the downloaded file is not the one we published.").await;

        let now = watch.now().await;
        assert_eq!(now.phase, Phase::Failed);
        assert_eq!(
            now.failed.as_deref(),
            Some("Refused: the downloaded file is not the one we published."),
            "the refusal's own words survive to whoever is watching"
        );
        assert!(
            watch.claim(None).await,
            "a failed update leaves nothing behind, so it can be retried"
        );
    }

    #[tokio::test]
    async fn a_watcher_is_told_when_the_bar_would_move() {
        let watch = new_watch();
        watch.claim(None).await;
        let mut seen = watch.watch();

        // The first chunk, a second inside the same percent, then one that
        // crosses it.
        watch.arrived(1, Some(1_000)).await;
        watch.arrived(2, Some(1_000)).await;
        watch.arrived(500, Some(1_000)).await;

        let opening = seen.try_recv().expect("the first chunk is published");
        assert_eq!(
            opening.total,
            Some(1_000),
            "the first chunk is what tells a watcher how big the download is"
        );

        let crossing = seen.try_recv().expect("the crossing chunk is published");
        assert_eq!(crossing.received, 500);

        assert!(
            seen.try_recv().is_err(),
            "the chunk that did not move a whole percent was not sent"
        );
    }

    #[tokio::test]
    async fn the_exact_count_is_kept_even_when_it_is_not_published() {
        let watch = new_watch();
        watch.claim(None).await;
        watch.arrived(7, Some(1_000)).await;
        assert_eq!(
            watch.now().await.received,
            7,
            "the stored figure is exact, whatever was worth sending"
        );
    }

    #[tokio::test]
    async fn a_download_with_no_declared_size_still_reports() {
        let watch = new_watch();
        watch.claim(None).await;
        let mut seen = watch.watch();
        watch.arrived(64, None).await;

        let frame = seen.try_recv().expect("a length-less download still reports");
        assert_eq!(frame.received, 64);
        assert_eq!(
            frame.total, None,
            "no denominator is invented, so the bar stays indeterminate"
        );
    }

    #[test]
    fn a_percent_needs_a_total_worth_dividing_by() {
        assert_eq!(percent_of(50, Some(200)), Some(25));
        assert_eq!(percent_of(5, None), None);
        assert_eq!(percent_of(5, Some(0)), None, "nothing is divided by zero");
    }
}
