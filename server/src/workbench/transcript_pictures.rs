//! Pictures leave the transcripts of chats an agent ran, once the run is over.
//!
//! A provider writes every picture it sees or makes into its own record as
//! base64, and Codex writes each one twice — the tool's answer and the item
//! that finished. Scripts that run `codex exec` from an Atelier chat use the
//! app's profile, so their records land in the app's data: one picture
//! generator filled 31 GB in a week, every byte of it pictures nobody reads
//! again (bw-zubih.1). Nobody opens or resumes those chats; they are out of
//! the chat list (bw-6usxb). So once a record has been left alone for a while,
//! each picture in it is swapped for a one-pixel stand-in. The record stays a
//! record: every line still parses, every other line is byte for byte what the
//! provider wrote, and a picture field still holds a picture.
//!
//! Only records in the app's own profiles are touched, and only ones an agent
//! began — Codex threads `begun_by` calls the agents', and Claude's subagent
//! records. A person's chats keep their pictures.

use base64::Engine;
use serde_json::{json, Value};
use crate::upkeep::{Pace, Paced};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Below this a string is not a picture worth the rewrite.
const PICTURE_KEPT: usize = 8 * 1024;
/// A transparent one-pixel PNG: still a picture to anything that reads one.
const STAND_IN: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DEPTH: usize = 12;

/// What one sweep did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Swept {
    pub records: usize,
    pub freed: u64,
}

/// Records already read and found with no pictures, by length and change
/// time, so a record is read once: not again ten minutes later, and not
/// again after a restart. The list is kept in a file beside the app's data;
/// kept only in memory, every start read every finished record in full, and
/// on a machine with months of agent runs that was gigabytes before anyone
/// opened a window.
#[derive(Default)]
pub struct Sweeper {
    clean: HashMap<PathBuf, (u64, SystemTime)>,
    /// Where `clean` is kept between runs of the app.
    store: Option<PathBuf>,
    /// Whether `clean` holds something the store does not.
    unsaved: usize,
    /// The records this pass has still to look at.
    waiting: VecDeque<PathBuf>,
    /// Every record the pass found, which is what the store keeps.
    found: HashSet<PathBuf>,
    /// What the pass has done so far.
    swept: Swept,
    passing: bool,
}

/// How long a record is left alone before its pictures go.
const LEFT_ALONE: Duration = Duration::from_secs(3600);
/// How long after one pass the next begins.
const PASS_EVERY: Duration = Duration::from_secs(600);

/// The upkeep job that sweeps the records under `profiles`, one record a
/// turn, remembering in `store` which it found with nothing to strip.
pub fn job(profiles: PathBuf, store: PathBuf) -> crate::upkeep::Job {
    let mut sweeper = Sweeper::kept_in(store);
    crate::upkeep::Job::new("agent records' pictures", PASS_EVERY, move |pace| {
        match sweeper.turn(&profiles, LEFT_ALONE, pace) {
            None => crate::upkeep::Turn::More,
            Some(swept) => {
                if swept.records > 0 {
                    tracing::info!(
                        records = swept.records,
                        freed = swept.freed,
                        "pictures stripped from agent records"
                    );
                }
                crate::upkeep::Turn::Done
            }
        }
    })
}

/// How many records are learned between two saves of the list, so a pass
/// stopped halfway keeps most of what it read.
const SAVED_EVERY: usize = 64;

type Kept = Vec<(PathBuf, u64, u64, u32)>;

