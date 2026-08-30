//! Backward-compatible storage for chat sessions and their event log.
//!
//! This deliberately opens the same `workbench.db` schema as the existing
//! helper. Moving the writer into Axum must not make an existing conversation
//! disappear or require an export/import step.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;
use std::time::Duration;

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

    #[cfg(test)]
    fn connection(&self) -> &Connection {
        &self.connection
    }
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
