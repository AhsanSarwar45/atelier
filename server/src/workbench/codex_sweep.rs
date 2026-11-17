//! What Codex keeps of a thread after the thread is gone.
//!
//! Codex keeps every thread in three places inside its home: a row in
//! `state_5.sqlite` (`threads`), its items in `thread_history_1.sqlite`
//! (`thread_items`, `thread_turns`, `thread_history_projection_state`,
//! `thread_realtime_items`) and its files on disk (the rollout under
//! `sessions/YYYY/MM/DD/` and the pictures under `generated_images/<id>/`).
//! Codex never removes any of it by itself, and the adapter's delete only
//! archives the thread.
//!
//! `forget_thread` removes all three for one chat a person deleted. `sweep`
//! removes them for every thread an agent began (`codex exec`, guardian
//! reviews, spawned subagents) once it has been idle long enough; those are
//! never chats of their own and nothing else ever clears them. Rows go first,
//! a short transaction per batch, and the history file is then handed back to
//! the disk a step at a time (`PRAGMA incremental_vacuum`), never by a full
//! `VACUUM`, which needs as much free space again as the file holds.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{params_from_iter, Connection, OptionalExtension};

use super::registry::WorkbenchRegistry;

const STATE: &str = "state_5.sqlite";
const HISTORY: &str = "thread_history_1.sqlite";

/// Threads removed per transaction, so Codex never waits long on a lock.
const BATCH: usize = 20;

/// Pages handed back per step: 16 MB at Codex's page size.
const VACUUM_STEP: i64 = 4096;

/// How long a write waits for Codex's own lock before giving up.
const BUSY: Duration = Duration::from_secs(10);

/// What a sweep removed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// Threads removed.
    pub threads: usize,
    /// Bytes the Codex home is smaller by.
    pub bytes: u64,
}

/// The Codex home a chat on this account uses: the one the server booted with
/// for the system account, the profile's own otherwise.
pub fn home_for(registry: &WorkbenchRegistry, profile: Option<&str>) -> PathBuf {
    match profile.filter(|id| *id != super::profiles::SYSTEM) {
        None => registry.codex_home_directory().to_path_buf(),
        Some(id) => registry.profile_directory("codex", id),
    }
}

/// Every Codex home the app's accounts use, the booted one always among them.
pub fn homes(registry: &WorkbenchRegistry) -> Vec<PathBuf> {
    let mut homes = vec![registry.codex_home_directory().to_path_buf()];
    homes.extend(registry.every_account("codex").into_iter().map(|(_, home)| home));
    homes.sort();
    homes.dedup();
    homes
}

/// Sweep every Codex home the app uses, each on a blocking thread, and answer
/// the bytes they are smaller by together. A home that fails is logged and
/// left for the next run.
pub async fn sweep_every_home(registry: &WorkbenchRegistry, older_than: Duration) -> u64 {
    let mut bytes = 0;
    for home in homes(registry) {
        let swept = {
            let home = home.clone();
            tokio::task::spawn_blocking(move || sweep(&home, Path::new("/proc"), older_than, Utc::now()))
                .await
                .map_err(|error| error.to_string())
                .and_then(|swept| swept)
        };
        match swept {
            Ok(swept) => {
                bytes += swept.bytes;
                tracing::info!(home = %home.display(), threads = swept.threads, bytes = swept.bytes, "Codex threads swept");
            }
            Err(error) => tracing::info!(home = %home.display(), %error, "Codex threads not swept"),
        }
    }
    bytes
}

/// Remove one deleted chat's thread from a Codex home: its rows in both
/// databases, its rollout file(s) and its generated pictures.
pub fn forget_thread(codex_home: &Path, thread_id: &str) -> Result<(), String> {
    forget_thread_in(codex_home, Path::new("/proc"), thread_id)
}

/// `forget_thread` with the process list read from `proc_root`. A rollout a
/// process still holds open is kept, and kept too when the list cannot be
/// read; the rows and pictures go either way, since the chat is deleted.
fn forget_thread_in(codex_home: &Path, proc_root: &Path, thread_id: &str) -> Result<(), String> {
    if !is_thread_id(thread_id) {
        return Err(format!("{thread_id} is not a Codex thread id"));
    }
    let id = thread_id.to_lowercase();
    let mut rollouts = rollout_files(codex_home);
    let mut files = rollouts.remove(&id).unwrap_or_default();
    if let Some(state) = open(codex_home, STATE)? {
        let row: Option<String> = state
            .query_row("SELECT rollout_path FROM threads WHERE id = ?1", [&id], |row| row.get(0))
            .optional()
            .map_err(text)?;
        files.extend(row.into_iter().map(PathBuf::from));
    }
    if open_threads(proc_root).is_none_or(|open| open.contains(&id)) {
        files.clear();
    }
    remove_rows(codex_home, std::slice::from_ref(&id))?;
    remove_files(codex_home, &id, &files);
    shrink(codex_home)?;
    Ok(())
}

