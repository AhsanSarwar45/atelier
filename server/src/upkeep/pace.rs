//! The pace background work is held to.
//!
//! The budget is in bytes read and written by the upkeep thread, as the
//! kernel counts them for that thread (`/proc/thread-self/io`). A job does
//! not have to count what it does and cannot forget to: reading a file,
//! a database query, a rewrite all show up in the same number. Where the
//! kernel gives no such count, what the job reports (`Pace::spent`, `Paced`)
//! is used instead.
//!
//! Work is paid for after it is done: `settle` sleeps until the budget is
//! back above zero. A job calls it between its steps, and the upkeep thread
//! calls it after every turn, so a job that never calls it still pays before
//! the next one starts.

use std::cell::Cell;
use std::io::Read;
use std::time::{Duration, Instant};

/// Bytes a second, read and written together. A start that finds a few
/// hundred megabytes of new work spreads it over minutes; the desktop does
/// not notice 2 MB/s.
const PER_SECOND: u64 = 2 * 1024 * 1024;
/// The most that is ever saved up, so a long quiet spell does not turn into
/// a burst.
const SAVED_UP: u64 = 2 * 1024 * 1024;
/// The share of the last ten seconds in which something waited for the disk,
/// above which upkeep waits too (`some avg10` in `/proc/pressure/io`).
const BUSY_PERCENT: f32 = 10.0;
/// How often a busy disk is looked at again.
const LOOKS_AGAIN: Duration = Duration::from_secs(5);
/// The longest one wait for a quiet disk. A disk that is never quiet must
/// not stop upkeep for good: after this one more turn runs, at the same pace.
const LONGEST_WAIT: Duration = Duration::from_secs(600);

pub struct Pace {
    per_second: u64,
    /// Bytes in hand; below zero is owed.
    budget: Cell<f64>,
    filled_at: Cell<Instant>,
    /// The kernel's count for this thread when it was last settled.
    counted: Cell<Option<u64>>,
    /// What the job said it did since then.
    reported: Cell<u64>,
    count: fn() -> Option<u64>,
    busy: fn() -> Option<f32>,
}

impl Pace {
    /// The pace of the upkeep thread, counted by the kernel.
    pub(super) fn measured() -> Self {
        Self::of(PER_SECOND, thread_bytes, disk_busy_percent)
    }

    /// No limit: for a test of what a job does, and for a caller who is
    /// waiting for the answer.
    pub fn unlimited() -> Self {
        Self::of(u64::MAX, || None, || None)
    }

    fn of(per_second: u64, count: fn() -> Option<u64>, busy: fn() -> Option<f32>) -> Self {
        Self {
            per_second,
            budget: Cell::new(SAVED_UP.min(per_second) as f64),
            filled_at: Cell::new(Instant::now()),
            counted: Cell::new(count()),
            reported: Cell::new(0),
            count,
            busy,
        }
    }

    /// Say that `bytes` were read or written. Used where the kernel does not
    /// count for the thread; elsewhere the larger of the two numbers is taken.
    pub fn spent(&self, bytes: u64) {
        self.reported.set(self.reported.get().saturating_add(bytes));
    }

    /// Pay for what was done since the last call, sleeping until the budget
    /// allows more. Call it between the steps of a turn.
    pub fn settle(&self) {
        let owed = self.owed();
        if !owed.is_zero() {
            std::thread::sleep(owed);
        }
    }

    /// Charge what was done and say how long to wait before doing more.
    fn owed(&self) -> Duration {
        if self.per_second == u64::MAX {
            return Duration::ZERO;
        }
        let now_counted = (self.count)();
        let by_kernel = match (self.counted.get(), now_counted) {
            (Some(before), Some(now)) => now.saturating_sub(before),
            _ => 0,
        };
        self.counted.set(now_counted);
        let did = by_kernel.max(self.reported.replace(0));
        let now = Instant::now();
        let earned = now.duration_since(self.filled_at.replace(now)).as_secs_f64() * self.per_second as f64;
        let budget = (self.budget.get() + earned).min(SAVED_UP.min(self.per_second) as f64) - did as f64;
        self.budget.set(budget);
        if budget >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-budget / self.per_second as f64)
        }
    }

    /// Wait while something else is kept waiting for the disk.
    pub fn wait_for_a_quiet_disk(&self) {
        let began = Instant::now();
        while (self.busy)().is_some_and(|percent| percent >= BUSY_PERCENT) && began.elapsed() < LONGEST_WAIT {
            std::thread::sleep(LOOKS_AGAIN);
        }
    }
}