impl Sweeper {
    /// A sweeper that remembers what it found clean in `store`.
    pub fn kept_in(store: PathBuf) -> Self {
        let clean = fs::read(&store)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|(path, len, secs, nanos)| {
                (path, (len, SystemTime::UNIX_EPOCH + Duration::new(secs, nanos)))
            })
            .collect();
        Self { clean, store: Some(store), ..Self::default() }
    }

    fn save(&mut self) {
        self.unsaved = 0;
        let Some(store) = &self.store else {
            return;
        };
        let kept: Kept = self
            .clean
            .iter()
            .filter_map(|(path, (len, modified))| {
                let since = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?;
                Some((path.clone(), *len, since.as_secs(), since.subsec_nanos()))
            })
            .collect();
        // Written beside and renamed over, so a reader never finds half a list.
        let beside = store.with_extension("json.part");
        let written = serde_json::to_vec(&kept)
            .map_err(std::io::Error::other)
            .and_then(|bytes| fs::write(&beside, bytes))
            .and_then(|()| fs::rename(&beside, store));
        if let Err(error) = written {
            tracing::warn!(%error, "could not keep the list of records with no pictures");
        }
    }

    /// Strip every record under `profiles` that an agent began and nothing has
    /// written to for `idle`.
    pub fn sweep(&mut self, profiles: &Path, idle: Duration) -> Swept {
        let pace = Pace::unlimited();
        loop {
            if let Some(swept) = self.turn(profiles, idle, &pace) {
                return swept;
            }
        }
    }

    /// One step of a pass: find the records to look at, or look at one.
    /// `Some` is what the whole pass did, once it has looked at them all.
    pub fn turn(&mut self, profiles: &Path, idle: Duration, pace: &Pace) -> Option<Swept> {
        if !self.passing {
            self.passing = true;
            self.swept = Swept::default();
            let records = agent_records(profiles);
            self.waiting = records.iter().cloned().collect();
            self.found = records.into_iter().collect();
            return None;
        }
        let now = SystemTime::now();
        while let Some(path) = self.waiting.pop_front() {
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            if now.duration_since(modified).unwrap_or_default() < idle {
                continue;
            }
            if self.clean.get(&path) == Some(&(meta.len(), modified)) {
                continue;
            }
            // A record shorter than one picture holds none, and is not read.
            if meta.len() <= PICTURE_KEPT as u64 {
                self.clean.insert(path, (meta.len(), modified));
                self.unsaved += 1;
                continue;
            }
            match strip_at(&path, pace) {
                // Left for later: held open, or written to while it was read.
                Ok(None) => {}
                Ok(Some(freed)) => {
                    if freed > 0 {
                        self.swept.records += 1;
                        self.swept.freed += freed;
                    }
                    if let Ok(meta) = fs::metadata(&path) {
                        if let Ok(modified) = meta.modified() {
                            self.clean.insert(path, (meta.len(), modified));
                            self.unsaved += 1;
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "pictures not stripped from record")
                }
            }
            if self.unsaved >= SAVED_EVERY {
                self.save();
            }
            // One record read is one step.
            return None;
        }
        // A record that is gone is forgotten with the pass that missed it.
        let known = self.clean.len();
        let found = std::mem::take(&mut self.found);
        self.clean.retain(|path, _| found.contains(path));
        if self.unsaved > 0 || self.clean.len() != known {
            self.save();
        }
        self.passing = false;
        Some(std::mem::take(&mut self.swept))
    }
}

/// Every record in the app's profiles that an agent began.
fn agent_records(profiles: &Path) -> Vec<PathBuf> {
    let mut records = Vec::new();
    for account in children(&profiles.join("codex")) {
        let mut rollouts = Vec::new();
        jsonl_under(&account.join("sessions"), 4, &mut rollouts);
        records.extend(rollouts.into_iter().filter(|path| {
            super::codex::history::begun_by(&json!({"path": path.to_string_lossy()})) == "agent"
        }));
    }
    for account in children(&profiles.join("claude")) {
        for project in children(&account.join("projects")) {
            for chat in children(&project) {
                jsonl_under(&chat.join("subagents"), 0, &mut records);
            }
        }
    }
    records
}

fn children(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

fn jsonl_under(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() && depth > 0 => jsonl_under(&path, depth - 1, found),
            Ok(kind) if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") => {
                found.push(path)
            }
            _ => {}
        }
    }
}

/// Rewrite one record with its pictures swapped out, and say how many bytes
/// that freed — `None` when the record was left for a later sweep. A record
/// with no pictures is left as it is, and frees nothing. A record that
/// changes while it is read — a run resumed after all — is left for the next
/// sweep rather than losing what was written meanwhile.
pub fn strip(path: &Path) -> std::io::Result<Option<u64>> {
    strip_at(path, &Pace::unlimited())
}

/// `strip`, reading no faster than `pace` allows.
pub fn strip_at(path: &Path, pace: &Pace) -> std::io::Result<Option<u64>> {
    // A provider keeps a record open for as long as the thread is loaded and
    // appends through that handle, so a record swapped while it is held would
    // send the next lines to the file it replaced. An idle hour does not prove
    // the writer has gone; an open handle proves it has not.
    if held_open(path) {
        return Ok(None);
    }
    let before = fs::metadata(path)?;
    let modified = before.modified()?;
    let mut reader = BufReader::new(Paced::new(File::open(path)?, pace));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temporary = path.with_file_name(format!(".{name}.stripping"));
    let mut writer: Option<BufWriter<File>> = None;
    let mut written = 0u64;
    let mut line = Vec::new();
    let mut read = 0u64;
    loop {
        line.clear();
        let length = reader.read_until(b'\n', &mut line)?;
        if length == 0 {
            break;
        }
        let stripped = (line.len() > PICTURE_KEPT)
            .then(|| stripped_line(&line))
            .flatten();
        if stripped.is_some() && writer.is_none() {
            // The first picture: everything before it is copied as it was.
            let mut fresh = BufWriter::new(File::create(&temporary)?);
            let head = Paced::new(File::open(path)?, pace);
            std::io::copy(&mut head.take(read), &mut fresh)?;
            written = read;
            writer = Some(fresh);
        }
        read += length as u64;
        if let Some(out) = writer.as_mut() {
            let bytes = stripped.as_deref().unwrap_or(&line);
            out.write_all(bytes)?;
            written += bytes.len() as u64;
        }
    }
    // Our own reading handle is let go, or the check below would find it.
    drop(reader);
    let Some(writer) = writer else {
        return Ok(Some(0));
    };
    let file = writer.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    let after = fs::metadata(path)?;
    if after.len() != before.len() || after.modified()? != modified || held_open(path) {
        let _ = fs::remove_file(&temporary);
        return Ok(None);
    }
    // The record keeps the time it was last written, so lists ordered by it
    // and the idle test above read it as they did before.
    file.set_modified(modified)?;
    fs::rename(&temporary, path)?;
    Ok(Some(before.len().saturating_sub(written)))
}

