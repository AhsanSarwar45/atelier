//! Measured project-specific compaction durations.

use std::collections::{HashMap, HashSet};

pub const RUN_CAP_MS: i64 = 1_800_000;
pub const RUNS_ENOUGH: usize = 5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Beat {
    pub id: String,
    pub project: String,
    pub summarising: bool,
    pub since: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SummaryRun {
    pub project: String,
    pub session_id: String,
    pub at: i64,
    pub ms: i64,
}

#[derive(Default)]
pub struct SummaryTracker {
    began: HashMap<String, (String, i64)>,
}

impl SummaryTracker {
    pub fn observe(&mut self, beat: &[Beat], now: i64) -> Vec<SummaryRun> {
        let mut here = HashSet::new();
        let mut finished = Vec::new();
        for chat in beat {
            here.insert(chat.id.clone());
            if chat.summarising {
                self.began
                    .entry(chat.id.clone())
                    .or_insert_with(|| (chat.project.clone(), chat.since.unwrap_or(now)));
            } else if let Some((project, began)) = self.began.remove(&chat.id) {
                let ms = now - began;
                if ms > 0 && ms <= RUN_CAP_MS {
                    finished.push(SummaryRun {
                        project,
                        session_id: chat.id.clone(),
                        at: now,
                        ms,
                    });
                }
            }
        }
        self.began.retain(|id, _| here.contains(id));
        finished
    }
}

pub fn median(runs: &[i64], enough: usize) -> Option<i64> {
    let mut sane: Vec<_> = runs.iter().copied().filter(|ms| *ms > 0).collect();
    sane.sort_unstable();
    if sane.len() < enough {
        return None;
    }
    let middle = sane.len() / 2;
    Some(if sane.len() % 2 == 1 {
        sane[middle]
    } else {
        (sane[middle - 1] + sane[middle] + 1) / 2
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_workbench_services_metadata_measures_and_summarises_compactions() {
        let mut tracker = SummaryTracker::default();
        assert!(tracker
            .observe(
                &[Beat {
                    id: "chat".into(),
                    project: "/p".into(),
                    summarising: true,
                    since: Some(100)
                }],
                200
            )
            .is_empty());
        let runs = tracker.observe(
            &[Beat {
                id: "chat".into(),
                project: "/p".into(),
                summarising: false,
                since: None,
            }],
            500,
        );
        assert_eq!(runs[0].ms, 400);
        assert_eq!(median(&[5, 1, 4, 2, 3], RUNS_ENOUGH), Some(3));
        assert_eq!(median(&[1, 2, 3, 4], RUNS_ENOUGH), None);

        let db = tempfile::NamedTempFile::new().unwrap();
        let store = crate::workbench::store::Store::open(db.path()).unwrap();
        store
            .note_summary_run("/p", "chat", "2026-08-30T00:00:00Z", 400)
            .unwrap();
        assert_eq!(store.summary_runs("/p", 20).unwrap(), [400]);
    }
}
