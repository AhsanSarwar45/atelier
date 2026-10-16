//! Making the chat record smaller: archiving a chat to a file of its own and
//! bringing it back, shortening long tool output in old chats, and handing
//! the pages that leaves unused back to the disk.
//!
//! Each rewrite of a chat's stored events is counted in `event_rewrite`, so
//! the storage index (`storage_index.rs`), which reads this record and never
//! writes to it, knows to measure that chat again from the start.

use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use base64::Engine;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::Store;

/// Tables kept by chat that an archive leaves out: what was spent (`turn`,
/// `summary_run`) stays counted, the transcript rows are a cache rebuilt from
/// the events, and the rest are this record's own bookkeeping.
const NOT_ARCHIVED: [&str; 7] = [
    "turn",
    "summary_run",
    "transcript_item",
    "transcript_projection",
    "transcript_agent",
    "event_scrub",
    "event_rewrite",
];

/// Tool output longer than this, in an old chat, is shortened by a rule.
pub const TRIM_OVER: usize = 16 * 1024;
/// What is kept of it: its start and its end.
const KEEP_HEAD: usize = 4 * 1024;
const KEEP_TAIL: usize = 2 * 1024;

/// What one archived chat was, written beside it so a list of archives never
/// opens the archives themselves.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedChat {
    pub id: String,
    pub title: Option<String>,
    pub brand: String,
    pub project_id: String,
    pub project_path: String,
    pub last_at: String,
    pub archived_at: String,
    /// Bytes of its events while it was in the record.
    pub bytes: u64,
    /// Bytes of the archive file.
    pub size: u64,
    /// Stored pictures and files its events name, kept while it is archived.
    pub assets: Vec<String>,
    /// The cards it is linked to.
    #[serde(default)]
    pub cards: Vec<String>,
}

pub fn archive_file(dir: &Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.json.gz"))
}

pub fn summary_file(dir: &Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.json"))
}

/// Every archived chat in a folder, newest archive first.
pub fn archived_chats(dir: &Path) -> Vec<ArchivedChat> {
    let mut found: Vec<ArchivedChat> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|entry| std::fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<ArchivedChat>(&bytes).ok())
        .filter(|chat| archive_file(dir, &chat.id).exists())
        .collect();
    found.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    found
}

/// The chat an archive holds, as the record kept it: enough to ask its
/// provider to delete its own copy when the archive is deleted.
pub fn archived_session(dir: &Path, id: &str) -> Result<super::Session, String> {
    let mut text = String::new();
    let file = std::fs::File::open(archive_file(dir, id)).map_err(|e| e.to_string())?;
    flate2::read::GzDecoder::new(file)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let archive: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let session = &archive["tables"]["session"];
    let row = session["rows"].get(0).ok_or("the archive holds no chat")?;
    let mut fields = Map::new();
    for (at, name) in session["columns"].as_array().into_iter().flatten().enumerate() {
        let Some(name) = name.as_str() else { continue };
        let camel: String = name
            .split('_')
            .enumerate()
            .map(|(n, part)| {
                if n == 0 {
                    part.to_string()
                } else {
                    let mut chars = part.chars();
                    chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
                }
            })
            .collect();
        let value = row.get(at).cloned().unwrap_or(Value::Null);
        fields.insert(camel, if name == "named_by_owner" { json!(value.as_i64() == Some(1)) } else { value });
    }
    serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())
}

/// Remove one archive and what it said about itself.
pub fn drop_archive(dir: &Path, id: &str) -> std::io::Result<u64> {
    let file = archive_file(dir, id);
    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    match std::fs::remove_file(&file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let _ = std::fs::remove_file(summary_file(dir, id));
    Ok(size)
}

/// Provider chats whose rows are archived, so provider discovery does not
/// take them in again as new chats while the archive holds them.
fn shelf(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS archived_external (
           brand TEXT NOT NULL,
           external_id TEXT NOT NULL,
           session_id TEXT NOT NULL,
           PRIMARY KEY (brand, external_id)
         );",
    )
}

