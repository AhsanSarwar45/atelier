//! Every chat's words, kept where a search can find them.
//!
//! The chat database only ever held the words of chats this app had replayed,
//! so a search answered for 233 of 1,952 chats: a chat begun in a terminal and
//! never opened here had its words only in the provider's own record, and a
//! `LIKE` over the `message` table could not see them (bw-21a2.1).
//!
//! So the index reads both. A chat whose events are stored is indexed from
//! them, a little at a time as they arrive; a chat that is only a Claude record
//! or a Codex rollout is indexed from that file, again whenever the file
//! changes. What is kept is what a person would search for: the title, what
//! they said, what the agent said, and the commands and paths its tools were
//! given — not tool output, which is most of every record and none of what
//! anyone remembers.
//!
//! It lives in its own file, `search.db`, written by its own thread. The chat
//! database has one writer and every live chat's events queue behind it; an
//! index that wrote there would hold that queue for as long as it took to read
//! 3.6 GB of records, and a search that ran there would hold it for as long as
//! a scan took. Here neither touches it: the chat database is only read, and
//! reading a WAL database never waits on its writer.

use super::store::SearchHit;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The account directories of one brand, `claude` or `codex`, asked again on
/// every pass so an account added while the app runs is read too.
pub type AccountDirs = Arc<dyn Fn(&str) -> Vec<PathBuf> + Send + Sync>;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS doc (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  part TEXT NOT NULL,
  field TEXT NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (session_id, part)
);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  text, content='doc', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS doc_added AFTER INSERT ON doc BEGIN
  INSERT INTO doc_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS doc_removed AFTER DELETE ON doc BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS doc_changed AFTER UPDATE ON doc BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO doc_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS source (
  session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mark TEXT NOT NULL,
  title TEXT
);
"#;

/// The part of a chat its title is kept under. No message or tool call is
/// named this, so one reset of the words never takes the title with it.
const TITLE: &str = "title";

/// A tool call's words are the arguments that name what it did, capped: an
/// agent's brief to a helper can run to pages, and a row that long buries the
/// line that matched.
const TOOL_WORDS: usize = 4_000;

/// The event types that carry words. Everything else in the log — progress,
/// costs, state, deltas of thinking — is skipped by the query, not the loop.
const WORD_EVENTS: &str =
    "'message.started','text.delta','message.retracted','tool.started','transcript.reset'";

#[derive(Clone)]
pub struct SearchIndex {
    inner: Arc<Inner>,
}

struct Inner {
    index_path: PathBuf,
    chats_path: PathBuf,
    accounts: AccountDirs,
    /// One pass at a time: the background loop and a caller who asked for a
    /// pass now would otherwise both read the same new events and both write
    /// them.
    writing: Mutex<()>,
    reader: Mutex<Option<Connection>>,
}

/// What one pass did, for the log and the tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Refreshed {
    pub from_events: usize,
    pub from_records: usize,
    pub forgotten: usize,
}

struct SessionRow {
    id: String,
    brand: String,
    external_id: Option<String>,
    title: Option<String>,
}

struct Known {
    kind: String,
    mark: String,
    title: Option<String>,
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn open_index(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(text)?;
    connection
        .busy_timeout(Duration::from_secs(10))
        .map_err(text)?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(text)?;
    connection.execute_batch(SCHEMA).map_err(text)?;
    Ok(connection)
}

impl SearchIndex {
    /// Open or create the index beside the chat database it reads.
    pub fn open(
        index_path: &Path,
        chats_path: &Path,
        accounts: AccountDirs,
    ) -> Result<Self, String> {
        open_index(index_path)?;
        Ok(Self {
            inner: Arc::new(Inner {
                index_path: index_path.to_path_buf(),
                chats_path: chats_path.to_path_buf(),
                accounts,
                writing: Mutex::new(()),
                reader: Mutex::new(None),
            }),
        })
    }

    /// Keep the index current for as long as the process runs.
    pub fn start(&self, every: Duration) {
        let inner = self.inner.clone();
        let started = std::thread::Builder::new()
            .name("atelier-search-index".to_string())
            .spawn(move || loop {
                let began = std::time::Instant::now();
                match inner.refresh() {
                    Ok(done) if done != Refreshed::default() => tracing::info!(
                        from_events = done.from_events,
                        from_records = done.from_records,
                        forgotten = done.forgotten,
                        elapsed_ms = began.elapsed().as_millis() as u64,
                        "search index refreshed"
                    ),
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "search index pass failed"),
                }
                std::thread::sleep(every);
            });
        if let Err(error) = started {
            tracing::warn!(%error, "search index thread did not start");
        }
    }