/// Remove every thread an agent began (`exec` and subagent sources) that has
/// been idle longer than `older_than`, whether or not any chat knows it and
/// whether or not its rollout is still there, then shrink the history file.
/// App chats are never taken, nor a thread whose rollout a process under
/// `proc_root` holds open; that one waits for a later run.
pub fn sweep(
    codex_home: &Path,
    proc_root: &Path,
    older_than: Duration,
    now: DateTime<Utc>,
) -> Result<Swept, String> {
    // Codex writes in WAL with its own lock waits, so deleting other rows
    // beside a running Codex is safe; only a thread it has loaded is not.
    let Some(open_now) = open_threads(proc_root) else {
        return Err(format!("cannot read {} to see which threads are open", proc_root.display()));
    };
    let Some(state) = open(codex_home, STATE)? else {
        return Ok(Swept::default());
    };
    let before = database_bytes(codex_home);
    let older_than = chrono::Duration::from_std(older_than).map_err(|e| e.to_string())?;
    let cutoff = (now - older_than).timestamp_millis();
    // The latest of the three times Codex keeps, so a thread is never judged
    // idler than it is by a column one version does not fill in.
    let mut statement = state
        .prepare(
            "SELECT id, rollout_path FROM threads
             WHERE (source = 'exec' OR source LIKE '{\"subagent\"%')
               AND MAX(COALESCE(updated_at_ms, 0), COALESCE(recency_at_ms, 0), updated_at * 1000) < ?1",
        )
        .map_err(text)?;
    let old: Vec<(String, String)> = statement
        .query_map([cutoff], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(text)?
        .collect::<rusqlite::Result<_>>()
        .map_err(text)?;
    drop(statement);
    drop(state);
    let old: Vec<_> = old
        .into_iter()
        .filter(|(id, _)| is_thread_id(id) && !open_now.contains(&id.to_lowercase()))
        .collect();
    if old.is_empty() {
        return Ok(Swept::default());
    }
    let mut rollouts = rollout_files(codex_home);
    let mut files_bytes = 0;
    for batch in old.chunks(BATCH) {
        let ids: Vec<String> = batch.iter().map(|(id, _)| id.to_lowercase()).collect();
        remove_rows(codex_home, &ids)?;
        for (id, (_, rollout)) in ids.iter().zip(batch) {
            let mut files = rollouts.remove(id).unwrap_or_default();
            files.push(PathBuf::from(rollout));
            files_bytes += remove_files(codex_home, id, &files);
        }
    }
    shrink(codex_home)?;
    Ok(Swept {
        threads: old.len(),
        bytes: before.saturating_sub(database_bytes(codex_home)) + files_bytes,
    })
}

/// The threads whose rollout some process under `proc_root` holds open, by
/// the id in the file's name: a thread a live Codex has loaded keeps its
/// rollout open, and is left for a later run. `None` when the process list
/// cannot be read, so a machine without `/proc` is never swept blind.
fn open_threads(proc_root: &Path) -> Option<HashSet<String>> {
    let entries = std::fs::read_dir(proc_root).ok()?;
    let mut open = HashSet::new();
    for entry in entries.flatten() {
        let numeric = entry.file_name().to_str().is_some_and(|name| name.bytes().all(|byte| byte.is_ascii_digit()));
        if !numeric {
            continue;
        }
        for fd in std::fs::read_dir(entry.path().join("fd")).into_iter().flatten().flatten() {
            if let Some(id) = std::fs::read_link(fd.path()).ok().as_deref().and_then(rollout_id) {
                open.insert(id);
            }
        }
    }
    Some(open)
}

/// One of Codex's databases with a wait on its lock, or `None` when this
/// home has never had it.
fn open(codex_home: &Path, name: &str) -> Result<Option<Connection>, String> {
    let path = codex_home.join(name);
    if !path.exists() {
        return Ok(None);
    }
    let connection = Connection::open(path).map_err(text)?;
    connection.busy_timeout(BUSY).map_err(text)?;
    Ok(Some(connection))
}

/// Delete these threads' rows from both databases, one transaction each.
/// Child rows are deleted by name: Codex's cascades only run with foreign
/// keys on, which a connection has to ask for.
fn remove_rows(codex_home: &Path, ids: &[String]) -> Result<(), String> {
    let marks = vec!["?"; ids.len()].join(",");
    if let Some(mut history) = open(codex_home, HISTORY)? {
        let tx = history.transaction().map_err(text)?;
        // The projection's trigger takes the realtime items too; they are
        // deleted by name as well for a file made before the trigger was.
        for table in ["thread_items", "thread_turns", "thread_history_projection_state", "thread_realtime_items"] {
            if has_table(&tx, table)? {
                tx.execute(&format!("DELETE FROM {table} WHERE thread_id IN ({marks})"), params_from_iter(ids))
                    .map_err(text)?;
            }
        }
        tx.commit().map_err(text)?;
    }
    if let Some(mut state) = open(codex_home, STATE)? {
        let tx = state.transaction().map_err(text)?;
        for (table, column) in [
            ("thread_dynamic_tools", "thread_id"),
            ("thread_artifacts", "thread_id"),
            ("thread_spawn_edges", "child_thread_id"),
            ("threads", "id"),
        ] {
            if has_table(&tx, table)? {
                tx.execute(&format!("DELETE FROM {table} WHERE {column} IN ({marks})"), params_from_iter(ids))
                    .map_err(text)?;
            }
        }
        tx.commit().map_err(text)?;
    }
    Ok(())
}

fn has_table(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
        .map_err(text)
}

/// Delete a thread's rollouts and pictures, and answer the bytes they took.
/// A rollout is only deleted inside this home and only when its name carries
/// the thread's id, whatever path a row names; one already gone is skipped.
fn remove_files(codex_home: &Path, id: &str, rollouts: &[PathBuf]) -> u64 {
    let mut bytes = 0;
    let mut seen = HashSet::new();
    for rollout in rollouts {
        let named = rollout.file_name().is_some_and(|name| name.to_string_lossy().to_lowercase().contains(id));
        if !named || !rollout.starts_with(codex_home) || !seen.insert(rollout) {
            continue;
        }
        let size = std::fs::metadata(rollout).map(|meta| meta.len()).unwrap_or(0);
        if std::fs::remove_file(rollout).is_ok() {
            bytes += size;
        }
    }
    let pictures = codex_home.join("generated_images").join(id);
    let size = super::disk_usage::size_of(&pictures);
    if std::fs::remove_dir_all(&pictures).is_ok() {
        bytes += size;
    }
    bytes
}

/// Every rollout under `sessions` and `archived_sessions`, by thread id, read
/// once: Codex names each `rollout-<time>-<id>.jsonl`.
fn rollout_files(codex_home: &Path) -> HashMap<String, Vec<PathBuf>> {
    let mut found: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut stack = vec![codex_home.join("sessions"), codex_home.join("archived_sessions")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            if let Some(id) = rollout_id(&path) {
                found.entry(id).or_default().push(path);
            }
        }
    }
    found
}