fn note_rewrite(connection: &Connection, session_id: &str) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS event_rewrite (
           session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
         );",
    )?;
    connection.execute(
        "INSERT INTO event_rewrite (session_id, generation) VALUES (?1, 1)
         ON CONFLICT(session_id) DO UPDATE SET generation = generation + 1",
        [session_id],
    )?;
    Ok(())
}

/// Write down that these chats' events were rewritten in place.
pub(super) fn note_rewrites(connection: &Connection, sessions: &HashSet<String>) -> rusqlite::Result<()> {
    for id in sessions {
        note_rewrite(connection, id)?;
    }
    Ok(())
}

fn to_json(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(n) => json!(n),
        SqlValue::Real(n) => json!(n),
        SqlValue::Text(text) => Value::String(text),
        SqlValue::Blob(bytes) => json!({ "blob": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    }
}

fn from_json(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or_default()),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(fields) => match fields.get("blob").and_then(Value::as_str) {
            Some(text) => SqlValue::Blob(base64::engine::general_purpose::STANDARD.decode(text).unwrap_or_default()),
            None => SqlValue::Text(value.to_string()),
        },
        Value::Array(_) => SqlValue::Text(value.to_string()),
    }
}

fn columns(connection: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    connection
        .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?
        .query_map([], |row| row.get(0))?
        .collect()
}

/// The tables that keep rows by chat and go into an archive.
fn chat_tables(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut kept = Vec::new();
    for table in tables {
        if NOT_ARCHIVED.contains(&table.as_str()) || table == "session" {
            continue;
        }
        if columns(connection, &table)?.iter().any(|c| c == "session_id") {
            kept.push(table);
        }
    }
    Ok(kept)
}

