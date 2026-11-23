//! Work nobody asked for runs here, and nowhere else.
//!
//! The server does things by itself: it strips pictures from finished agent
//! records, indexes chats for search, measures what its database holds. Each
//! of those once had a thread and a timer of its own and no limit, so a start
//! read gigabytes while the desktop waited for the disk. Now there is one
//! thread, named `upkeep`, and every such job is a `Job` given to it:
//!
//! - one job works at a time, a short turn each, so two never add up;
//! - what the thread reads and writes is counted by the kernel and held to a
//!   pace (`Pace`), whatever the job does and whether or not it counts;
//! - it waits while the disk is busy with anything else;
//! - nothing starts until the app has been up for a while.
//!
//! A job has no other way to run, so one added later gets the same limits.
//! What a job has already done it must remember across a restart; the pace
//! keeps the cost of work low, it does not make repeated work free.
//! `scripts/checks/an-idle-server-spares-the-disk.sh` holds both rules.

mod pace;

pub use pace::{thread_bytes, Counted, Pace, Paced};

use std::time::{Duration, Instant};

/// How long after start the first job waits: the app starting is when the
/// disk is wanted most.
const WAITS_AFTER_START: Duration = Duration::from_secs(60);

/// What one turn may read and write before the log names it.
const LONG_TURN: u64 = 32 * 1024 * 1024;

/// What a turn left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn {
    /// Nothing is left; look again after the job's interval.
    Done,
    /// More is waiting; the job gets another turn once the others had theirs.
    More,
}

/// One kind of background work.
pub struct Job {
    name: &'static str,
    every: Duration,
    turn: Box<dyn FnMut(&Pace) -> Turn + Send>,
}

impl Job {
    /// A job that takes a turn, and once a turn says `Done` waits `every`
    /// before the next. A turn is short: one file, one batch of rows.
    pub fn new(
        name: &'static str,
        every: Duration,
        turn: impl FnMut(&Pace) -> Turn + Send + 'static,
    ) -> Self {
        Self { name, every, turn: Box::new(turn) }
    }
}

/// Run the jobs for as long as the process lives, on the one upkeep thread.
pub fn start(jobs: Vec<Job>) {
    let started = std::thread::Builder::new()
        .name("upkeep".to_string())
        .spawn(move || run(jobs, WAITS_AFTER_START, &Pace::measured()));
    if let Err(error) = started {
        tracing::warn!(%error, "upkeep thread did not start; no background work will run");
    }
}

fn run(mut jobs: Vec<Job>, wait: Duration, pace: &Pace) {
    std::thread::sleep(wait);
    let mut due: Vec<Instant> = jobs.iter().map(|_| Instant::now()).collect();
    let mut next = 0;
    while !jobs.is_empty() {
        let Some(at) = take_turn(&mut jobs, &mut due, &mut next, pace) else {
            continue;
        };
        std::thread::sleep(at.saturating_duration_since(Instant::now()));
    }
}

/// Give the next job that is due one turn. `Some` is when the earliest job
/// is due, returned when none is due now.
fn take_turn(
    jobs: &mut [Job],
    due: &mut [Instant],
    next: &mut usize,
    pace: &Pace,
) -> Option<Instant> {
    let now = Instant::now();
    // Round the table from where the last turn was taken, so a job with more
    // to do never keeps the others from theirs.
    let order = (0..jobs.len()).map(|step| (*next + step) % jobs.len());
    let Some(chosen) = order.into_iter().find(|&job| due[job] <= now) else {
        return due.iter().min().copied();
    };
    *next = (chosen + 1) % jobs.len();
    pace.wait_for_a_quiet_disk();
    let job = &mut jobs[chosen];
    let began = Instant::now();
    let before = thread_bytes();
    let turn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (job.turn)(pace)));
    pace.settle();
    due[chosen] = match turn {
        Ok(Turn::More) => Instant::now(),
        Ok(Turn::Done) => Instant::now() + job.every,
        Err(_) => {
            tracing::warn!(job = job.name, "upkeep job failed; trying again after its interval");
            Instant::now() + job.every
        }
    };
    let bytes = thread_bytes().zip(before).map_or(0, |(now, before)| now.saturating_sub(before));
    // A turn is meant to be short. One that is not is named, so a job that
    // reads a great deal in one go is found from the log.
    if bytes >= LONG_TURN {
        tracing::info!(job = job.name, mb = bytes / (1024 * 1024), elapsed_ms = began.elapsed().as_millis() as u64, "a long upkeep turn");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn turns(jobs: &mut [Job], count: usize) {
        let pace = Pace::unlimited();
        let mut due: Vec<Instant> = jobs.iter().map(|_| Instant::now()).collect();
        let mut next = 0;
        for _ in 0..count {
            take_turn(jobs, &mut due, &mut next, &pace);
        }
    }

    #[test]
    fn a_job_with_more_to_do_does_not_keep_the_others_waiting() {
        let said = Arc::new(Mutex::new(Vec::new()));
        let (busy, other) = (said.clone(), said.clone());
        let mut jobs = vec![
            Job::new("busy", Duration::from_secs(3600), move |_| {
                busy.lock().unwrap().push("busy");
                Turn::More
            }),
            Job::new("other", Duration::from_secs(3600), move |_| {
                other.lock().unwrap().push("other");
                Turn::More
            }),
        ];
        turns(&mut jobs, 4);
        assert_eq!(*said.lock().unwrap(), ["busy", "other", "busy", "other"]);
    }

    #[test]
    fn a_job_that_is_done_waits_its_interval() {
        let said = Arc::new(Mutex::new(0));
        let counted = said.clone();
        let mut jobs = vec![Job::new("once", Duration::from_secs(3600), move |_| {
            *counted.lock().unwrap() += 1;
            Turn::Done
        })];
        turns(&mut jobs, 3);
        assert_eq!(*said.lock().unwrap(), 1);
    }

    #[test]
    fn a_job_that_panics_does_not_end_the_others() {
        let said = Arc::new(Mutex::new(0));
        let counted = said.clone();
        let mut jobs = vec![
            Job::new("broken", Duration::from_secs(3600), |_| panic!("broken job")),
            Job::new("fine", Duration::from_secs(3600), move |_| {
                *counted.lock().unwrap() += 1;
                Turn::More
            }),
        ];
        turns(&mut jobs, 3);
        assert_eq!(*said.lock().unwrap(), 2);
    }
}