/// The thread id in a rollout's name, which Codex writes as
/// `rollout-<time>-<id>.jsonl`.
fn rollout_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    is_thread_id(id).then(|| id.to_string())
}

/// Hand both databases' free pages back to the disk a step at a time, then
/// fold and empty the log. Each step is its own short write, so Codex waits
/// no longer than one. A file not made incremental gives nothing back, which
/// is no reason to fail.
fn shrink(codex_home: &Path) -> Result<(), String> {
    for name in [HISTORY, STATE] {
        let Some(db) = open(codex_home, name)? else {
            continue;
        };
        loop {
            let free: i64 = db.query_row("PRAGMA freelist_count", [], |row| row.get(0)).map_err(text)?;
            if free == 0 {
                break;
            }
            // The pragma frees one page per row it steps over, so every row
            // is read; stepping it once frees a single page.
            let mut step = db.prepare(&format!("PRAGMA incremental_vacuum({VACUUM_STEP})")).map_err(text)?;
            let mut pages = step.query([]).map_err(text)?;
            while pages.next().map_err(text)?.is_some() {}
            drop(pages);
            drop(step);
            let left: i64 = db.query_row("PRAGMA freelist_count", [], |row| row.get(0)).map_err(text)?;
            checkpoint(&db)?;
            if left >= free {
                break;
            }
        }
        checkpoint(&db)?;
    }
    Ok(())
}

