//! What happens to a chat's provider record when this process stops driving it.
//!
//! While a driver runs, the driver is the chat's only source: every message
//! reaches the store over the wire, and the provider's own record of the same
//! turn is not read again. The byte cursor into that record only moves while a
//! follower reads it, so a chat that worked with nobody looking left its cursor
//! where the driver was attached. When the driver went — a stop, a memory stop,
//! a crash — the next follower read the whole driven stretch as somebody else's
//! work, under ids the store cannot match to the driver's, and every message of
//! it was appended again at the end of the chat (bw-6n29).
//!
//! So the driven stretch is handed back once, when the driver is gone: its
//! notes are read out of it, and the cursor moves past it. The same rule holds
//! for every provider; only what a note looks like is the provider's.

use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::actor::ChatDb;

/// The record one chat's provider keeps of it, if it has written one.
pub fn record_path(
    brand: &str,
    profile: Option<&str>,
    external_id: &str,
    claude_config: &Path,
    codex_home: &Path,
) -> Option<PathBuf> {
    match brand {
        "claude" => super::claude::history::find_record(
            &super::profiles::chat_dir("claude", profile, claude_config),
            external_id,
        ),
        "codex" => find_codex_record(
            &super::profiles::chat_dir("codex", profile, codex_home),
            external_id,
        ),
        _ => None,
    }
}

/// A Codex rollout, filed by date under its account's `sessions` directory.
pub fn find_codex_record(home: &Path, id: &str) -> Option<PathBuf> {
    fn find(root: &Path, id: &str, depth: u8) -> Option<PathBuf> {
        if depth == 0 {
            return None;
        }
        for entry in std::fs::read_dir(root).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = find(&path, id, depth - 1) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.contains(id) && name.ends_with(".jsonl"))
            {
                return Some(path);
            }
        }
        None
    }
    find(home.join("sessions").as_path(), id, 5)
}

/// Whether a record line can hold a note, read before it is parsed: a long
/// driven stretch is mostly messages, and only notes are wanted from it.
pub fn may_hold_a_note(brand: &str, line: &str) -> bool {
    keeps_notes(brand) && line.contains("queue-operation")
}

/// Whether a provider's record says anything its driver does not.
pub fn keeps_notes(brand: &str) -> bool {
    brand == "claude"
}

/**
 * What a record says that the driver's wire never does, as events.
 *
 * A Claude record writes down when a shell or a watch the chat left running
 * ended — the kit tells itself in a queue row, and ACP carries no word of it,
 * so without this a driven chat's shells stayed Running for hours after they
 * finished (bw-3cmk.1). Helpers are left out: ACP ends them with their own
 * answer, and the kit's one-line receipt would overwrite it. A Codex rollout
 * says nothing its driver has not already said.
 */
pub fn record_notes(brand: &str, rows: &[Value]) -> Vec<Value> {
    if !keeps_notes(brand) {
        return Vec::new();
    }
    super::claude::history::record_notices(rows)
        .into_iter()
        .filter(|notice| !super::claude::history::about_a_helper(notice))
        .collect()
}

/// A note or replayed record event, made an event of this chat. The id comes
/// from the record line, so the same note read twice is stored once.
pub fn record_event(
    brand: &str,
    session_id: &str,
    external_id: Option<&str>,
    mut value: Value,
) -> Option<super::protocol::Event> {
    let event_id = super::protocol::provider_record_event_id(brand, &value);
    let object = value.as_object_mut()?;
    object.insert(
        "providerEvent".into(),
        json!({"provider":brand,"threadId":external_id,"eventId":event_id,"delivery":"live"}),
    );
    object.insert("sessionId".into(), json!(session_id));
    object.insert("seq".into(), json!(0));
    object
        .entry("at")
        .or_insert_with(|| json!(chrono::Utc::now().to_rfc3339()));
    serde_json::from_value(value).ok()
}

/**
 * Hand one chat's driven stretch back: store its notes, and move the cursor
 * past it. The registry clears the mark that says a driver runs it.
 *
 * Runs once the driver's process is closed, so the record is not still
 * growing under the read. Reads only from the cursor on, one line at a time,
 * and parses only the lines that can hold a note.
 */