/// A reader that pays as it goes, so one large file is spread out instead of
/// being read in one burst and paid for afterwards.
pub struct Paced<'a, R> {
    inner: R,
    pace: &'a Pace,
    since: u64,
}

/// How much of a file is read between two payments.
const STEP: u64 = 256 * 1024;

impl<'a, R: Read> Paced<'a, R> {
    pub fn new(inner: R, pace: &'a Pace) -> Self {
        Self { inner, pace, since: 0 }
    }
}

impl<R: Read> Read for Paced<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.pace.spent(read as u64);
        self.since += read as u64;
        if self.since >= STEP {
            self.since = 0;
            self.pace.settle();
        }
        Ok(read)
    }
}

/// Bytes this thread has read and written so far, by the kernel's count.
///
/// The kernel keeps two counts. One is what the thread asked for in read and
/// write calls, whether or not the disk was needed; the other is what the
/// disk was asked for on its behalf, which also counts a file read through
/// memory (SQLite's `mmap_size`), where no call is made at all. The larger of
/// the two is taken, for reading and for writing.
pub fn thread_bytes() -> Option<u64> {
    let io = std::fs::read_to_string("/proc/thread-self/io").ok()?;
    let field = |name: &str| {
        io.lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| value.trim().parse::<u64>().ok())
    };
    let read = field("rchar:")?.max(field("read_bytes:").unwrap_or(0));
    let written = field("wchar:")?.max(field("write_bytes:").unwrap_or(0));
    Some(read + written)
}

/// How much of the last ten seconds something spent waiting for the disk.
fn disk_busy_percent() -> Option<f32> {
    busy_percent(&std::fs::read_to_string("/proc/pressure/io").ok()?)
}

fn busy_percent(pressure: &str) -> Option<f32> {
    pressure
        .lines()
        .find_map(|line| line.strip_prefix("some "))?
        .split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> Option<u64> {
        None
    }

    #[test]
    fn work_within_the_budget_is_not_kept_waiting() {
        let pace = Pace::of(1000, none, || None);
        pace.spent(400);
        assert_eq!(pace.owed(), Duration::ZERO);
    }

    #[test]
    fn work_past_the_budget_waits_for_as_long_as_it_takes_to_earn() {
        let pace = Pace::of(1000, none, || None);
        pace.spent(3000);
        let owed = pace.owed().as_secs_f64();
        assert!((1.9..=2.0).contains(&owed), "2000 bytes over at 1000 a second, owed {owed}");
    }

    #[test]
    fn a_quiet_spell_saves_up_no_more_than_the_limit() {
        let pace = Pace::of(1000, none, || None);
        pace.filled_at.set(Instant::now() - Duration::from_secs(3600));
        pace.spent(3000);
        assert!(pace.owed() >= Duration::from_millis(1900));
    }

    #[test]
    fn the_larger_of_the_kernels_count_and_the_jobs_is_charged() {
        thread_local!(static COUNTED: Cell<u64> = const { Cell::new(0) });
        let pace = Pace::of(1000, || Some(COUNTED.with(Cell::get)), || None);
        COUNTED.with(|counted| counted.set(5000));
        pace.spent(10);
        assert!(pace.owed() >= Duration::from_millis(3900));
    }

    #[test]
    fn a_paced_reader_reports_every_byte() {
        let pace = Pace::of(u64::MAX - 1, none, || None);
        let mut read = Vec::new();
        Paced::new(&[7u8; 1000][..], &pace).read_to_end(&mut read).unwrap();
        assert_eq!((read.len(), pace.reported.get()), (1000, 1000));
    }

    #[test]
    fn the_busy_share_is_read_from_the_pressure_file() {
        let pressure = "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=9.00 avg60=1.00 avg300=0.50 total=1\n";
        assert_eq!(busy_percent(pressure), Some(12.5));
        assert_eq!(busy_percent(""), None);
    }

    #[test]
    fn nothing_is_waited_for_while_the_disk_is_quiet_or_cannot_be_asked() {
        let began = Instant::now();
        Pace::of(1000, none, || None).wait_for_a_quiet_disk();
        Pace::of(1000, none, || Some(0.5)).wait_for_a_quiet_disk();
        assert!(began.elapsed() < Duration::from_secs(1));
    }
}
