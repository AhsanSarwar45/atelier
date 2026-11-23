//! What one pass over a chat's record found, kept so the pass is not made
//! again.
//!
//! Two questions are put to a record's bytes whenever its chat is opened:
//! whether the chat ever sent work to a helper, and how the calls that
//! started its helpers ended. Each was answered by reading the record from
//! its first line to its last, every time; a long chat's record is hundreds
//! of megabytes, and opening it, switching back to it or a window
//! reconnecting each read all of it again.
//!
//! A record is only ever added to. So what a pass found stands for the bytes
//! it covered, and the next pass starts where that one stopped: opening a
//! chat reads what was written since the last time, which is usually
//! nothing. What was found is kept beside the app's data, so a restart does
//! not start over either.
//!
//! A record that is not the file it was (another inode, shorter, or other
//! bytes where the last pass stopped) is read from its first line again.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How many bytes before the place a pass stopped are compared, to tell a
/// record that was added to from one that was written anew.
const SEAM: u64 = 256;
/// The file is written at most this often; what a crash loses is read again.
const SAVED_EVERY: Duration = Duration::from_secs(30);

#[derive(Clone, Default, Serialize, Deserialize)]
struct Scan {
    /// Which file this was (its inode), and the byte just past the last
    /// whole line read.
    file: u64,
    to: u64,
    /// The bytes just before `to`, hashed.
    seam: u64,
    delegated: bool,
    /// The calls whose results were looked for over all of `0..to`.
    asked: HashSet<String>,
    outcomes: HashMap<String, bool>,
}

#[derive(Default)]
struct Scans {
    known: HashMap<PathBuf, Scan>,
    unsaved: bool,
    saved_at: Option<Instant>,
}

static STORE: OnceLock<PathBuf> = OnceLock::new();
static SCANS: OnceLock<Mutex<Scans>> = OnceLock::new();

/// Keep what the passes find in `store`, read back at the next start.
pub fn keep_in(store: PathBuf) {
    let _ = STORE.set(store);
}

fn scans() -> std::sync::MutexGuard<'static, Scans> {
    SCANS
        .get_or_init(|| {
            let known = STORE
                .get()
                .and_then(|store| fs::read(store).ok())
                .and_then(|bytes| serde_json::from_slice::<Vec<(PathBuf, Scan)>>(&bytes).ok())
                .map(|known| known.into_iter().collect())
                .unwrap_or_default();
            Mutex::new(Scans { known, ..Scans::default() })
        })
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Write what is known if anything is new and the last write is not recent.
/// Called after a pass and by upkeep, so the last pass of a quiet spell is
/// written too.
pub fn save() {
    let Some(store) = STORE.get() else {
        return;
    };
    let kept: Vec<(PathBuf, Scan)> = {
        let mut scans = scans();
        if !scans.unsaved || scans.saved_at.is_some_and(|at| at.elapsed() < SAVED_EVERY) {
            return;
        }
        scans.unsaved = false;
        scans.saved_at = Some(Instant::now());
        scans.known.retain(|path, _| path.exists());
        scans.known.iter().map(|(path, scan)| (path.clone(), scan.clone())).collect()
    };
    // Written beside and renamed over, so a reader never finds half a file.
    let beside = store.with_extension("json.part");
    let written = serde_json::to_vec(&kept)
        .map_err(std::io::Error::other)
        .and_then(|bytes| fs::write(&beside, bytes))
        .and_then(|()| fs::rename(&beside, store));
    if let Err(error) = written {
        tracing::warn!(%error, "could not keep what the record passes found");
    }
}

/// The upkeep job that writes down what the last passes found.
pub fn job() -> crate::upkeep::Job {
    crate::upkeep::Job::new("record passes", Duration::from_secs(60), |_| {
        save();
        crate::upkeep::Turn::Done
    })
}

/// Whether the record holds a call that sends work to a helper.
pub fn delegated(record: &Path) -> bool {
    caught_up(record, &HashSet::new()).delegated
}

/// Whether each of `calls` succeeded, from the tool results in the record.
pub fn outcomes(record: &Path, calls: &HashSet<String>) -> HashMap<String, bool> {
    if calls.is_empty() {
        return HashMap::new();
    }
    let scan = caught_up(record, calls);
    scan.outcomes.into_iter().filter(|(call, _)| calls.contains(call)).collect()
}

#[cfg(unix)]
fn file_of(about: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    about.ino()
}

#[cfg(not(unix))]
fn file_of(_about: &fs::Metadata) -> u64 {
    0
}

/// The bytes just before `to`, hashed.
fn seam_of(file: &mut fs::File, to: u64) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let from = to.saturating_sub(SEAM);
    let mut bytes = vec![0; (to - from) as usize];
    file.seek(SeekFrom::Start(from)).ok()?;
    file.read_exact(&mut bytes).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

/// Bring what is known of `record` up to its last line, looking for the
/// results of `calls` as well as those already asked for.
fn caught_up(record: &Path, calls: &HashSet<String>) -> Scan {
    let Ok(mut file) = fs::File::open(record) else {
        return Scan::default();
    };
    let Ok(about) = file.metadata() else {
        return Scan::default();
    };
    let before = scans().known.get(record).cloned();
    let mut scan = before
        .filter(|scan| {
            scan.file == file_of(&about)
                && scan.to <= about.len()
                && seam_of(&mut file, scan.to) == Some(scan.seam)
        })
        .unwrap_or_default();
    scan.file = file_of(&about);
    let began = (scan.to, scan.delegated, scan.asked.len(), scan.outcomes.len());

    // A call not asked about before may have its result in what was already
    // covered: those bytes are read once more, for the new calls only.
    let new: HashSet<String> = calls.difference(&scan.asked).cloned().collect();
    if !new.is_empty() && scan.to > 0 {
        let mut found = Scan::default();
        pass(&mut file, 0, Some(scan.to), &new, true, &mut found);
        scan.outcomes.extend(found.outcomes);
    }
    scan.asked.extend(new);

    let asked = scan.asked.clone();
    let from = scan.to;
    let delegated = scan.delegated;
    scan.to = pass(&mut file, from, None, &asked, delegated, &mut scan);
    scan.seam = seam_of(&mut file, scan.to).unwrap_or_default();

    if began != (scan.to, scan.delegated, scan.asked.len(), scan.outcomes.len()) {
        let mut scans = scans();
        scans.known.insert(record.to_path_buf(), scan.clone());
        scans.unsaved = true;
        drop(scans);
        save();
    }
    scan
}

