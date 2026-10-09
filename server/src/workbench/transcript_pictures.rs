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
use std::collections::HashMap;
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
/// time, so a sweep reads only what is new — a few hundred megabytes of
/// cleaned records are not read again every ten minutes.
#[derive(Default)]
pub struct Sweeper {
    clean: HashMap<PathBuf, (u64, SystemTime)>,
}

impl Sweeper {
    /// Strip every record under `profiles` that an agent began and nothing has
    /// written to for `idle`.
    pub fn sweep(&mut self, profiles: &Path, idle: Duration) -> Swept {
        let mut swept = Swept::default();
        let now = SystemTime::now();
        for path in agent_records(profiles) {
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
            match strip(&path) {
                Ok(freed) => {
                    if freed > 0 {
                        swept.records += 1;
                        swept.freed += freed;
                    }
                    if let Ok(meta) = fs::metadata(&path) {
                        if let Ok(modified) = meta.modified() {
                            self.clean.insert(path, (meta.len(), modified));
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "pictures not stripped from record")
                }
            }
        }
        swept
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
/// that freed. A record with no pictures is left as it is. A record that
/// changes while it is read — a run resumed after all — is left for the next
/// sweep rather than losing what was written meanwhile.
pub fn strip(path: &Path) -> std::io::Result<u64> {
    // A provider keeps a record open for as long as the thread is loaded and
    // appends through that handle, so a record swapped while it is held would
    // send the next lines to the file it replaced. An idle hour does not prove
    // the writer has gone; an open handle proves it has not.
    if held_open(path) {
        return Ok(0);
    }
    let before = fs::metadata(path)?;
    let modified = before.modified()?;
    let mut reader = BufReader::new(File::open(path)?);
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
            let mut head = File::open(path)?;
            std::io::copy(&mut (&mut head).take(read), &mut fresh)?;
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
    let Some(writer) = writer else { return Ok(0) };
    let file = writer.into_inner().map_err(|error| error.into_error())?;
    file.sync_all()?;
    let after = fs::metadata(path)?;
    if after.len() != before.len() || after.modified()? != modified || held_open(path) {
        let _ = fs::remove_file(&temporary);
        return Ok(0);
    }
    // The record keeps the time it was last written, so lists ordered by it
    // and the idle test above read it as they did before.
    file.set_modified(modified)?;
    fs::rename(&temporary, path)?;
    Ok(before.len().saturating_sub(written))
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
        assert_eq!(
            Sweeper::default().sweep(dir.path(), Duration::ZERO),
            Swept::default()
        );
        writeln!(
            writer,
            "{}",
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"later"}})
        )
        .unwrap();
        drop(writer);
        assert!(fs::read_to_string(&agent).unwrap().contains("later"));
        // Once the writer lets go, the next sweep takes the pictures and keeps
        // the line it wrote.
        assert_eq!(
            Sweeper::default().sweep(dir.path(), Duration::ZERO).records,
            1
        );
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