pub async fn hand_back(
    database: &ChatDb,
    session_id: &str,
    claude_config: &Path,
    codex_home: &Path,
) {
    if let Ok(Some(session)) = database.get_session(session_id.to_string()).await {
        // The cursor, where a follower kept it; otherwise where the driver
        // began, which is all a new chat has.
        let from = match database.followed_to(session_id.to_string()).await {
            Ok(Some(at)) => Some(at),
            _ => database
                .driven_from(session_id.to_string())
                .await
                .ok()
                .flatten(),
        };
        let record = session.external_id.as_deref().and_then(|id| {
            record_path(
                &session.brand,
                session.profile.as_deref(),
                id,
                claude_config,
                codex_home,
            )
        });
        // A missing record has nothing in it to read again.
        if let (Some(from), Some(record)) = (from, record) {
            let brand = session.brand.clone();
            let read = tokio::task::spawn_blocking(move || {
                read_notes(&record, &brand, from.max(0) as u64)
            })
            .await;
            if let Ok(Ok((notes, through))) = read {
                for note in notes {
                    if let Some(event) = record_event(
                        &session.brand,
                        &session.id,
                        session.external_id.as_deref(),
                        note,
                    ) {
                        let _ = database.append(event).await;
                    }
                }
                if through as i64 != from {
                    let _ = database
                        .remember_followed(session_id.to_string(), through as i64)
                        .await;
                }
            }
        }
        end_unfinished_tools(database, session_id).await;
    }
}

/// A tool call the driver left running can no longer return: the process that
/// would have said how it ended is gone. A turn that ends, or a stop, closes
/// its own calls; a server stopped or lost mid-call does neither, and the call
/// showed as running for good.
async fn end_unfinished_tools(database: &ChatDb, session_id: &str) {
    let Ok(calls) = database.unfinished_tools(session_id.to_string()).await else {
        return;
    };
    let at = chrono::Utc::now().to_rfc3339();
    let endings: Vec<_> = calls
        .into_iter()
        .filter_map(|call| {
            serde_json::from_value(json!({
                "type": "tool.completed", "sessionId": session_id, "seq": 0, "at": at,
                "toolCallId": call, "ok": false,
                "output": "The chat's process ended before this tool returned.",
                "source": "hand-back",
            }))
            .ok()
        })
        .collect();
    if !endings.is_empty() {
        let _ = database.append_many(endings).await;
    }
}

/**
 * Where a driver's stretch of a chat's record begins: the follower's cursor
 * if it has one, else the record's end, or its start if it is not written yet.
 */
pub async fn stretch_start(
    database: &ChatDb,
    session_id: &str,
    claude_config: &Path,
    codex_home: &Path,
) -> i64 {
    if let Ok(Some(at)) = database.followed_to(session_id.to_string()).await {
        return at;
    }
    let Ok(Some(session)) = database.get_session(session_id.to_string()).await else {
        return 0;
    };
    session
        .external_id
        .as_deref()
        .and_then(|id| {
            record_path(
                &session.brand,
                session.profile.as_deref(),
                id,
                claude_config,
                codex_home,
            )
        })
        .and_then(|record| std::fs::metadata(record).ok())
        .map_or(0, |metadata| metadata.len() as i64)
}

/// The notes in a record after one byte, and where its last whole line ends.
fn read_notes(record: &Path, brand: &str, from: u64) -> std::io::Result<(Vec<Value>, u64)> {
    let mut file = std::fs::File::open(record)?;
    let size = file.metadata()?.len();
    // A record shorter than the cursor was rewritten; the follower's own
    // rewrite handling owns that case.
    if size < from {
        return Ok((Vec::new(), from));
    }
    file.seek(SeekFrom::Start(from))?;
    let mut reader = BufReader::new(file);
    let mut rows = Vec::new();
    let mut through = from;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        through += read as u64;
        let text = String::from_utf8_lossy(&line);
        if may_hold_a_note(brand, &text) {
            if let Ok(row) = serde_json::from_str::<Value>(text.trim_end()) {
                rows.push(row);
            }
        }
    }
    Ok((record_notes(brand, &rows), through))
}