    /// One pass now, on the caller's thread.
    pub fn refresh(&self) -> Result<Refreshed, String> {
        self.inner.refresh()
    }

    /// The best matches for the words given, every word required, the last
    /// one as a prefix so a word still being typed already finds something.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
        let Some(matching) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let mut reader = self.inner.reader.lock().unwrap();
        if reader.is_none() {
            *reader = Some(self.inner.open_reader()?);
        }
        let connection = reader.as_ref().unwrap();
        let mut statement = connection
            .prepare_cached(
                r#"SELECT d.session_id, d.part, d.field, d.text, d.at, s.title, s.project_id,
                          snippet(doc_fts, 0, ?3, ?4, '…', 32)
                   FROM doc_fts
                   JOIN doc d ON d.id = doc_fts.rowid
                   LEFT JOIN chats.session s ON s.id = d.session_id
                   WHERE doc_fts MATCH ?1
                   ORDER BY bm25(doc_fts)
                   LIMIT ?2"#,
            )
            .map_err(text)?;
        let rows = statement
            .query_map(params![matching, limit as i64, "\u{2}", "\u{3}"], |row| {
                let field: String = row.get(2)?;
                let snippet: String = row.get(7)?;
                let (sentence, matched) = unmark(&snippet);
                Ok(SearchHit {
                    session_id: row.get(0)?,
                    message_id: row.get(1)?,
                    role: match field.as_str() {
                        "me" => "user",
                        "agent" => "assistant",
                        other => other,
                    }
                    .to_string(),
                    text: row.get(3)?,
                    sentence,
                    matched,
                    at: row.get(4)?,
                    title: row.get(5)?,
                    project_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                })
            })
            .map_err(text)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(text)
    }
}