/// Fold the log into the file and cut it to nothing. A reader that keeps
/// part of it is told to Codex's own later checkpoint, not an error.
fn checkpoint(db: &Connection) -> Result<(), String> {
    db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).map_err(text)
}

/// Both databases with their logs, as the disk counts them.
fn database_bytes(codex_home: &Path) -> u64 {
    [STATE, HISTORY]
        .iter()
        .flat_map(|name| [name.to_string(), format!("{name}-wal"), format!("{name}-shm")])
        .map(|name| std::fs::metadata(codex_home.join(name)).map(|meta| meta.len()).unwrap_or(0))
        .sum()
}

/// A UUID as Codex writes thread ids, which is also what keeps an id from
/// naming any path but its own.
fn is_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn text(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::path::PathBuf;

    const STATE: &str = "state_5.sqlite";
    const HISTORY: &str = "thread_history_1.sqlite";

    // Ids shaped like Codex's own (UUIDv7).
    const EXEC_OLD: &str = "01a10296-033b-7ff1-90fa-f84e4cb55d28";
    const EXEC_GONE: &str = "01a10296-0353-7f53-9b7e-0573515a2948";
    const GUARDIAN_OLD: &str = "01a131d9-df3f-7d22-8635-5afbe9b928ee";
    const SPAWN_OLD: &str = "01a17799-82df-72d2-8fee-d408077e4f38";
    const APP_OLD: &str = "01a17798-fc25-77a0-8e2a-affddbe09c6f";
    const APP_YOUNG: &str = "01a17d89-da9c-7ee3-ad1f-168efad5cb9c";
    const EXEC_YOUNG: &str = "01a10297-a12f-72d3-bf2a-ce25aff9c625";

    /// `state_5.sqlite` as Codex 0.153.4 has it, the tables a thread touches.
    const STATE_SCHEMA: &str = r#"
        CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            rollout_path TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            source TEXT NOT NULL,
            model_provider TEXT NOT NULL,
            cwd TEXT NOT NULL,
            title TEXT NOT NULL,
            sandbox_policy TEXT NOT NULL,
            approval_mode TEXT NOT NULL,
            tokens_used INTEGER NOT NULL DEFAULT 0,
            has_user_event INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            git_sha TEXT,
            git_branch TEXT,
            git_origin_url TEXT,
            cli_version TEXT NOT NULL DEFAULT '',
            first_user_message TEXT NOT NULL DEFAULT '',
            agent_nickname TEXT, agent_role TEXT,
            memory_mode TEXT NOT NULL DEFAULT 'enabled',
            model TEXT, reasoning_effort TEXT, agent_path TEXT,
            created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT,
            preview TEXT NOT NULL DEFAULT '',
            recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
            history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT,
            is_pinned INTEGER NOT NULL DEFAULT 0, thread_section_id TEXT,
            section_position INTEGER, section_entered_at_ms INTEGER, project_id TEXT
        );
        CREATE INDEX idx_threads_source ON threads(source);
        CREATE TABLE thread_dynamic_tools (
            thread_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            input_schema TEXT NOT NULL, defer_loading INTEGER NOT NULL DEFAULT 0, namespace TEXT,
            PRIMARY KEY(thread_id, position),
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE TABLE thread_spawn_edges (
            parent_thread_id TEXT NOT NULL,
            child_thread_id TEXT NOT NULL PRIMARY KEY,
            status TEXT NOT NULL
        );
        CREATE TABLE thread_artifacts (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            artifact_type TEXT NOT NULL,
            identity_key TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (thread_id, artifact_type, identity_key)
        );
    "#;

    /// `thread_history_1.sqlite` as Codex 0.153.4 has it.
    const HISTORY_SCHEMA: &str = r#"
        CREATE TABLE thread_turns (
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL,
            status TEXT NOT NULL,
            error_json TEXT,
            started_at INTEGER,
            completed_at INTEGER,
            duration_ms INTEGER,
            first_user_item_id TEXT,
            final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER,
            rollout_end_byte_offset INTEGER,
            PRIMARY KEY (thread_id, turn_id)
        );
        CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal);
        CREATE TABLE thread_items (
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '',
            updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (thread_id, turn_id, item_id)
        );
        CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
        CREATE TABLE thread_history_projection_state (
            thread_id TEXT PRIMARY KEY,
            next_rollout_byte_offset INTEGER NOT NULL,
            next_rollout_ordinal INTEGER NOT NULL
        );
        CREATE TABLE thread_realtime_items (
            thread_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            rollout_ordinal INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            item_type TEXT NOT NULL,
            item_json TEXT NOT NULL,
            PRIMARY KEY (thread_id, item_id)
        );
        CREATE TRIGGER thread_realtime_items_projection_cleanup
            AFTER DELETE ON thread_history_projection_state
        BEGIN
            DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id;
        END;
    "#;

    struct Thread {
        id: &'static str,
        source: &'static str,
        thread_source: Option<&'static str>,
        days_idle: i64,
        /// Picture-generation items, each about 100 KB of base64.
        pictures: usize,
        rollout: bool,
    }

    fn threads() -> Vec<Thread> {
        let guardian = r#"{"subagent":{"other":"guardian"}}"#;
        let spawn = r#"{"subagent":{"thread_spawn":{"parent_thread_id":"01a17798-fc25-77a0-8e2a-affddbe09c6f","depth":1,"agent_path":"/root/grass_review","agent_nickname":"Lagrange","agent_role":null}}}"#;
        let t = |id, source, thread_source, days_idle, pictures, rollout| Thread {
            id,
            source,
            thread_source,
            days_idle,
            pictures,
            rollout,
        };
        vec![
            t(EXEC_OLD, "exec", Some("user"), 60, 30, true),
            // A `codex exec` thread whose rollout is already gone.
            t(EXEC_GONE, "exec", Some("user"), 90, 30, false),
            t(GUARDIAN_OLD, guardian, Some("guardian_review"), 45, 30, true),
            t(SPAWN_OLD, spawn, Some("subagent"), 45, 30, true),
            t(APP_OLD, "vscode", None, 60, 2, true),
            t(APP_YOUNG, "vscode", None, 1, 2, true),
            t(EXEC_YOUNG, "exec", Some("user"), 2, 2, true),
        ]
    }

    fn picture_json(id: &str, n: usize) -> String {
        // Distinct per row so nothing compresses it away.
        let mut data = String::with_capacity(100_000);
        let seed = format!("{id}{n}");
        while data.len() < 100_000 {
            data.push_str(&seed.replace('-', "A"));
        }
        format!(r#"{{"type":"imageGeneration","id":"ig_{n}","status":"completed","result":"{data}"}}"#)
    }

    /// A Codex home with the threads above, as Codex leaves it.
    fn codex_home(root: &Path, now: DateTime<Utc>) -> PathBuf {
        let home = root.join("codex/azeem");
        std::fs::create_dir_all(&home).unwrap();
        let state = Connection::open(home.join(STATE)).unwrap();
        state.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;").unwrap();
        state.execute_batch(STATE_SCHEMA).unwrap();
        let mut history = Connection::open(home.join(HISTORY)).unwrap();
        // The real file is incremental, page size 4096, in WAL.
        history
            .execute_batch("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;")
            .unwrap();
        history.execute_batch(HISTORY_SCHEMA).unwrap();
        for thread in threads() {
            let at = now - chrono::Duration::days(thread.days_idle);
            let day = at.format("%Y/%m/%d").to_string();
            let rollout = home.join("sessions").join(&day).join(format!(
                "rollout-{}-{}.jsonl",
                at.format("%Y-%m-%dT%H-%M-%S"),
                thread.id
            ));
            if thread.rollout {
                std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
                std::fs::write(&rollout, format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{}\"}}}}\n", thread.id))
                    .unwrap();
            }
            state
                .execute(
                    "INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
                        sandbox_policy, approval_mode, cli_version, created_at_ms, updated_at_ms, thread_source,
                        recency_at, recency_at_ms, history_mode)
                     VALUES (?1, ?2, ?3, ?3, ?4, 'openai', '/tmp/p', 't', '{}', 'never', '0.153.4', ?5, ?5, ?6, ?3, ?5, 'paginated')",
                    params![
                        thread.id,
                        rollout.to_string_lossy(),
                        at.timestamp(),
                        thread.source,
                        at.timestamp_millis(),
                        thread.thread_source
                    ],
                )
                .unwrap();
            state
                .execute(
                    "INSERT INTO thread_dynamic_tools (thread_id, position, name, description, input_schema)
                     VALUES (?1, 0, 'tool', 'd', '{}')",
                    [thread.id],
                )
                .unwrap();
            if thread.id == SPAWN_OLD {
                state
                    .execute(
                        "INSERT INTO thread_spawn_edges VALUES (?1, ?2, 'completed')",
                        [APP_OLD, SPAWN_OLD],
                    )
                    .unwrap();
            }
            let tx = history.transaction().unwrap();
            tx.execute(
                "INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?1, 'turn-1', 0, 'completed')",
                [thread.id],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO thread_history_projection_state VALUES (?1, 100, ?2)",
                params![thread.id, thread.pictures as i64 + 1],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO thread_realtime_items VALUES (?1, 'rt-1', 0, ?2, 'realtime_session_started', '{}')",
                params![thread.id, at.timestamp_millis()],
            )
            .unwrap();
            for n in 0..thread.pictures {
                tx.execute(
                    "INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal)
                     VALUES (?1, 'turn-1', ?2, ?3, ?4, ?5, 'imageGeneration', ?3)",
                    params![thread.id, format!("item-{n}"), n as i64, at.timestamp_millis(), picture_json(thread.id, n)],
                )
                .unwrap();
            }
            tx.commit().unwrap();
            let pictures = home.join("generated_images").join(thread.id);
            std::fs::create_dir_all(&pictures).unwrap();
            std::fs::write(pictures.join(format!("exec-{}.png", thread.id)), [7u8; 4096]).unwrap();
        }
        // Closing the last connection folds the log into the file.
        drop(state);
        drop(history);
        home
    }

    fn rows(home: &Path, file: &str, table: &str, column: &str, id: &str) -> i64 {
        let db = Connection::open(home.join(file)).unwrap();
        db.query_row(&format!("SELECT count(*) FROM {table} WHERE {column} = ?1"), [id], |row| row.get(0))
            .unwrap()
    }

    fn history_rows(home: &Path, id: &str) -> i64 {
        ["thread_items", "thread_turns", "thread_history_projection_state", "thread_realtime_items"]
            .iter()
            .map(|table| rows(home, HISTORY, table, "thread_id", id))
            .sum()
    }

    fn state_rows(home: &Path, id: &str) -> i64 {
        rows(home, STATE, "threads", "id", id) + rows(home, STATE, "thread_dynamic_tools", "thread_id", id)
    }

    fn rollouts(home: &Path, id: &str) -> usize {
        let mut found = 0;
        let mut stack = vec![home.join("sessions")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.to_string_lossy().contains(id) {
                    found += 1;
                }
            }
        }
        found
    }

    fn pictures(home: &Path, id: &str) -> bool {
        home.join("generated_images").join(id).exists()
    }

    /// The history file on disk with its log, as the Storage page counts it.
    fn history_bytes(home: &Path) -> u64 {
        let size = |name: String| std::fs::metadata(home.join(name)).map(|m| m.len()).unwrap_or(0);
        size(HISTORY.to_string()) + size(format!("{HISTORY}-wal"))
    }

    const MONTH: Duration = Duration::from_secs(30 * 86_400);

    #[test]
    fn a_sweep_removes_old_agent_threads_and_keeps_app_chats_and_young_threads() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let home = codex_home(dir.path(), now);
        let no_codex = dir.path().join("proc");
        std::fs::create_dir_all(&no_codex).unwrap();

        let swept = sweep(&home, &no_codex, MONTH, now).unwrap();

        for id in [EXEC_OLD, EXEC_GONE, GUARDIAN_OLD, SPAWN_OLD] {
            assert_eq!(history_rows(&home, id), 0, "SWEPT_THREAD_KEPT: old agent thread {id} still has history rows");
            assert_eq!(state_rows(&home, id), 0, "SWEPT_THREAD_KEPT: old agent thread {id} still has state rows");
            assert_eq!(rollouts(&home, id), 0, "SWEPT_THREAD_KEPT: old agent thread {id} still has a rollout");
            assert!(!pictures(&home, id), "SWEPT_THREAD_KEPT: old agent thread {id} still has generated images");
        }
        assert_eq!(
            rows(&home, STATE, "thread_spawn_edges", "child_thread_id", SPAWN_OLD),
            0,
            "the swept subagent's spawn edge is left behind"
        );
        assert_eq!(swept.threads, 4, "{swept:?}");
        // App chats, whatever their age, are the cleanup rule's to delete
        // through the app; young agent threads may still be wanted.
        for id in [APP_OLD, APP_YOUNG, EXEC_YOUNG] {
            assert!(history_rows(&home, id) > 0, "kept thread {id} lost its history rows");
            assert_eq!(state_rows(&home, id), 2, "kept thread {id} lost its state rows");
            assert_eq!(rollouts(&home, id), 1, "kept thread {id} lost its rollout");
            assert!(pictures(&home, id), "kept thread {id} lost its generated images");
        }
    }

    #[test]
    fn a_sweep_that_removes_most_history_makes_the_history_file_smaller() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let home = codex_home(dir.path(), now);
        let no_codex = dir.path().join("proc");
        std::fs::create_dir_all(&no_codex).unwrap();
        let before = history_bytes(&home);
        assert!(before > 10_000_000, "fixture too small to measure: {before}");

        sweep(&home, &no_codex, MONTH, now).unwrap();

        // Four of seven threads hold ~96% of the items; the file must give
        // that room back, not just mark it free inside.
        let after = history_bytes(&home);
        assert!(
            after < before / 4,
            "HISTORY_NOT_SHRUNK: thread_history_1.sqlite is {after} bytes after the sweep, {before} before"
        );
        assert!(history_rows(&home, APP_YOUNG) > 0, "the young app chat lost its history");
    }

    #[test]
    fn a_sweep_keeps_an_old_agent_thread_whose_rollout_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let home = codex_home(dir.path(), now);
        // A process with EXEC_OLD's rollout open, as /proc shows it.
        let proc_root = dir.path().join("proc");
        let fd = proc_root.join("4242/fd");
        std::fs::create_dir_all(&fd).unwrap();
        let rollout = super::rollout_files(&home).remove(EXEC_OLD).unwrap().remove(0);
        std::os::unix::fs::symlink(&rollout, fd.join("7")).unwrap();

        let swept = sweep(&home, &proc_root, MONTH, now).unwrap();

        assert_eq!(swept.threads, 3, "{swept:?}");
        assert!(history_rows(&home, EXEC_OLD) > 0, "the open thread lost its history rows");
        assert_eq!(state_rows(&home, EXEC_OLD), 2, "the open thread lost its state rows");
        assert_eq!(rollouts(&home, EXEC_OLD), 1, "the open thread lost its rollout");
        assert!(pictures(&home, EXEC_OLD), "the open thread lost its generated images");
        for id in [EXEC_GONE, GUARDIAN_OLD, SPAWN_OLD] {
            assert_eq!(history_rows(&home, id), 0, "old agent thread {id} still has history rows");
            assert_eq!(state_rows(&home, id), 0, "old agent thread {id} still has state rows");
        }

        // Without a readable process list nothing is swept at all.
        assert!(sweep(&home, &dir.path().join("no-proc"), MONTH, now).is_err());
        assert!(history_rows(&home, EXEC_OLD) > 0);
    }

    #[test]
    fn forgetting_a_deleted_chats_thread_removes_its_leftovers_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let home = codex_home(dir.path(), now);

        // A person deleted this young app chat; its age does not matter.
        forget_thread(&home, APP_YOUNG).unwrap();

        assert_eq!(history_rows(&home, APP_YOUNG), 0, "FORGOTTEN_THREAD_KEPT: deleted chat still has history rows");
        assert_eq!(state_rows(&home, APP_YOUNG), 0, "FORGOTTEN_THREAD_KEPT: deleted chat still has state rows");
        assert_eq!(rollouts(&home, APP_YOUNG), 0, "FORGOTTEN_THREAD_KEPT: deleted chat still has a rollout");
        assert!(!pictures(&home, APP_YOUNG), "FORGOTTEN_THREAD_KEPT: deleted chat still has generated images");
        for id in [APP_OLD, EXEC_YOUNG, EXEC_OLD] {
            assert!(history_rows(&home, id) > 0, "thread {id} lost its history rows");
            assert_eq!(state_rows(&home, id), 2, "thread {id} lost its state rows");
            assert_eq!(rollouts(&home, id), 1, "thread {id} lost its rollout");
            assert!(pictures(&home, id), "thread {id} lost its generated images");
        }
    }
}
