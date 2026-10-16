//! What each chat holds on disk: the bytes of its events, and the stored
//! pictures and files its events name.
//!
//! Kept in a database of its own beside the chats (`storage.db`), filled the
//! way the search index is filled: by reading `workbench.db` and never writing
//! to it. Each chat is read once up to its newest event and from there on only
//! its new events are read, so the storage screen and the cleanup rules can
//! answer "how much would this free" without reading every chat again.
//!
//! Also where the cleanup writes down which of a chat's pictures or files it
//! has removed: the events that named them are left as they were, so the
//! names stay in the chat, and only the mark says they no longer hold a file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use regex::Regex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

/// Events read per query while catching a chat up.
const BATCH: i64 = 400;

/// How long to rest after a batch that read this much, so the first fill of a
/// large store is never the heavy read that slows the chats themselves.
const HEAVY_BATCH: i64 = 8 * 1024 * 1024;
const REST: Duration = Duration::from_millis(15);

/// The two kinds of stored file a rule can remove.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, PartialOrd, Ord)]
pub enum Kind {
    Images,
    Files,
}

impl Kind {
    pub fn of(asset: &str) -> Kind {
        match asset.rsplit_once('.').map(|(_, ext)| ext) {
            Some("png" | "jpg" | "jpeg" | "gif" | "webp") => Kind::Images,
            _ => Kind::Files,
        }
    }

    fn word(self) -> &'static str {
        match self {
            Kind::Images => "images",
            Kind::Files => "files",
        }
    }

    fn from_word(word: &str) -> Option<Kind> {
        match word {
            "images" => Some(Kind::Images),
            "files" => Some(Kind::Files),
            _ => None,
        }
    }
}

/// One stored file named by one chat, at the newest event that names it.
#[derive(Clone, Debug, PartialEq)]
pub struct AssetRef {
    pub asset: String,
    pub session_id: String,
    pub last_seq: i64,
}

/// Everything the index holds, read at once.
#[derive(Clone, Debug, Default)]
pub struct Indexed {
    /// Event bytes and the newest event read, by chat.
    pub chats: HashMap<String, (i64, i64)>,
    pub refs: Vec<AssetRef>,
    /// Through which event a chat's pictures or files were removed.
    pub cleared: HashMap<(String, Kind), i64>,
}

impl Indexed {
    /// Whether this file is still shown by any chat the index holds, leaving
    /// out the chats named in `gone`.
    pub fn in_use(&self, asset: &str, gone: &HashSet<String>) -> bool {
        let kind = Kind::of(asset);
        self.refs.iter().any(|r| {
            r.asset == asset
                && !gone.contains(&r.session_id)
                && self
                    .cleared
                    .get(&(r.session_id.clone(), kind))
                    .map_or(true, |through| r.last_seq > *through)
        })
    }
}

/// How far the index has got, for the screen to show while it fills.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub chats: usize,
    pub measured: usize,
    /// Every chat has been measured at least once.
    pub ready: bool,
}

impl Progress {
    pub fn ready(&self) -> bool {
        self.ready
    }
}

fn asset_name() -> &'static Regex {
    static NAME: OnceLock<Regex> = OnceLock::new();
    NAME.get_or_init(|| Regex::new(r"\b[0-9a-f]{64}\.[a-z0-9]{1,12}\b").expect("asset pattern"))
}

/// Every stored file name in one event's text.
pub fn names_in(text: &str) -> impl Iterator<Item = &str> {
    asset_name().find_iter(text).map(|found| found.as_str())
}

pub struct StorageIndex {
    path: PathBuf,
    chats: PathBuf,
    /// One fill at a time; a second caller waits and then finds little to do.
    filling: Mutex<()>,
    progress: Mutex<Progress>,
    /// Whether one fill has ever finished, after which a fill only catches up
    /// and is quick enough to wait for.
    filled: std::sync::atomic::AtomicBool,
}