/// Read the lines from byte `from` to `until` (the end when `None`), noting
/// in `found` the results of `calls` and, unless `delegated` is known
/// already, whether work was sent to a helper. Returns the byte just past the
/// last whole line: a line still being written is looked at, since what it
/// holds already counts, and read again by the next pass.
fn pass(
    file: &mut fs::File,
    from: u64,
    until: Option<u64>,
    calls: &HashSet<String>,
    delegated: bool,
    found: &mut Scan,
) -> u64 {
    if file.seek(SeekFrom::Start(from)).is_err() {
        return from;
    }
    let limit = until.map_or(u64::MAX, |until| until.saturating_sub(from));
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, file.take(limit));
    let mut line = Vec::new();
    let mut whole = from;
    let mut delegated = delegated;
    while matches!(reader.read_until(b'\n', &mut line), Ok(read) if read > 0) {
        if line.ends_with(b"\n") {
            whole += line.len() as u64;
        }
        if !delegated && sends_work(&line) {
            delegated = true;
            found.delegated = true;
        }
        if !calls.is_empty() && super::history::names_a_result_for(&line, calls) {
            if let Ok(row) = serde_json::from_slice::<Value>(&line) {
                found.outcomes.extend(
                    super::history::tool_outcomes(std::slice::from_ref(&row))
                        .into_iter()
                        .filter(|(call, _)| calls.contains(call)),
                );
            }
        }
        line.clear();
    }
    whole
}

/// Whether one raw record line holds a `Task` or `Agent` call. Only a line
/// that could is parsed.
fn sends_work(line: &[u8]) -> bool {
    let has = |text: &[u8]| line.windows(text.len()).any(|window| window == text);
    has(b"\"tool_use\"")
        && (has(b"\"Task\"") || has(b"\"Agent\""))
        && serde_json::from_slice::<Value>(line).is_ok_and(|row| {
            row["message"]["content"].as_array().into_iter().flatten().any(|block| {
                block["type"] == "tool_use" && matches!(block["name"].as_str(), Some("Task") | Some("Agent"))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn call(name: &str, id: &str) -> String {
        serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":name,"id":id,"input":{}}]}})
            .to_string()
            + "\n"
    }

    fn result(id: &str, failed: bool) -> String {
        serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":failed,"content":"x"}]}})
            .to_string()
            + "\n"
    }

    fn add(record: &Path, text: &str) {
        fs::OpenOptions::new().create(true).append(true).open(record).unwrap().write_all(text.as_bytes()).unwrap();
    }

    fn covered(record: &Path) -> u64 {
        scans().known.get(record).map(|scan| scan.to).unwrap_or(0)
    }

    #[test]
    fn a_record_is_read_from_where_the_last_pass_stopped() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        add(&record, &call("Bash", "b1"));
        add(&record, &result("b1", false));
        assert!(!delegated(&record));
        let first = fs::metadata(&record).unwrap().len();
        assert_eq!(covered(&record), first);

        // Nothing new: nothing but the seam is read, and the answer stands.
        assert!(!delegated(&record));
        assert_eq!(covered(&record), first);

        add(&record, &call("Task", "t1"));
        assert!(delegated(&record), "a call written since the last pass was not found");
        assert_eq!(covered(&record), fs::metadata(&record).unwrap().len());
    }

    #[test]
    fn a_call_asked_about_later_is_looked_for_in_what_was_already_read() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        add(&record, &call("Task", "t1"));
        add(&record, &result("t1", false));
        add(&record, &call("Task", "t2"));
        add(&record, &result("t2", true));
        let one: HashSet<String> = ["t1".to_string()].into();
        assert_eq!(outcomes(&record, &one), HashMap::from([("t1".to_string(), true)]));
        let both: HashSet<String> = ["t1".to_string(), "t2".to_string()].into();
        assert_eq!(
            outcomes(&record, &both),
            HashMap::from([("t1".to_string(), true), ("t2".to_string(), false)])
        );
        add(&record, &call("Task", "t3"));
        add(&record, &result("t3", false));
        let third: HashSet<String> = ["t3".to_string()].into();
        assert_eq!(outcomes(&record, &third), HashMap::from([("t3".to_string(), true)]));
    }

    #[test]
    fn a_record_written_anew_is_read_from_its_first_line() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        add(&record, &call("Bash", "b1"));
        add(&record, &call("Bash", "b2"));
        assert!(!delegated(&record));
        // The same file, as long as before, with other bytes in it.
        fs::write(&record, call("Task", "t1") + &call("Bash", "b3")).unwrap();
        assert!(delegated(&record));
    }

    #[test]
    fn a_line_still_being_written_counts_and_is_read_again() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        add(&record, &call("Bash", "b1"));
        let whole = fs::metadata(&record).unwrap().len();
        add(&record, call("Task", "t1").trim_end());
        assert!(delegated(&record), "a last line without its newline still counts");
        assert_eq!(covered(&record), whole);
    }
}