/// The words as FTS5 reads them: each one a quoted phrase, so punctuation in
/// a path or a flag is never taken for query syntax.
fn fts_query(query: &str) -> Option<String> {
    let still_typing = !query.ends_with(char::is_whitespace);
    let words: Vec<&str> = query
        .split_whitespace()
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .collect();
    let last = words.len().checked_sub(1)?;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(index, word)| {
                let phrase = format!("\"{}\"", word.replace('"', "\"\""));
                if index == last && still_typing {
                    format!("{phrase}*")
                } else {
                    phrase
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// The snippet without its marks, and the first words that were marked.
fn unmark(snippet: &str) -> (String, String) {
    let matched = snippet
        .split_once('\u{2}')
        .and_then(|(_, after)| after.split_once('\u{3}'))
        .map(|(inside, _)| inside.to_string())
        .unwrap_or_default();
    let sentence = snippet.replace(['\u{2}', '\u{3}'], "");
    (sentence.trim().to_string(), matched)
}

impl Inner {
    fn open_reader(&self) -> Result<Connection, String> {
        let connection = Connection::open_with_flags(
            &self.index_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(text)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(text)?;
        connection
            .execute(
                "ATTACH DATABASE ?1 AS chats",
                [self.chats_path.to_string_lossy()],
            )
            .map_err(text)?;
        Ok(connection)
    }

    fn refresh(&self) -> Result<Refreshed, String> {
        let _writing = self.writing.lock().unwrap();
        let mut index = open_index(&self.index_path)?;
        let chats = Connection::open_with_flags(
            &self.chats_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(text)?;
        chats.busy_timeout(Duration::from_secs(10)).map_err(text)?;
        let sessions = chats
            .prepare("SELECT id, brand, external_id, title FROM session")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| {
                        Ok(SessionRow {
                            id: row.get(0)?,
                            brand: row.get(1)?,
                            external_id: row.get(2)?,
                            title: row.get(3)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(text)?;
        let mut known = index
            .prepare("SELECT session_id, kind, mark, title FROM source")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            Known {
                                kind: row.get(1)?,
                                mark: row.get(2)?,
                                title: row.get(3)?,
                            },
                        ))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()
            })
            .map_err(text)?;
        let records = RecordFiles::find(&self.accounts);
        let mut done = Refreshed::default();
        for session in &sessions {
            let before = known.remove(&session.id);
            match index_session(&mut index, &chats, &records, session, before.as_ref()) {
                Ok(Some(Kind::Events)) => done.from_events += 1,
                Ok(Some(Kind::Record)) => done.from_records += 1,
                Ok(None) => {}
                // One unreadable chat is not a reason to leave every chat
                // after it unindexed; it is tried again next pass.
                Err(error) => {
                    tracing::warn!(session = %session.id, %error, "chat not indexed")
                }
            }
        }
        // What is left was indexed once and has since been deleted.
        for session_id in known.keys() {
            let transaction = index.transaction().map_err(text)?;
            transaction
                .execute("DELETE FROM doc WHERE session_id=?1", [session_id])
                .map_err(text)?;
            transaction
                .execute("DELETE FROM source WHERE session_id=?1", [session_id])
                .map_err(text)?;
            transaction.commit().map_err(text)?;
            done.forgotten += 1;
        }
        Ok(done)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Events,
    Record,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Events => "events",
            Kind::Record => "record",
        }
    }
}

/// Bring one chat's rows up to date. `Some` names where the words came from
/// when any were read; `None` means nothing had changed.
fn index_session(
    index: &mut Connection,
    chats: &Connection,
    records: &RecordFiles,
    session: &SessionRow,
    known: Option<&Known>,
) -> Result<Option<Kind>, String> {
    let spoken = chats
        .prepare_cached("SELECT 1 FROM event WHERE type='text.delta' AND session_id=?1 LIMIT 1")
        .and_then(|mut statement| statement.exists([&session.id]))
        .map_err(text)?;
    // A chat that has stored words is read from them: those are the words the
    // app shows for it. Only a chat with none is read from its record, which
    // is where a chat nobody opened here keeps all of them.
    let (kind, mark, record) = if spoken {
        let seq: i64 = chats
            .prepare_cached("SELECT COALESCE(MAX(seq), 0) FROM event WHERE session_id=?1")
            .and_then(|mut statement| statement.query_row([&session.id], |row| row.get(0)))
            .map_err(text)?;
        (Some(Kind::Events), seq.to_string(), None)
    } else if let Some(path) = records.path_for(&session.brand, session.external_id.as_deref()) {
        (Some(Kind::Record), stamp(path), Some(path))
    } else {
        (None, String::new(), None)
    };
    let kind_name = kind.map(Kind::name).unwrap_or("none");
    let same_kind = known.is_some_and(|known| known.kind == kind_name);
    let words_current = same_kind && known.is_some_and(|known| known.mark == mark);
    let title_current = known.is_some_and(|known| known.title == session.title);
    if words_current && title_current {
        return Ok(None);
    }

    let transaction = index.transaction().map_err(text)?;
    if !title_current {
        match session
            .title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
        {
            Some(title) => {
                transaction
                    .execute(
                        r#"INSERT INTO doc (session_id, part, field, at, text) VALUES (?1,?2,'title','',?3)
                           ON CONFLICT(session_id, part) DO UPDATE SET text=excluded.text"#,
                        params![session.id, TITLE, title],
                    )
                    .map_err(text)?;
            }
            None => {
                transaction
                    .execute(
                        "DELETE FROM doc WHERE session_id=?1 AND part=?2",
                        params![session.id, TITLE],
                    )
                    .map_err(text)?;
            }
        }
    }
    let mut read = None;
    if !words_current {
        let mut words = Words::new(&transaction, &session.id);
        match kind {
            Some(Kind::Events) => {
                // The same source as last pass continues where that pass
                // stopped; any other starts the chat's words over.
                let after = if same_kind {
                    known
                        .and_then(|known| known.mark.parse::<i64>().ok())
                        .unwrap_or(0)
                } else {
                    words.reset();
                    0
                };
                let mut statement = chats
                    .prepare_cached(&format!(
                        "SELECT json FROM event WHERE session_id=?1 AND seq>?2 AND type IN ({WORD_EVENTS}) ORDER BY seq"
                    ))
                    .map_err(text)?;
                let mut rows = statement.query(params![session.id, after]).map_err(text)?;
                while let Some(row) = rows.next().map_err(text)? {
                    let json: String = row.get(0).map_err(text)?;
                    if let Ok(event) = serde_json::from_str::<Value>(&json) {
                        words.apply(&event)?;
                    }
                }
            }
            Some(Kind::Record) => {
                // A record is read whole: a changed file may have been
                // rewritten as easily as appended to.
                words.reset();
                let path = record.expect("a record kind has its path");
                let events = if session.brand == "codex" {
                    rollout_events(path)
                } else {
                    super::claude::history::searchable_events(path)
                };
                for event in &events {
                    words.apply(event)?;
                }
            }
            None => words.reset(),
        }
        words.flush()?;
        read = kind;
    }
    transaction
        .execute(
            r#"INSERT INTO source (session_id, kind, mark, title) VALUES (?1,?2,?3,?4)
               ON CONFLICT(session_id) DO UPDATE SET kind=excluded.kind, mark=excluded.mark, title=excluded.title"#,
            params![session.id, kind_name, mark, session.title],
        )
        .map_err(text)?;
    transaction.commit().map_err(text)?;
    Ok(read)
}

/// A file's size and modification time: when neither moved, nothing in it did.
fn stamp(path: &Path) -> String {
    let Ok(meta) = fs::metadata(path) else {
        return String::new();
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    format!("{}:{modified}", meta.len())
}

struct Part {
    field: &'static str,
    at: String,
    text: String,
}

/// The words of one chat as events add to them, written once at the end.
///
/// A message arrives as many deltas and may have begun in an earlier pass, so
/// a message not yet held is read back from the index before it is grown.
struct Words<'a> {
    connection: &'a Connection,
    session_id: &'a str,
    parts: HashMap<String, Part>,
    gone: HashSet<String>,
    helpers: HashSet<String>,
    reset: bool,
}

impl<'a> Words<'a> {
    fn new(connection: &'a Connection, session_id: &'a str) -> Self {
        Self {
            connection,
            session_id,
            parts: HashMap::new(),
            gone: HashSet::new(),
            helpers: HashSet::new(),
            reset: false,
        }
    }

    fn reset(&mut self) {
        self.parts.clear();
        self.gone.clear();
        self.reset = true;
    }

    fn held(&mut self, id: &str, field: &'static str, at: &str) -> Result<&mut Part, String> {
        if !self.parts.contains_key(id) {
            let stored = if self.reset {
                None
            } else {
                self.connection
                    .prepare_cached(
                        "SELECT field, at, text FROM doc WHERE session_id=?1 AND part=?2",
                    )
                    .and_then(|mut statement| {
                        statement
                            .query_row(params![self.session_id, id], |row| {
                                Ok(Part {
                                    field: match row.get::<_, String>(0)?.as_str() {
                                        "me" => "me",
                                        "tool" => "tool",
                                        _ => "agent",
                                    },
                                    at: row.get(1)?,
                                    text: row.get(2)?,
                                })
                            })
                            .optional()
                    })
                    .map_err(text)?
            };
            self.gone.remove(id);
            self.parts.insert(
                id.to_string(),
                stored.unwrap_or(Part {
                    field,
                    at: at.to_string(),
                    text: String::new(),
                }),
            );
        }
        Ok(self.parts.get_mut(id).unwrap())
    }

    fn apply(&mut self, event: &Value) -> Result<(), String> {
        let at = event["at"].as_str().unwrap_or_default();
        // A helper's words belong to the helper's own conversation, which a
        // search for this chat did not ask for.
        let from_helper = event["parentToolCallId"]
            .as_str()
            .is_some_and(|parent| !parent.is_empty());
        match event["type"].as_str().unwrap_or_default() {
            "transcript.reset" => self.reset(),
            "message.started" => {
                let Some(id) = event["messageId"].as_str() else {
                    return Ok(());
                };
                if from_helper {
                    self.helpers.insert(id.to_string());
                    return Ok(());
                }
                let field = if event["role"] == "user" {
                    "me"
                } else {
                    "agent"
                };
                let part = self.held(id, field, at)?;
                part.field = field;
                if part.at.is_empty() {
                    part.at = at.to_string();
                }
            }
            "text.delta" => {
                let (Some(id), Some(words)) = (event["messageId"].as_str(), event["text"].as_str())
                else {
                    return Ok(());
                };
                if from_helper || self.helpers.contains(id) {
                    return Ok(());
                }
                self.held(id, "agent", at)?.text.push_str(words);
            }
            "message.retracted" => {
                if let Some(id) = event["messageId"].as_str() {
                    self.parts.remove(id);
                    self.gone.insert(id.to_string());
                }
            }
            "tool.started" => {
                let Some(call) = event["toolCallId"].as_str() else {
                    return Ok(());
                };
                if from_helper {
                    return Ok(());
                }
                let words = tool_words(event);
                if !words.is_empty() {
                    let part = self.held(&format!("tool:{call}"), "tool", at)?;
                    part.text = words;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn flush(self) -> Result<(), String> {
        if self.reset {
            self.connection
                .execute(
                    "DELETE FROM doc WHERE session_id=?1 AND part<>?2",
                    params![self.session_id, TITLE],
                )
                .map_err(text)?;
        }
        for id in &self.gone {
            self.connection
                .execute(
                    "DELETE FROM doc WHERE session_id=?1 AND part=?2",
                    params![self.session_id, id],
                )
                .map_err(text)?;
        }
        let mut upsert = self
            .connection
            .prepare_cached(
                r#"INSERT INTO doc (session_id, part, field, at, text) VALUES (?1,?2,?3,?4,?5)
                   ON CONFLICT(session_id, part) DO UPDATE
                     SET field=excluded.field, at=excluded.at, text=excluded.text
                   WHERE doc.text<>excluded.text OR doc.field<>excluded.field"#,
            )
            .map_err(text)?;
        for (id, part) in &self.parts {
            let words = part.text.trim();
            if words.is_empty() {
                continue;
            }
            upsert
                .execute(params![self.session_id, id, part.field, part.at, words])
                .map_err(text)?;
        }
        Ok(())
    }
}

/// What a tool call was given that someone would remember it by: the command,
/// the file, the pattern, the address — and the call's own title.
fn tool_words(event: &Value) -> String {
    const NAMING: &[&str] = &[
        "command",
        "cmd",
        "file_path",
        "path",
        "notebook_path",
        "pattern",
        "query",
        "url",
        "description",
        "skill",
        "prompt",
    ];
    let mut words = Vec::new();
    if let Some(name) = event["name"].as_str() {
        words.push(name.to_string());
    }
    let input = &event["input"];
    for key in NAMING {
        match &input[*key] {
            Value::String(said) if !said.trim().is_empty() => words.push(said.clone()),
            Value::Array(parts) => {
                words.extend(parts.iter().filter_map(Value::as_str).map(str::to_string))
            }
            _ => {}
        }
    }
    if let Some(title) = event["title"].as_str() {
        if words.first().is_none_or(|name| name != title) {
            words.push(title.to_string());
        }
    }
    let joined = words.join(" ");
    match joined.char_indices().nth(TOOL_WORDS) {
        Some((cut, _)) => joined[..cut].to_string(),
        None => joined,
    }
}

/// Where each provider keeps the record of a chat, found once per pass.
struct RecordFiles {
    claude: HashMap<String, PathBuf>,
    codex: HashMap<String, PathBuf>,
}

impl RecordFiles {
    fn find(accounts: &AccountDirs) -> Self {
        let mut claude = HashMap::new();
        for directory in unique(accounts("claude")) {
            for path in super::claude::history::record_paths(&directory) {
                if let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) {
                    claude.insert(id.to_lowercase(), path.clone());
                }
            }
        }
        let mut codex = HashMap::new();
        for home in unique(accounts("codex")) {
            for folder in ["sessions", "archived_sessions"] {
                walk_rollouts(&home.join(folder), &mut codex);
            }
        }
        Self { claude, codex }
    }

    fn path_for(&self, brand: &str, external_id: Option<&str>) -> Option<&Path> {
        let id = external_id?.to_lowercase();
        match brand {
            "claude" => self.claude.get(&id),
            "codex" => self.codex.get(&id),
            _ => None,
        }
        .map(PathBuf::as_path)
    }
}

fn unique(directories: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    directories
        .into_iter()
        .filter(|directory| seen.insert(directory.clone()))
        .collect()
}

/// Codex files a rollout by date, `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`;
/// the id is the last 36 characters of the name.
fn walk_rollouts(directory: &Path, found: &mut HashMap<String, PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_rollouts(&path, found);
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if !stem.starts_with("rollout-") || path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        if let Some(id) = stem.get(stem.len().saturating_sub(36)..) {
            if uuid::Uuid::parse_str(id).is_ok() {
                found.insert(id.to_lowercase(), path);
            }
        }
    }
}

/// A Codex rollout's words, as the same events a stored chat would hold.
///
/// Only `response_item` rows: the user's words are written twice, once there
/// and once as an `event_msg`, and the rows that are neither are reasoning,
/// token counts and tool output.
fn rollout_events(path: &Path) -> Vec<Value> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for (number, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else {
            break;
        };
        if !line.contains("\"response_item\"") {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if row["type"] != "response_item" {
            continue;
        }
        let at = row["timestamp"].as_str().unwrap_or_default();
        let payload = &row["payload"];
        let id = format!("rollout:{number}");
        match payload["type"].as_str().unwrap_or_default() {
            "message" => {
                let role = payload["role"].as_str().unwrap_or_default();
                if role != "user" && role != "assistant" {
                    continue;
                }
                let said = payload["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .filter(|words| {
                        !words.trim().is_empty()
                            && !(role == "user" && super::codex::history::machine_context(words))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if said.is_empty() {
                    continue;
                }
                events.push(json!({"type":"message.started","messageId":id,"role":role,"at":at}));
                events.push(json!({"type":"text.delta","messageId":id,"text":said,"at":at}));
            }
            kind @ ("function_call" | "custom_tool_call" | "local_shell_call") => {
                let input = match (&payload["arguments"], &payload["input"], &payload["action"]) {
                    (Value::String(arguments), _, _) => serde_json::from_str::<Value>(arguments)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({"command": arguments})),
                    (_, Value::String(input), _) => json!({"command": input}),
                    (_, _, action) if action.is_object() => action.clone(),
                    _ => json!({}),
                };
                let call = payload["call_id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or(id);
                events.push(json!({
                    "type":"tool.started", "toolCallId":call,
                    "name":payload["name"].as_str().unwrap_or(kind),
                    "input":input, "at":at
                }));
            }
            _ => {}
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::protocol::Event;
    use crate::workbench::store::{Session, Store};

    const CLAUDE_CHAT: &str = "11111111-1111-4111-8111-111111111111";
    const CODEX_CHAT: &str = "22222222-2222-4222-8222-222222222222";

    fn session(id: &str, brand: &str, external_id: Option<&str>, title: Option<&str>) -> Session {
        Session {
            id: id.to_string(),
            brand: brand.to_string(),
            external_id: external_id.map(str::to_string),
            project_id: "project".to_string(),
            project_path: "/tmp/project".to_string(),
            cwd: "/tmp/project".to_string(),
            model: None,
            permission_mode: "default".to_string(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: title.map(str::to_string),
            state: "dormant".to_string(),
            origin: if external_id.is_some() {
                "terminal"
            } else {
                "app"
            }
            .to_string(),
            created_at: "2026-09-01T00:00:00.000Z".to_string(),
            last_active_at: "2026-09-01T00:00:00.000Z".to_string(),
            last_spoke_at: None,
            begun_by: None,
        }
    }

    fn event(session: &str, seq: i64, kind: &str, fields: Value) -> Event {
        let mut value = json!({"type":kind, "sessionId":session, "seq":seq,
            "at":"2026-09-01T00:00:00.000Z"});
        for (name, field) in fields.as_object().unwrap() {
            value[name] = field.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    struct Place {
        _directory: tempfile::TempDir,
        root: PathBuf,
        chats: PathBuf,
    }

    fn place() -> Place {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        Place {
            chats: root.join("workbench.db"),
            root,
            _directory: directory,
        }
    }

    fn index(place: &Place) -> SearchIndex {
        let root = place.root.clone();
        SearchIndex::open(
            &place.root.join("search.db"),
            &place.chats,
            Arc::new(move |brand: &str| vec![root.join(brand)]),
        )
        .unwrap()
    }

    fn found(index: &SearchIndex, query: &str) -> Vec<(String, String)> {
        index
            .search(query, 20)
            .unwrap()
            .into_iter()
            .map(|hit| (hit.session_id, hit.role))
            .collect()
    }

    /// A chat begun in a terminal and never opened here has no stored words
    /// at all; everything it said is in its provider's own record. Those were
    /// 1,600 of this computer's 1,952 chats, and none of them could be found.
    #[test]
    fn a_chat_only_its_record_holds_is_found_by_what_was_said_in_it() {
        let place = place();
        let store = Store::open(&place.chats).unwrap();
        store
            .create_session(&session(
                "claude-row",
                "claude",
                Some(CLAUDE_CHAT),
                Some("Tidy the loader"),
            ))
            .unwrap();
        store
            .create_session(&session("codex-row", "codex", Some(CODEX_CHAT), None))
            .unwrap();

        let claude = place.root.join("claude/projects/-tmp-project");
        fs::create_dir_all(&claude).unwrap();
        let rows = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":CLAUDE_CHAT,
                "timestamp":"2026-09-01T10:00:00.000Z","cwd":"/tmp/project",
                "message":{"role":"user","content":"where is the periwinkle crash"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":CLAUDE_CHAT,
            "timestamp":"2026-09-01T10:00:05.000Z","cwd":"/tmp/project",
            "message":{"id":"msg_1","role":"assistant","content":[
                {"type":"text","text":"Found it in the loader."},
                {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"cargo test lavender"}}
            ]}}),
        ];
        fs::write(
            claude.join(format!("{CLAUDE_CHAT}.jsonl")),
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();

        let codex = place.root.join("codex/sessions/2026/09/01");
        fs::create_dir_all(&codex).unwrap();
        let rollout = [
            json!({"timestamp":"2026-09-01T11:00:00.000Z","type":"session_meta","payload":{"id":CODEX_CHAT}}),
            json!({"timestamp":"2026-09-01T11:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":"<environment_context>quince</environment_context>"}]}}),
            json!({"timestamp":"2026-09-01T11:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user",
                "content":[{"type":"input_text","text":"why does the tangerine build fail"}]}}),
            json!({"timestamp":"2026-09-01T11:00:03.000Z","type":"event_msg","payload":{"type":"user_message",
                "message":"why does the tangerine build fail"}}),
            json!({"timestamp":"2026-09-01T11:00:04.000Z","type":"response_item","payload":{"type":"function_call",
                "name":"shell","call_id":"call_1","arguments":"{\"command\":[\"cargo\",\"build\",\"--features\",\"marmalade\"]}"}}),
        ];
        fs::write(
            codex.join(format!("rollout-2026-09-01T11-00-00-{CODEX_CHAT}.jsonl")),
            rollout
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();

        let index = index(&place);
        let done = index.refresh().unwrap();
        assert_eq!(done.from_records, 2, "{done:?}");

        assert_eq!(
            found(&index, "periwinkle"),
            [("claude-row".to_string(), "user".to_string())]
        );
        assert_eq!(
            found(&index, "lavender"),
            [("claude-row".to_string(), "tool".to_string())]
        );
        assert_eq!(
            found(&index, "loader found"),
            [("claude-row".to_string(), "assistant".to_string())]
        );
        assert!(found(&index, "tidy").contains(&("claude-row".to_string(), "title".to_string())));
        // Said once, recorded twice by Codex, found once.
        assert_eq!(
            found(&index, "tangerine"),
            [("codex-row".to_string(), "user".to_string())]
        );
        assert_eq!(
            found(&index, "marmalade"),
            [("codex-row".to_string(), "tool".to_string())]
        );
        // The context Codex writes into the user's turn is not the user's words.
        assert!(found(&index, "quince").is_empty());

        // Nothing moved, so nothing is read again.
        assert_eq!(index.refresh().unwrap(), Refreshed::default());
    }

    /// A stored chat's words arrive a few characters at a time and across
    /// passes, and are taken back, and the chat itself can be deleted.
    #[test]
    fn a_stored_chat_is_indexed_as_its_words_arrive() {
        let place = place();
        let mut store = Store::open(&place.chats).unwrap();
        store
            .create_session(&session("chat-1", "claude", None, None))
            .unwrap();
        let mut seq = 0;
        let mut say = |store: &Store, kind: &str, fields: Value| {
            seq += 1;
            store
                .append_event(&event("chat-1", seq, kind, fields))
                .unwrap();
        };
        say(
            &store,
            "message.started",
            json!({"messageId":"m1","role":"assistant"}),
        );
        say(
            &store,
            "text.delta",
            json!({"messageId":"m1","text":"The word is PERI"}),
        );
        say(
            &store,
            "message.started",
            json!({"messageId":"h1","role":"assistant","parentToolCallId":"t9"}),
        );
        say(
            &store,
            "text.delta",
            json!({"messageId":"h1","text":"a helper said apricot"}),
        );

        let index = index(&place);
        assert_eq!(index.refresh().unwrap().from_events, 1);
        assert!(found(&index, "periwinkle").is_empty());
        assert_eq!(
            found(&index, "PERI").len(),
            1,
            "a word still being typed is a prefix"
        );
        assert!(
            found(&index, "apricot").is_empty(),
            "a helper's words are its own chat's"
        );

        say(
            &store,
            "text.delta",
            json!({"messageId":"m1","text":"WINKLE here."}),
        );
        index.refresh().unwrap();
        let hits = index.search("periwinkle", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "The word is PERIWINKLE here.");
        assert_eq!(hits[0].matched, "PERIWINKLE");
        assert!(hits[0].sentence.contains("PERIWINKLE"));

        say(&store, "message.retracted", json!({"messageId":"m1"}));
        index.refresh().unwrap();
        assert!(found(&index, "periwinkle").is_empty());

        store.delete_session("chat-1").unwrap();
        assert_eq!(index.refresh().unwrap().forgotten, 1);
    }

    /// The chat database's writer is every live chat's writer. A search that
    /// waited for it would stall while a chat streams; one that held it would
    /// stall the chat.
    #[test]
    fn a_search_does_not_wait_for_the_chat_database_writer() {
        let place = place();
        let store = Store::open(&place.chats).unwrap();
        store
            .create_session(&session("chat-1", "claude", None, Some("Plum jam")))
            .unwrap();
        let index = index(&place);
        index.refresh().unwrap();

        let writer = Connection::open(&place.chats).unwrap();
        writer
            .execute_batch("BEGIN IMMEDIATE; UPDATE session SET state='busy';")
            .unwrap();
        let (sent, answer) = std::sync::mpsc::channel();
        let searching = index.clone();
        std::thread::spawn(move || {
            let _ = sent.send(searching.search("plum", 10).map(|hits| hits.len()));
        });
        let hits = answer
            .recv_timeout(Duration::from_secs(2))
            .expect("the search waited on the chat database's writer");
        assert_eq!(hits.unwrap(), 1);
        writer.execute_batch("ROLLBACK;").unwrap();
    }

    /// Not a check: how the index does over a real install, which it only
    /// reads. The index itself is written where `SEARCH_MEASURE_OUT` says.
    ///
    /// SEARCH_MEASURE_DATA=~/.local/share/atelier SEARCH_MEASURE_OUT=target/search-measure \
    ///   cargo test --lib measure_the_index -- --ignored --nocapture
    #[test]
    #[ignore]
    fn measure_the_index_on_this_computer() {
        let (Some(data), Some(out)) = (
            std::env::var_os("SEARCH_MEASURE_DATA"),
            std::env::var_os("SEARCH_MEASURE_OUT"),
        ) else {
            return;
        };
        let out = PathBuf::from(out);
        let _ = fs::remove_dir_all(&out);
        fs::create_dir_all(&out).unwrap();
        let home = directories::BaseDirs::new()
            .unwrap()
            .home_dir()
            .to_path_buf();
        let index = SearchIndex::open(
            &out.join("search.db"),
            &PathBuf::from(data).join("workbench.db"),
            Arc::new(move |brand: &str| {
                vec![home.join(if brand == "claude" {
                    ".claude"
                } else {
                    ".codex"
                })]
            }),
        )
        .unwrap();
        let began = std::time::Instant::now();
        let done = index.refresh().unwrap();
        println!("first pass: {done:?} in {:?}", began.elapsed());
        let began = std::time::Instant::now();
        let again = index.refresh().unwrap();
        println!("second pass: {again:?} in {:?}", began.elapsed());
        let size: u64 = fs::read_dir(&out)
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        println!("index on disk: {} MB", size / 1_000_000);
        let reading = Connection::open(out.join("search.db")).unwrap();
        let (chats, rows, chars): (i64, i64, i64) = reading
            .query_row(
                "SELECT COUNT(DISTINCT session_id), COUNT(*), COALESCE(SUM(LENGTH(text)),0) FROM doc",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        println!("chats with words: {chats}; rows: {rows}; characters: {chars}");
        for (field, count) in reading
            .prepare("SELECT field, COUNT(*) FROM doc GROUP BY field")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .flatten()
        {
            println!("  {field}: {count}");
        }
        let (sessions, terminal): (i64, i64) = reading
            .query_row(
                "SELECT COUNT(*), SUM(kind='record') FROM source WHERE kind<>'none'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        println!("chats with a source: {sessions}, of which from a record: {terminal}");
        for query in [
            "periwinkle",
            "search",
            "cargo test",
            "worktree remove",
            "fts5",
            "escape cancel",
            "a",
        ] {
            let began = std::time::Instant::now();
            let hits = index.search(query, 100).unwrap();
            println!(
                "search {query:?}: {} hits in {:?}",
                hits.len(),
                began.elapsed()
            );
        }
    }
}