impl StorageIndex {
    pub fn new(path: PathBuf, chats: PathBuf) -> Self {
        Self {
            path,
            chats,
            filling: Mutex::new(()),
            progress: Mutex::new(Progress::default()),
            filled: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn filled(&self) -> bool {
        self.filled.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Start a fill on a thread of its own unless one is under way.
    pub fn fill_in_background(self: &std::sync::Arc<Self>) {
        if self.filling.try_lock().is_err() {
            return;
        }
        let index = self.clone();
        std::thread::spawn(move || {
            if let Err(error) = index.refresh() {
                tracing::warn!(%error, "storage index not filled");
            }
        });
    }

    /// How far the last fill got, without waiting for one under way.
    pub fn progress(&self) -> Progress {
        *self.progress.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn open(&self) -> rusqlite::Result<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(10))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS measured (
               session_id TEXT PRIMARY KEY,
               through_seq INTEGER NOT NULL,
               bytes INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS asset_ref (
               asset TEXT NOT NULL,
               session_id TEXT NOT NULL,
               last_seq INTEGER NOT NULL,
               PRIMARY KEY (asset, session_id)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS asset_ref_by_session ON asset_ref(session_id);
             CREATE TABLE IF NOT EXISTS cleared (
               session_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               through_seq INTEGER NOT NULL,
               PRIMARY KEY (session_id, kind)
             );",
        )?;
        Ok(connection)
    }

    fn open_chats(&self) -> rusqlite::Result<Connection> {
        let connection = Connection::open_with_flags(
            &self.chats,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(10))?;
        Ok(connection)
    }

    /// Catch every chat up to its newest event, and forget the chats that are
    /// gone. Blocking: call it off the async threads.
    pub fn refresh(&self) -> Result<Progress, String> {
        let _filling = self.filling.lock().unwrap_or_else(|p| p.into_inner());
        let report = |progress: Progress| {
            *self.progress.lock().unwrap_or_else(|p| p.into_inner()) = progress;
            progress
        };
        if !self.chats.exists() {
            self.filled.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(report(Progress { ready: true, ..Progress::default() }));
        }
        let text = |e: rusqlite::Error| e.to_string();
        let chats = self.open_chats().map_err(text)?;
        let mut index = self.open().map_err(text)?;
        let sessions: Vec<String> = chats
            .prepare("SELECT id FROM session")
            .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
            .map_err(text)?;
        let known: HashMap<String, i64> = index
            .prepare("SELECT session_id, through_seq FROM measured")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .map_err(text)?;
        let present: HashSet<&str> = sessions.iter().map(String::as_str).collect();
        let gone: Vec<&String> = known.keys().filter(|id| !present.contains(id.as_str())).collect();
        if !gone.is_empty() {
            let transaction = index.transaction().map_err(text)?;
            for id in gone {
                for table in ["measured", "asset_ref", "cleared"] {
                    transaction
                        .execute(&format!("DELETE FROM {table} WHERE session_id = ?1"), [id])
                        .map_err(text)?;
                }
            }
            transaction.commit().map_err(text)?;
        }
        let mut progress = Progress {
            chats: sessions.len(),
            measured: self.progress().measured.min(sessions.len()),
            ready: self.filled(),
        };
        // A fill that only catches up is not shown as starting again.
        let mut counted = 0;
        for id in &sessions {
            let through = known.get(id).copied().unwrap_or(i64::MIN);
            let newest: Option<i64> = chats
                .query_row("SELECT MAX(seq) FROM event WHERE session_id = ?1", [id], |r| r.get(0))
                .map_err(text)?;
            if newest.map_or(false, |newest| newest > through) {
                self.catch_up(&chats, &mut index, id, through).map_err(text)?;
            } else if !known.contains_key(id) {
                index
                    .execute(
                        "INSERT OR IGNORE INTO measured (session_id, through_seq, bytes) VALUES (?1, ?2, 0)",
                        params![id, through.max(-1)],
                    )
                    .map_err(text)?;
            }
            counted += 1;
            if counted > progress.measured && counted % 50 == 0 {
                progress.measured = counted;
                report(progress);
            }
        }
        progress.measured = sessions.len();
        progress.ready = true;
        self.filled.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(report(progress))
    }

    fn catch_up(&self, chats: &Connection, index: &mut Connection, id: &str, mut through: i64) -> rusqlite::Result<()> {
        let mut read = chats.prepare(
            "SELECT seq, octet_length(json), CASE WHEN instr(json, 'asset') > 0 THEN json END
               FROM event WHERE session_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        loop {
            let rows: Vec<(i64, i64, Option<String>)> = read
                .query_map(params![id, through, BATCH], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let Some(last) = rows.last().map(|row| row.0) else {
                return Ok(());
            };
            let mut bytes = 0;
            let mut named: HashMap<String, i64> = HashMap::new();
            for (seq, size, json) in &rows {
                bytes += size;
                for asset in json.as_deref().into_iter().flat_map(names_in) {
                    named.insert(asset.to_string(), *seq);
                }
            }
            let transaction = index.transaction()?;
            transaction.execute(
                "INSERT INTO measured (session_id, through_seq, bytes) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET through_seq = ?2, bytes = bytes + ?3",
                params![id, last, bytes],
            )?;
            for (asset, seq) in named {
                transaction.execute(
                    "INSERT INTO asset_ref (asset, session_id, last_seq) VALUES (?1, ?2, ?3)
                     ON CONFLICT(asset, session_id) DO UPDATE SET last_seq = MAX(last_seq, ?3)",
                    params![asset, id, seq],
                )?;
            }
            transaction.commit()?;
            through = last;
            if bytes > HEAVY_BATCH {
                std::thread::sleep(REST);
            }
            if (rows.len() as i64) < BATCH {
                return Ok(());
            }
        }
    }

    /// Everything the index holds.
    pub fn read(&self) -> Result<Indexed, String> {
        let text = |e: rusqlite::Error| e.to_string();
        let index = self.open().map_err(text)?;
        let chats = index
            .prepare("SELECT session_id, bytes, through_seq FROM measured")
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?))))?
                    .collect()
            })
            .map_err(text)?;
        let refs = index
            .prepare("SELECT asset, session_id, last_seq FROM asset_ref")
            .and_then(|mut s| {
                s.query_map([], |r| {
                    Ok(AssetRef {
                        asset: r.get(0)?,
                        session_id: r.get(1)?,
                        last_seq: r.get(2)?,
                    })
                })?
                .collect()
            })
            .map_err(text)?;
        let cleared = index
            .prepare("SELECT session_id, kind, through_seq FROM cleared")
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?)))?
                    .collect::<rusqlite::Result<Vec<(String, String, i64)>>>()
            })
            .map_err(text)?
            .into_iter()
            .filter_map(|(id, kind, through)| Kind::from_word(&kind).map(|kind| ((id, kind), through)))
            .collect();
        Ok(Indexed { chats, refs, cleared })
    }

    /// Write down that these chats' pictures or files are removed through the
    /// event given.
    pub fn mark_cleared(&self, cleared: &[(String, Kind, i64)]) -> Result<(), String> {
        let text = |e: rusqlite::Error| e.to_string();
        let mut index = self.open().map_err(text)?;
        let transaction = index.transaction().map_err(text)?;
        for (id, kind, through) in cleared {
            transaction
                .execute(
                    "INSERT INTO cleared (session_id, kind, through_seq) VALUES (?1, ?2, ?3)
                     ON CONFLICT(session_id, kind) DO UPDATE SET through_seq = MAX(through_seq, ?3)",
                    params![id, kind.word(), through],
                )
                .map_err(text)?;
        }
        transaction.commit().map_err(text)
    }

    /// Bytes no chat uses inside the chat database, which new chats fill
    /// before the file grows again.
    pub fn unused_chat_bytes(&self) -> Option<u64> {
        let chats = self.open_chats().ok()?;
        let pages: i64 = chats.query_row("PRAGMA freelist_count", [], |r| r.get(0)).optional().ok()??;
        let size: i64 = chats.query_row("PRAGMA page_size", [], |r| r.get(0)).optional().ok()??;
        Some((pages.max(0) * size.max(0)) as u64)
    }
}