fn rows(connection: &Connection, table: &str, key: &str, id: &str) -> rusqlite::Result<Value> {
    let names = columns(connection, table)?;
    let list = names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(",");
    let mut statement = connection.prepare(&format!("SELECT {list} FROM \"{table}\" WHERE \"{key}\" = ?1"))?;
    let found: Vec<Value> = statement
        .query_map([id], |row| {
            (0..names.len())
                .map(|at| row.get::<_, SqlValue>(at).map(to_json))
                .collect::<rusqlite::Result<Vec<_>>>()
                .map(Value::Array)
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({ "columns": names, "rows": found }))
}

fn io(error: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

impl Store {
    /// Write one chat to a compressed file in `dir` and then remove it from
    /// the record. The file is complete on disk before anything is removed,
    /// so a failure part way leaves the chat where it was.
    pub fn archive_session(&mut self, id: &str, dir: &Path, at: &str) -> rusqlite::Result<ArchivedChat> {
        std::fs::create_dir_all(dir).map_err(io)?;
        let session = rows(&self.connection, "session", "id", id)?;
        let Some(row) = session["rows"].as_array().and_then(|rows| rows.first()).cloned() else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        let field = |name: &str| -> Value {
            session["columns"]
                .as_array()
                .and_then(|columns| columns.iter().position(|c| c == name))
                .and_then(|at| row.get(at).cloned())
                .unwrap_or(Value::Null)
        };
        let mut tables = Map::new();
        tables.insert("session".into(), session.clone());
        for table in chat_tables(&self.connection)? {
            tables.insert(table.clone(), rows(&self.connection, &table, "session_id", id)?);
        }
        let mut assets: Vec<String> = Vec::new();
        let mut bytes = 0u64;
        if let Some(events) = tables.get("event") {
            let at = events["columns"].as_array().and_then(|c| c.iter().position(|n| n == "json"));
            for row in events["rows"].as_array().into_iter().flatten() {
                let Some(text) = at.and_then(|at| row.get(at)).and_then(Value::as_str) else {
                    continue;
                };
                bytes += text.len() as u64;
                assets.extend(crate::workbench::storage_index::names_in(text).map(String::from));
            }
        }
        assets.sort();
        assets.dedup();
        let cards: Vec<String> = tables
            .get("bead_link")
            .and_then(|links| {
                let at = links["columns"].as_array()?.iter().position(|n| n == "bead_id")?;
                Some(
                    links["rows"]
                        .as_array()?
                        .iter()
                        .filter_map(|row| row.get(at)?.as_str().map(String::from))
                        .collect(),
                )
            })
            .unwrap_or_default();

        let archive = archive_file(dir, id);
        let partial = dir.join(format!("{id}.json.gz.partial"));
        {
            let file = std::fs::File::create(&partial).map_err(io)?;
            let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            serde_json::to_writer(&mut encoder, &json!({ "version": 1, "tables": tables }))
                .map_err(|e| io(std::io::Error::other(e)))?;
            encoder.finish().map_err(io)?.sync_all().map_err(io)?;
        }
        std::fs::rename(&partial, &archive).map_err(io)?;
        let summary = ArchivedChat {
            id: id.to_string(),
            title: field("title").as_str().map(String::from),
            brand: field("brand").as_str().unwrap_or_default().to_string(),
            project_id: field("project_id").as_str().unwrap_or_default().to_string(),
            project_path: field("project_path").as_str().unwrap_or_default().to_string(),
            last_at: [field("last_active_at"), field("last_spoke_at")]
                .iter()
                .filter_map(Value::as_str)
                .max()
                .unwrap_or_default()
                .to_string(),
            archived_at: at.to_string(),
            bytes,
            size: std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0),
            assets,
            cards,
        };
        std::fs::write(
            summary_file(dir, id),
            serde_json::to_vec(&summary).map_err(|e| io(std::io::Error::other(e)))?,
        )
        .map_err(io)?;
        // Before the row goes: while the row is here, discovery matches it.
        if let (Some(brand), Some(external)) = (field("brand").as_str(), field("external_id").as_str()) {
            shelf(&self.connection)?;
            self.connection.execute(
                "INSERT OR REPLACE INTO archived_external (brand, external_id, session_id) VALUES (?1, ?2, ?3)",
                params![brand, external, id],
            )?;
        }
        self.delete_session(id)?;
        Ok(summary)
    }

    /// "brand:external id" of every archived provider chat.
    pub fn shelved_chats(&mut self) -> rusqlite::Result<Vec<String>> {
        shelf(&self.connection)?;
        let mut query = self
            .connection
            .prepare("SELECT brand || ':' || external_id FROM archived_external")?;
        let keys = query.query_map([], |row| row.get(0))?.collect();
        keys
    }

    /// The archive is gone, so discovery may take the provider chat in again.
    pub fn unshelve(&mut self, id: &str) -> rusqlite::Result<()> {
        shelf(&self.connection)?;
        self.connection
            .execute("DELETE FROM archived_external WHERE session_id = ?1", [id])?;
        Ok(())
    }

    /// Put an archived chat back in the record, as it was, and delete its
    /// archive. Columns added since it was archived take their defaults. The
    /// archive is kept unless the whole chat went back in.
    pub fn restore_session(&mut self, id: &str, dir: &Path) -> Result<(), String> {
        let failed = |e: rusqlite::Error| format!("Couldn’t restore the chat: {e}");
        let exists = self
            .connection
            .query_row("SELECT 1 FROM session WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map_err(failed)?
            .is_some();
        if exists {
            return Err("The chat is already in the chat list.".into());
        }
        let mut text = String::new();
        let file = std::fs::File::open(archive_file(dir, id)).map_err(|e| format!("Couldn’t read the archive: {e}"))?;
        flate2::read::GzDecoder::new(file)
            .read_to_string(&mut text)
            .map_err(|e| format!("Couldn’t read the archive: {e}"))?;
        let archive: Value = serde_json::from_str(&text).map_err(|e| format!("Couldn’t read the archive: {e}"))?;
        let tables = archive["tables"].as_object().cloned().unwrap_or_default();
        if tables.get("session").and_then(|t| t["rows"].as_array()).map_or(0, Vec::len) != 1 {
            return Err("The archive has no chat in it.".into());
        }
        self.insert_archived(id, &tables).map_err(|e| match e {
            // The provider's chat was opened again since it was archived.
            rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::ConstraintViolation => {
                "This chat was opened again after it was archived, so it can’t be restored.".to_string()
            }
            e => failed(e),
        })?;
        drop_archive(dir, id).map_err(|e| format!("Restored, but couldn’t delete the archive: {e}"))?;
        Ok(())
    }

    fn insert_archived(&mut self, id: &str, tables: &serde_json::Map<String, Value>) -> rusqlite::Result<()> {
        let transaction = self.connection.transaction()?;
        // The chat first: everything else is filed under it.
        let mut order: Vec<&String> = tables.keys().collect();
        order.sort_by_key(|name| *name != "session");
        for table in order {
            let here = columns(&transaction, table)?;
            if here.is_empty() {
                continue;
            }
            let saved: Vec<String> = tables[table]["columns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c.as_str().map(String::from))
                .collect();
            let kept: Vec<usize> = (0..saved.len()).filter(|at| here.contains(&saved[*at])).collect();
            if kept.is_empty() {
                continue;
            }
            let names = kept.iter().map(|at| format!("\"{}\"", saved[*at])).collect::<Vec<_>>().join(",");
            let marks = (1..=kept.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(",");
            // The chat row must go in; a clash drops the whole restore.
            let verb = if table == "session" { "INSERT" } else { "INSERT OR IGNORE" };
            let mut insert = transaction.prepare(&format!("{verb} INTO \"{table}\" ({names}) VALUES ({marks})"))?;
            for row in tables[table]["rows"].as_array().into_iter().flatten() {
                let values: Vec<SqlValue> = kept
                    .iter()
                    .map(|at| row.get(*at).map(from_json).unwrap_or(SqlValue::Null))
                    .collect();
                insert.execute(rusqlite::params_from_iter(values))?;
            }
        }
        // Measured again from the start, whatever an earlier copy of it left.
        note_rewrite(&transaction, id)?;
        shelf(&transaction)?;
        transaction.execute("DELETE FROM archived_external WHERE session_id = ?1", [id])?;
        transaction.commit()
    }

    /// Shorten every tool output in one chat longer than `TRIM_OVER`, keeping
    /// its start and end. Output that names a stored picture or file, or
    /// carries a widget, is left whole. How many events were shortened, and
    /// by how many bytes.
    pub fn trim_tool_output(&mut self, id: &str) -> rusqlite::Result<(usize, u64)> {
        let found: Vec<(i64, String)> = self
            .connection
            .prepare(
                "SELECT seq, json FROM event
                  WHERE session_id = ?1 AND type IN ('tool.progress', 'tool.completed')
                    AND octet_length(json) > ?2",
            )?
            .query_map(params![id, TRIM_OVER as i64], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let transaction = self.connection.transaction()?;
        let (mut events, mut saved) = (0, 0u64);
        for (seq, text) in found {
            let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if shorten(&mut value) == 0 {
                continue;
            }
            let shorter = value.to_string();
            if shorter.len() >= text.len() {
                continue;
            }
            saved += text.len().saturating_sub(shorter.len()) as u64;
            transaction.execute(
                "UPDATE event SET json = ?3 WHERE session_id = ?1 AND seq = ?2",
                params![id, seq, shorter],
            )?;
            events += 1;
        }
        if events > 0 {
            // The transcript rows hold the long text too; they are a cache,
            // and the next read builds them again from the shortened events.
            for table in ["transcript_item", "transcript_agent", "transcript_projection"] {
                transaction.execute(&format!("DELETE FROM {table} WHERE session_id = ?1"), [id])?;
            }
            note_rewrite(&transaction, id)?;
        }
        transaction.commit()?;
        if events > 0 {
            self.agents_folded.borrow_mut().remove(id);
        }
        Ok((events, saved))
    }

    /// Whether freed pages go back to the disk as they are freed: true once
    /// `compact` has run.
    pub fn reclaims_space(&self) -> rusqlite::Result<bool> {
        Ok(self.connection.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))? == 2)
    }

    /// Hand up to `pages` unused pages back to the disk. Quick, and a no-op
    /// until `compact` has run once. How many unused pages remain.
    pub fn reclaim(&self, pages: i64) -> rusqlite::Result<i64> {
        if self.reclaims_space()? {
            self.connection
                .prepare(&format!("PRAGMA incremental_vacuum({pages})"))?
                .query_map([], |_| Ok(()))?
                .for_each(drop);
        }
        self.connection.query_row("PRAGMA freelist_count", [], |row| row.get(0))
    }

    /// Rebuild the record without its unused pages, and from then on hand
    /// pages back as cleanups free them (`reclaim`). Slow on a large record:
    /// nothing else writes to it while this runs.
    pub fn compact(&self) -> rusqlite::Result<()> {
        self.connection
            .execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")?;
        self.connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }
}

/// Whether a long text is one an old chat can do without: anything but a
/// picture's or file's name, or a widget, which the chat still draws.
/// How many bytes `trim_tool_output` would take out of one event's JSON, so
/// what is counted as trimmable is exactly what a trim shortens.
pub fn trim_saves(json: &str) -> u64 {
    if json.len() <= TRIM_OVER {
        return 0;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(json) else {
        return 0;
    };
    if shorten(&mut value) == 0 {
        return 0;
    }
    json.len().saturating_sub(value.to_string().len()) as u64
}

fn may_shorten(text: &str) -> bool {
    text.len() > KEEP_HEAD + KEEP_TAIL + 256
        && !text.contains("atelier-")
        && crate::workbench::storage_index::names_in(text).next().is_none()
}

/// Shorten every long text in `value` to its start and end; how many were.
fn shorten(value: &mut Value) -> usize {
    match value {
        Value::String(text) if text.len() > TRIM_OVER / 2 && may_shorten(text) => {
            let head = floor(text, KEEP_HEAD);
            let tail = ceil(text, text.len() - KEEP_TAIL);
            let removed = tail - head;
            *text = format!(
                "{}\n\n[… {} KB removed by cleanup …]\n\n{}",
                &text[..head],
                removed.div_ceil(1024),
                &text[tail..]
            );
            1
        }
        Value::Array(items) => items.iter_mut().map(shorten).sum(),
        Value::Object(fields) => fields.values_mut().map(shorten).sum(),
        _ => 0,
    }
}

fn floor(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn ceil(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::store::Session;

    fn session(id: &str) -> Session {
        Session {
            id: id.into(),
            brand: "claude".into(),
            external_id: None,
            project_id: "p".into(),
            project_path: "/p".into(),
            cwd: "/p".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: Some("Old chat".into()),
            state: "dormant".into(),
            origin: "atelier".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            last_active_at: "2026-01-02T00:00:00.000Z".into(),
            last_spoke_at: None,
            begun_by: None,
            named_by_owner: false,
        }
    }

    fn event(store: &Store, id: &str, seq: i64, kind: &str, json: &str) {
        store
            .connection
            .execute(
                "INSERT INTO event (session_id, seq, at, type, json) VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', ?3, ?4)",
                params![id, seq, kind, json],
            )
            .unwrap();
    }

    #[test]
    fn an_archived_chat_comes_back_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("workbench.db")).unwrap();
        store.create_session(&session("c")).unwrap();
        let picture = format!("{}.png", "a".repeat(64));
        event(&store, "c", 1, "message", &json!({"text": "hello"}).to_string());
        event(&store, "c", 2, "image", &json!({"asset": picture}).to_string());
        store.remember_bead_link("c", "bw-1", "tool", "2026-01-01T00:00:00.000Z").unwrap();

        let archives = dir.path().join("archive");
        let summary = store.archive_session("c", &archives, "2026-02-01T00:00:00.000Z").unwrap();
        assert_eq!(summary.assets, vec![picture.clone()]);
        assert_eq!(summary.title.as_deref(), Some("Old chat"));
        assert_eq!(summary.cards, vec!["bw-1".to_string()]);
        assert_eq!(archived_session(&archives, "c").unwrap().title.as_deref(), Some("Old chat"));
        assert!(store.get_session("c").unwrap().is_none());
        assert_eq!(archived_chats(&archives).len(), 1);

        store.restore_session("c", &archives).unwrap();
        assert_eq!(store.get_session("c").unwrap().unwrap().title.as_deref(), Some("Old chat"));
        let events: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM event WHERE session_id = 'c'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 2);
        assert_eq!(store.beads_for_session("c").unwrap(), vec!["bw-1".to_string()]);
        assert!(archived_chats(&archives).is_empty());
        assert!(!archive_file(&archives, "c").exists());
    }

    #[test]
    fn a_chat_opened_again_since_its_archive_is_not_restored_and_the_archive_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("workbench.db")).unwrap();
        let provider = Session { external_id: Some("ext-1".into()), ..session("c") };
        store.create_session(&provider).unwrap();
        event(&store, "c", 1, "message", &json!({"text": "hello"}).to_string());
        let archives = dir.path().join("archive");
        store.archive_session("c", &archives, "2026-02-01T00:00:00.000Z").unwrap();
        // The same provider chat, opened again under a new id.
        store.create_session(&Session { id: "d".into(), ..provider }).unwrap();

        let refused = store.restore_session("c", &archives).unwrap_err();
        assert!(refused.contains("opened again"), "{refused}");
        assert!(store.get_session("c").unwrap().is_none());
        let orphans: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM event WHERE session_id = 'c'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
        assert!(archive_file(&archives, "c").exists());
    }

    #[test]
    fn long_tool_output_keeps_its_ends_and_pictures_are_left_whole() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("workbench.db")).unwrap();
        store.create_session(&session("c")).unwrap();
        let long = format!("START{}END", "x".repeat(40_000));
        let picture = format!("see {}.png {}", "b".repeat(64), "y".repeat(40_000));
        let tool = |kind: &str, id: &str, fields: Value| {
            let mut value = json!({"type": kind, "sessionId": "c", "toolCallId": id, "seq": 0});
            value.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
            value.to_string()
        };
        event(&store, "c", 1, "tool.completed", &tool("tool.completed", "t1", json!({"output": long, "acp": {"rawOutput": long}})));
        event(&store, "c", 2, "tool.completed", &tool("tool.completed", "t2", json!({"output": picture})));
        event(&store, "c", 3, "tool.started", &tool("tool.started", "t3", json!({"input": long})));
        store.ensure_transcript_projection("c").unwrap();
        let cached = |store: &Store| -> i64 {
            store
                .connection
                .query_row("SELECT COUNT(*) FROM transcript_item WHERE session_id = 'c'", [], |r| r.get(0))
                .unwrap()
        };
        assert!(cached(&store) > 0);

        let (events, saved) = store.trim_tool_output("c").unwrap();
        assert_eq!(cached(&store), 0, "the cached transcript kept the long text");
        assert_eq!(events, 1);
        assert!(saved > 60_000, "{saved}");
        let kept: String = store
            .connection
            .query_row("SELECT json FROM event WHERE session_id = 'c' AND seq = 1", [], |r| r.get(0))
            .unwrap();
        let kept: Value = serde_json::from_str(&kept).unwrap();
        let output = kept["output"].as_str().unwrap();
        assert!(output.starts_with("START") && output.ends_with("END") && output.contains("removed by cleanup"));
        let rewrites: i64 = store
            .connection
            .query_row("SELECT generation FROM event_rewrite WHERE session_id = 'c'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rewrites, 1);
        assert_eq!(store.trim_tool_output("c").unwrap().0, 0);
    }

    #[test]
    fn compacting_hands_unused_pages_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workbench.db");
        let mut store = Store::open(&path).unwrap();
        store.create_session(&session("c")).unwrap();
        for seq in 0..200 {
            event(&store, "c", seq, "message", &json!({"text": "z".repeat(8000)}).to_string());
        }
        store.delete_session("c").unwrap();
        assert!(!store.reclaims_space().unwrap());
        store.compact().unwrap();
        assert!(store.reclaims_space().unwrap());
        assert_eq!(store.reclaim(1000).unwrap(), 0);
        assert!(std::fs::metadata(&path).unwrap().len() < 400_000);
    }
}
