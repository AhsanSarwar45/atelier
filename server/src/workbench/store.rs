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

/// Version of the provider-history normalization recipe persisted on a chat.
/// Raise only when replaying the same provider record can add or correct
/// canonical events; this matches the last Node implementation's generation.
pub const IMPORT_RECIPE: i64 = 10;

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub message_id: String,
    pub role: String,
    pub text: String,
    pub at: String,
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

    /// Restore-list rows, preserving the former default that an untitled chat
    /// with no message is not an offer to resume. `everything` deliberately
    /// exposes those rows for diagnosis.
    pub fn list_restore_sessions(
        &self,
        project_id: Option<&str>,
        everything: bool,
    ) -> rusqlite::Result<Vec<Session>> {
        if everything {
            return self.list_sessions(project_id);
        }
        let visible = r#"(title IS NOT NULL OR EXISTS (
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
        Ok(changed == 1)
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
            "SELECT json FROM event WHERE session_id=?1 AND type IN ('agent.started','agent.progress','agent.finished') ORDER BY seq",
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
    pub fn session_activities(&self) -> rusqlite::Result<HashMap<String, SessionActivity>> {
        let mut statement=self.connection.prepare("WITH states AS (SELECT session_id,seq,json_extract(json,'$.state') state,COALESCE(json_extract(json,'$.label'),'') label,json_extract(json,'$.at') at FROM event WHERE type='session.state'), latest AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY session_id ORDER BY seq DESC) rank FROM states) SELECT l.session_id,l.state,l.label,CASE WHEN l.state IN ('starting','thinking','streaming','running_tool','waiting_permission') THEN (SELECT s.at FROM states s WHERE s.session_id=l.session_id AND s.seq>COALESCE((SELECT MAX(x.seq) FROM states x WHERE x.session_id=l.session_id AND x.seq<l.seq AND (x.state!=l.state OR x.label!=l.label)),0) ORDER BY s.seq LIMIT 1) ELSE NULL END FROM latest l WHERE l.rank=1")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SessionActivity {
                    label: if row.get::<_, String>(1)? == "dormant" {
                        String::new()
                    } else {
                        row.get(2)?
                    },
                    busy_since: row.get(3)?,
                },
            ))
        })?;
        rows.collect()
    }

    pub fn token_stats(&self, session_id: &str) -> rusqlite::Result<TokenStats> {
        let number = |sql: &str| {
            self.connection
                .query_row(sql, [session_id], |row| row.get::<_, i64>(0))
        };
        let turns = number("SELECT COUNT(*) FROM event c WHERE session_id=?1 AND type='message.completed' AND EXISTS(SELECT 1 FROM event s WHERE s.session_id=c.session_id AND s.type='message.started' AND json_extract(s.json,'$.messageId')=json_extract(c.json,'$.messageId') AND json_extract(s.json,'$.role')='assistant')")?;
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
                "SELECT followed_to FROM session WHERE id=?1",
                [session_id],
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
            "UPDATE session SET imported_at=COALESCE(imported_at,?1),imported_recipe=?2 WHERE id=?3",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), IMPORT_RECIPE, session_id],
        )
    }
    pub fn remember_followed(&self, session_id: &str, at: i64) -> rusqlite::Result<usize> {
        self.connection.execute("UPDATE session SET followed_to=?1,followed_drawn=0,imported_at=COALESCE(imported_at,?2),imported_recipe=?3 WHERE id=?4",rusqlite::params![at,chrono::Utc::now().to_rfc3339(),IMPORT_RECIPE,session_id])
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
        let mut statement = self.connection.prepare(
            r#"SELECT event.json FROM event
                 JOIN session ON session.id = event.session_id
                WHERE event.type = 'session.menu'
                  AND session.brand = (SELECT brand FROM session WHERE id = ?1)
                ORDER BY event.rowid DESC LIMIT 50"#,
        )?;
        let rows = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
        let mut menu = serde_json::Map::new();
        for row in rows {
            let value: Value = serde_json::from_str(&row?).map_err(json_error)?;
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
            r#"SELECT session_id, message_id, role, text, at FROM message
               WHERE text LIKE ?1 ESCAPE '\' ORDER BY at DESC LIMIT ?2"#,
        )?;
        let found = statement
            .query_map(params![format!("%{escaped}%"), limit as i64], |row| {
                Ok(SearchHit {
                    session_id: row.get(0)?,
                    message_id: row.get(1)?,
                    role: row.get(2)?,
                    text: row.get(3)?,
                    at: row.get(4)?,
                })
            })?
            .collect();
        found
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
                Some("tool.started") => input = event["input"].clone(),
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
                return Ok(newest_seq);
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
                return Ok(newest_seq);
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
        if before.is_some_and(|cursor| cursor < 0) || !has_projection {
            return self.event_transcript_items(session_id, before, limit);
        }
        let newest_seq = self.ensure_transcript_projection(session_id)?;
        let ceiling = before.unwrap_or(i64::MAX);
        let mut statement = self.connection.prepare(
            r#"SELECT position, json FROM transcript_item
                 WHERE session_id = ?1 AND visible = 1 AND position < ?2
                 ORDER BY position DESC LIMIT ?3"#,
        )?;
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
        let has_older = match oldest {
            Some(cursor) => self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM transcript_item WHERE session_id = ?1 AND visible = 1 AND position < ?2)",
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
        let has_projection = self
            .connection
            .query_row(
                "SELECT 1 FROM transcript_projection WHERE session_id=?1",
                [session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !has_projection {
            return Ok(fold_all(&self.agent_lifecycle_events(session_id)?)
                .agents()
                .to_vec());
        }
        self.ensure_transcript_projection(session_id)?;
        self.projected_agents_without_ensuring(session_id)
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
        let mut scan_before = ceiling;
        let mut descending = Vec::new();
        let mut anchors = HashMap::<String, i64>::new();
        let wanted = limit.saturating_add(8);

        loop {
            let mut statement = self.connection.prepare(
                "SELECT seq,json FROM event WHERE session_id=?1 AND seq<?2 AND seq>?3 ORDER BY seq DESC LIMIT 512",
            )?;
            let chunk: Vec<(i64, String)> = statement
                .query_map(params![session_id, scan_before, reset_seq], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            if chunk.is_empty() {
                break;
            }
            scan_before = chunk.last().map(|(seq, _)| *seq).unwrap_or(scan_before);
            for (seq, json) in chunk {
                let mut event: Event = serde_json::from_str(&json).map_err(json_error)?;
                event.fields.insert("seq".into(), json!(seq));
                super::wire::bound_event(&mut event);
                if let Some(key) = event_item_anchor(&event) {
                    // We scan newest-to-oldest, so replacing leaves the
                    // earliest creation event for an item such as thinking.
                    anchors.insert(key, seq);
                }
                descending.push(event);
            }
            if anchors.len() >= wanted {
                let mut ordered = descending.clone();
                ordered.reverse();
                if fold_all(&ordered)
                    .items()
                    .iter()
                    .filter(|item| item_visible(item))
                    .count()
                    >= limit
                {
                    break;
                }
            }
        }

        descending.reverse();
        let projection = fold_all(&descending);
        let visible: Vec<Value> = projection
            .items()
            .iter()
            .filter(|item| item_visible(item))
            .cloned()
            .collect();
        let start = visible.len().saturating_sub(limit);
        let items = visible[start..].to_vec();
        let oldest_anchor = items
            .iter()
            .filter_map(item_key)
            .filter_map(|key| anchors.get(&key).copied())
            .min();
        let has_older = match oldest_anchor {
            Some(cursor) if cursor > reset_seq => self.connection.query_row(
                r#"SELECT EXISTS(SELECT 1 FROM event
                    WHERE session_id=?1 AND seq>?2 AND seq<?3 AND type IN
                    ('message.started','thinking.delta','tool.started','note',
                     'ask.permission','question.requested','plan.proposed',
                     'provider.message','notice'))"#,
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
            "agentDefinitions":[{"name":"private-agent"}]
        }))
        .unwrap();
        assert!(store.append_event(&menu).unwrap());

        let inherited = store.steering_menu("migrated").unwrap();
        assert_eq!(inherited["models"][0]["value"], "gpt-5");
        assert_eq!(inherited["permissionModes"][0], "on-request");
        assert!(inherited.get("commands").is_none());
        assert!(inherited.get("skills").is_none());
        assert!(inherited.get("agentDefinitions").is_none());
        assert_eq!(store.steering_menu("other").unwrap(), json!({}));
    }

    #[test]
    fn restore_sessions_hide_only_unused_untitled_chats() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        for id in ["empty", "spoken", "titled"] {
            let mut row = session(id, "claude", None, "2026-08-20T00:00:00Z");
            row.title = (id == "titled").then(|| "Kept title".into());
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
        assert_eq!(newest.items.len(), 3);
        assert!(newest.has_older);
        assert_eq!(
            newest
                .items
                .iter()
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