/// The path of one stored file, when the name is one this store could hold.
pub fn stored_file(media: &Path, asset: &str) -> Option<PathBuf> {
    let (digest, ext) = asset.split_once('.')?;
    let fits = digest.len() == 64
        && digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && !ext.is_empty()
        && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    fits.then(|| media.join(asset))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chats_db(path: &Path) -> Connection {
        let c = Connection::open(path).unwrap();
        c.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY);
             CREATE TABLE event (session_id TEXT, seq INTEGER, json TEXT, PRIMARY KEY (session_id, seq));",
        )
        .unwrap();
        c
    }

    const PNG: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
    const PDF: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf";

    #[test]
    fn storage_index_reads_new_events_once_and_forgets_deleted_chats() {
        let dir = tempfile::tempdir().unwrap();
        let chats = chats_db(&dir.path().join("workbench.db"));
        chats.execute("INSERT INTO session VALUES ('a'), ('b')", []).unwrap();
        chats
            .execute(
                "INSERT INTO event VALUES ('a', 1, ?1), ('a', 2, '{\"text\":\"hi\"}'), ('b', 1, ?2)",
                params![
                    format!(r#"{{"images":[{{"asset":"{PNG}"}}]}}"#),
                    format!(r#"{{"text":"```atelier-widget {{\"asset\":\"{PDF}\"}}```"}}"#),
                ],
            )
            .unwrap();
        let index = StorageIndex::new(dir.path().join("storage.db"), dir.path().join("workbench.db"));
        assert!(index.refresh().unwrap().ready());
        let read = index.read().unwrap();
        assert_eq!(read.chats["a"].1, 2);
        assert!(read.chats["a"].0 > 0);
        assert!(read.refs.contains(&AssetRef { asset: PNG.into(), session_id: "a".into(), last_seq: 1 }));
        assert!(read.refs.contains(&AssetRef { asset: PDF.into(), session_id: "b".into(), last_seq: 1 }));

        chats
            .execute("INSERT INTO event VALUES ('a', 3, ?1)", [format!(r#"{{"asset":"{PNG}"}}"#)])
            .unwrap();
        chats.execute("DELETE FROM session WHERE id = 'b'", []).unwrap();
        index.refresh().unwrap();
        let read = index.read().unwrap();
        assert!(!read.chats.contains_key("b"));
        assert_eq!(read.refs, vec![AssetRef { asset: PNG.into(), session_id: "a".into(), last_seq: 3 }]);
    }

    #[test]
    fn a_cleared_file_is_in_use_only_where_a_later_event_names_it_again() {
        let mut indexed = Indexed::default();
        indexed.refs = vec![
            AssetRef { asset: PNG.into(), session_id: "a".into(), last_seq: 5 },
            AssetRef { asset: PNG.into(), session_id: "b".into(), last_seq: 9 },
        ];
        indexed.cleared.insert(("a".into(), Kind::Images), 5);
        let none = HashSet::new();
        assert!(indexed.in_use(PNG, &none), "chat b still shows it");
        assert!(!indexed.in_use(PNG, &HashSet::from(["b".to_string()])));
        indexed.cleared.insert(("b".into(), Kind::Images), 8);
        assert!(indexed.in_use(PNG, &none), "named again after b was cleared");
        // A file of the other kind is not covered by an images mark.
        indexed.refs.push(AssetRef { asset: PDF.into(), session_id: "a".into(), last_seq: 1 });
        assert!(indexed.in_use(PDF, &none));
    }

    #[test]
    fn only_names_shaped_like_stored_files_are_paths() {
        let media = Path::new("/m");
        assert_eq!(stored_file(media, PNG), Some(media.join(PNG)));
        assert_eq!(stored_file(media, "../etc/passwd"), None);
        assert_eq!(stored_file(media, &PNG.replace(".png", "./x")), None);
        assert_eq!(Kind::of(PNG), Kind::Images);
        assert_eq!(Kind::of(PDF), Kind::Files);
    }
}
