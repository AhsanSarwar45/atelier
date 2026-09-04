//! Backward-compatible storage for chat sessions and their event log.
//!
//! This deliberately opens the same `workbench.db` schema as the existing
//! helper. Moving the writer into Axum must not make an existing conversation
//! disappear or require an export/import step.

use crate::workbench::projection::{fold_all, fold_from};
use crate::workbench::protocol::{Event, EventKind};
use rusqlite::types::Value as SqlValue;
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// Provider-history normalization generations. A provider advances only when
/// replaying its record can add or correct canonical events; changing Claude
/// must not force every Codex transcript through an unrelated rebuild.
pub const IMPORT_RECIPE: i64 = 11;
pub const CLAUDE_IMPORT_RECIPE: i64 = 12;

pub fn import_recipe(brand: &str) -> i64 {
    if brand == "claude" {
        CLAUDE_IMPORT_RECIPE
    } else {
        IMPORT_RECIPE
    }
}

const LEGACY_MIGRATIONS: &[&str] = &[
    r#"CREATE TABLE session (
         id TEXT PRIMARY KEY,
         brand TEXT NOT NULL,
         external_id TEXT,
         project_id TEXT NOT NULL,
         project_path TEXT NOT NULL,
         cwd TEXT NOT NULL,
         model TEXT,
         permission_mode TEXT NOT NULL,
         title TEXT,
         state TEXT NOT NULL,
         origin TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_active_at TEXT NOT NULL,
         ended_at TEXT
       );
       CREATE TABLE event (
         session_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         at TEXT NOT NULL,
         type TEXT NOT NULL,
         json TEXT NOT NULL,
         PRIMARY KEY (session_id, seq)
       );
       CREATE INDEX event_by_session ON event(session_id, seq);"#,
    r#"CREATE TABLE bead_link (
         session_id TEXT NOT NULL,
         bead_id TEXT NOT NULL,
         via TEXT NOT NULL,
         first_seen_at TEXT NOT NULL,
         PRIMARY KEY (session_id, bead_id)
       );"#,
    r#"CREATE TABLE message (
         session_id TEXT NOT NULL,
         message_id TEXT NOT NULL,
         role TEXT NOT NULL,
         text TEXT NOT NULL,
         at TEXT NOT NULL,
         PRIMARY KEY (session_id, message_id)
       );
       CREATE INDEX message_by_session ON message(session_id, at);
       CREATE TABLE turn (
         session_id TEXT NOT NULL,
         project_id TEXT NOT NULL,
         brand TEXT NOT NULL,
         day TEXT NOT NULL,
         at TEXT NOT NULL,
         usd REAL,
         input INTEGER,
         output INTEGER,
         total INTEGER,
         PRIMARY KEY (session_id, at)
       );
       CREATE INDEX turn_by_day ON turn(day, project_id);"#,
    "ALTER TABLE session ADD COLUMN imported_at TEXT;",
    "ALTER TABLE session ADD COLUMN imported_recipe INTEGER;",
    "ALTER TABLE session ADD COLUMN last_spoke_at TEXT;",
    r#"ALTER TABLE session ADD COLUMN followed_to INTEGER;
       ALTER TABLE session ADD COLUMN followed_drawn INTEGER;"#,
    r#"CREATE TABLE summary_run (
         project TEXT NOT NULL,
         session_id TEXT NOT NULL,
         at TEXT NOT NULL,
         ms INTEGER NOT NULL,
         PRIMARY KEY (project, session_id, at)
       );
       CREATE INDEX summary_run_by_project ON summary_run(project, at);"#,
    "ALTER TABLE session ADD COLUMN effort TEXT;",
];

/// The native owner of the existing workbench database.
pub struct Store {
    connection: Connection,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub brand: String,
    pub external_id: Option<String>,
    pub project_id: String,
    pub project_path: String,
    pub cwd: String,
    pub model: Option<String>,
    pub permission_mode: String,
    pub effort: Option<String>,
    pub collaboration_mode: Option<String>,
    pub title: Option<String>,
    pub state: String,
    pub origin: String,
    pub created_at: String,
    pub last_active_at: String,
    pub last_spoke_at: Option<String>,
}

/// `Some(None)` clears a nullable setting; `None` leaves it untouched.
#[derive(Clone, Debug, Default)]
pub struct SessionPatch {
    pub external_id: Option<Option<String>>,
    pub title: Option<Option<String>>,
    pub state: Option<String>,
    pub model: Option<Option<String>>,
    pub permission_mode: Option<String>,
    pub effort: Option<Option<String>>,
    pub collaboration_mode: Option<Option<String>>,
}

/// One match, as the panel draws it: the sentence it fell in, the words that
/// matched inside that sentence, and enough about the chat to name it and open
/// it (search-panel.tsx, `Match`).
///
/// `text` is the whole message and `sentence` the part worth reading. Both,
/// because a caller that wants the message should not have to search again for
/// it, and the panel should not have to hold a chat's worth of words to draw
/// one line.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub message_id: String,
    pub role: String,
    pub text: String,
    pub sentence: String,
    #[serde(rename = "match")]
    pub matched: String,
    pub at: String,
    pub title: Option<String>,
    pub project_id: String,
}

#[derive(Clone, Debug)]
pub struct Turn {
    pub session_id: String,
    pub project_id: String,
    pub brand: String,
    pub at: String,
    pub usd: Option<f64>,
    pub input: Option<i64>,
    pub output: Option<i64>,
    pub total: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    pub day: String,
    pub project_id: String,
    pub brand: String,
    pub usd: f64,
    pub tokens: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionActivity {
    pub label: String,
    pub busy_since: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TokenStats {
    pub turns: i64,
    pub tool_calls: i64,
    pub forgettings: i64,
    pub helper_count: i64,
    pub cost: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptItemPage {
    pub items: Vec<serde_json::Value>,
    pub cursor: Option<i64>,
    pub has_older: bool,
    pub newest_seq: i64,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        }
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(10))?;
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        migrate(&mut connection)?;
        Ok(Self { connection })
    }

    /// The last positional migration understood by this build.
    pub fn schema_version(&self) -> rusqlite::Result<usize> {
        self.connection
            .query_row("SELECT version FROM schema_version", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|version| version.max(0) as usize)
    }