/// Whether any process of ours has the record open, read from each one's
/// descriptors. Another user's processes cannot be read and cannot hold the
/// owner's records either.
fn held_open(path: &Path) -> bool {
    let Ok(path) = fs::canonicalize(path) else {
        return false;
    };
    fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|process| {
            process
                .file_name()
                .to_str()
                .is_some_and(|name| name.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .flat_map(|process| {
            fs::read_dir(process.path().join("fd"))
                .into_iter()
                .flatten()
                .flatten()
        })
        .any(|descriptor| fs::read_link(descriptor.path()).is_ok_and(|target| target == path))
}

fn stripped_line(line: &[u8]) -> Option<Vec<u8>> {
    let (text, ending) = match line.strip_suffix(b"\n") {
        Some(text) => (text, &b"\n"[..]),
        None => (line, &b""[..]),
    };
    let mut value: Value = serde_json::from_slice(text).ok()?;
    if !strip_value(&mut value, DEPTH) {
        return None;
    }
    let mut out = serde_json::to_vec(&value).ok()?;
    out.extend_from_slice(ending);
    Some(out)
}

fn strip_value(value: &mut Value, depth: usize) -> bool {
    match value {
        Value::Object(fields) => {
            let mut changed = false;
            let mut retyped = false;
            for (key, field) in fields.iter_mut() {
                if let Some(stand_in) = field.as_str().and_then(stand_in_for) {
                    // Claude names the kind beside the bytes; the stand-in is
                    // a PNG whatever the original was.
                    retyped |= key == "data" && !stand_in.starts_with("data:");
                    *field = Value::String(stand_in);
                    changed = true;
                } else if depth > 0 {
                    changed |= strip_value(field, depth - 1);
                }
            }
            if retyped && fields.contains_key("media_type") {
                fields.insert("media_type".into(), Value::String("image/png".into()));
            }
            changed
        }
        Value::Array(values) if depth > 0 => {
            let mut changed = false;
            for value in values {
                changed |= strip_value(value, depth - 1);
            }
            changed
        }
        _ => false,
    }
}

/// The stand-in for a string that is a picture, in the same form: a data URL
/// for a data URL, bare base64 for bare base64. Anything else is not a picture.
fn stand_in_for(text: &str) -> Option<String> {
    if text.len() < PICTURE_KEPT {
        return None;
    }
    if let Some(rest) = text.strip_prefix("data:image/") {
        let (_, data) = rest.split_once(";base64,")?;
        return is_picture(data).then(|| format!("data:image/png;base64,{STAND_IN}"));
    }
    is_picture(text).then(|| STAND_IN.to_string())
}

fn is_picture(data: &str) -> bool {
    let head = data.get(..16).unwrap_or_default();
    data.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        && base64::engine::general_purpose::STANDARD
            .decode(head)
            .ok()
            .and_then(|bytes| super::media::image_kind(&bytes))
            .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture() -> String {
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        png.extend(std::iter::repeat_n(7u8, 30_000));
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    fn write(path: &Path, lines: &[Value]) -> String {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        fs::write(path, &text).unwrap();
        text
    }

    fn rollout(source: &str, picture: &str) -> Vec<Value> {
        vec![
            json!({"type":"session_meta","payload":{"id":"t","source":source}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output",
                "output":[{"type":"input_image","image_url":format!("data:image/png;base64,{picture}")}]}}),
            json!({"type":"event_msg","payload":{"type":"item_completed",
                "item":{"type":"imageGeneration","result":picture}}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"done"}}),
        ]
    }

    #[test]
    fn an_agents_finished_record_loses_its_pictures_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = dir.path();
        let picture = picture();
        let agent = profiles.join("codex/me/sessions/2026/10/04/rollout-a.jsonl");
        let person = profiles.join("codex/me/sessions/2026/10/04/rollout-b.jsonl");
        let subagent = profiles.join("claude/me/projects/-work/chat/subagents/agent-1.jsonl");
        let main = profiles.join("claude/me/projects/-work/chat.jsonl");
        write(&agent, &rollout("exec", &picture));
        let kept_person = write(&person, &rollout("cli", &picture));
        let claude = vec![
            json!({"type":"user","isSidechain":true,"message":{"content":[{"type":"tool_result",
            "content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":picture}}]}]}}),
        ];
        write(&subagent, &claude);
        let kept_main = write(&main, &claude);
        let modified = fs::metadata(&agent).unwrap().modified().unwrap();

        let swept = Sweeper::default().sweep(profiles, Duration::ZERO);
        assert_eq!(swept.records, 2);

        let text = fs::read_to_string(&agent).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 4);
        assert_eq!(
            lines[1]["payload"]["output"][0]["image_url"],
            format!("data:image/png;base64,{STAND_IN}")
        );
        assert_eq!(lines[2]["payload"]["item"]["result"], STAND_IN);
        // A line with no picture is the provider's own bytes.
        let original = rollout("exec", &picture);
        assert_eq!(text.lines().next().unwrap(), original[0].to_string());
        assert_eq!(text.lines().nth(3).unwrap(), original[3].to_string());
        assert_eq!(fs::metadata(&agent).unwrap().modified().unwrap(), modified);

        let source = &serde_json::from_str::<Value>(fs::read_to_string(&subagent).unwrap().trim())
            .unwrap()["message"]["content"][0]["content"][0]["source"];
        assert_eq!(source["data"], STAND_IN);
        assert_eq!(source["media_type"], "image/png");

        // A person's chats keep their pictures.
        assert_eq!(fs::read_to_string(&person).unwrap(), kept_person);
        assert_eq!(fs::read_to_string(&main).unwrap(), kept_main);
    }

    /// What a start found with no pictures, the next start does not read.
    #[test]
    fn a_record_found_clean_is_not_read_again_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = dir.path().join("profiles");
        let store = dir.path().join("records-without-pictures.json");
        let record = profiles.join("claude/me/projects/-work/chat/subagents/agent-1.jsonl");
        let line = json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"x".repeat(4000)}]}});
        write(&record, &vec![line; 256]);
        let len = fs::metadata(&record).unwrap().len();
        let read = |sweeper: &mut Sweeper| {
            let before = crate::upkeep::thread_bytes();
            sweeper.sweep(&profiles, Duration::ZERO);
            crate::upkeep::thread_bytes().zip(before).map(|(now, before)| now - before)
        };

        let first = read(&mut Sweeper::kept_in(store.clone()));
        let again = read(&mut Sweeper::kept_in(store));
        if let (Some(first), Some(again)) = (first, again) {
            assert!(first >= len, "the first start reads the {len} byte record; it read {first}");
            assert!(again < len / 4, "the next start read {again} bytes of a {len} byte record it had found clean");
        }
    }

    #[test]
    fn a_record_still_being_written_is_left_for_later() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir
            .path()
            .join("codex/me/sessions/2026/10/09/rollout-a.jsonl");
        let kept = write(&agent, &rollout("exec", &picture()));
        let swept = Sweeper::default().sweep(dir.path(), Duration::from_secs(3600));
        assert_eq!(swept, Swept::default());
        assert_eq!(fs::read_to_string(&agent).unwrap(), kept);
    }

    #[test]
    fn a_record_a_writer_still_holds_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir
            .path()
            .join("codex/me/sessions/2026/10/04/rollout-a.jsonl");
        write(&agent, &rollout("exec", &picture()));
        let mut writer = fs::OpenOptions::new().append(true).open(&agent).unwrap();
        writeln!(
            writer,
            "{}",
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"later"}})
        )
        .unwrap();
        let mut sweeper = Sweeper::default();
        assert_eq!(sweeper.sweep(dir.path(), Duration::ZERO), Swept::default());
        drop(writer);
        // Once the writer lets go, the same sweeper — which has not written the
        // record off as clean — takes the pictures and keeps the line written.
        assert_eq!(sweeper.sweep(dir.path(), Duration::ZERO).records, 1);
        let text = fs::read_to_string(&agent).unwrap();
        assert!(text.contains("later") && !text.contains(&picture()));
    }

    #[test]
    fn long_text_that_is_not_a_picture_is_kept() {
        let text = "A".repeat(20_000);
        assert_eq!(stand_in_for(&text), None);
        assert_eq!(stand_in_for(&format!("data:image/png;base64,{text}")), None);
        assert!(stand_in_for(&picture()).is_some());
    }
}
