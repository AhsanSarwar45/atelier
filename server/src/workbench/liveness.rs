//! Facts about a chat's work that the app checks for itself instead of being told.
//!
//! A provider's word that work has ended can arrive late or never. In
//! bw-1fw6 a background command finished at 10:08, its notice was written at
//! 15:03 when its process died, and the adapter held the turn open the whole
//! time on the strength of that missing notice. The chat read Running for five
//! hours, and reloading asked the same wrong question again. These read the
//! provider's own record and the machine, so the status decision
//! (`status.rs`) never waits on a message that may not come.
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// How much of a record's end is read. A turn's closing rows are the last ones
/// written, so the end of the file is where the question is answered.
const TAIL_BYTES: u64 = 512 * 1024;

/// How old a record's ending must be before it is believed over the wire.
/// Claude writes the row slightly before the adapter finishes delivering the
/// same answer (measured 2026-09-15: row at .549, last ACP delta at .626).
pub const SETTLED: Duration = Duration::from_secs(2);

/// How long one look at the open files stands for. The sweep asks every five
/// seconds and a live turn asks on every event; the machine is read at most
/// this often per file.
const HELD_FOR: Duration = Duration::from_secs(2);

/// The rows at the end of a JSONL record, parsed. A missing file has none.
pub fn tail_rows(record: &Path) -> Vec<Value> {
    let Ok(mut file) = fs::File::open(record) else {
        return Vec::new();
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.split('\n');
    if start > 0 {
        // Cut mid-row.
        lines.next();
    }
    lines
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// The last row of a reply, if it is the reply's ending.
///
/// Claude writes each answer as `assistant` rows carrying the API's
/// `stop_reason`; a reply that is still going ends in `tool_use` or in the
/// `user` row that answers it, and anything that wakes the model again — the
/// person, or a task notification delivered to it — is a `user` row after the
/// ending. Checked on six real records on 2026-09-15: an `end_turn` row was
/// never followed by a new assistant message without a user row between, and
/// every record's last row matched whether its chat was working. A helper's
/// rows are all marked as a sidechain; in the parent's record they are not the
/// parent's.
fn ending_row(rows: &[Value], helper: bool) -> Option<&Value> {
    let last = rows.iter().rev().find(|row| {
        matches!(row["type"].as_str(), Some("assistant" | "user"))
            && (helper || row["isSidechain"] != true)
    })?;
    if last["type"] != "assistant" {
        return None;
    }
    let reason = last["message"]["stop_reason"].as_str()?;
    (reason != "tool_use").then_some(last)
}

fn row_time(row: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(row["timestamp"].as_str()?)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn row_words(row: &Value) -> Option<String> {
    let words = match &row["message"]["content"] {
        Value::String(text) => text.trim().to_string(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    };
    (!words.is_empty()).then_some(words)
}

/// When the record says the agent's reply ended, if its last word was an ending.
pub fn reply_ended_at(rows: &[Value]) -> Option<DateTime<Utc>> {
    ending_row(rows, false).and_then(row_time)
}

type Ending = Option<(DateTime<Utc>, Option<String>)>;

/// A reply's ending and its last words, read again only when the file changed.
fn cached_ending(record: &Path, helper: bool) -> Ending {
    static READ: LazyLock<Mutex<HashMap<PathBuf, (u64, Ending)>>> =
        LazyLock::new(Default::default);
    let size = fs::metadata(record).map(|m| m.len()).ok()?;
    let mut read = READ.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((seen, ended)) = read.get(record) {
        if *seen == size {
            return ended.clone();
        }
    }
    let rows = tail_rows(record);
    let ended = ending_row(&rows, helper).and_then(|row| Some((row_time(row)?, row_words(row))));
    read.insert(record.to_path_buf(), (size, ended.clone()));
    ended
}

/// `reply_ended_at` for a record on disk.
pub fn record_reply_ended_at(record: &Path) -> Option<DateTime<Utc>> {
    cached_ending(record, false).map(|(at, _)| at)
}

/// When a helper's own record ended its reply, and what it last said.
pub fn helper_reply(record: &Path, agent_id: &str) -> Ending {
    let stem = record.file_stem()?.to_str()?;
    let helper = record
        .with_file_name(stem)
        .join("subagents")
        .join(format!("agent-{agent_id}.jsonl"));
    cached_ending(&helper, true)
}

/// A chat's record, found once. Looking means reading every project folder
/// of the account, so a record not written yet is looked for again only
/// after a while. The hold beat and every chat follower ask this for each live
/// chat every two seconds; uncached, that listing never stopped (bw-ifjt.2).
pub fn find_record(config: &Path, session_id: &str) -> Option<PathBuf> {
    static FOUND: LazyLock<Mutex<HashMap<(PathBuf, String), (Instant, Option<PathBuf>)>>> =
        LazyLock::new(Default::default);
    let key = (config.to_path_buf(), session_id.to_string());
    if let Some((at, found)) = FOUND.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        match found {
            Some(path) if path.exists() => return Some(path.clone()),
            None if at.elapsed() < Duration::from_secs(10) => return None,
            _ => {}
        }
    }
    let found = super::claude::history::find_record(config, session_id);
    FOUND
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, (Instant::now(), found.clone()));
    found
}

/// Every ending of background work the record's notices wrote, by task.
///
/// Read forward from where the last look stopped, so a long record is read
/// through once. The first notice for a task is its ending.
pub fn record_endings(record: &Path) -> HashMap<String, Value> {
    static READ: LazyLock<Mutex<HashMap<PathBuf, (u64, HashMap<String, Value>)>>> =
        LazyLock::new(Default::default);
    let Ok(size) = fs::metadata(record).map(|m| m.len()) else {
        return HashMap::new();
    };
    let mut read = READ.lock().unwrap_or_else(|e| e.into_inner());
    let (offset, endings) = read.entry(record.to_path_buf()).or_default();
    if size < *offset {
        // Rewritten.
        *offset = 0;
        endings.clear();
    }
    if size > *offset {
        if let Ok(mut file) = fs::File::open(record) {
            let mut bytes = Vec::new();
            if file.seek(SeekFrom::Start(*offset)).is_ok() && file.read_to_end(&mut bytes).is_ok() {
                // Only whole rows; a row being written is read next time.
                let whole = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
                let rows: Vec<Value> = String::from_utf8_lossy(&bytes[..whole])
                    .split('\n')
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect();
                for notice in super::claude::history::record_notices(&rows) {
                    if let Some(task) = notice["agentId"].as_str() {
                        endings.entry(task.to_string()).or_insert_with(|| notice.clone());
                    }
                }
                *offset += whole as u64;
            }
        }
    }
    endings.clone()
}

/// Where a backgrounded command writes, as its own tool result says.
///
/// Claude answers a command it sends to the background with "Output is being
/// written to: PATH." — whether the model asked for that or the command
/// outran its timeout.
pub fn output_file(tool_output: &str) -> Option<PathBuf> {
    let (_, rest) = tool_output.split_once("Output is being written to: ")?;
    let path = rest.split_whitespace().next()?.trim_end_matches('.');
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Which of these files some process still has open.
///
/// A backgrounded command's shell and the command under it hold its output
/// file open for as long as it runs, and nothing holds it after (measured on
/// Linux 2026-09-15). That is the one fact about background work no message
/// has to carry. Where the machine cannot be asked, every file counts as
/// held: an ending that cannot be shown is not claimed.
pub fn held_open(files: &[PathBuf]) -> HashSet<PathBuf> {
    static SEEN: LazyLock<Mutex<HashMap<PathBuf, (Instant, bool)>>> =
        LazyLock::new(Default::default);
    let mut held = HashSet::new();
    let mut unknown = Vec::new();
    {
        let seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        for file in files {
            match seen.get(file) {
                Some((at, open)) if at.elapsed() < HELD_FOR => {
                    if *open {
                        held.insert(file.clone());
                    }
                }
                _ => unknown.push(file.clone()),
            }
        }
    }
    if unknown.is_empty() {
        return held;
    }
    let found = look_for_holders(&unknown);
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    for file in unknown {
        let open = found.contains(&file);
        seen.insert(file.clone(), (now, open));
        if open {
            held.insert(file);
        }
    }
    held
}

#[cfg(target_os = "linux")]
fn look_for_holders(files: &[PathBuf]) -> HashSet<PathBuf> {
    held_open_in(Path::new("/proc"), files)
}

#[cfg(target_os = "macos")]
fn look_for_holders(files: &[PathBuf]) -> HashSet<PathBuf> {
    files
        .iter()
        .filter(|file| {
            !file.exists()
                || std::process::Command::new("lsof")
                    .arg("-t")
                    .arg("--")
                    .arg(file.as_os_str())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|status| status.success())
                    .unwrap_or(true)
        })
        .filter(|file| file.exists())
        .cloned()
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn look_for_holders(files: &[PathBuf]) -> HashSet<PathBuf> {
    files.iter().filter(|file| file.exists()).cloned().collect()
}

/// Every process's open files under one proc root, for the files asked about.
#[cfg(any(target_os = "linux", test))]
fn held_open_in(proc_root: &Path, files: &[PathBuf]) -> HashSet<PathBuf> {
    let wanted: HashSet<&Path> = files.iter().map(PathBuf::as_path).collect();
    let Ok(processes) = fs::read_dir(proc_root) else {
        return files.iter().filter(|file| file.exists()).cloned().collect();
    };
    let mut held = HashSet::new();
    for process in processes.flatten() {
        let numeric = process
            .file_name()
            .to_str()
            .is_some_and(|name| name.bytes().all(|byte| byte.is_ascii_digit()));
        if !numeric {
            continue;
        }
        let Ok(descriptors) = fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        for descriptor in descriptors.flatten() {
            if let Ok(target) = fs::read_link(descriptor.path()) {
                if wanted.contains(target.as_path()) {
                    held.insert(target);
                }
            }
        }
        if held.len() == wanted.len() {
            break;
        }
    }
    held
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(kind: &str, stop: Option<&str>, at: &str) -> Value {
        json!({"type":kind,"timestamp":at,"message":{"stop_reason":stop}})
    }

    /// Once found, a record is not looked for again: the project folders can
    /// no longer be listed, and the record still comes back.
    #[test]
    fn a_found_record_is_not_looked_for_again() {
        use std::os::unix::fs::PermissionsExt;
        let config = tempfile::tempdir().unwrap();
        let chat = "6f729ab8-6b7d-4ad6-a78e-5dc8cc05eddb";
        let projects = config.path().join("projects");
        let record = projects.join("-home-someone").join(format!("{chat}.jsonl"));
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        fs::write(&record, "").unwrap();
        assert_eq!(find_record(config.path(), chat), Some(record.clone()));

        fs::set_permissions(&projects, fs::Permissions::from_mode(0o300)).unwrap();
        assert!(fs::read_dir(&projects).is_err());
        assert_eq!(find_record(config.path(), chat), Some(record));
        fs::set_permissions(&projects, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn a_reply_has_ended_only_when_its_last_word_is_an_ending() {
        let ended = [
            row("user", None, "2026-09-15T14:50:38Z"),
            row("assistant", Some("tool_use"), "2026-09-15T14:50:43Z"),
            row("user", None, "2026-09-15T14:51:48Z"),
            row("assistant", Some("end_turn"), "2026-09-15T14:51:54Z"),
            json!({"type":"system","subtype":"stop_hook_summary","timestamp":"2026-09-15T14:51:55Z"}),
            json!({"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-15T15:03:54Z"}),
        ];
        assert_eq!(
            reply_ended_at(&ended).unwrap().to_rfc3339(),
            "2026-09-15T14:51:54+00:00"
        );
        // Calling a tool, answered by a tool, or woken again: still going.
        assert_eq!(reply_ended_at(&ended[..2]), None);
        assert_eq!(reply_ended_at(&ended[..3]), None);
        let mut woken = ended.to_vec();
        woken.push(row("user", None, "2026-09-15T15:04:00Z"));
        assert_eq!(reply_ended_at(&woken), None);
        // A helper's row in the parent's record says nothing about the parent.
        let mut helper = ended.to_vec();
        helper.push(json!({"type":"user","isSidechain":true,"timestamp":"2026-09-15T15:05:00Z"}));
        assert!(reply_ended_at(&helper).is_some());
    }

    #[test]
    fn a_helper_reply_is_read_from_its_own_record_with_its_last_words() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        fs::write(&record, "").unwrap();
        let helpers = directory.path().join("chat").join("subagents");
        fs::create_dir_all(&helpers).unwrap();
        let mut last = row("assistant", Some("end_turn"), "2026-09-15T14:51:54Z");
        last["isSidechain"] = json!(true);
        last["message"]["content"] = json!([{"type":"text","text":"Found it."}]);
        fs::write(helpers.join("agent-a1.jsonl"), format!("{last}\n")).unwrap();
        let (_, words) = helper_reply(&record, "a1").unwrap();
        assert_eq!(words.as_deref(), Some("Found it."));
        assert!(helper_reply(&record, "a2").is_none());
    }

    #[test]
    fn notices_are_read_forward_as_the_record_grows() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        let notice = |task: &str, status: &str| {
            json!({"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-15T15:03:54Z",
                "content":format!("<task-notification><task-id>{task}</task-id><status>{status}</status><summary>s</summary></task-notification>")})
        };
        fs::write(&record, format!("{}\n", notice("one", "completed"))).unwrap();
        assert_eq!(record_endings(&record)["one"]["state"], "done");
        let mut file = fs::OpenOptions::new().append(true).open(&record).unwrap();
        use std::io::Write;
        write!(file, "{}\n{}", notice("two", "killed"), "{\"type\":\"queue-op").unwrap();
        let endings = record_endings(&record);
        assert_eq!(endings["two"]["state"], "stopped");
        assert_eq!(endings.len(), 2);
    }

    #[test]
    fn a_backgrounded_command_names_its_output_file() {
        assert_eq!(
            output_file("Command did not complete within its 120s timeout and was moved to the background (ID: bo5vybw2h). Output is being written to: /tmp/claude-1000/p/s/tasks/bo5vybw2h.output. To check interim output, use Read."),
            Some(PathBuf::from("/tmp/claude-1000/p/s/tasks/bo5vybw2h.output"))
        );
        assert_eq!(output_file("port 3471 free"), None);
    }

    #[test]
    fn a_record_is_read_from_its_end() {
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("chat.jsonl");
        let filler = format!("{}\n", json!({"type":"user","pad":"x".repeat(4096)}));
        let mut text = filler.repeat(200);
        text.push_str(&format!("{}\n", row("assistant", Some("end_turn"), "2026-09-15T14:51:54Z")));
        fs::write(&record, text).unwrap();
        assert!(record_reply_ended_at(&record).is_some());
        assert_eq!(record_reply_ended_at(&directory.path().join("missing.jsonl")), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_file_is_held_while_a_process_has_it_open_and_not_after() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("task.output");
        fs::write(&output, "").unwrap();
        let finished = directory.path().join("finished.output");
        fs::write(&finished, "done").unwrap();
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("exec 3>>\"$1\"; sleep 30")
            .arg("sh")
            .arg(&output)
            .spawn()
            .unwrap();
        let output = output.canonicalize().unwrap();
        let finished = finished.canonicalize().unwrap();
        let wanted = [output.clone(), finished.clone()];
        let mut held = HashSet::new();
        for _ in 0..50 {
            held = held_open_in(Path::new("/proc"), &wanted);
            if held.contains(&output) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(held.contains(&output));
        assert!(!held.contains(&finished));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!held_open_in(Path::new("/proc"), &wanted).contains(&output));
    }
}