    /// Persist one completed compaction measurement. The key makes repeated
    /// observation of the same beat idempotent.
    pub fn note_summary_run(
        &self,
        project: &str,
        session_id: &str,
        at: &str,
        ms: i64,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT OR REPLACE INTO summary_run (project, session_id, at, ms) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![project, session_id, at, ms],
        )?;
        Ok(())
    }

    /// Recent compaction lengths for one project, newest first.
    pub fn summary_runs(&self, project: &str, limit: usize) -> rusqlite::Result<Vec<i64>> {
        let mut query = self
            .connection
            .prepare("SELECT ms FROM summary_run WHERE project = ?1 ORDER BY at DESC LIMIT ?2")?;
        let rows = query
            .query_map(rusqlite::params![project, limit as i64], |row| row.get(0))?
            .collect();
        rows
    }

    pub fn create_session(&self, session: &Session) -> rusqlite::Result<()> {
        self.connection.execute(
            r#"INSERT INTO session
                 (id, brand, external_id, project_id, project_path, cwd, model,
                  permission_mode, effort, collaboration_mode, title, state,
                  origin, created_at, last_active_at, last_spoke_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)"#,
            params![
                session.id,
                session.brand,
                session.external_id,
                session.project_id,
                session.project_path,
                session.cwd,
                session.model,
                session.permission_mode,
                session.effort,
                session.collaboration_mode,
                session.title,
                session.state,
                session.origin,
                session.created_at,
                session.last_active_at,
                session.last_spoke_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_session(&mut self, id: &str) -> rusqlite::Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM event WHERE session_id = ?1", [id])?;
        transaction.execute("DELETE FROM bead_link WHERE session_id = ?1", [id])?;
        transaction.execute("DELETE FROM session WHERE id = ?1", [id])?;
        transaction.commit()
    }

    pub fn update_session(
        &self,
        id: &str,
        patch: SessionPatch,
        touch_at: Option<&str>,
    ) -> rusqlite::Result<()> {
        let mut sets = Vec::new();
        let mut values = Vec::<SqlValue>::new();
        let mut nullable = |column: &str, value: Option<Option<String>>| {
            if let Some(value) = value {
                sets.push(format!("{column} = ?"));
                values.push(value.map(SqlValue::Text).unwrap_or(SqlValue::Null));
            }
        };
        nullable("external_id", patch.external_id);
        nullable("title", patch.title);
        nullable("model", patch.model);
        nullable("effort", patch.effort);
        nullable("collaboration_mode", patch.collaboration_mode);
        if let Some(state) = patch.state {
            sets.push("state = ?".to_string());
            values.push(SqlValue::Text(state));
        }
        if let Some(mode) = patch.permission_mode {
            sets.push("permission_mode = ?".to_string());
            values.push(SqlValue::Text(mode));
        }
        if let Some(at) = touch_at {
            sets.push("last_active_at = ?".to_string());
            values.push(SqlValue::Text(at.to_string()));
        }
        if sets.is_empty() {
            return Ok(());
        }
        values.push(SqlValue::Text(id.to_string()));
        self.connection.execute(
            &format!("UPDATE session SET {} WHERE id = ?", sets.join(", ")),
            params_from_iter(values),
        )?;
        Ok(())
    }

    pub fn mark_spoke(&self, id: &str, at: &str) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE session SET last_spoke_at = ?1 WHERE id = ?2",
            params![at, id],
        )?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> rusqlite::Result<Option<Session>> {
        self.connection
            .query_row(
                "SELECT * FROM session WHERE id = ?1",
                [id],
                session_from_row,
            )
            .optional()
    }

    pub fn session_by_external_id(&self, external_id: &str) -> rusqlite::Result<Option<Session>> {
        self.connection
            .query_row(
                "SELECT * FROM session WHERE external_id = ?1 ORDER BY last_active_at DESC LIMIT 1",
                [external_id],
                session_from_row,
            )
            .optional()
    }

    /// The model this brand was last started on anywhere in this app.
    ///
    /// Not scoped to a project on purpose: the thing being remembered is which
    /// model the person likes to work with on this machine, and a runtime that
    /// holds one model at a time makes that a property of the machine rather
    /// than of any one repository.
    pub fn last_model_for_brand(&self, brand: &str) -> rusqlite::Result<Option<String>> {
        self.connection
            .query_row(
                "SELECT model FROM session WHERE brand = ?1 AND model IS NOT NULL \
                 ORDER BY COALESCE(last_spoke_at, last_active_at) DESC LIMIT 1",
                [brand],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }

    pub fn list_sessions(&self, project_id: Option<&str>) -> rusqlite::Result<Vec<Session>> {
        let (sql, parameter): (&str, Option<&str>) = match project_id {
            Some(project_id) => (
                "SELECT * FROM session WHERE project_id = ?1 ORDER BY COALESCE(last_spoke_at, last_active_at) DESC",
                Some(project_id),
            ),
            None => (
                "SELECT * FROM session ORDER BY COALESCE(last_spoke_at, last_active_at) DESC",
                None,
            ),
        };
        let mut statement = self.connection.prepare(sql)?;
        let found = match parameter {
            Some(project_id) => statement
                .query_map([project_id], session_from_row)?
                .collect(),
            None => statement.query_map([], session_from_row)?.collect(),
        };
        found
    }

    /// Restore-list rows: an untitled chat with nothing said in it is not an
    /// offer to resume — unless the person started it here, by hand.
    ///
    /// The old rule was title-or-a-message alone, and it was written against
    /// the chats we did not start: the kit's index is full of unnamed review
    /// agents, and offering those back is the fault §6.3.1 exists to prevent.
    /// A chat begun at the New Chat button is the opposite case. It is the one
    /// thing on that list the person definitely meant to have, and `origin`
    /// already tells the two apart — only `CommandKind::SessionStart` writes
    /// `app`, while everything discovered or opened from outside writes
    /// `terminal`.
    ///
    /// Claude and Codex hid the gap. A chat of theirs with no title and no
    /// message is still an ACP session the provider knows about, so provider
    /// discovery hands it back and the row returns. Local has no such rescue —
    /// `list_sessions` asks only claude and codex, and could not ask a local
    /// runtime anyway, since that call passes no model and `launch_config` has
    /// none without one. And a local chat is created with no title, no message
    /// and no driver on purpose: it is waiting for the model to be chosen. So
    /// the one chat that most needed the list was the one it dropped, at once
    /// and for good (bw-u6cl.1).
    ///
    /// `everything` deliberately exposes every row for diagnosis.
    pub fn list_restore_sessions(
        &self,
        project_id: Option<&str>,
        everything: bool,
    ) -> rusqlite::Result<Vec<Session>> {
        if everything {
            return self.list_sessions(project_id);
        }
        let visible = r#"(title IS NOT NULL OR origin='app' OR EXISTS (
            SELECT 1 FROM event WHERE event.session_id=session.id
              AND event.type='message.started' LIMIT 1))"#;
        let sql = match project_id {
            Some(_) => format!(
                "SELECT * FROM session WHERE project_id=?1 AND {visible} ORDER BY COALESCE(last_spoke_at,last_active_at) DESC"
            ),
            None => format!(
                "SELECT * FROM session WHERE {visible} ORDER BY COALESCE(last_spoke_at,last_active_at) DESC"
            ),
        };
        let mut statement = self.connection.prepare(&sql)?;
        match project_id {
            Some(project_id) => statement
                .query_map([project_id], session_from_row)?
                .collect(),
            None => statement.query_map([], session_from_row)?.collect(),
        }
    }

    pub fn mark_all_dormant(&self) -> rusqlite::Result<usize> {
        self.connection.execute(
            "UPDATE session SET state = 'dormant' WHERE state != 'dormant'",
            [],
        )
    }

    pub fn next_seq(&self, session_id: &str) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM event WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
    }

    /// Append once across live, replay, and snapshot delivery of one provider event.
    pub fn append_event(&self, event: &Event) -> rusqlite::Result<bool> {
        let owns_transaction = self.connection.is_autocommit();
        if owns_transaction {
            self.connection.execute_batch("BEGIN IMMEDIATE")?;
        }
        let result = self.append_event_in_transaction(event);
        if owns_transaction {
            match result {
                Ok(changed) => {
                    self.connection.execute_batch("COMMIT")?;
                    return Ok(changed);
                }
                Err(error) => {
                    let _ = self.connection.execute_batch("ROLLBACK");
                    return Err(error);
                }
            }
        }
        result
    }

    fn append_event_in_transaction(&self, event: &Event) -> rusqlite::Result<bool> {
        let session_id = event_string(event, "sessionId")?;
        let seq = event
            .fields
            .get("seq")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| rusqlite::Error::InvalidParameterName("event.seq".to_string()))?;
        let at = event_string(event, "at")?;
        let kind = serde_json::to_value(event.kind)
            .map_err(json_error)?
            .as_str()
            .unwrap()
            .to_string();
        let identity = event
            .fields
            .get("providerEvent")
            .and_then(serde_json::Value::as_object);
        let provider = identity
            .and_then(|value| value.get("provider"))
            .and_then(serde_json::Value::as_str);
        let thread_id = identity
            .and_then(|value| value.get("threadId"))
            .and_then(serde_json::Value::as_str);
        let event_id = identity
            .and_then(|value| value.get("eventId"))
            .and_then(serde_json::Value::as_str);
        let json = serde_json::to_string(event).map_err(json_error)?;
        let changed = self.connection.execute(
            r#"INSERT INTO event
                 (session_id, seq, at, type, json, provider, provider_thread_id, provider_event_id)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
               ON CONFLICT(session_id, provider, provider_thread_id, provider_event_id)
                 WHERE provider_event_id IS NOT NULL DO NOTHING"#,
            params![session_id, seq, at, kind, json, provider, thread_id, event_id],
        )?;
        if changed == 1 {
            self.remove_superseded_progress(event, session_id, seq)?;
        }
        Ok(changed == 1)
    }

    /// Progress is a replaceable live snapshot, not permanent transcript
    /// history. Broadcast delivery still publishes every update; durable
    /// replay needs only the newest value for each logical operation.
    fn remove_superseded_progress(
        &self,
        event: &Event,
        session_id: &str,
        seq: i64,
    ) -> rusqlite::Result<usize> {
        let (kind, key) =
            match event.kind {
                EventKind::ToolProgress => ("tool.progress", "toolCallId"),
                EventKind::AgentProgress => ("agent.progress", "agentId"),
                EventKind::ThinkingProgress => return self.connection.execute(
                    "DELETE FROM event WHERE session_id=?1 AND type='thinking.progress' AND seq<?2",
                    params![session_id, seq],
                ),
                _ => return Ok(0),
            };
        let Some(owner) = event.fields.get(key).and_then(Value::as_str) else {
            return Ok(0);
        };
        self.connection.execute(
            "DELETE FROM event WHERE session_id=?1 AND type=?2 AND seq<?3 AND json_extract(json,?4)=?5",
            params![session_id, kind, seq, format!("$.{key}"), owner],
        )
    }

    /// Group a replay import into one SQLite commit. The chat actor remains
    /// the sole connection owner, so no other command can observe the batch
    /// until `commit_event_batch` returns.
    pub fn begin_event_batch(&self) -> rusqlite::Result<()> {
        self.connection.execute_batch("BEGIN IMMEDIATE")
    }

    pub fn commit_event_batch(&self) -> rusqlite::Result<()> {
        self.connection.execute_batch("COMMIT")
    }

    pub fn rollback_event_batch(&self) {
        let _ = self.connection.execute_batch("ROLLBACK");
    }

    pub fn events_since(&self, session_id: &str, since: i64) -> rusqlite::Result<Vec<Event>> {
        let mut statement = self.connection.prepare(
            "SELECT seq, json FROM event WHERE session_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![session_id, since], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (seq, json) = row?;
            let mut event: Event = serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            // Legacy helper rows kept the sequence in the indexed SQL column
            // but not always in their JSON. SQL is the durable ordering source
            // for both old and native events, so decode it back onto the wire.
            event
                .fields
                .insert("seq".to_string(), serde_json::json!(seq));
            super::wire::bound_event(&mut event);
            Ok(event)
        })
        .collect()
    }

    /// Only canonical helper edges, used once to restore terminal tombstones
    /// before accepting a new live helper signal after a process restart.
    pub fn agent_lifecycle_events(&self, session_id: &str) -> rusqlite::Result<Vec<Event>> {
        let mut statement = self.connection.prepare(
            r#"SELECT json FROM (
                 SELECT seq,json FROM event
                  WHERE session_id=?1 AND type IN
                    ('agent.started','agent.finished','agent.identified','agent.relayed')
                    AND seq > COALESCE((SELECT MAX(seq) FROM event
                      WHERE session_id=?1 AND type='transcript.reset'),0)
                 UNION ALL
                 SELECT seq,json FROM (
                   SELECT seq,json,
                          ROW_NUMBER() OVER (
                            PARTITION BY json_extract(json,'$.agentId') ORDER BY seq DESC
                          ) AS place
                     FROM event WHERE session_id=?1 AND type='agent.progress'
                       AND seq > COALESCE((SELECT MAX(seq) FROM event
                         WHERE session_id=?1 AND type='transcript.reset'),0)
                 ) WHERE place=1
               ) ORDER BY seq"#,
        )?;
        let found = statement
            .query_map([session_id], |row| {
                let json: String = row.get(0)?;
                serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })?
            .collect();
        found
    }

    pub fn event_count(&self, session_id: &str) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM event WHERE session_id = ?1 AND type IN ('message.started','tool.started','notice')",
            [session_id], |row| row.get(0))
    }

    pub fn session_activity(&self, session_id: &str) -> rusqlite::Result<SessionActivity> {
        let mut statement = self.connection.prepare(
            "SELECT json_extract(json,'$.state'), COALESCE(json_extract(json,'$.label'),''), json_extract(json,'$.at') FROM event WHERE session_id=?1 AND type='session.state' ORDER BY seq DESC")?;
        let rows = statement.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let values: Vec<_> = rows.collect::<rusqlite::Result<_>>()?;
        let Some((state, label, at)) = values.first() else {
            return Ok(SessionActivity {
                label: String::new(),
                busy_since: None,
            });
        };
        let counting = matches!(
            state.as_str(),
            "starting" | "thinking" | "streaming" | "running_tool" | "waiting_permission"
        );
        let shown = if state == "dormant" { "" } else { label };
        let busy_since = counting.then(|| {
            values
                .iter()
                .take_while(|(s, l, _)| s == state && l == label)
                .last()
                .map(|(_, _, at)| at.clone())
                .unwrap_or_else(|| at.clone())
        });
        Ok(SessionActivity {
            label: shown.to_string(),
            busy_since,
        })
    }
    /// The activity of every chat that ever reported one, read from its latest
    /// `session.state` row alone.
    ///
    /// This is the query behind every chat-list snapshot, so it is asked on
    /// every socket open and again whenever a live feed falls behind. It used
    /// to filter the whole event table by type, which no index served: on a
    /// board of a million events that was a read of the entire file — two
    /// gigabytes from disk, five to fifty seconds — on the one thread every
    /// other read and every append waits behind (bw-uxoe). Now `event_by_type`
    /// finds the newest state row of each chat without touching another, and
    /// only a chat that is still counting reads its own short run of states
    /// to say since when.
    pub fn session_activities(&self) -> rusqlite::Result<HashMap<String, SessionActivity>> {
        let mut statement = self.connection.prepare(
            "SELECT e.session_id, json_extract(e.json,'$.state'), COALESCE(json_extract(e.json,'$.label'),'') \
             FROM (SELECT session_id, MAX(seq) seq FROM event WHERE type='session.state' GROUP BY session_id) latest \
             JOIN event e ON e.session_id=latest.session_id AND e.seq=latest.seq",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let latest: Vec<_> = rows.collect::<rusqlite::Result<_>>()?;
        let mut activities = HashMap::with_capacity(latest.len());
        for (session_id, state, label) in latest {
            let Some(state) = state else { continue };
            let counting = matches!(
                state.as_str(),
                "starting" | "thinking" | "streaming" | "running_tool" | "waiting_permission"
            );
            let activity = if counting {
                self.session_activity(&session_id)?
            } else {
                SessionActivity {
                    label: if state == "dormant" { String::new() } else { label },
                    busy_since: None,
                }
            };
            activities.insert(session_id, activity);
        }
        Ok(activities)
    }

    pub fn token_stats(&self, session_id: &str) -> rusqlite::Result<TokenStats> {
        let number = |sql: &str| {
            self.connection
                .query_row(sql, [session_id], |row| row.get::<_, i64>(0))
        };
        // The assistant's message ids are gathered once and the completions
        // matched against that set. Asking `EXISTS` per completion instead
        // re-read every started message of the chat for each one, so a chat
        // with eight thousand turns paid sixty million json reads and held
        // the one database thread for fifteen seconds — every other read and
        // every incoming event queued behind it (bw-oion.1).
        let turns = number(
            "SELECT COUNT(*) FROM event c WHERE c.session_id=?1 AND c.type='message.completed' \
             AND json_extract(c.json,'$.messageId') IN ( \
               SELECT json_extract(json,'$.messageId') FROM event \
               WHERE session_id=?1 AND type='message.started' \
                 AND json_extract(json,'$.role')='assistant')",
        )?;
        let tool_calls =
            number("SELECT COUNT(*) FROM event WHERE session_id=?1 AND type='tool.started'")?;
        let helper_count =
            number("SELECT COUNT(*) FROM event WHERE session_id=?1 AND type='agent.started'")?;
        let forgettings = number("SELECT COUNT(*) FROM event WHERE session_id=?1 AND type='note' AND json_extract(json,'$.kind') IN ('compact','thread/compacted')")?;
        let cost = self.connection.query_row("SELECT json_extract(json,'$.cost') FROM event WHERE session_id=?1 AND type='cost' AND json_extract(json,'$.cost.kind')='tokens' ORDER BY seq DESC LIMIT 1",[session_id],|row|row.get::<_,String>(0)).optional()?.and_then(|text|serde_json::from_str(&text).ok());
        Ok(TokenStats {
            turns,
            tool_calls,
            forgettings,
            helper_count,
            cost,
        })
    }
    pub fn timeline_count(&self, session_id: &str) -> rusqlite::Result<i64> {
        self.connection.query_row("SELECT COUNT(*) FROM event WHERE session_id=?1 AND type IN ('message.started','tool.started','note','ask.permission','notice','agent.started')",[session_id],|row|row.get(0))
    }
    pub fn followed_to(&self, session_id: &str) -> rusqlite::Result<Option<i64>> {
        self.connection
            .query_row(
                "SELECT CASE WHEN imported_recipe>=CASE brand WHEN 'claude' THEN ?1 ELSE ?2 END THEN followed_to ELSE NULL END FROM session WHERE id=?3",
                rusqlite::params![CLAUDE_IMPORT_RECIPE, IMPORT_RECIPE, session_id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
    }
    pub fn imported_by(&self, session_id: &str) -> rusqlite::Result<Option<i64>> {
        self.connection.query_row(
            "SELECT CASE WHEN imported_recipe IS NOT NULL THEN imported_recipe WHEN imported_at IS NOT NULL THEN 0 ELSE NULL END FROM session WHERE id=?1",
            [session_id],
            |row| row.get(0),
        ).optional().map(Option::flatten)
    }
    pub fn mark_imported(&self, session_id: &str) -> rusqlite::Result<usize> {
        self.connection.execute(
            "UPDATE session SET imported_at=?1,imported_recipe=CASE brand WHEN 'claude' THEN ?2 ELSE ?3 END,followed_to=NULL,followed_drawn=NULL WHERE id=?4",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), CLAUDE_IMPORT_RECIPE, IMPORT_RECIPE, session_id],
        )
    }
    /// Where the outside follower has read to, and NOTHING about whether this
    /// chat's own history was ever read in.
    ///
    /// It used to say both. The follower starts at the end of the record — the
    /// import is what puts everything before that on the page — and it wrote
    /// that cursor down as an import of its own. A chat whose import is slow
    /// was therefore marked imported milliseconds after it was opened, and the
    /// import that followed found the work already claimed and left. Every
    /// external chat read through ACP `session/load` opened blank: the adapter
    /// takes seconds to start, and the follower needs four milliseconds
    /// (measured 2026-09-03, bw-t26l.20). Only `mark_imported` says imported.
    pub fn remember_followed(&self, session_id: &str, at: i64) -> rusqlite::Result<usize> {
        self.connection.execute(
            "UPDATE session SET followed_to=?1,followed_drawn=0 WHERE id=?2",
            rusqlite::params![at, session_id],
        )
    }
    pub fn was_driven_here(&self, session_id: &str) -> rusqlite::Result<bool> {
        Ok(self.connection.query_row("SELECT 1 FROM event WHERE session_id=?1 AND type='session.started' AND COALESCE(json_extract(json,'$.readOnly'),0)!=1 LIMIT 1",[session_id],|_|Ok(())).optional()?.is_some())
    }

    /// Events needed to rebuild only the non-transcript portion of a view.
    /// Transcript rows and agents already live in indexed projection tables;
    /// replaying their raw deltas here defeats on-demand history loading.
    pub fn view_events(&self, session_id: &str) -> rusqlite::Result<Vec<Event>> {
        let mut statement = self.connection.prepare(
            r#"SELECT seq, json FROM event
               WHERE session_id = ?1 AND (
                 type = 'session.pinned' OR seq IN (
                   SELECT MAX(seq) FROM event
                   WHERE session_id = ?1 AND type IN (
                     'session.started','session.state','session.menu','todo',
                     'cost','context','error','thinking.progress'
                   ) GROUP BY type
                 )
               ) ORDER BY seq"#,
        )?;
        let rows = statement.query_map([session_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (seq, json) = row?;
            let mut event: Event = serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            event
                .fields
                .insert("seq".to_string(), serde_json::json!(seq));
            super::wire::bound_event(&mut event);
            Ok(event)
        })
        .collect()
    }

    /// Newest durable steering catalog for this session's provider.
    ///
    /// Menus are emitted per chat, but model/mode/effort catalogs belong to
    /// the provider. A migrated chat can predate `session.menu`; borrowing only
    /// these provider-wide fields keeps its controls useful without leaking
    /// project-specific commands, skills, or agent definitions across chats.
    pub fn steering_menu(&self, session_id: &str) -> rusqlite::Result<Value> {
        let brand = self.connection.query_row(
            "SELECT brand FROM session WHERE id=?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )?;
        // Search the provider's newest chats, current chat first, through the
        // existing per-session event index. The former join ordered the entire
        // multi-provider event table by rowid; a cold 2 GB store could spend
        // seconds finding a fallback that an ordinary chat did not need.
        let mut sessions = self.connection.prepare(
            r#"SELECT id FROM session WHERE brand=?1
               ORDER BY (id=?2) DESC, COALESCE(last_spoke_at,last_active_at) DESC
               LIMIT 50"#,
        )?;
        let sessions = sessions
            .query_map(params![brand, session_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut latest = self.connection.prepare(
            r#"SELECT json FROM event
               WHERE session_id=?1 AND type='session.menu'
               ORDER BY seq DESC LIMIT 1"#,
        )?;
        let mut menu = serde_json::Map::new();
        for session in sessions {
            let is_current = session == session_id;
            let Some(row) = latest
                .query_row([session.as_str()], |row| row.get::<_, String>(0))
                .optional()?
            else {
                continue;
            };
            let value: Value = serde_json::from_str(&row).map_err(json_error)?;
            if is_current {
                for field in [
                    "commands",
                    "skills",
                    "agentDefinitions",
                    "agentControls",
                    "configOptions",
                ] {
                    if value[field].is_array() {
                        menu.insert(field.into(), value[field].clone());
                    }
                }
            }
            for field in ["models", "permissionModes", "efforts", "collaborationModes"] {
                if menu
                    .get(field)
                    .is_some_and(|held| held.as_array().is_some_and(|rows| !rows.is_empty()))
                {
                    continue;
                }
                if value[field].as_array().is_some_and(|rows| !rows.is_empty()) {
                    menu.insert(field.into(), value[field].clone());
                }
            }
            if ["models", "permissionModes", "efforts", "collaborationModes"]
                .iter()
                .all(|field| {
                    menu.get(*field)
                        .is_some_and(|held| held.as_array().is_some_and(|rows| !rows.is_empty()))
                })
            {
                break;
            }
        }
        if let Some(options) = menu.get_mut("configOptions").and_then(Value::as_array_mut) {
            let mut selected = HashMap::<String, Value>::new();
            let mut statement = self.connection.prepare(
                r#"SELECT json FROM event
                   WHERE session_id=?1 AND type='session.pinned'
                   ORDER BY seq DESC"#,
            )?;
            let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
            for row in rows {
                let event: Value = serde_json::from_str(&row?).map_err(json_error)?;
                for patch in event["configOptions"].as_array().into_iter().flatten() {
                    if let Some(id) = patch["id"].as_str() {
                        selected
                            .entry(id.to_string())
                            .or_insert_with(|| patch["currentValue"].clone());
                    }
                }
            }
            for option in options {
                if let Some(current) = option["id"].as_str().and_then(|id| selected.get(id)) {
                    option["currentValue"] = current.clone();
                }
            }
        }
        Ok(Value::Object(menu))
    }

    pub fn open_message(
        &self,
        session_id: &str,
        message_id: &str,
        role: &str,
        at: &str,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT OR IGNORE INTO message (session_id, message_id, role, text, at) VALUES (?1,?2,?3,'',?4)",
            params![session_id, message_id, role, at],
        )?;
        Ok(())
    }

    pub fn grow_message(
        &self,
        session_id: &str,
        message_id: &str,
        text: &str,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE message SET text = text || ?1 WHERE session_id = ?2 AND message_id = ?3",
            params![text, session_id, message_id],
        )?;
        Ok(())
    }

    pub fn retract_message(&self, session_id: &str, message_id: &str) -> rusqlite::Result<()> {
        self.connection.execute(
            "DELETE FROM message WHERE session_id = ?1 AND message_id = ?2",
            params![session_id, message_id],
        )?;
        Ok(())
    }

    pub fn search(&self, query: &str, limit: usize) -> rusqlite::Result<Vec<SearchHit>> {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut statement = self.connection.prepare(
            r#"SELECT m.session_id, m.message_id, m.role, m.text, m.at, s.title, s.project_id
               -- Left, so a message is never dropped for want of a chat row to
               -- name it. A hit the reader cannot place still says the word
               -- was said; a hit that is not returned says it never was.
               FROM message m LEFT JOIN session s ON s.id = m.session_id
               WHERE m.text LIKE ?1 ESCAPE '\' ORDER BY m.at DESC LIMIT ?2"#,
        )?;
        let found = statement
            .query_map(params![format!("%{escaped}%"), limit as i64], |row| {
                let text: String = row.get(3)?;
                let (sentence, matched) = Self::sentence_around(&text, query);
                Ok(SearchHit {
                    session_id: row.get(0)?,
                    message_id: row.get(1)?,
                    role: row.get(2)?,
                    text,
                    sentence,
                    matched,
                    at: row.get(4)?,
                    title: row.get(5)?,
                    project_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                })
            })?
            .collect();
        found
    }

    /// The sentence a match fell in, and the words as they were actually
    /// written there.
    ///
    /// The words, not the query: someone searching `periwinkle` should see
    /// `PERIWINKLE` marked in the line, and the panel marks by finding the
    /// returned string in the returned sentence — a lowercased query would
    /// mark nothing (`split`, search-panel.tsx).
    ///
    /// A sentence ends at `.`, `?`, `!` or a line break, and is capped: a chat
    /// can say two thousand words without a full stop, and a panel row is one
    /// line high.
    fn sentence_around(text: &str, query: &str) -> (String, String) {
        const MOST: usize = 240;
        let hay = text.to_lowercase();
        let needle = query.to_lowercase();
        let Some(at) = hay.find(&needle).filter(|_| !needle.is_empty()) else {
            return (text.chars().take(MOST).collect(), String::new());
        };
        // Byte offsets from the lowercased copy only line up with the original
        // while lowercasing keeps every character's width, which it does not
        // for every alphabet. When they do not, the whole message stands in for
        // the sentence and nothing is marked — a poorer answer, never a panic.
        let Some(matched) = text.get(at..at + needle.len()).map(str::to_string) else {
            return (text.chars().take(MOST).collect(), String::new());
        };
        let ends = |c: char| matches!(c, '.' | '?' | '!' | '\n' | '\r');
        let from = text[..at].rfind(ends).map(|i| i + 1).unwrap_or(0);
        let to = text[at..]
            .find(ends)
            .map(|i| at + i + 1)
            .unwrap_or(text.len());
        let sentence = text[from..to].trim();
        if sentence.chars().count() <= MOST {
            return (sentence.to_string(), matched);
        }
        // Kept around the match rather than from the start, so the words that
        // matched are in what is kept.
        let want = MOST / 2;
        let start = text[from..at]
            .char_indices()
            .rev()
            .take(want)
            .last()
            .map(|(i, _)| from + i)
            .unwrap_or(at);
        let end = text[at..to]
            .char_indices()
            .take(want)
            .last()
            .map(|(i, c)| at + i + c.len_utf8())
            .unwrap_or(to);
        (format!("…{}…", text[start..end].trim()), matched)
    }

    pub fn remember_turn(&self, turn: &Turn) -> rusqlite::Result<()> {
        self.connection.execute(
            r#"INSERT OR REPLACE INTO turn
                 (session_id, project_id, brand, day, at, usd, input, output, total)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"#,
            params![
                turn.session_id,
                turn.project_id,
                turn.brand,
                turn.at.get(..10).unwrap_or(&turn.at),
                turn.at,
                turn.usd,
                turn.input,
                turn.output,
                turn.total,
            ],
        )?;
        Ok(())
    }

    /// What one finished turn added, taken from the `cost` event that ends it.
    ///
    /// Nothing wrote to this table outside its own unit test, so
    /// `/api/workbench/spend` answered `[]` for every project on every day it
    /// was ever asked, and read as "nothing has been spent" rather than as
    /// "nobody is counting" (bw-t26l.20).
    ///
    /// The event carries the running total for the whole chat, because that is
    /// what the chat header draws. This table is summed across chats and days,
    /// so writing the running total on every turn would count the first turn
    /// once more for each turn after it. Only this turn's own share is
    /// recorded: what the chat has now, less what it has already been charged
    /// for here.
    ///
    /// A provider that names no dollars — Claude speaks tokens, and a
    /// subscription has no per-turn price to report — leaves `usd` null rather
    /// than claiming zero, which is a different statement.
    pub fn remember_turn_cost(
        &self,
        session_id: &str,
        at: &str,
        cost: &serde_json::Value,
    ) -> rusqlite::Result<()> {
        let Some((project_id, brand)) = self
            .connection
            .query_row(
                "SELECT project_id, brand FROM session WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        else {
            return Ok(());
        };
        let number = |field: &str| cost[field].as_i64().unwrap_or_default().max(0);
        let usd = cost["usd"].as_f64().filter(|usd| *usd > 0.0);
        let (was_usd, was_input, was_output, was_total) = self.connection.query_row(
            r#"SELECT COALESCE(SUM(usd), 0), COALESCE(SUM(input), 0),
                      COALESCE(SUM(output), 0), COALESCE(SUM(total), 0)
               FROM turn WHERE session_id = ?1"#,
            params![session_id],
            |row| Ok((row.get::<_, f64>(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let share = |now: i64, was: i64| Some(now - was).filter(|share| *share > 0);
        let turn = Turn {
            session_id: session_id.to_string(),
            project_id,
            brand,
            // The day is cut from this, so an event that arrived without a
            // clock would file itself under the empty day and never group.
            at: if at.len() >= 10 {
                at.to_string()
            } else {
                chrono::Utc::now().to_rfc3339()
            },
            usd: usd.map(|usd| usd - was_usd).filter(|share| *share > 0.0),
            input: share(number("input"), was_input),
            output: share(number("output"), was_output),
            total: share(number("total"), was_total),
        };
        // A turn that added nothing anyone can count is not a row. The header
        // still redraws its running total from the event itself.
        if turn.usd.is_none() && turn.total.is_none() && turn.input.is_none() {
            return Ok(());
        }
        self.remember_turn(&turn)
    }

    pub fn spend(&self) -> rusqlite::Result<Vec<Spend>> {
        let mut statement = self.connection.prepare(
            r#"SELECT day, project_id, brand,
                      COALESCE(SUM(usd), 0), COALESCE(SUM(total), 0)
               FROM turn GROUP BY day, project_id, brand ORDER BY day"#,
        )?;
        let found = statement
            .query_map([], |row| {
                Ok(Spend {
                    day: row.get(0)?,
                    project_id: row.get(1)?,
                    brand: row.get(2)?,
                    usd: row.get(3)?,
                    tokens: row.get(4)?,
                })
            })?
            .collect();
        found
    }

    pub fn remember_bead_link(
        &self,
        session_id: &str,
        bead_id: &str,
        via: &str,
        first_seen_at: &str,
    ) -> rusqlite::Result<bool> {
        self.connection
            .execute(
                "INSERT OR IGNORE INTO bead_link (session_id, bead_id, via, first_seen_at) VALUES (?1,?2,?3,?4)",
                params![session_id, bead_id, via, first_seen_at],
            )
            .map(|changed| changed == 1)
    }

    pub fn beads_for_session(&self, session_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT bead_id FROM bead_link WHERE session_id = ?1 ORDER BY first_seen_at",
        )?;
        let found = statement
            .query_map([session_id], |row| row.get(0))?
            .collect();
        found
    }

    pub fn sessions_for_bead(&self, bead_id: &str) -> rusqlite::Result<Vec<Session>> {
        let mut statement = self.connection.prepare(
            "SELECT s.* FROM bead_link b JOIN session s ON s.id = b.session_id WHERE b.bead_id = ?1 ORDER BY s.last_active_at DESC",
        )?;
        let sessions = statement.query_map([bead_id], session_from_row)?.collect();
        sessions
    }

    pub fn tool_details(&self, session_id: &str, tool_id: &str) -> rusqlite::Result<Option<Value>> {
        let mut statement = self.connection.prepare(
            r#"SELECT json FROM event WHERE session_id = ?1
               AND type IN ('tool.started','tool.completed','diff')
               AND json_extract(json, '$.toolCallId') = ?2 ORDER BY seq"#,
        )?;
        let rows =
            statement.query_map(params![session_id, tool_id], |row| row.get::<_, String>(0))?;
        let mut found = false;
        let mut input = json!({});
        let mut output = Value::Null;
        let mut diff = Value::Null;
        for row in rows {
            let event: Value = serde_json::from_str(&row?).map_err(json_error)?;
            found = true;
            match event["type"].as_str() {
                // A call whose arguments are not an object has none: the
                // reader is handed the same empty object it starts with
                // rather than a null it would read a key off (bw-t26l.20).
                Some("tool.started") => {
                    if event["input"].is_object() {
                        input = event["input"].clone()
                    }
                }
                Some("tool.completed") => output = event["output"].clone(),
                Some("diff") => {
                    diff = json!({"path":event["path"],"before":event["before"],"after":event["after"],"line":event.get("line").cloned().unwrap_or(Value::Null)})
                }
                _ => {}
            }
        }
        Ok(found.then(|| json!({"input":input,"output":output,"diff":diff})))
    }

    pub fn beads_for_sessions(
        &self,
        session_ids: &[String],
    ) -> rusqlite::Result<HashMap<String, Vec<String>>> {
        let mut grouped = HashMap::new();
        if session_ids.is_empty() {
            return Ok(grouped);
        }
        let ids = serde_json::to_string(session_ids).map_err(json_error)?;
        let mut statement = self.connection.prepare(
            r#"SELECT session_id, bead_id FROM bead_link
               WHERE session_id IN (SELECT value FROM json_each(?1))
               ORDER BY first_seen_at"#,
        )?;
        let rows = statement.query_map([ids], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (session_id, bead_id) = row?;
            grouped
                .entry(session_id)
                .or_insert_with(Vec::new)
                .push(bead_id);
        }
        Ok(grouped)
    }

    /// Materialise the canonical fold when the event tail has moved.
    ///
    /// The event table remains the source of truth. Projection rows are a
    /// disposable read cache with the same all-or-nothing transaction used by
    /// the helper this replaces.
    fn ensure_transcript_projection(&self, session_id: &str) -> rusqlite::Result<i64> {
        let (newest_seq, reset_seq) = self.connection.query_row(
            r#"SELECT COALESCE(MAX(seq), 0),
                      COALESCE(MAX(CASE WHEN type = 'transcript.reset' THEN seq END), 0)
                 FROM event WHERE session_id = ?1"#,
            [session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let held = self
            .connection
            .query_row(
                "SELECT projected_seq, reset_seq FROM transcript_projection WHERE session_id = ?1",
                [session_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        if held == Some((newest_seq, reset_seq)) {
            return Ok(newest_seq);
        }

        match held {
            Some((projected_seq, held_reset)) if held_reset == reset_seq => {
                self.catch_up_transcript_projection(
                    session_id,
                    projected_seq,
                    newest_seq,
                    reset_seq,
                )?;
                Ok(newest_seq)
            }
            _ => {
                // A cold or incompatible projection starts empty at the last
                // reset, then uses the same row-local tail algorithm as a live
                // chat. Folding the entire event log into one growing Vec made
                // first open quadratic and blocked every other chat behind the
                // single database actor for tens of seconds.
                let transaction = self.connection.unchecked_transaction()?;
                transaction.execute(
                    "DELETE FROM transcript_item WHERE session_id = ?1",
                    [session_id],
                )?;
                transaction.execute(
                    "DELETE FROM transcript_agent WHERE session_id = ?1",
                    [session_id],
                )?;
                transaction.execute(
                    r#"INSERT INTO transcript_projection (session_id,projected_seq,reset_seq)
                       VALUES (?1,?2,?2)
                       ON CONFLICT(session_id) DO UPDATE SET
                         projected_seq=excluded.projected_seq,
                         reset_seq=excluded.reset_seq"#,
                    params![session_id, reset_seq],
                )?;
                transaction.commit()?;
                self.catch_up_transcript_projection(session_id, reset_seq, newest_seq, reset_seq)?;
                Ok(newest_seq)
            }
        }
    }

    /// Advance an existing projection through only its unseen event tail.
    ///
    /// Each event loads and rewrites only the transcript rows it can affect.
    /// This preserves the former implementation's open-time bound: a live
    /// tail never causes an old conversation to be loaded and folded again.
    fn catch_up_transcript_projection(
        &self,
        session_id: &str,
        projected_seq: i64,
        newest_seq: i64,
        reset_seq: i64,
    ) -> rusqlite::Result<()> {
        let events = self.events_since(session_id, projected_seq)?;
        if events.is_empty() {
            return Ok(());
        }
        let mut agents = self.projected_agents_without_ensuring(session_id)?;
        let mut next_position: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM transcript_item WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        let transaction = self.connection.unchecked_transaction()?;

        for event in events {
            let selected = projection_items_for_event(&transaction, session_id, &event, &agents)?;
            let positions: HashMap<String, i64> = selected
                .iter()
                .filter_map(|(position, item)| item_key(item).map(|key| (key, *position)))
                .collect();
            let before: std::collections::HashSet<String> = positions.keys().cloned().collect();
            let mut view = crate::workbench::projection::empty_view();
            view.insert(
                "items".into(),
                Value::Array(selected.into_iter().map(|(_, item)| item).collect()),
            );
            view.insert("agents".into(), Value::Array(agents.clone()));
            let projection = fold_from(&mut view, std::slice::from_ref(&event));
            let after: std::collections::HashSet<String> =
                projection.items().iter().filter_map(item_key).collect();

            for key in before.difference(&after) {
                transaction.execute(
                    "DELETE FROM transcript_item WHERE session_id = ?1 AND item_key = ?2",
                    params![session_id, key],
                )?;
            }
            for item in projection.items() {
                let Some(key) = item_key(item) else { continue };
                let position = positions.get(&key).copied().unwrap_or_else(|| {
                    let position = next_position;
                    next_position += 1;
                    position
                });
                transaction.execute(
                    r#"INSERT INTO transcript_item
                         (session_id,item_key,position,updated_seq,visible,json)
                       VALUES (?1,?2,?3,?4,?5,?6)
                       ON CONFLICT(session_id,item_key) DO UPDATE SET
                         updated_seq=excluded.updated_seq,
                         visible=excluded.visible,
                         json=excluded.json"#,
                    params![
                        session_id,
                        key,
                        position,
                        event
                            .fields
                            .get("seq")
                            .and_then(Value::as_i64)
                            .unwrap_or_default(),
                        item_visible(item),
                        serde_json::to_string(item).map_err(json_error)?,
                    ],
                )?;
            }
            if projection.agents() != agents.as_slice() {
                agents = projection.agents().to_vec();
                transaction.execute(
                    "DELETE FROM transcript_agent WHERE session_id = ?1",
                    [session_id],
                )?;
                for agent in &agents {
                    transaction.execute(
                        r#"INSERT INTO transcript_agent
                             (session_id,agent_id,tool_call_id,json) VALUES (?1,?2,?3,?4)"#,
                        params![
                            session_id,
                            agent["id"].as_str().unwrap_or_default(),
                            agent["toolCallId"].as_str(),
                            serde_json::to_string(agent).map_err(json_error)?,
                        ],
                    )?;
                }
            }
        }
        transaction.execute(
            "UPDATE transcript_projection SET projected_seq=?1,reset_seq=?2 WHERE session_id=?3",
            params![newest_seq, reset_seq, session_id],
        )?;
        transaction.commit()
    }

    /// A fixed-size page of complete visible transcript items, in reading order.
    pub fn transcript_items(
        &self,
        session_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> rusqlite::Result<TranscriptItemPage> {
        let has_projection = self
            .connection
            .query_row(
                "SELECT 1 FROM transcript_projection WHERE session_id=?1",
                [session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        // First paint is always an event-anchor page. A projection left by an
        // older build may be far behind a newly imported provider record; its
        // catch-up is useful as an optional cache, but must never put the full
        // event tail back on the chat-open path. Negative cursors keep every
        // older page on the same provider-agnostic event contract.
        if before.is_none() || before.is_some_and(|cursor| cursor < 0) || !has_projection {
            return self.event_transcript_items(session_id, before, limit);
        }
        let newest_seq = self.ensure_transcript_projection(session_id)?;
        let ceiling = before.unwrap_or(i64::MAX);
        let page_predicate = r#"(
            json_extract(json,'$.kind') NOT IN ('tool','message','thinking')
            OR json_extract(json,'$.parentId') IS NULL
            OR (json_extract(json,'$.kind')='tool' AND json_extract(json,'$.status')='failed')
        )"#;
        let mut statement = self.connection.prepare(&format!(
            r#"SELECT position, json FROM transcript_item
                 WHERE session_id = ?1 AND visible = 1 AND position < ?2 AND {page_predicate}
                 ORDER BY position DESC LIMIT ?3"#,
        ))?;
        let mut rows: Vec<(i64, serde_json::Value)> = statement
            .query_map(params![session_id, ceiling, limit as i64], |row| {
                let position = row.get(0)?;
                let json: String = row.get(1)?;
                let item = serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok((position, item))
            })?
            .collect::<rusqlite::Result<_>>()?;
        rows.reverse();
        let oldest = rows.first().map(|row| row.0);
        let lower = oldest.unwrap_or(ceiling);
        let mut nested_statement = self.connection.prepare(
            r#"SELECT position,json FROM transcript_item
               WHERE session_id=?1 AND visible=1 AND position>=?2 AND position<?3
                 AND json_extract(json,'$.kind') IN ('tool','message','thinking')
                 AND json_extract(json,'$.parentId') IS NOT NULL
                 AND NOT(json_extract(json,'$.kind')='tool' AND json_extract(json,'$.status')='failed')
               ORDER BY position DESC LIMIT ?4"#,
        )?;
        let nested = nested_statement
            .query_map(params![session_id, lower, ceiling, limit as i64], |row| {
                let position = row.get(0)?;
                let json: String = row.get(1)?;
                let item = serde_json::from_str(&json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok((position, item))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.extend(nested);
        rows.sort_by_key(|row| row.0);
        let has_older = match oldest {
            Some(cursor) => self.connection.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM transcript_item WHERE session_id=?1 AND visible=1 AND position<?2 AND {page_predicate})"),
                params![session_id, cursor],
                |row| row.get::<_, bool>(0),
            )?,
            None => false,
        };
        Ok(TranscriptItemPage {
            items: rows.into_iter().map(|row| row.1).collect(),
            cursor: if has_older { oldest } else { None },
            has_older,
            newest_seq,
        })
    }

    pub fn projected_agents(&self, session_id: &str) -> rusqlite::Result<Vec<serde_json::Value>> {
        // The side panel is not transcript history. Rebuild it from durable
        // lifecycle edges plus only the newest progress report per agent, the
        // same bounded contract the final Node reader used. In particular, do
        // not let a stale transcript projection force a full chat catch-up.
        Ok(fold_all(&self.agent_lifecycle_events(session_id)?)
            .agents()
            .to_vec())
    }

    /// Read a cold conversation newest-first without constructing its complete
    /// durable projection. Negative cursors are opaque event anchors used only
    /// by this fallback; the browser already treats cursors as opaque numbers.
    fn event_transcript_items(
        &self,
        session_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> rusqlite::Result<TranscriptItemPage> {
        let newest_seq: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM event WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )?;
        let ceiling = before
            .filter(|cursor| *cursor < 0)
            .map(|cursor| cursor.saturating_abs())
            .unwrap_or_else(|| newest_seq.saturating_add(1));
        let reset_seq: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM event WHERE session_id=?1 AND type='transcript.reset' AND seq<?2",
            params![session_id, ceiling],
            |row| row.get(0),
        )?;
        let wanted = limit.saturating_add(8);
        let mut candidate_count = wanted;
        let (items, anchors) = loop {
            let cutoff = self
            .connection
            .query_row(
                r#"WITH anchors AS (
                     SELECT CASE type
                       WHEN 'message.started' THEN 'message:' || json_extract(json,'$.messageId')
                       WHEN 'thinking.delta' THEN 'thinking:' || json_extract(json,'$.messageId')
                       WHEN 'tool.started' THEN 'tool:' || json_extract(json,'$.toolCallId')
                       WHEN 'note' THEN 'note:' || json_extract(json,'$.noteId')
                       WHEN 'ask.permission' THEN 'ask:' || json_extract(json,'$.askId')
                       WHEN 'question.requested' THEN 'question:' || json_extract(json,'$.requestId')
                       WHEN 'plan.proposed' THEN 'plan:' || json_extract(json,'$.proposalId')
                       WHEN 'provider.message' THEN 'provider_message:' || json_extract(json,'$.signal.id')
                       WHEN 'notice' THEN 'notice:' || seq END AS item_key,
                       MIN(seq) AS started
                     FROM event
                     WHERE session_id=?1 AND seq<?2 AND seq>?3
                       AND (
                         type IN ('note','ask.permission','question.requested','plan.proposed',
                                  'provider.message','notice')
                         OR (type IN ('message.started','thinking.delta','tool.started')
                             AND json_extract(json,'$.parentToolCallId') IS NULL)
                       )
                       AND NOT(type='note' AND json_extract(json,'$.rank')='detail')
                     GROUP BY item_key
                   )
                   SELECT started FROM anchors ORDER BY started DESC LIMIT 1 OFFSET ?4"#,
                params![
                    session_id,
                    ceiling,
                    reset_seq,
                    candidate_count.saturating_sub(1) as i64
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or_else(|| reset_seq.saturating_add(1));

            // Select only the events that can affect the chosen parent rows and a
            // separately bounded helper tail. SQLite performs the identity joins;
            // Rust never parses or repeatedly folds a huge intervening child run.
            let mut statement = self.connection.prepare(
            r#"WITH
               root_messages(id) AS (
                 SELECT DISTINCT json_extract(json,'$.messageId') FROM event
                 WHERE session_id=?1 AND seq>=?2 AND seq<?3
                   AND type IN ('message.started','thinking.delta')
                   AND json_extract(json,'$.parentToolCallId') IS NULL
               ),
               child_messages(id) AS (
                 SELECT json_extract(json,'$.messageId') FROM event
                 WHERE session_id=?1 AND seq>?5 AND seq<?3
                   AND type IN ('message.started','thinking.delta')
                   AND json_extract(json,'$.parentToolCallId') IS NOT NULL
                 GROUP BY json_extract(json,'$.messageId')
                 ORDER BY MIN(seq) DESC LIMIT ?4
               ),
               selected_messages(id) AS (
                 SELECT id FROM root_messages UNION SELECT id FROM child_messages
               ),
               root_tools(id) AS (
                 SELECT DISTINCT json_extract(json,'$.toolCallId') FROM event
                 WHERE session_id=?1 AND seq>=?2 AND seq<?3 AND type='tool.started'
                   AND json_extract(json,'$.parentToolCallId') IS NULL
               ),
               child_tools(id) AS (
                 SELECT json_extract(json,'$.toolCallId') FROM event
                 WHERE session_id=?1 AND seq>?5 AND seq<?3 AND type='tool.started'
                   AND json_extract(json,'$.parentToolCallId') IS NOT NULL
                 GROUP BY json_extract(json,'$.toolCallId')
                 ORDER BY MIN(seq) DESC LIMIT ?4
               ),
               selected_tools(id) AS (
                 SELECT id FROM root_tools UNION SELECT id FROM child_tools
               ),
               selected_agents(id) AS (
                 SELECT DISTINCT json_extract(json,'$.agentId') FROM event
                 WHERE session_id=?1 AND seq>?5 AND seq<?3 AND type='agent.started'
                   AND json_extract(json,'$.toolCallId') IN (SELECT id FROM selected_tools)
               )
               SELECT seq,json FROM event
               WHERE session_id=?1 AND seq>?5 AND seq<?3 AND (
                 (type IN ('message.started','text.delta','thinking.delta','message.completed',
                           'message.retracted','image','image.compare','widget')
                    AND json_extract(json,'$.messageId') IN (SELECT id FROM selected_messages))
                 OR (type IN ('tool.started','tool.completed','tool.progress','diff')
                    AND json_extract(json,'$.toolCallId') IN (SELECT id FROM selected_tools))
                 OR (type IN ('agent.started','agent.progress','agent.finished','agent.relayed','agent.identified')
                    AND json_extract(json,'$.agentId') IN (SELECT id FROM selected_agents))
                 OR (seq>=?2 AND type IN
                    ('ask.permission','ask.resolved','question.requested','question.resolved',
                     'plan.proposed','plan.resolved','provider.message','notice','note'))
               )
               AND NOT(type='note' AND json_extract(json,'$.rank')='detail')
               ORDER BY seq"#,
        )?;
            let rows = statement
                .query_map(
                    params![session_id, cutoff, ceiling, limit as i64, reset_seq],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut anchors = HashMap::<String, i64>::new();
            let mut events = Vec::with_capacity(rows.len());
            for (seq, json) in rows {
                let mut event: Event = serde_json::from_str(&json).map_err(json_error)?;
                event.fields.insert("seq".into(), json!(seq));
                super::wire::bound_event(&mut event);
                if let Some(key) = event_item_anchor(&event) {
                    anchors.insert(key, seq);
                }
                events.push(event);
            }
            let projection = fold_all(&events);
            let items = bounded_page_items(projection.items(), limit);
            let primary_count = items
                .iter()
                .filter(|item| item_counts_toward_page(item))
                .count();
            if primary_count >= limit || cutoff <= reset_seq.saturating_add(1) {
                break (items, anchors);
            }
            // Retractions and identity refinements can make creation anchors
            // disappear during folding. Expanding the indexed anchor window
            // is cheap and guarantees a full page without scanning child runs.
            candidate_count = candidate_count.saturating_add(wanted);
        };
        let oldest_anchor = items
            .iter()
            .filter(|item| item_counts_toward_page(item))
            .filter_map(item_key)
            .filter_map(|key| anchors.get(&key).copied())
            .min();
        let has_older = match oldest_anchor {
            Some(cursor) if cursor > reset_seq => self.connection.query_row(
                r#"SELECT EXISTS(SELECT 1 FROM event
                    WHERE session_id=?1 AND seq>?2 AND seq<?3 AND (
                      type IN ('note','ask.permission','question.requested','plan.proposed',
                               'provider.message','notice')
                      OR (type IN ('message.started','thinking.delta','tool.started')
                          AND json_extract(json,'$.parentToolCallId') IS NULL)
                    )
                    AND NOT(type='note' AND json_extract(json,'$.rank')='detail'))"#,
                params![session_id, reset_seq, cursor],
                |row| row.get::<_, bool>(0),
            )?,
            _ => false,
        };
        Ok(TranscriptItemPage {
            items,
            cursor: oldest_anchor.filter(|_| has_older).map(|seq| -seq),
            has_older,
            newest_seq,
        })
    }

    /// Page one helper's private transcript by the canonical call that owns
    /// its rows. This is deliberately independent from the parent chat cursor:
    /// a large helper cannot starve the main transcript, and exhausting the
    /// main transcript cannot make older helper words unreachable.
    pub fn agent_transcript_items(
        &self,
        session_id: &str,
        parent_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> rusqlite::Result<TranscriptItemPage> {
        let newest_seq: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM event WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )?;
        let ceiling = before
            .filter(|cursor| *cursor < 0)
            .map(|cursor| cursor.saturating_abs())
            .unwrap_or_else(|| newest_seq.saturating_add(1));
        let reset_seq: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(seq),0) FROM event WHERE session_id=?1 AND type='transcript.reset' AND seq<?2",
            params![session_id, ceiling],
            |row| row.get(0),
        )?;
        let batch = limit.saturating_add(8);
        let mut candidate_count = batch;
        let (items, anchors) = loop {
            let mut statement = self.connection.prepare(
                r#"WITH candidate_events(item_kind,item_id,started) AS (
                     SELECT CASE type
                       WHEN 'message.started' THEN 'message'
                       WHEN 'thinking.delta' THEN 'thinking'
                       WHEN 'tool.started' THEN 'tool'
                       WHEN 'ask.permission' THEN 'ask'
                       WHEN 'question.requested' THEN 'question'
                       WHEN 'plan.proposed' THEN 'plan' END,
                       CASE type
                       WHEN 'message.started' THEN json_extract(json,'$.messageId')
                       WHEN 'thinking.delta' THEN json_extract(json,'$.messageId')
                       WHEN 'tool.started' THEN json_extract(json,'$.toolCallId')
                       WHEN 'ask.permission' THEN json_extract(json,'$.askId')
                       WHEN 'question.requested' THEN json_extract(json,'$.requestId')
                       WHEN 'plan.proposed' THEN json_extract(json,'$.proposalId') END,
                       seq
                     FROM event
                     WHERE session_id=?1 AND seq>?2 AND seq<?3
                       AND json_extract(json,'$.parentToolCallId')=?4
                       AND type IN ('message.started','thinking.delta','tool.started',
                                    'ask.permission','question.requested','plan.proposed')
                   ), anchors(item_kind,item_id,started) AS (
                     SELECT item_kind,item_id,MIN(started) FROM candidate_events
                     GROUP BY item_kind,item_id ORDER BY MIN(started) DESC LIMIT ?5
                   ), selected_agents(id) AS (
                     SELECT DISTINCT json_extract(event.json,'$.agentId') FROM event
                     WHERE event.session_id=?1 AND event.seq>?2 AND event.seq<?3
                       AND event.type='agent.started'
                       AND json_extract(event.json,'$.toolCallId') IN
                           (SELECT item_id FROM anchors WHERE item_kind='tool')
                   )
                   SELECT event.seq,event.json FROM event
                   WHERE event.session_id=?1 AND event.seq>?2 AND event.seq<?3 AND (
                     (event.type IN ('message.started','text.delta','thinking.delta','message.completed',
                                     'message.retracted','image','image.compare','widget')
                       AND json_extract(event.json,'$.messageId') IN
                           (SELECT item_id FROM anchors WHERE item_kind IN ('message','thinking')))
                     OR (event.type IN ('tool.started','tool.completed','tool.progress','diff')
                       AND json_extract(event.json,'$.toolCallId') IN
                           (SELECT item_id FROM anchors WHERE item_kind='tool'))
                     OR (event.type IN ('ask.permission','ask.resolved')
                       AND json_extract(event.json,'$.askId') IN
                           (SELECT item_id FROM anchors WHERE item_kind='ask'))
                     OR (event.type IN ('question.requested','question.resolved')
                       AND json_extract(event.json,'$.requestId') IN
                           (SELECT item_id FROM anchors WHERE item_kind='question'))
                     OR (event.type IN ('plan.proposed','plan.resolved')
                       AND json_extract(event.json,'$.proposalId') IN
                           (SELECT item_id FROM anchors WHERE item_kind='plan'))
                     OR (event.type IN ('agent.started','agent.progress','agent.finished',
                                        'agent.relayed','agent.identified')
                       AND json_extract(event.json,'$.agentId') IN (SELECT id FROM selected_agents))
                   ) ORDER BY event.seq"#,
            )?;
            let rows = statement
                .query_map(
                    params![
                        session_id,
                        reset_seq,
                        ceiling,
                        parent_id,
                        candidate_count as i64
                    ],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut anchors = HashMap::<String, i64>::new();
            let mut events = Vec::with_capacity(rows.len());
            for (seq, json) in rows {
                let mut event: Event = serde_json::from_str(&json).map_err(json_error)?;
                event.fields.insert("seq".into(), json!(seq));
                super::wire::bound_event(&mut event);
                if let Some(key) = event_item_anchor(&event) {
                    anchors.insert(key, seq);
                }
                events.push(event);
            }
            let projection = fold_all(&events);
            let visible = projection
                .items()
                .iter()
                .filter(|item| item_visible(item) && item["parentId"].as_str() == Some(parent_id))
                .cloned()
                .collect::<Vec<_>>();
            let start = visible.len().saturating_sub(limit);
            let items = visible[start..].to_vec();
            if items.len() >= limit || candidate_count > anchors.len() {
                break (items, anchors);
            }
            candidate_count = candidate_count.saturating_add(batch);
        };
        let oldest_anchor = items
            .iter()
            .filter_map(item_key)
            .filter_map(|key| anchors.get(&key).copied())
            .min();
        let has_older = match oldest_anchor {
            Some(cursor) => self.connection.query_row(
                r#"SELECT EXISTS(SELECT 1 FROM event
                    WHERE session_id=?1 AND seq>?2 AND seq<?3
                      AND json_extract(json,'$.parentToolCallId')=?4
                      AND type IN ('message.started','thinking.delta','tool.started',
                                   'ask.permission','question.requested','plan.proposed'))"#,
                params![session_id, reset_seq, cursor, parent_id],
                |row| row.get::<_, bool>(0),
            )?,
            None => false,
        };
        Ok(TranscriptItemPage {
            items,
            cursor: oldest_anchor.filter(|_| has_older).map(|seq| -seq),
            has_older,
            newest_seq,
        })
    }

    fn projected_agents_without_ensuring(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Vec<serde_json::Value>> {
        let mut statement = self
            .connection
            .prepare("SELECT json FROM transcript_agent WHERE session_id = ?1 ORDER BY rowid")?;
        let found = statement
            .query_map([session_id], |row| row.get::<_, String>(0))?
            .map(|row| serde_json::from_str(&row?).map_err(json_error))
            .collect();
        found
    }

    #[cfg(test)]
    fn connection(&self) -> &Connection {
        &self.connection
    }
}

fn item_key(item: &Value) -> Option<String> {
    Some(format!(
        "{}:{}",
        item["kind"].as_str()?,
        item["id"].as_str()?
    ))
}

fn event_item_anchor(event: &Event) -> Option<String> {
    let field = |name: &str| event.fields.get(name).and_then(Value::as_str);
    match event.kind {
        EventKind::MessageStarted => Some(format!("message:{}", field("messageId")?)),
        EventKind::ThinkingDelta => Some(format!("thinking:{}", field("messageId")?)),
        EventKind::ToolStarted => Some(format!("tool:{}", field("toolCallId")?)),
        EventKind::Note => Some(format!("note:{}", field("noteId")?)),
        EventKind::AskPermission => Some(format!("ask:{}", field("askId")?)),
        EventKind::QuestionRequested => Some(format!("question:{}", field("requestId")?)),
        EventKind::PlanProposed => Some(format!("plan:{}", field("proposalId")?)),
        EventKind::ProviderMessage => Some(format!(
            "provider_message:{}",
            event.fields.get("signal")?.get("id")?.as_str()?
        )),
        EventKind::Notice => Some(format!("notice-{}", event.fields.get("seq")?.as_i64()?))
            .map(|id| format!("notice:{id}")),
        _ => None,
    }
}

fn item_visible(item: &Value) -> bool {
    !(item["kind"] == "note" && item["rank"] == "detail")
}

/// The main conversation's page budget counts only rows the main transcript
/// can draw. Helper-owned words and commands remain available to the helper
/// panel, but a long child run cannot displace the parent conversation.
fn item_counts_toward_page(item: &Value) -> bool {
    if !item_visible(item) {
        return false;
    }
    let nested = matches!(item["kind"].as_str(), Some("tool" | "message" | "thinking"))
        && item["parentId"].as_str().is_some();
    !nested || (item["kind"] == "tool" && item["status"] == "failed")
}

/// Keep one fixed main-conversation page plus one fixed helper tail. The
/// latter preserves the existing subagent panel without allowing its private
/// transcript to make the main conversation blank or unbounded.
fn bounded_page_items(items: &[Value], limit: usize) -> Vec<Value> {
    let primary = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item_counts_toward_page(item))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let nested = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item_visible(item) && !item_counts_toward_page(item))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut selected = primary
        .into_iter()
        .rev()
        .take(limit)
        .chain(nested.into_iter().rev().take(limit))
        .collect::<Vec<_>>();
    selected.sort_unstable();
    selected.dedup();
    selected
        .into_iter()
        .map(|index| items[index].clone())
        .collect()
}

fn projection_items_for_event(
    transaction: &Transaction<'_>,
    session_id: &str,
    event: &Event,
    agents: &[Value],
) -> rusqlite::Result<Vec<(i64, Value)>> {
    let field = |name: &str| {
        event
            .fields
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let keys: Vec<String> = match event.kind {
        EventKind::Image
        | EventKind::ImageCompare
        | EventKind::Widget
        | EventKind::TextDelta
        | EventKind::MessageRetracted => vec![format!("message:{}", field("messageId"))],
        EventKind::ThinkingDelta => vec![format!("thinking:{}", field("messageId"))],
        EventKind::MessageCompleted => vec![
            format!("message:{}", field("messageId")),
            format!("thinking:{}", field("messageId")),
        ],
        EventKind::ToolStarted
        | EventKind::ToolCompleted
        | EventKind::ToolProgress
        | EventKind::Diff => vec![format!("tool:{}", field("toolCallId"))],
        EventKind::AgentFinished => agents
            .iter()
            .find(|agent| agent["id"].as_str() == Some(field("agentId")))
            .and_then(|agent| agent["toolCallId"].as_str())
            .map(|id| vec![format!("tool:{id}")])
            .unwrap_or_default(),
        EventKind::AskResolved => vec![format!("ask:{}", field("askId"))],
        EventKind::QuestionResolved => vec![format!("question:{}", field("requestId"))],
        EventKind::PlanResolved => vec![format!("plan:{}", field("proposalId"))],
        EventKind::PlanProposed => {
            return projection_items_matching(transaction, session_id, "plan:%")
        }
        EventKind::TranscriptReset => {
            return projection_items_matching(transaction, session_id, "%")
        }
        _ => Vec::new(),
    };
    let mut found = Vec::new();
    for key in keys {
        let row = transaction
            .query_row(
                "SELECT position,json FROM transcript_item WHERE session_id=?1 AND item_key=?2",
                params![session_id, key],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((position, json)) = row {
            found.push((position, serde_json::from_str(&json).map_err(json_error)?));
        }
    }
    found.sort_by_key(|(position, _)| *position);
    Ok(found)
}

fn projection_items_matching(
    transaction: &Transaction<'_>,
    session_id: &str,
    pattern: &str,
) -> rusqlite::Result<Vec<(i64, Value)>> {
    let mut statement = transaction.prepare(
        "SELECT position,json FROM transcript_item WHERE session_id=?1 AND item_key LIKE ?2 ORDER BY position",
    )?;
    let found = statement
        .query_map(params![session_id, pattern], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (position, json) = row?;
            Ok((position, serde_json::from_str(&json).map_err(json_error)?))
        })
        .collect();
    found
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get("id")?,
        brand: row.get("brand")?,
        external_id: row.get("external_id")?,
        project_id: row.get("project_id")?,
        project_path: row.get("project_path")?,
        cwd: row.get("cwd")?,
        model: row.get("model")?,
        permission_mode: row.get("permission_mode")?,
        effort: row.get("effort")?,
        collaboration_mode: row.get("collaboration_mode")?,
        title: row.get("title")?,
        state: row.get("state")?,
        origin: row.get("origin")?,
        created_at: row.get("created_at")?,
        last_active_at: row.get("last_active_at")?,
        last_spoke_at: row.get("last_spoke_at")?,
    })
}

fn event_string<'a>(event: &'a Event, field: &str) -> rusqlite::Result<&'a str> {
    event
        .fields
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| rusqlite::Error::InvalidParameterName(format!("event.{field}")))
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction
        .execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);")?;
    let held = transaction
        .query_row("SELECT version FROM schema_version", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    let mut version = held.unwrap_or(0).max(0) as usize;
    if held.is_none() {
        transaction.execute("INSERT INTO schema_version VALUES (0)", [])?;
    }
    for migration in LEGACY_MIGRATIONS.iter().skip(version) {
        transaction.execute_batch(migration)?;
        version += 1;
    }
    reconcile_capabilities(&transaction)?;
    transaction.execute("UPDATE schema_version SET version = ?1", [version as i64])?;
    transaction.commit()
}

fn reconcile_capabilities(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    if !columns(transaction, "session")?
        .iter()
        .any(|name| name == "collaboration_mode")
    {
        transaction.execute_batch("ALTER TABLE session ADD COLUMN collaboration_mode TEXT;")?;
    }

    let event_columns = columns(transaction, "event")?;
    for column in ["provider", "provider_thread_id", "provider_event_id"] {
        if !event_columns.iter().any(|name| name == column) {
            transaction.execute_batch(&format!("ALTER TABLE event ADD COLUMN {column} TEXT;"))?;
        }
    }
    transaction.execute_batch(
        r#"CREATE UNIQUE INDEX IF NOT EXISTS event_by_provider_identity
             ON event(session_id, provider, provider_thread_id, provider_event_id)
             WHERE provider_event_id IS NOT NULL;
           CREATE INDEX IF NOT EXISTS event_by_type
             ON event(type, session_id, seq);
           CREATE TABLE IF NOT EXISTS transcript_item (
             session_id TEXT NOT NULL,
             item_key TEXT NOT NULL,
             position INTEGER NOT NULL,
             updated_seq INTEGER NOT NULL,
             visible INTEGER NOT NULL,
             json TEXT NOT NULL,
             PRIMARY KEY (session_id, item_key),
             UNIQUE (session_id, position)
           );
           CREATE INDEX IF NOT EXISTS transcript_item_page
             ON transcript_item(session_id, visible, position DESC);
           CREATE TABLE IF NOT EXISTS transcript_projection (
             session_id TEXT PRIMARY KEY,
             projected_seq INTEGER NOT NULL,
             reset_seq INTEGER NOT NULL
           );
           CREATE TABLE IF NOT EXISTS transcript_agent (
             session_id TEXT NOT NULL,
             agent_id TEXT NOT NULL,
             tool_call_id TEXT,
             json TEXT NOT NULL,
             PRIMARY KEY (session_id, agent_id)
           );"#,
    )?;

    one_row_per_external_chat(transaction)
}

/**
 * One row per chat another program is holding, enforced by the database.
 *
 * A chat opened in a terminal is discovered rather than created here, and the
 * discovery caches a row for it the first time it is seen. Two of those
 * requests in flight at once each looked, each found nothing, and each cached
 * a row: the recovery for that race asked the database which row had won, and
 * the database had no opinion, because nothing said the pair was unique.
 * Measured on a real install: four rows for one terminal chat, all four
 * written in the same millisecond, all four drawn in the sidebar under the
 * same name (bw-t26l.20).
 *
 * So the pair is made unique, once, and the duplicates already written are
 * collapsed onto the row that read the most of the chat. What the losers hold
 * of the transcript is a shorter copy of the same conversation and is read
 * again from the provider on the next open; what they hold of the reader's own
 * work — the cards they were linked to, the spend they were billed — is moved
 * onto the survivor rather than dropped.
 */
fn one_row_per_external_chat(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    let already: Option<String> = transaction
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='session_by_external'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if already.is_some() {
        return Ok(());
    }

    // The survivor of each group, and every row it replaces. Ordered by how
    // much of the chat each one actually read, so the row the reader has been
    // looking at is the one that stays.
    let mut statement = transaction.prepare(
        r#"SELECT brand, external_id, id,
                  (SELECT COUNT(*) FROM event WHERE event.session_id = session.id) AS depth
             FROM session
            WHERE external_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM session AS peer
                           WHERE peer.brand = session.brand
                             AND peer.external_id = session.external_id
                             AND peer.id <> session.id)
            ORDER BY brand, external_id, depth DESC,
                     COALESCE(last_spoke_at, last_active_at) DESC, created_at DESC, id"#,
    )?;
    let ranked: Vec<(String, String)> = statement
        .query_map([], |row| {
            Ok((
                format!(
                    "{}\u{0}{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?
                ),
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(statement);

    let mut winner: Option<String> = None;
    let mut group = String::new();
    for (key, id) in ranked {
        if key != group {
            group = key;
            winner = Some(id);
            continue;
        }
        let Some(keep) = winner.as_deref() else {
            continue;
        };
        // The reader's own work first, so nothing of theirs is deleted with
        // the row. `OR IGNORE` because the survivor may already carry the
        // same card or the same billed turn.
        transaction.execute(
            "UPDATE OR IGNORE bead_link SET session_id = ?1 WHERE session_id = ?2",
            [keep, id.as_str()],
        )?;
        transaction.execute(
            "UPDATE OR IGNORE turn SET session_id = ?1 WHERE session_id = ?2",
            [keep, id.as_str()],
        )?;
        for table in [
            "event",
            "message",
            "bead_link",
            "turn",
            "summary_run",
            "transcript_item",
            "transcript_agent",
            "transcript_projection",
        ] {
            transaction.execute(
                &format!("DELETE FROM {table} WHERE session_id = ?1"),
                [id.as_str()],
            )?;
        }
        transaction.execute("DELETE FROM session WHERE id = ?1", [id.as_str()])?;
    }

    transaction.execute_batch(
        "CREATE UNIQUE INDEX session_by_external ON session(brand, external_id)
           WHERE external_id IS NOT NULL;",
    )
}

fn columns(transaction: &Transaction<'_>, table: &str) -> rusqlite::Result<Vec<String>> {
    debug_assert!(matches!(table, "session" | "event"));
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let found = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, brand: &str, external_id: Option<&str>, at: &str) -> Session {
        Session {
            id: id.to_string(),
            brand: brand.to_string(),
            external_id: external_id.map(str::to_string),
            project_id: "project-1".to_string(),
            project_path: "/project".to_string(),
            cwd: "/project".to_string(),
            model: Some("model-1".to_string()),
            permission_mode: "default".to_string(),
            effort: Some("high".to_string()),
            collaboration_mode: None,
            title: Some(format!("Chat {id}")),
            state: "idle".to_string(),
            origin: "app".to_string(),
            created_at: at.to_string(),
            last_active_at: at.to_string(),
            last_spoke_at: None,
        }
    }

    /// What a chat has spent is a running total, and the spend table is a sum.
    ///
    /// Three turns of one chat, each `cost` event naming everything the chat
    /// has used so far. Summed back, that has to be the last event's figure
    /// and not the three added together (bw-t26l.20).
    #[test]
    fn what_a_turn_added_is_recorded_once_however_often_the_running_total_is_said() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store
            .create_session(&session("chat-1", "claude", None, "2026-08-20T00:00:00.000Z"))
            .unwrap();
        for (at, total) in [
            ("2026-08-20T00:01:00.000Z", 100),
            ("2026-08-20T00:02:00.000Z", 260),
            ("2026-08-20T00:03:00.000Z", 300),
        ] {
            store
                .remember_turn_cost(
                    "chat-1",
                    at,
                    &serde_json::json!({"kind":"tokens","input":total,"output":0,"total":total}),
                )
                .unwrap();
        }
        assert_eq!(
            store.spend().unwrap(),
            [Spend {
                day: "2026-08-20".to_string(),
                project_id: "project-1".to_string(),
                brand: "claude".to_string(),
                usd: 0.0,
                tokens: 300,
            }]
        );

        // A turn that added nothing writes nothing, so the same event arriving
        // twice cannot invent a second turn.
        store
            .remember_turn_cost(
                "chat-1",
                "2026-08-20T00:04:00.000Z",
                &serde_json::json!({"kind":"tokens","input":300,"output":0,"total":300}),
            )
            .unwrap();
        assert_eq!(store.spend().unwrap()[0].tokens, 300);

        // And a chat this store has never heard of is not a row at all.
        store
            .remember_turn_cost(
                "no-such-chat",
                "2026-08-20T00:05:00.000Z",
                &serde_json::json!({"kind":"tokens","total":99}),
            )
            .unwrap();
        assert_eq!(store.spend().unwrap().len(), 1);
    }

    #[test]
    fn workbench_core_store_creates_updates_and_orders_sessions() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store
            .create_session(&session(
                "older",
                "claude",
                Some("native-older"),
                "2026-08-20T00:00:00.000Z",
            ))
            .unwrap();
        store
            .create_session(&session(
                "newer",
                "codex",
                Some("native-newer"),
                "2026-08-21T00:00:00.000Z",
            ))
            .unwrap();

        store
            .update_session(
                "older",
                SessionPatch {
                    title: Some(Some("Renamed".to_string())),
                    model: Some(None),
                    collaboration_mode: Some(Some("plan".to_string())),
                    state: Some("streaming".to_string()),
                    ..SessionPatch::default()
                },
                Some("2026-08-22T00:00:00.000Z"),
            )
            .unwrap();
        store
            .mark_spoke("newer", "2026-08-23T00:00:00.000Z")
            .unwrap();

        let older = store.get_session("older").unwrap().unwrap();
        assert_eq!(older.title.as_deref(), Some("Renamed"));
        assert_eq!(older.model, None);
        assert_eq!(older.collaboration_mode.as_deref(), Some("plan"));
        assert_eq!(older.state, "streaming");
        assert_eq!(
            store
                .session_by_external_id("native-older")
                .unwrap()
                .unwrap()
                .id,
            "older"
        );
        assert_eq!(
            store
                .list_sessions(Some("project-1"))
                .unwrap()
                .into_iter()
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            ["newer", "older"]
        );
        assert_eq!(store.mark_all_dormant().unwrap(), 2);
        assert!(store
            .list_sessions(None)
            .unwrap()
            .iter()
            .all(|row| row.state == "dormant"));
    }

    #[test]
    fn workbench_core_follower_cursor_belongs_to_the_current_import() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store
            .create_session(&session(
                "external",
                "claude",
                Some("native-external"),
                "2026-08-21T00:00:00.000Z",
            ))
            .unwrap();

        // Following says nothing about whether this chat was ever read in.
        // Said the other way — and it was — the follower's first tick claimed
        // the import, and the import that arrived seconds later left the page
        // blank because the work looked done (bw-t26l.20).
        store.remember_followed("external", 12_345).unwrap();
        assert_eq!(
            store.imported_by("external").unwrap(),
            None,
            "the follower claimed an import nobody had done"
        );
        assert_eq!(
            store.followed_to("external").unwrap(),
            None,
            "a cursor from before the import was read as though the import had happened"
        );

        store.mark_imported("external").unwrap();
        store.remember_followed("external", 12_345).unwrap();
        assert_eq!(store.followed_to("external").unwrap(), Some(12_345));

        store
            .connection()
            .execute(
                "UPDATE session SET imported_recipe=?1 WHERE id='external'",
                [IMPORT_RECIPE - 1],
            )
            .unwrap();
        assert_eq!(
            store.followed_to("external").unwrap(),
            None,
            "a byte from an older normalization recipe cannot skip current history"
        );

        store.remember_followed("external", 23_456).unwrap();
        store.mark_imported("external").unwrap();
        assert_eq!(
            store.followed_to("external").unwrap(),
            None,
            "reading the whole record invalidates the incremental follower byte"
        );
    }

    #[test]
    fn import_generations_advance_only_the_provider_whose_normalizer_changed() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for row in [
            session("claude-chat", "claude", Some("c"), "now"),
            session("codex-chat", "codex", Some("x"), "now"),
        ] {
            store.create_session(&row).unwrap();
            store.mark_imported(&row.id).unwrap();
        }
        assert_eq!(
            store.imported_by("claude-chat").unwrap(),
            Some(CLAUDE_IMPORT_RECIPE)
        );
        assert_eq!(
            store.imported_by("codex-chat").unwrap(),
            Some(IMPORT_RECIPE)
        );
    }

    #[test]
    fn workbench_core_keeps_only_latest_durable_progress_per_operation() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for value in [
            json!({"type":"tool.progress","sessionId":"s","seq":1,"at":"now","toolCallId":"a","seconds":1,"summary":"one"}),
            json!({"type":"tool.progress","sessionId":"s","seq":2,"at":"now","toolCallId":"b","seconds":1,"summary":"other"}),
            json!({"type":"agent.progress","sessionId":"s","seq":3,"at":"now","agentId":"helper","seconds":1}),
            json!({"type":"thinking.progress","sessionId":"s","seq":4,"at":"now","tokens":10}),
            json!({"type":"tool.progress","sessionId":"s","seq":5,"at":"now","toolCallId":"a","seconds":2,"summary":"two"}),
            json!({"type":"agent.progress","sessionId":"s","seq":6,"at":"now","agentId":"helper","seconds":2}),
            json!({"type":"thinking.progress","sessionId":"s","seq":7,"at":"now","tokens":20}),
        ] {
            assert!(store
                .append_event(&serde_json::from_value(value).unwrap())
                .unwrap());
        }
        let events = store.events_since("s", 0).unwrap();
        assert_eq!(events.len(), 4);
        assert!(events
            .iter()
            .any(|event| event.kind == EventKind::ToolProgress
                && event.fields["toolCallId"] == "a"
                && event.fields["summary"] == "two"));
        assert!(events.iter().any(
            |event| event.kind == EventKind::ToolProgress && event.fields["toolCallId"] == "b"
        ));
        assert!(events
            .iter()
            .any(|event| event.kind == EventKind::AgentProgress && event.fields["seconds"] == 2));
        assert!(
            events
                .iter()
                .any(|event| event.kind == EventKind::ThinkingProgress
                    && event.fields["tokens"] == 20)
        );
    }

    #[test]
    fn steering_menu_reuses_only_provider_wide_controls() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for row in [
            session("catalog", "codex", Some("thread-1"), "2026-08-20T00:00:00Z"),
            session(
                "migrated",
                "codex",
                Some("thread-2"),
                "2026-08-21T00:00:00Z",
            ),
            session("other", "claude", Some("thread-3"), "2026-08-22T00:00:00Z"),
        ] {
            store.create_session(&row).unwrap();
        }
        let menu: Event = serde_json::from_value(json!({
            "type":"session.menu", "sessionId":"catalog", "seq":1, "at":"now",
            "models":[{"value":"gpt-5","displayName":"GPT-5"}],
            "permissionModes":["on-request"], "efforts":[{"value":"high"}],
            "collaborationModes":[{"value":"plan"}],
            "commands":[{"name":"project-only"}], "skills":["private-skill"],
            "agentDefinitions":[{"name":"private-agent"}],
            "agentControls":["stop","say"]
        }))
        .unwrap();
        assert!(store.append_event(&menu).unwrap());

        let inherited = store.steering_menu("migrated").unwrap();
        assert_eq!(inherited["models"][0]["value"], "gpt-5");
        assert_eq!(inherited["permissionModes"][0], "on-request");
        assert!(inherited.get("commands").is_none());
        assert!(inherited.get("skills").is_none());
        assert!(inherited.get("agentDefinitions").is_none());
        assert!(inherited.get("agentControls").is_none());
        let exact = store.steering_menu("catalog").unwrap();
        assert_eq!(exact["commands"][0]["name"], "project-only");
        assert_eq!(exact["skills"][0], "private-skill");
        assert_eq!(exact["agentDefinitions"][0]["name"], "private-agent");
        assert_eq!(exact["agentControls"], json!(["stop", "say"]));
        assert_eq!(store.steering_menu("other").unwrap(), json!({}));
    }

    #[test]
    fn steering_menu_keeps_only_this_sessions_provider_owned_option_values() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for row in [
            session("one", "codex", Some("thread-1"), "2026-08-20T00:00:00Z"),
            session("two", "codex", Some("thread-2"), "2026-08-21T00:00:00Z"),
        ] {
            store.create_session(&row).unwrap();
        }
        for id in ["one", "two"] {
            let menu: Event = serde_json::from_value(json!({
                "type":"session.menu", "sessionId":id, "seq":1, "at":"now",
                "configOptions":[{"id":"fast-mode","name":"Fast mode","type":"boolean","currentValue":false}]
            })).unwrap();
            assert!(store.append_event(&menu).unwrap());
        }
        let pinned: Event = serde_json::from_value(json!({
            "type":"session.pinned", "sessionId":"one", "seq":2, "at":"now",
            "permissionMode":null, "model":null,
            "configOptions":[{"id":"fast-mode","currentValue":true}]
        }))
        .unwrap();
        assert!(store.append_event(&pinned).unwrap());

        assert_eq!(
            store.steering_menu("one").unwrap()["configOptions"][0]["currentValue"],
            true
        );
        assert_eq!(
            store.steering_menu("two").unwrap()["configOptions"][0]["currentValue"],
            false
        );
    }

    #[test]
    fn restore_sessions_hide_only_unused_untitled_chats() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for id in ["empty", "spoken", "titled"] {
            let mut row = session(id, "claude", None, "2026-08-20T00:00:00Z");
            row.title = (id == "titled").then(|| "Kept title".into());
            // The rule this test is about is for the chats we did not start.
            row.origin = "terminal".into();
            store.create_session(&row).unwrap();
        }
        let message: Event = serde_json::from_value(json!({
            "type":"message.started", "sessionId":"spoken", "seq":1,
            "at":"now", "messageId":"m1", "role":"user"
        }))
        .unwrap();
        assert!(store.append_event(&message).unwrap());

        let normal = store
            .list_restore_sessions(Some("project-1"), false)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            normal,
            std::collections::HashSet::from(["spoken".into(), "titled".into()])
        );
        assert_eq!(
            store
                .list_restore_sessions(Some("project-1"), true)
                .unwrap()
                .len(),
            3
        );
    }

    /// A chat begun at the New Chat button is on the list from the moment it
    /// is made.
    ///
    /// This is the shape a local chat is deliberately created in: no title, no
    /// message, no model, no driver — it is waiting to be told which model to
    /// use. Under the old title-or-a-message rule it was dropped from the
    /// restore list at once, and unlike Claude and Codex nothing rediscovered
    /// it, so the chat the person had just asked for was never seen again
    /// (bw-u6cl.1). A chat of the same shape that we did not start stays
    /// hidden, which is the rule this one is carved out of.
    #[test]
    fn restore_sessions_offer_a_chat_the_person_started_here_before_anything_is_said() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();

        let mut started_here = session("local-new", "local", None, "2026-09-04T00:00:00Z");
        started_here.title = None;
        started_here.model = None;
        started_here.origin = "app".into();
        store.create_session(&started_here).unwrap();

        let mut from_outside = session("outside-new", "claude", None, "2026-09-04T00:00:00Z");
        from_outside.title = None;
        from_outside.origin = "terminal".into();
        store.create_session(&from_outside).unwrap();

        let offered = store
            .list_restore_sessions(Some("project-1"), false)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            offered,
            std::collections::HashSet::from(["local-new".to_string()])
        );
    }

    #[test]
    fn the_model_a_local_chat_was_last_started_on_is_remembered_across_projects() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();

        let mut older = session("local-old", "local", None, "2026-09-01T00:00:00Z");
        older.model = Some("ollama::gemma".into());
        store.create_session(&older).unwrap();

        // A newer chat in another project still speaks for this machine.
        let mut newer = session("local-new", "local", None, "2026-09-03T00:00:00Z");
        newer.model = Some("ollama::qwen".into());
        newer.project_id = "project-2".into();
        store.create_session(&newer).unwrap();

        // A chat that never chose one cannot be the answer, however recent.
        let mut unanswered = session("local-blank", "local", None, "2026-09-04T00:00:00Z");
        unanswered.model = None;
        store.create_session(&unanswered).unwrap();

        assert_eq!(
            store.last_model_for_brand("local").unwrap().as_deref(),
            Some("ollama::qwen")
        );
        assert_eq!(store.last_model_for_brand("goose").unwrap(), None);
    }

    #[test]
    fn workbench_core_store_appends_once_and_keeps_search_costs_and_links() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store
            .create_session(&session(
                "chat-1",
                "claude",
                Some("native-1"),
                "2026-08-20T00:00:00.000Z",
            ))
            .unwrap();
        let live: Event = serde_json::from_value(serde_json::json!({
            "seq": 1,
            "sessionId": "chat-1",
            "at": "2026-08-20T00:00:01.000Z",
            "type": "text.delta",
            "messageId": "answer-1",
            "text": "kept exactly",
            "providerEvent": {
                "provider": "claude",
                "threadId": "native-1",
                "eventId": "answer-1:text:0",
                "delivery": "live"
            }
        }))
        .unwrap();
        let replay: Event = serde_json::from_value(serde_json::json!({
            "seq": 2,
            "sessionId": "chat-1",
            "at": "2026-08-20T00:00:01.000Z",
            "type": "text.delta",
            "messageId": "answer-1",
            "text": "kept exactly",
            "providerEvent": {
                "provider": "claude",
                "threadId": "native-1",
                "eventId": "answer-1:text:0",
                "delivery": "replay"
            }
        }))
        .unwrap();
        assert!(store.append_event(&live).unwrap());
        assert!(!store.append_event(&replay).unwrap());
        assert_eq!(store.next_seq("chat-1").unwrap(), 2);
        assert_eq!(store.events_since("chat-1", 0).unwrap(), [live]);

        store
            .open_message(
                "chat-1",
                "answer-1",
                "assistant",
                "2026-08-20T00:00:01.000Z",
            )
            .unwrap();
        store
            .grow_message("chat-1", "answer-1", "100% kept exactly")
            .unwrap();
        let found = store.search("% kept", 100).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "100% kept exactly");

        store
            .remember_turn(&Turn {
                session_id: "chat-1".to_string(),
                project_id: "project-1".to_string(),
                brand: "claude".to_string(),
                at: "2026-08-20T00:01:00.000Z".to_string(),
                usd: Some(0.25),
                input: None,
                output: None,
                total: None,
            })
            .unwrap();
        store
            .remember_turn(&Turn {
                session_id: "codex-chat".to_string(),
                project_id: "project-1".to_string(),
                brand: "codex".to_string(),
                at: "2026-08-20T00:02:00.000Z".to_string(),
                usd: None,
                input: Some(10),
                output: Some(20),
                total: Some(30),
            })
            .unwrap();
        assert_eq!(
            store.spend().unwrap(),
            [
                Spend {
                    day: "2026-08-20".to_string(),
                    project_id: "project-1".to_string(),
                    brand: "claude".to_string(),
                    usd: 0.25,
                    tokens: 0,
                },
                Spend {
                    day: "2026-08-20".to_string(),
                    project_id: "project-1".to_string(),
                    brand: "codex".to_string(),
                    usd: 0.0,
                    tokens: 30,
                },
            ]
        );

        assert!(store
            .remember_bead_link("chat-1", "bw-one", "tool", "2026-08-20T00:00:02.000Z")
            .unwrap());
        assert!(!store
            .remember_bead_link("chat-1", "bw-one", "brief", "2026-08-20T00:00:03.000Z")
            .unwrap());
        store
            .remember_bead_link("chat-1", "bw-two", "manual", "2026-08-20T00:00:04.000Z")
            .unwrap();
        assert_eq!(
            store.beads_for_session("chat-1").unwrap(),
            ["bw-one", "bw-two"]
        );
        assert_eq!(
            store
                .beads_for_sessions(&["chat-1".to_string()])
                .unwrap()
                .get("chat-1")
                .unwrap(),
            &["bw-one".to_string(), "bw-two".to_string()]
        );

        store.retract_message("chat-1", "answer-1").unwrap();
        assert!(store.search("kept", 100).unwrap().is_empty());
    }

    #[test]
    fn legacy_event_json_gets_its_durable_sql_sequence_back() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store.connection().execute(
            "INSERT INTO event (session_id, seq, at, type, json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "legacy-chat",
                41_i64,
                "2026-08-20T00:00:00.000Z",
                "notice",
                r#"{"type":"notice","sessionId":"legacy-chat","at":"2026-08-20T00:00:00.000Z","text":"kept"}"#,
            ],
        ).unwrap();

        let events = store.events_since("legacy-chat", 0).unwrap();
        assert_eq!(events[0].fields["seq"], 41);
        assert_eq!(fold_all(&events).view["lastSeq"], 41);
    }

    #[test]
    fn legacy_report_event_does_not_abort_replay() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store.connection().execute(
            "INSERT INTO event (session_id, seq, at, type, json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "legacy-chat",
                42_i64,
                "2026-08-20T00:00:00.000Z",
                "report.available",
                r#"{"type":"report.available","sessionId":"legacy-chat","project":"beads-web","slug":"review"}"#,
            ],
        ).unwrap();

        let events = store.events_since("legacy-chat", 0).unwrap();
        assert_eq!(
            events[0].kind,
            crate::workbench::protocol::EventKind::ReportAvailable
        );
        assert_eq!(fold_all(&events).view["lastSeq"], 42);
    }

    #[test]
    fn workbench_core_projection_pages_visible_rows_and_persists_agents() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/workbench-contract.json"))
                .unwrap();
        let events = fixture["events"].as_array().unwrap();
        for source in &events[..events.len() - 1] {
            let event: Event = serde_json::from_value(source.clone()).unwrap();
            assert!(store.append_event(&event).unwrap());
        }
        store.ensure_transcript_projection("session-1").unwrap();

        let newest = store.transcript_items("session-1", None, 3).unwrap();
        assert_eq!(newest.newest_seq, 37);
        assert!(
            newest.items.len() <= 6,
            "one primary page plus one helper tail"
        );
        assert!(newest.has_older);
        assert_eq!(
            newest
                .items
                .iter()
                .filter(|item| item_counts_toward_page(item))
                .map(|item| item["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["plan", "provider_message", "notice"]
        );
        // The detail note exists in the durable projection but cannot consume
        // a visible transcript page slot.
        assert_eq!(
            store
                .connection()
                .query_row(
                    "SELECT visible FROM transcript_item WHERE item_key = 'note:note-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        let older = store
            .transcript_items("session-1", newest.cursor, 20)
            .unwrap();
        assert_eq!(older.items.len(), 5);
        assert!(!older.has_older);
        let agents = store.projected_agents("session-1").unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["state"], "done");
        assert_eq!(agents[0]["result"], "Looks good");

        let reset: Event = serde_json::from_value(events.last().unwrap().clone()).unwrap();
        assert!(store.append_event(&reset).unwrap());
        assert!(store
            .transcript_items("session-1", None, 40)
            .unwrap()
            .items
            .is_empty());
        assert!(store.projected_agents("session-1").unwrap().is_empty());
    }

    #[test]
    fn workbench_core_projection_catches_up_only_touched_rows() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for value in [
            json!({"type":"message.started","sessionId":"chat","seq":1,"at":"now","messageId":"old","role":"user"}),
            json!({"type":"text.delta","sessionId":"chat","seq":2,"at":"now","messageId":"old","text":"kept"}),
            json!({"type":"message.completed","sessionId":"chat","seq":3,"at":"now","messageId":"old"}),
        ] {
            assert!(store
                .append_event(&serde_json::from_value(value).unwrap())
                .unwrap());
        }
        store.ensure_transcript_projection("chat").unwrap();
        assert_eq!(
            store
                .transcript_items("chat", None, 40)
                .unwrap()
                .items
                .len(),
            1
        );
        let before: i64 = store
            .connection()
            .query_row(
                "SELECT updated_seq FROM transcript_item WHERE session_id='chat' AND item_key='message:old'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let notice: Event = serde_json::from_value(json!({
            "type":"notice","sessionId":"chat","seq":4,"at":"later","text":"new"
        }))
        .unwrap();
        assert!(store.append_event(&notice).unwrap());
        let page = store.transcript_items("chat", None, 40).unwrap();
        assert_eq!(page.items.len(), 2);
        let after: i64 = store
            .connection()
            .query_row(
                "SELECT updated_seq FROM transcript_item WHERE session_id='chat' AND item_key='message:old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after, before, "an unrelated tail event rewrote old history");
    }

    #[test]
    fn workbench_core_cold_history_pages_without_materialising_every_item() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for seq in 1..=50 {
            let event: Event = serde_json::from_value(json!({
                "type":"notice","sessionId":"cold","seq":seq,"at":"now","text":format!("row {seq}")
            }))
            .unwrap();
            assert!(store.append_event(&event).unwrap());
        }

        let newest = store.transcript_items("cold", None, 40).unwrap();
        assert_eq!(newest.items.len(), 40);
        assert_eq!(newest.items[0]["text"], "row 11");
        assert!(newest.cursor.is_some_and(|cursor| cursor < 0));
        assert!(newest.has_older);
        assert_eq!(
            store
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM transcript_item WHERE session_id='cold'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        let older = store.transcript_items("cold", newest.cursor, 40).unwrap();
        assert_eq!(older.items.len(), 10);
        assert_eq!(older.items[0]["text"], "row 1");
        assert!(!older.has_older);
    }

    #[test]
    fn helper_history_cannot_consume_the_parent_transcript_page() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let mut seq = 0;
        let mut append = |body: Value| {
            seq += 1;
            let mut object = body.as_object().unwrap().clone();
            object.insert("sessionId".into(), json!("nested"));
            object.insert("seq".into(), json!(seq));
            object.insert("at".into(), json!("now"));
            assert!(store
                .append_event(&serde_json::from_value(Value::Object(object)).unwrap())
                .unwrap());
        };
        for index in 0..45 {
            append(
                json!({"type":"message.started","messageId":format!("root-{index}"),"role":"assistant"}),
            );
            append(
                json!({"type":"text.delta","messageId":format!("root-{index}"),"text":format!("root {index}")}),
            );
            append(json!({"type":"message.completed","messageId":format!("root-{index}")}));
        }
        for index in 0..80 {
            append(
                json!({"type":"message.started","messageId":format!("child-{index}"),"role":"assistant","parentToolCallId":"spawn"}),
            );
            append(
                json!({"type":"text.delta","messageId":format!("child-{index}"),"text":format!("child {index}")}),
            );
            append(json!({"type":"message.completed","messageId":format!("child-{index}")}));
        }

        let newest = store.transcript_items("nested", None, 40).unwrap();
        let primary = newest
            .items
            .iter()
            .filter(|item| item_counts_toward_page(item))
            .collect::<Vec<_>>();
        let child = newest
            .items
            .iter()
            .filter(|item| !item_counts_toward_page(item))
            .collect::<Vec<_>>();
        assert_eq!(primary.len(), 40);
        assert_eq!(primary.first().unwrap()["text"], "root 5");
        assert_eq!(primary.last().unwrap()["text"], "root 44");
        assert_eq!(child.len(), 40, "the helper panel tail stays bounded too");
        assert_eq!(child.last().unwrap()["text"], "child 79");
        assert_eq!(newest.items.len(), 80);
        assert!(newest.has_older);

        let older = store.transcript_items("nested", newest.cursor, 40).unwrap();
        assert_eq!(
            older
                .items
                .iter()
                .filter(|item| item_counts_toward_page(item))
                .count(),
            5
        );
        assert!(!older.has_older);
    }

    #[test]
    fn cold_history_expands_past_retracted_anchor_rows() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let mut seq = 0;
        let mut append = |body: Value| {
            seq += 1;
            let mut object = body.as_object().unwrap().clone();
            object.insert("sessionId".into(), json!("retracted"));
            object.insert("seq".into(), json!(seq));
            object.insert("at".into(), json!("now"));
            assert!(store
                .append_event(&serde_json::from_value(Value::Object(object)).unwrap())
                .unwrap());
        };
        for index in 0..60 {
            append(json!({
                "type":"message.started",
                "messageId":format!("root-{index}"),
                "role":"assistant"
            }));
            append(json!({
                "type":"text.delta",
                "messageId":format!("root-{index}"),
                "text":format!("root {index}")
            }));
            append(json!({"type":"message.completed","messageId":format!("root-{index}")}));
        }
        for index in 40..60 {
            append(json!({"type":"message.retracted","messageId":format!("root-{index}")}));
        }

        let newest = store.transcript_items("retracted", None, 40).unwrap();
        let primary = newest
            .items
            .iter()
            .filter(|item| item_counts_toward_page(item))
            .collect::<Vec<_>>();
        assert_eq!(primary.len(), 40);
        assert_eq!(primary.first().unwrap()["text"], "root 0");
        assert_eq!(primary.last().unwrap()["text"], "root 39");
        assert!(!newest.has_older);
    }

    #[test]
    fn helper_history_pages_on_its_own_cursor() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let mut seq = 0;
        let mut append = |body: Value| {
            seq += 1;
            let mut object = body.as_object().unwrap().clone();
            object.insert("sessionId".into(), json!("helper-pages"));
            object.insert("seq".into(), json!(seq));
            object.insert("at".into(), json!("now"));
            assert!(store
                .append_event(&serde_json::from_value(Value::Object(object)).unwrap())
                .unwrap());
        };
        for index in 0..45 {
            append(
                json!({"type":"message.started","messageId":format!("root-{index}"),"role":"assistant"}),
            );
            append(
                json!({"type":"text.delta","messageId":format!("root-{index}"),"text":format!("root {index}")}),
            );
            append(json!({"type":"message.completed","messageId":format!("root-{index}")}));
        }
        for index in 0..85 {
            append(
                json!({"type":"message.started","messageId":format!("child-{index}"),"role":"assistant","parentToolCallId":"spawn"}),
            );
            append(
                json!({"type":"text.delta","messageId":format!("child-{index}"),"text":format!("child {index}")}),
            );
            append(json!({"type":"message.completed","messageId":format!("child-{index}")}));
        }

        let newest = store
            .agent_transcript_items("helper-pages", "spawn", None, 40)
            .unwrap();
        assert_eq!(newest.items.len(), 40);
        assert_eq!(newest.items.first().unwrap()["text"], "child 45");
        assert_eq!(newest.items.last().unwrap()["text"], "child 84");
        assert!(newest.has_older);

        let middle = store
            .agent_transcript_items("helper-pages", "spawn", newest.cursor, 40)
            .unwrap();
        assert_eq!(middle.items.len(), 40);
        assert_eq!(middle.items.first().unwrap()["text"], "child 5");
        assert_eq!(middle.items.last().unwrap()["text"], "child 44");
        assert!(middle.has_older);

        let oldest = store
            .agent_transcript_items("helper-pages", "spawn", middle.cursor, 40)
            .unwrap();
        assert_eq!(oldest.items.len(), 5);
        assert_eq!(oldest.items.first().unwrap()["text"], "child 0");
        assert_eq!(oldest.items.last().unwrap()["text"], "child 4");
        assert!(!oldest.has_older);
    }

    #[test]
    fn cold_helper_tail_keeps_an_items_complete_early_events() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let mut seq = 0;
        let mut append = |body: Value| {
            seq += 1;
            let mut object = body.as_object().unwrap().clone();
            object.insert("sessionId".into(), json!("complete-helper"));
            object.insert("seq".into(), json!(seq));
            object.insert("at".into(), json!("now"));
            assert!(store
                .append_event(&serde_json::from_value(Value::Object(object)).unwrap())
                .unwrap());
        };
        append(json!({
            "type":"thinking.delta","messageId":"long-thought","text":"early ",
            "parentToolCallId":"spawn"
        }));
        for index in 0..45 {
            append(
                json!({"type":"message.started","messageId":format!("root-{index}"),"role":"assistant"}),
            );
            append(
                json!({"type":"text.delta","messageId":format!("root-{index}"),"text":format!("root {index}")}),
            );
            append(json!({"type":"message.completed","messageId":format!("root-{index}")}));
        }
        append(json!({
            "type":"thinking.delta","messageId":"long-thought","text":"late",
            "parentToolCallId":"spawn"
        }));
        append(json!({"type":"message.completed","messageId":"long-thought"}));

        let newest = store.transcript_items("complete-helper", None, 40).unwrap();
        let thought = newest
            .items
            .iter()
            .find(|item| item["kind"] == "thinking" && item["id"] == "long-thought")
            .unwrap();
        assert_eq!(thought["text"], "early late");
        assert_eq!(thought["done"], true);
    }

    #[test]
    fn workbench_core_first_paint_never_catches_up_a_stale_projection() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for seq in 1..=60 {
            let event: Event = serde_json::from_value(json!({
                "type":"notice","sessionId":"stale","seq":seq,"at":"now",
                "text":format!("row {seq}")
            }))
            .unwrap();
            assert!(store.append_event(&event).unwrap());
        }
        store
            .connection()
            .execute(
                "INSERT INTO transcript_projection(session_id,projected_seq,reset_seq) VALUES('stale',1,0)",
                [],
            )
            .unwrap();
        for value in [
            json!({"type":"agent.started","sessionId":"stale","seq":61,"at":"2026-08-31T00:00:00Z","agentId":"a","toolCallId":"t","kind":"helper","what":"Inspect","agentType":null,"model":null}),
            json!({"type":"agent.progress","sessionId":"stale","seq":62,"at":"now","agentId":"a","seconds":1,"tokens":2,"calls":3}),
            json!({"type":"agent.progress","sessionId":"stale","seq":63,"at":"now","agentId":"a","seconds":4,"tokens":5,"calls":6}),
        ] {
            assert!(store
                .append_event(&serde_json::from_value(value).unwrap())
                .unwrap());
        }

        let page = store.transcript_items("stale", None, 40).unwrap();
        assert_eq!(page.items.len(), 40);
        assert_eq!(page.items[0]["text"], "row 21");
        assert!(page.cursor.is_some_and(|cursor| cursor < 0));
        let agents = store.projected_agents("stale").unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["seconds"], 4);
        assert_eq!(
            store
                .connection()
                .query_row(
                    "SELECT projected_seq FROM transcript_projection WHERE session_id='stale'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
            "opening a chat caught up its stale full-history cache"
        );
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn text(connection: &Connection, sql: &str) -> String {
        connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn snapshot(connection: &Connection) -> Vec<(String, i64, String)> {
        [
            ("session", "SELECT title FROM session WHERE id = 'old-chat'"),
            (
                "event",
                "SELECT json FROM event WHERE session_id = 'old-chat'",
            ),
            (
                "message",
                "SELECT text FROM message WHERE session_id = 'old-chat'",
            ),
            (
                "bead_link",
                "SELECT bead_id FROM bead_link WHERE session_id = 'old-chat'",
            ),
            (
                "transcript_item",
                "SELECT json FROM transcript_item WHERE session_id = 'old-chat'",
            ),
            (
                "transcript_projection",
                "SELECT projected_seq FROM transcript_projection WHERE session_id = 'old-chat'",
            ),
            (
                "transcript_agent",
                "SELECT json FROM transcript_agent WHERE session_id = 'old-chat'",
            ),
        ]
        .into_iter()
        .map(|(table, sql)| {
            let value = if table == "transcript_projection" {
                connection
                    .query_row(sql, [], |row| row.get::<_, i64>(0))
                    .unwrap()
                    .to_string()
            } else {
                text(connection, sql)
            };
            (table.to_string(), count(connection, table), value)
        })
        .collect()
    }

    #[test]
    fn workbench_database_contract_preserves_a_copied_old_database_twice() {
        let source = tempfile::tempdir().unwrap();
        let source_path = source.path().join("old-workbench.db");
        let fixture = Connection::open(&source_path).unwrap();
        fixture
            .execute_batch(include_str!("../../tests/fixtures/workbench-legacy.sql"))
            .unwrap();
        let before = snapshot(&fixture);
        drop(fixture);

        let destination = tempfile::tempdir().unwrap();
        let copied = destination.path().join("workbench.db");
        std::fs::copy(&source_path, &copied).unwrap();

        {
            let store = Store::open(&copied).unwrap();
            assert_eq!(snapshot(store.connection()), before);
            let session_columns = columns_for_test(store.connection(), "session");
            assert!(session_columns.contains(&"collaboration_mode".to_string()));
            let event_columns = columns_for_test(store.connection(), "event");
            for expected in ["provider", "provider_thread_id", "provider_event_id"] {
                assert!(event_columns.contains(&expected.to_string()));
            }
        }
        {
            let reopened = Store::open(&copied).unwrap();
            assert_eq!(snapshot(reopened.connection()), before);
            assert_eq!(
                reopened
                    .connection()
                    .query_row("SELECT version FROM schema_version", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                LEGACY_MIGRATIONS.len() as i64
            );
        }
    }

    #[test]
    fn workbench_database_contract_builds_the_whole_schema_from_empty() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for table in [
            "session",
            "event",
            "bead_link",
            "message",
            "turn",
            "summary_run",
            "transcript_item",
            "transcript_projection",
            "transcript_agent",
        ] {
            let found: i64 = store
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "missing {table}");
        }
    }

    /**
     * Four rows for one terminal chat, collapsed onto the one that read most
     * of it — and made impossible afterwards (bw-t26l.20).
     *
     * The duplicates are written the way the race wrote them, with the index
     * out of the way, because that is the state every install that ran the old
     * code is in. What is asserted is what the reader loses and keeps: one row
     * in the sidebar, the fullest transcript of the four, and their own card
     * link and billed turn carried over from a row that is gone.
     */
    #[test]
    fn workbench_store_keeps_one_row_per_chat_another_program_holds() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workbench.db");
        let store = Store::open(&path).unwrap();
        store.connection().execute_batch(
            r#"DROP INDEX session_by_external;
               INSERT INTO session (id,brand,external_id,project_id,project_path,cwd,
                                    permission_mode,title,state,origin,created_at,last_active_at)
                 VALUES ('thin','claude','term-1','p','/p','/p','default','App performance issues',
                         'dormant','terminal','2026-09-03T11:03:05.801Z','2026-09-03T11:03:05.801Z'),
                        ('empty','claude','term-1','p','/p','/p','default','App performance issues',
                         'dormant','terminal','2026-09-03T11:03:05.801Z','2026-09-03T11:03:05.801Z'),
                        ('full','claude','term-1','p','/p','/p','default','App performance issues',
                         'dormant','terminal','2026-09-03T11:03:05.801Z','2026-09-03T11:03:05.801Z'),
                        ('alone','codex','term-2','p','/p','/p','on-request','Something else',
                         'dormant','terminal','2026-09-03T11:03:05.801Z','2026-09-03T11:03:05.801Z');
               INSERT INTO event (session_id,seq,at,type,json)
                 VALUES ('thin',1,'2026-09-03T11:03:06.000Z','message.started','{}'),
                        ('full',1,'2026-09-03T11:03:06.000Z','message.started','{}'),
                        ('full',2,'2026-09-03T11:03:07.000Z','message.started','{}'),
                        ('alone',1,'2026-09-03T11:03:06.000Z','message.started','{}');
               INSERT INTO bead_link (session_id,bead_id,via,first_seen_at)
                 VALUES ('thin','bw-1','said','2026-09-03T11:03:06.000Z');
               INSERT INTO turn (session_id,project_id,brand,day,at,usd,input,output,total)
                 VALUES ('empty','p','claude','2026-09-03','2026-09-03T11:03:06.000Z',0.5,1,2,3);"#,
        )
        .unwrap();
        drop(store);

        let store = Store::open(&path).unwrap();
        let left: Vec<String> = store
            .list_sessions(Some("p"))
            .unwrap()
            .into_iter()
            .map(|session| session.id)
            .collect();
        assert_eq!(left, vec!["full".to_string(), "alone".to_string()]);
        assert_eq!(store.beads_for_session("full").unwrap(), vec!["bw-1"]);
        assert_eq!(store.spend().unwrap().len(), 1);
        assert_eq!(store.event_count("full").unwrap(), 2);
        assert_eq!(store.event_count("alone").unwrap(), 1);

        // And the pair cannot be written twice again.
        assert!(store
            .create_session(&session("again", "claude", Some("term-1"), "2026-09-04T00:00:00.000Z"))
            .is_err());
    }

    /// A turn is counted when a completion answers a started assistant
    /// message, and counting them reads the started messages once.
    ///
    /// The count used to be asked per completion, which re-read the chat's
    /// whole message history each time; on the owner's heaviest chat that was
    /// fifteen seconds with the single database thread held shut (bw-oion.1).
    #[test]
    fn workbench_core_turns_are_counted_in_one_pass_over_the_started_messages() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        store
            .create_session(&session("chat", "claude", None, "2026-08-20T00:00:00Z"))
            .unwrap();
        let message = |seq: i64, kind: &str, id: &str, role: &str| -> Event {
            serde_json::from_value(json!({
                "type": kind, "sessionId": "chat", "seq": seq,
                "at": "2026-08-20T00:00:00Z", "messageId": id, "role": role
            }))
            .unwrap()
        };
        for event in [
            // Two answered turns, each started by the assistant.
            message(1, "message.started", "m1", "assistant"),
            message(2, "message.completed", "m1", "assistant"),
            message(3, "message.started", "m2", "assistant"),
            message(4, "message.completed", "m2", "assistant"),
            // What the person said is not a turn of the agent's.
            message(5, "message.started", "m3", "user"),
            message(6, "message.completed", "m3", "user"),
            // A completion whose start never arrived is not counted either.
            message(7, "message.completed", "m4", "assistant"),
        ] {
            assert!(store.append_event(&event).unwrap());
        }

        assert_eq!(store.token_stats("chat").unwrap().turns, 2);

        // And it is found through the type index rather than by rereading the
        // chat once per completion.
        let plan: Vec<String> = store
            .connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM event c WHERE c.session_id=?1 \
                 AND c.type='message.completed' AND json_extract(c.json,'$.messageId') IN ( \
                   SELECT json_extract(json,'$.messageId') FROM event WHERE session_id=?1 \
                     AND type='message.started' AND json_extract(json,'$.role')='assistant')",
            )
            .unwrap()
            .query_map(["chat"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            plan.iter().all(|step| !step.contains("CORRELATED")),
            "the started messages are read once, not once per completion: {plan:?}"
        );
        assert!(
            plan.iter().any(|step| step.contains("event_by_type")),
            "both halves are found through the type index: {plan:?}"
        );
    }

    /// The chat list's activity column is read through the type index, from
    /// each chat's newest state row — never by a walk of every event (bw-uxoe).
    #[test]
    fn workbench_core_session_activities_read_only_the_latest_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for id in ["busy", "resting", "silent"] {
            store
                .create_session(&session(id, "claude", None, "2026-08-20T00:00:00Z"))
                .unwrap();
        }
        let state = |session_id: &str, seq: i64, state: &str, label: &str, at: &str| -> Event {
            serde_json::from_value(json!({
                "type":"session.state", "sessionId":session_id, "seq":seq, "at":at,
                "state":state, "label":label
            }))
            .unwrap()
        };
        for event in [
            state("busy", 1, "thinking", "Thinking", "2026-08-20T00:00:01Z"),
            state("busy", 2, "streaming", "Working", "2026-08-20T00:00:02Z"),
            state("busy", 3, "streaming", "Working", "2026-08-20T00:00:03Z"),
            state("resting", 1, "streaming", "Working", "2026-08-20T00:00:01Z"),
            state("resting", 2, "dormant", "Dormant", "2026-08-20T00:00:02Z"),
        ] {
            assert!(store.append_event(&event).unwrap());
        }

        let activities = store.session_activities().unwrap();
        assert_eq!(activities.len(), 2, "a chat with no state row has no activity");
        assert_eq!(activities["busy"].label, "Working");
        assert_eq!(
            activities["busy"].busy_since.as_deref(),
            Some("2026-08-20T00:00:02Z"),
            "since the first row of the current run, not the newest"
        );
        assert_eq!(activities["resting"].label, "");
        assert_eq!(activities["resting"].busy_since, None);
        assert_eq!(activities["busy"], store.session_activity("busy").unwrap());

        let index: i64 = store
            .connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='event_by_type'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, 1, "the type index is part of every opened database");
        let plan: Vec<String> = store
            .connection
            .prepare("EXPLAIN QUERY PLAN SELECT session_id, MAX(seq) FROM event WHERE type='session.state' GROUP BY session_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter().any(|step| step.contains("event_by_type")),
            "the latest state is found through the type index, not a scan: {plan:?}"
        );
    }

    fn columns_for_test(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let found = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        found
    }
}
