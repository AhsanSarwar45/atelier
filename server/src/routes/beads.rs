//! Beads API route handlers.
//!
//! Provides endpoints for reading beads data.
//! Supports two data sources:
//! - **Dolt** (preferred): reads via `bd list --json` + `bd sql` CLI commands
//! - **JSONL** (fallback): reads from `.beads/issues.jsonl` if bd CLI is unavailable

use axum::{
    extract::{Extension, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::io::AsyncWriteExt;

use super::validate_path_security;
use crate::db::{CachedCounts, Database, Project};
use crate::dolt::{self, DoltManager};

/// Resolves the Dolt server port for a project.
/// Tries dolt-server.port file first, falls back to parsing dolt-server.log.
pub fn resolve_dolt_port(beads_dir: &std::path::Path) -> Option<u16> {
    // Try port file first
    let port_file = beads_dir.join("dolt-server.port");
    if let Ok(content) = std::fs::read_to_string(&port_file) {
        if let Ok(port) = content.trim().parse::<u16>() {
            return Some(port);
        }
    }

    // Fallback: parse port from dolt-server.log
    let log_file = beads_dir.join("dolt-server.log");
    if let Ok(content) = std::fs::read_to_string(&log_file) {
        // Look for HP="127.0.0.1:PORT" pattern
        if let Some(start) = content.find("HP=\"127.0.0.1:") {
            let after = &content[start + 14..]; // skip HP="127.0.0.1:
            if let Some(end) = after.find('"') {
                if let Ok(port) = after[..end].parse::<u16>() {
                    tracing::info!("Resolved port {} from dolt-server.log (no port file)", port);
                    return Some(port);
                }
            }
        }
    }

    None
}

/// Resolves the correct path to `issues.jsonl` for a project.
///
/// When a project has `sync-branch` set in `.beads/config.yaml`, the canonical
/// JSONL file lives at `.git/beads-worktrees/<branch>/.beads/issues.jsonl`
/// instead of the default `.beads/issues.jsonl`.
///
/// # Fallback behavior
///
/// Returns the default `.beads/issues.jsonl` path when:
/// - No `.beads/config.yaml` exists
/// - The YAML is malformed or cannot be parsed
/// - `sync-branch` is not set, empty, or commented out
/// - The resolved worktree directory does not exist
pub fn resolve_issues_path(project_path: &Path) -> PathBuf {
    let config_path = project_path.join(".beads").join("config.yaml");
    let default_path = project_path.join(".beads").join("issues.jsonl");

    let config_contents = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return default_path,
    };

    let yaml: serde_yaml::Value = match serde_yaml::from_str(&config_contents) {
        Ok(v) => v,
        Err(_) => return default_path,
    };

    let branch = match yaml.get("sync-branch").and_then(|v| v.as_str()) {
        Some(b) if !b.trim().is_empty() => b.trim().to_string(),
        _ => return default_path,
    };

    let worktree_dir = project_path
        .join(".git")
        .join("beads-worktrees")
        .join(&branch);

    if !worktree_dir.exists() {
        return default_path;
    }

    worktree_dir.join(".beads").join("issues.jsonl")
}

/// Query parameters for the beads endpoint.
#[derive(Debug, Deserialize)]
pub struct BeadsParams {
    /// The project path containing .beads/issues.jsonl
    pub path: String,
    /// Optional ISO 8601 timestamp — only return beads updated after this time.
    /// Used for incremental polling (subsequent fetches after initial full load).
    pub updated_after: Option<String>,
    /// Ask for the counts rather than the cards. The list of projects wants to
    /// know how many cards sit in each column, not what any of them says, and
    /// downloading a whole card database to count it cost the reader megabytes
    /// per project (bw-uiyz.2). Present at all means counts.
    pub counts: Option<String>,
}

/// A dependency relationship in the JSONL file (old format).
///
/// Old `bd` versions stored dependencies as:
/// ```json
/// "dependencies": [{"depends_on_id":"parent-1", "type":"parent-child"}]
/// ```
#[derive(Debug, Deserialize, Clone)]
pub(crate) struct LegacyDependency {
    depends_on_id: String,
    #[serde(rename = "type")]
    dep_type: String,
}

/// A single bead/issue from the JSONL file.
///
/// Supports both old and new `bd` CLI formats:
/// - **Old**: `dependencies` as array of objects with `depends_on_id` and `type`
/// - **New**: `parent` (string), `dependencies` as array of string IDs, `related` as array of strings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bead {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub status: String,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub issue_type: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default, alias = "closedAt")]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub close_reason: Option<String>,
    #[serde(default)]
    pub comments: Option<Vec<Comment>>,
    #[serde(default, alias = "parent")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<String>>,
    #[serde(default)]
    pub design: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub deps: Option<Vec<String>>,
    #[serde(default, alias = "related")]
    pub relates_to: Option<Vec<String>>,
    /// Tags carried by the issue, e.g. `area:board`, `kind:bug`. `bd` keeps them in
    /// a side table; the board draws and filters by the `area:` and `kind:` ones.
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// Raw dependencies field — accepts both old (array of objects) and new (array of strings) formats.
    #[serde(default, skip_serializing, deserialize_with = "deserialize_dependencies")]
    pub(crate) dependencies: Option<RawDependencies>,
}

/// Parsed dependencies in either old or new format.
#[derive(Debug, Clone)]
pub(crate) enum RawDependencies {
    /// Old format: array of `{depends_on_id, type}` objects
    Legacy(Vec<LegacyDependency>),
    /// New format: flat array of string IDs (blocking deps)
    StringIds(Vec<String>),
}

/// Custom deserializer that handles both old and new dependency formats.
fn deserialize_dependencies<'de, D>(deserializer: D) -> Result<Option<RawDependencies>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    let arr = match value {
        Some(serde_json::Value::Array(a)) => a,
        Some(serde_json::Value::Null) | None => return Ok(None),
        _ => return Err(serde::de::Error::custom("expected array or null for dependencies")),
    };

    if arr.is_empty() {
        return Ok(None);
    }

    // Check first element to distinguish formats
    if arr[0].is_string() {
        // New format: ["id1", "id2"]
        let ids: Vec<String> = serde_json::from_value(serde_json::Value::Array(arr))
            .map_err(serde::de::Error::custom)?;
        Ok(Some(RawDependencies::StringIds(ids)))
    } else {
        // Old format: [{depends_on_id, type}, ...]
        let deps: Vec<LegacyDependency> = serde_json::from_value(serde_json::Value::Array(arr))
            .map_err(serde::de::Error::custom)?;
        Ok(Some(RawDependencies::Legacy(deps)))
    }
}

fn deserialize_comment_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de;

    struct CommentIdVisitor;

    impl<'de> de::Visitor<'de> for CommentIdVisitor {
        type Value = String;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("string or integer")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<String, E> {
            Ok(v.to_string())
        }

        fn visit_string<E: de::Error>(self, v: String) -> Result<String, E> {
            Ok(v)
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<String, E> {
            Ok(v.to_string())
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<String, E> {
            Ok(v.to_string())
        }
    }

    deserializer.deserialize_any(CommentIdVisitor)
}

/// A comment on a bead.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    #[serde(deserialize_with = "deserialize_comment_id")]
    pub id: String,
    pub issue_id: String,
    pub author: String,
    pub text: String,
    pub created_at: String,
}

/// Runs a `bd` CLI command and returns stdout.
///
/// Uses `find_bd()` to locate the binary — searches PATH and common install locations.
async fn run_bd(args: &[&str], cwd: &Path) -> Result<String, String> {
    let Some(bd_path) = super::find_bd() else {
        super::forget_tools();
        return Err(super::BD_MISSING.to_string());
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(bd_path).args(args).current_dir(cwd).output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            if output.status.success() {
                String::from_utf8(output.stdout)
                    .map_err(|e| format!("Invalid UTF-8 in bd output: {}", e))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("bd exited with {}: {}", output.status, stderr))
            }
        }
        Ok(Err(e)) => Err(format!("Failed to run bd: {}", e)),
        Err(_) => Err("bd command timed out after 30s".to_string()),
    }
}

/// Extracts JSON array from CLI output that may contain non-JSON prefix lines.
/// bd v0.61+ outputs warnings and migration messages to stdout before the JSON.
fn extract_json_array(output: &str) -> Result<&str, String> {
    if let Some(start) = output.find('[') {
        Ok(&output[start..])
    } else {
        Err(format!(
            "No JSON array found in output: {}",
            &output[..output.len().min(200)]
        ))
    }
}

/// Computes bead counts from a slice of beads and upserts them into the
/// local SQLite cache so the home page can render donut charts instantly.
///
/// Cache writes are best-effort — failures are logged but never propagated
/// to the `/api/beads` response. The `project_path` is looked up against
/// the `projects` table; if no matching project exists (e.g. `dolt://`
/// paths or paths unknown to the local DB), the cache is skipped.
fn upsert_counts_cache(
    db: &Database,
    project_path: &str,
    data_source: &str,
    beads: &[Bead],
) {
    let project = match db.get_project_by_path(project_path) {
        Ok(Some(p)) => p,
        Ok(None) => {
            tracing::debug!(
                "No project row for path {}, skipping counts cache",
                project_path
            );
            return;
        }
        Err(e) => {
            tracing::warn!("Failed to look up project by path {}: {}", project_path, e);
            return;
        }
    };

    let counts = counts_of(beads, data_source);

    if let Err(e) = db.upsert_cached_counts(&project.id, &counts) {
        tracing::warn!(
            "Failed to upsert cached counts for project {}: {}",
            project.id,
            e
        );
    }
}

/// How many cards sit in each column, worked out from the cards themselves.
fn counts_of(beads: &[Bead], data_source: &str) -> CachedCounts {
    let mut open = 0i64;
    let mut in_progress = 0i64;
    let mut inreview = 0i64;
    let mut manager_review = 0i64;
    let mut closed = 0i64;
    let mut cancelled = 0i64;
    for bead in beads {
        // Dropped work is a closed bead carrying the mark, never a status of its own.
        let is_cancelled = bead.labels.as_ref()
            .is_some_and(|l| l.iter().any(|s| s == CANCELLED_LABEL));
        match bead.status.as_str() {
            "open" => open += 1,
            "in_progress" => in_progress += 1,
            // bd writes `in_review`; this screen has always called the column `inreview`.
            "inreview" | "in_review" => inreview += 1,
            "manager_review" => manager_review += 1,
            "closed" if is_cancelled => cancelled += 1,
            "closed" => closed += 1,
            _ => {}
        }
    }

    CachedCounts {
        open,
        in_progress,
        inreview,
        manager_review,
        closed,
        cancelled,
        data_source: Some(data_source.to_string()),
        updated_at: Utc::now().to_rfc3339(),
    }
}

/// Reads beads from the Dolt database via `bd` CLI.
///
/// Calls `bd list --json` for issues and `bd sql` for comments,
/// then merges them together.
///
/// The board always comes back whole: what changed is picked out of it
/// afterwards by `changed_since`, so one run answers every kind of ask and can
/// be kept for the next one (bw-uiyz.13).
async fn read_beads_from_cli(project_path: &Path) -> Result<Vec<Bead>, String> {
    let list_output = run_bd(&["list", "--json", "--all"], project_path).await?;
    let json_str = extract_json_array(&list_output)?;
    let mut beads: Vec<Bead> = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse bd list output: {}", e))?;

    // Get all comments. Try `bd sql` first; on any failure (notably "not yet
    // supported in embedded mode" for JSONL-only projects), fall back to
    // reading comments from .beads/issues.jsonl, which embeds them per issue.
    let mut comments_map: HashMap<String, Vec<Comment>> = HashMap::new();
    let sql_result = run_bd(
        &["sql", "SELECT * FROM comments ORDER BY issue_id, id", "--json"],
        project_path,
    )
    .await;
    match sql_result {
        Ok(output) => {
            let json_str = extract_json_array(&output).unwrap_or("[]");
            match serde_json::from_str::<Vec<Comment>>(json_str) {
                Ok(comments) => {
                    for comment in comments {
                        comments_map
                            .entry(comment.issue_id.clone())
                            .or_default()
                            .push(comment);
                    }
                }
                Err(_) => {
                    tracing::warn!("Failed to parse comments from bd sql, falling back to JSONL");
                    load_comments_from_jsonl(project_path, &mut comments_map);
                }
            }
        }
        Err(_) => {
            load_comments_from_jsonl(project_path, &mut comments_map);
        }
    }

    for bead in &mut beads {
        if let Some(bead_comments) = comments_map.remove(&bead.id) {
            bead.comments = Some(bead_comments);
        }
    }

    Ok(beads)
}

/// Returns `true` if a JSONL line is a non-issue record that should be skipped.
///
/// Newer `bd` versions append service records (e.g. `bd remember` memories)
/// into `issues.jsonl`, marked with a `_type` field and lacking an `id`.
/// These must not be parsed as beads. We treat the presence of a top-level
/// `_type` key as the discriminator so future record types are skipped too.
fn is_non_issue_record(line: &str) -> bool {
    matches!(
        serde_json::from_str::<serde_json::Value>(line),
        Ok(serde_json::Value::Object(ref obj)) if obj.contains_key("_type")
    )
}

/// Reads comments from .beads/issues.jsonl and inserts them into `comments_map`.
/// Used when `bd sql` is unavailable (embedded mode).
fn load_comments_from_jsonl(project_path: &Path, comments_map: &mut HashMap<String, Vec<Comment>>) {
    let issues_path = project_path.join(".beads").join("issues.jsonl");
    let jsonl_beads = match read_beads_from_jsonl(&issues_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("Failed to load comments from JSONL ({}); continuing without comments", e);
            return;
        }
    };
    for bead in jsonl_beads {
        if let Some(comments) = bead.comments {
            if !comments.is_empty() {
                comments_map.insert(bead.id, comments);
            }
        }
    }
}

/// Reads beads from the JSONL file (fallback when bd CLI is unavailable).
fn read_beads_from_jsonl(issues_path: &Path) -> Result<Vec<Bead>, String> {
    let contents = std::fs::read_to_string(issues_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let mut beads = Vec::new();
    for (line_num, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if is_non_issue_record(line) {
            tracing::debug!("Skipping non-issue record at line {}", line_num + 1);
            continue;
        }
        match serde_json::from_str::<Bead>(line) {
            Ok(bead) => beads.push(bead),
            Err(e) => {
                tracing::warn!("Failed to parse bead at line {}: {} - {}", line_num + 1, e, line);
            }
        }
    }
    Ok(beads)
}

/// Dolt-only path prefix: `dolt://beads_dbname`
const DOLT_PATH_PREFIX: &str = "dolt://";

/// The mark a closed bead carries when the work was dropped rather than done.
const CANCELLED_LABEL: &str = "cancelled";

/// The live stages, earliest first, each with every spelling bd may write.
const LIVE_STAGES: [(&str, &[&str]); 3] = [
    ("in_progress", &["in_progress"]),
    ("inreview", &["inreview", "in_review"]),
    ("manager_review", &["manager_review"]),
];

/// GET /api/beads?path=/path/to/project
/// GET /api/beads?path=dolt://beads_dbname
///
/// Reads beads from a project. For `dolt://` paths, reads directly from Dolt SQL.
/// For filesystem paths, uses three-tier fallback: Dolt SQL → bd CLI → JSONL.
///
/// On every successful read, the computed per-status bead counts are upserted
/// into the local SQLite cache (`project_bead_counts`) so `/api/projects` can
/// return them for instant home-page rendering. Cache writes are best-effort.
/// How long a board that has just been read is handed out again before it is
/// worth reading afresh.
///
/// Reading one costs a `bd` run — 0.6s on a quiet machine, 4.3s while other
/// agents are writing — and a screen asks for the same board from several
/// places at once: the columns, the counts, the search (bw-uiyz.9). Past this,
/// the board we hold is still handed back at once and the fresh read runs
/// behind the answer instead of in front of it (bw-uiyz.17). This app's own
/// writes clear what we hold outright, so the read after one of those waits.
const BOARD_MEMO: Duration = Duration::from_secs(30);

/// How many complete boards the server may retain.
///
/// A board is not a small cache record: the manager's board is 3,168 rich
/// cards and serializes to 6.29 MB before allocator overhead. Keeping every
/// project read during startup made the server's resting memory proportional
/// to the sum of every project ever registered. Two keeps the current board
/// and the one most likely to be switched back to without letting that sum
/// grow without bound.
const BOARD_CACHE_CAPACITY: usize = 2;

type SharedBoard = Arc<Vec<Bead>>;

#[derive(Serialize)]
#[serde(untagged)]
enum BoardAnswer {
    Cards {
        #[serde(serialize_with = "serialize_shared_board")]
        beads: SharedBoard,
        source: String,
    },
    Counts {
        counts: CachedCounts,
        source: String,
    },
    Error {
        error: String,
    },
}

fn board_error(error: impl Into<String>) -> Json<BoardAnswer> {
    Json(BoardAnswer::Error { error: error.into() })
}

fn serialize_shared_board<S>(board: &SharedBoard, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    board.as_slice().serialize(serializer)
}

/// The answer to a read: the cards themselves, or only how many there are.
fn board_answer(beads: SharedBoard, source: &str, counted: bool) -> Json<BoardAnswer> {
    if counted {
        return Json(BoardAnswer::Counts {
            counts: counts_of(&beads, source),
            source: source.to_string(),
        });
    }
    Json(BoardAnswer::Cards {
        beads,
        source: source.to_string(),
    })
}

/// The cards of a board that changed after a moment, or all of them if no
/// moment was asked about.
///
/// This is what a screen watching a board wants when the watcher tells it a
/// file moved: not the board again, only what moved in it. Answering it from
/// the board we already hold is the whole point — the ask used to be its own
/// `bd` run (bw-uiyz.13).
///
/// A card whose stamp cannot be read counts as changed. Handing back one card
/// too many costs the screen a redraw of that card; leaving one out leaves the
/// board wrong until something else happens to it.
fn changed_since(beads: SharedBoard, since: Option<&str>) -> SharedBoard {
    let Some(since) = since else { return beads };
    Arc::new(beads
        .iter()
        .filter(|bead| {
            let stamp = bead.updated_at.as_deref().or(bead.created_at.as_deref());
            stamp.is_none_or(|stamp| after(stamp, since))
        })
        .cloned()
        .collect())
}

/// Whether one stamp is later than another.
///
/// Both are written by `bd`, so they are the same shape and comparing the text
/// would do — but a stamp in one zone and a moment in another compare as text
/// to nonsense, so they are read as times when they can be read at all.
fn after(stamp: &str, since: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(stamp),
        chrono::DateTime::parse_from_rfc3339(since),
    ) {
        (Ok(stamp), Ok(since)) => stamp > since,
        _ => stamp > since,
    }
}

struct HeldBoard {
    at: Instant,
    source: String,
    beads: SharedBoard,
}

/// Complete boards kept ready, newest use first.
#[derive(Default)]
struct BoardCache {
    entries: HashMap<String, HeldBoard>,
    recency: VecDeque<String>,
}

impl BoardCache {
    fn get(&mut self, path: &str) -> Option<(SharedBoard, String, bool)> {
        let held = self.entries.get(path)?;
        let answer = (
            Arc::clone(&held.beads),
            held.source.clone(),
            held.at.elapsed() < BOARD_MEMO,
        );
        self.recency.retain(|held| held != path);
        self.recency.push_front(path.to_string());
        Some(answer)
    }

    fn insert(&mut self, path: String, source: String, beads: SharedBoard) {
        self.recency.retain(|held| held != &path);
        self.recency.push_front(path.clone());
        self.entries.insert(path, HeldBoard { at: Instant::now(), source, beads });
        while self.entries.len() > BOARD_CACHE_CAPACITY {
            if let Some(oldest) = self.recency.pop_back() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn remove_matching(&mut self, path: &str) {
        self.entries.retain(|held, _| !held.starts_with(path) && !path.starts_with(held.as_str()));
        self.recency.retain(|held| self.entries.contains_key(held));
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.recency.clear();
    }
}

type Boards = Mutex<BoardCache>;

fn boards() -> &'static Boards {
    static BOARDS: OnceLock<Boards> = OnceLock::new();
    BOARDS.get_or_init(Boards::default)
}

/// Every board that has just been read again, for the screens watching it.
///
/// A read that happens behind a reader's back has nobody waiting on it, so the
/// screens have to be told it landed — otherwise a board read before the last
/// card moved would sit there until something else moved (bw-uiyz.17).
fn changed_boards() -> &'static tokio::sync::broadcast::Sender<String> {
    static CHANGED: OnceLock<tokio::sync::broadcast::Sender<String>> = OnceLock::new();
    CHANGED.get_or_init(|| tokio::sync::broadcast::channel(64).0)
}

/// Every board read again from now on, for a screen that wants telling.
pub fn boards_read_again() -> tokio::sync::broadcast::Receiver<String> {
    changed_boards().subscribe()
}

/// One reader per board at a time, so two arriving together cost one `bd` run:
/// the second waits, and then finds the first one's answer already kept.
type BoardGate = tokio::sync::Mutex<()>;
type Gates = Mutex<HashMap<String, Weak<BoardGate>>>;

fn gate_for(path: &str) -> Arc<BoardGate> {
    static GATES: OnceLock<Gates> = OnceLock::new();
    let gates = GATES.get_or_init(Gates::default);
    let mut held = gates.lock().unwrap_or_else(|e| e.into_inner());
    held.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = held.get(path).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(BoardGate::default());
    held.insert(path.to_string(), Arc::downgrade(&gate));
    gate
}

/// The board as it was last read, and whether that was recent enough to stand
/// on its own. An old one is still handed back — waiting for a `bd` run is the
/// whole of what a board open used to cost — but the caller reads it again
/// behind the answer (bw-uiyz.17).
fn kept_board(path: &str) -> Option<(SharedBoard, String, bool)> {
    boards().lock().unwrap_or_else(|e| e.into_inner()).get(path)
}

fn keep_board(path: &str, source: &str, beads: Vec<Bead>) -> SharedBoard {
    let beads = Arc::new(beads);
    boards().lock().unwrap_or_else(|e| e.into_inner()).insert(
        path.to_string(),
        source.to_string(),
        Arc::clone(&beads),
    );
    beads
}

/// Something changed a board, so what was read of it is no longer the truth.
///
/// Called by every route that writes a card and by the watcher that sees the
/// file move under us, whoever wrote it.
pub fn forget_board(project_path: &str) {
    let key = project_path.replace('\\', "/");
    // A path may be named to us in more than one way — a worktree, a symlink,
    // a trailing slash — and a card written under one name must not leave the
    // same board kept under another.
    boards().lock().unwrap_or_else(|e| e.into_inner()).remove_matching(&key);
}

/// Everything read of every board is thrown away: a command we did not write
/// has just run against one of them and we cannot tell which.
pub fn forget_all_boards() {
    boards().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

pub async fn read_beads(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<BeadsParams>,
) -> impl IntoResponse {
    // Normalize Windows backslashes to forward slashes
    let path = params.path.replace('\\', "/");

    let counted = params.counts.is_some();

    // Direct Dolt read for dolt:// paths (no filesystem needed)
    if let Some(db_name) = path.strip_prefix(DOLT_PATH_PREFIX) {
        if !dolt_manager.is_available() && !dolt_manager.check_server().await {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                board_error("Dolt server is not running"),
            );
        }
        return match dolt_manager.read_beads(db_name).await {
            Ok(beads) => {
                let beads = Arc::new(post_process_beads(beads));
                upsert_counts_cache(&db, &path, "dolt-direct", &beads);
                (StatusCode::OK, board_answer(beads, "dolt-direct", counted))
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                board_error(e.to_string()),
            ),
        };
    }

    let project_path = PathBuf::from(&path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&project_path) {
        return (
            StatusCode::FORBIDDEN,
            board_error(e),
        );
    }

    // Check that project has a .beads directory
    let beads_dir = project_path.join(".beads");
    if !beads_dir.exists() {
        return (
            StatusCode::NOT_FOUND,
            board_error("No .beads directory found at the specified path"),
        );
    }

    // Reading a whole board costs a `bd` run and about a second, and one screen
    // asks for the same board from several places at once (bw-uiyz.9). So reads
    // share: the board just read is handed straight back, and two asking at the
    // same moment cost one read between them rather than one each.
    //
    // A read of only what changed is answered out of that same board rather
    // than by a `bd` run of its own (bw-uiyz.13). It used to run one — unshared
    // and never kept — so every change to a busy board cost half a second for
    // every screen watching it, while the whole board beside it was handed back
    // in four milliseconds. The board is read whole and kept whole; what changed
    // is a question about what we already hold.
    //
    // A board we have read before is answered from it whatever its age, and if
    // it is old enough to be worth reading again that read runs behind the
    // answer (bw-uiyz.17). Only a board nobody has ever read is worth waiting
    // for, and the screens are told when the read behind lands.
    //
    // A count is always of the whole board: how many cards changed in the last
    // minute is not a count of anything the screen shows.
    let since = if counted {
        None
    } else {
        params.updated_after.as_deref()
    };
    if let Some((beads, source, fresh)) = kept_board(&path) {
        if !fresh {
            read_behind(dolt_manager.clone(), db.clone(), path.clone());
        }
        return (
            StatusCode::OK,
            board_answer(changed_since(beads, since), &source, counted),
        );
    }
    let gate = gate_for(&path);
    let _hold = gate.lock().await;
    // Whoever we waited behind has read it by now.
    if let Some((beads, source, _)) = kept_board(&path) {
        return (
            StatusCode::OK,
            board_answer(changed_since(beads, since), &source, counted),
        );
    }

    match read_board(&dolt_manager, &db, &path, &project_path, &beads_dir).await {
        Ok((beads, source)) => (
            StatusCode::OK,
            board_answer(changed_since(beads, since), source, counted),
        ),
        Err(failed) => failed,
    }
}

/// Reads a board again with nobody waiting on it, and tells the screens
/// watching it when that lands (bw-uiyz.17).
///
/// Answers whether anything was told. A board already being read has nothing
/// to gain from a second reader, so this stands aside for the one in flight.
/// Every board the reader has, read once behind their back as the program
/// starts.
///
/// The first read of a board costs a `bd` run whoever pays for it — 3.0s on
/// this machine — and until now the reader paid it, on whichever board they
/// opened first. Nobody is waiting here.
///
/// One at a time, most-recently-opened first: two `bd` runs at once fight
/// over the same board and each comes back slower, and the board the reader
/// is about to click is the one they left open last (bw-uiyz.18). A reader
/// who beats us to a board takes its gate, and the read ahead skips it rather
/// than queueing a second run behind theirs.
pub fn read_boards_ahead(dolt_manager: Arc<DoltManager>, db: Arc<Database>) {
    tokio::spawn(async move {
        let projects = match db.get_projects_filtered(false, false) {
            Ok(projects) => projects,
            Err(e) => {
                tracing::warn!("No boards read ahead, so the first board open waits: {e}");
                return;
            }
        };
        let started = Instant::now();
        let mut read = 0usize;
        for project in boards_to_read_ahead(&projects) {
            if refresh_board(&dolt_manager, &db, &project.path).await {
                read += 1;
            }
        }
        tracing::info!(
            "{read} of {} board(s) read ahead in {:?}",
            projects.len(),
            started.elapsed()
        );
    });
}

fn boards_to_read_ahead(projects: &[Project]) -> &[Project] {
    &projects[..projects.len().min(BOARD_CACHE_CAPACITY)]
}

pub async fn refresh_board(dolt_manager: &Arc<DoltManager>, db: &Arc<Database>, path: &str) -> bool {
    let path = path.replace('\\', "/");
    let project_path = PathBuf::from(&path);
    if validate_path_security(&project_path).is_err() {
        return false;
    }
    let beads_dir = project_path.join(".beads");
    if !beads_dir.exists() {
        return false;
    }

    let gate = gate_for(&path);
    let Ok(_hold) = gate.try_lock() else { return false };

    match read_board(dolt_manager, db, &path, &project_path, &beads_dir).await {
        Ok(_) => {
            let _ = changed_boards().send(path);
            true
        }
        Err(_) => false,
    }
}

/// Reads a board behind whoever just asked for it, so they wait for nothing.
fn read_behind(dolt_manager: Arc<DoltManager>, db: Arc<Database>, path: String) {
    tokio::spawn(async move {
        refresh_board(&dolt_manager, &db, &path).await;
    });
}

/// Reads a board from wherever it actually lives, and keeps what it read.
///
/// The caller holds the board's gate: this is the expensive part, and only one
/// of these runs per board at a time.
async fn read_board(
    dolt_manager: &Arc<DoltManager>,
    db: &Arc<Database>,
    path: &str,
    project_path: &Path,
    beads_dir: &Path,
) -> Result<(SharedBoard, &'static str), (StatusCode, Json<BoardAnswer>)> {
    // Tier 0: Try per-project Dolt server via port file or log
    // Tier 0: Try per-project Dolt server via port file or log
    if let Some(port) = resolve_dolt_port(beads_dir) {
        // Quick TCP probe: skip Tier 0 if port is dead (avoids slow SQL timeout)
        let port_alive = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)),
        ).await.map(|r| r.is_ok()).unwrap_or(false);

        if port_alive {
            // Try known db name first, then discover via SHOW DATABASES
            let db_name = match dolt::database_name_for_project(project_path) {
                Some(name) => Some(name),
                None => {
                    tracing::info!("No db name from metadata for port {}, discovering...", port);
                    dolt::discover_database_on_port(port).await.ok()
                }
            };

            if let Some(db_name) = db_name {
                tracing::info!("Trying per-project Dolt server on port {} for db {}", port, db_name);
                match dolt::read_beads_on_port(port, &db_name).await {
                    Ok(beads) => {
                        tracing::info!("Read {} beads from per-project Dolt (port {})", beads.len(), port);
                        let beads = post_process_beads(beads);
                        upsert_counts_cache(db, path, "dolt-project", &beads);
                        let beads = keep_board(path, "dolt-project", beads);
                        return Ok((beads, "dolt-project"));
                    }
                    Err(e) => {
                        tracing::warn!("Per-project Dolt server on port {} failed: {}, falling back", port, e);
                    }
                }
            }
        } else {
            tracing::debug!("Port {} not responding, skipping Tier 0 SQL", port);
        }
    }

    // Three-tier fallback: Dolt SQL → bd CLI → JSONL

    // Tier 1: Try Dolt SQL (direct MySQL connection)
    let (beads, source) = 'fallback: {
        if dolt_manager.is_available() {
            if let Some(db_name) = dolt::database_name_for_project(project_path) {
                match dolt_manager.read_beads(&db_name).await {
                    Ok(b) => break 'fallback (b, "dolt-central"),
                    Err(crate::dolt::DoltError::DatabaseNotFound(_)) => {
                        tracing::info!("Dolt database {} not found on SQL server, trying bd CLI", db_name);
                        // Don't skip CLI — bd can read from local .beads/dolt in direct mode
                    }
                    Err(e) => {
                        tracing::info!("Dolt SQL failed for {} ({}), trying bd CLI", db_name, e);
                    }
                }
            }
        }

        // Tier 2: Try bd CLI
        match read_beads_from_cli(project_path).await {
            Ok(b) => {
                tracing::info!("Read {} beads from bd CLI for {}", b.len(), path);
                break 'fallback (b, "cli");
            }
            Err(cli_err) => {
                tracing::warn!("bd CLI failed for {}: {}", path, cli_err);
            }
        }

        // Tier 3: JSONL file
        let issues_path = resolve_issues_path(project_path);
        if !issues_path.exists() {
            return Err((
                StatusCode::NOT_FOUND,
                board_error("No data source available: Dolt SQL, bd CLI, and JSONL all failed"),
            ));
        }
        match read_beads_from_jsonl(&issues_path) {
            Ok(b) => (b, "jsonl"),
            Err(e) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    board_error(e),
                ));
            }
        }
    };

    let beads = post_process_beads(beads);
    upsert_counts_cache(db, path, source, &beads);
    let beads = keep_board(path, source, beads);
    Ok((beads, source))
}

/// Request body for creating a new bead.
#[derive(Debug, Deserialize)]
pub struct CreateBeadRequest {
    /// Project path or `dolt://dbname`
    pub path: String,
    /// Bead title (required)
    pub title: String,
    /// Bead description (optional)
    pub description: Option<String>,
    /// Issue type: task, bug, feature, epic (default: task)
    pub issue_type: Option<String>,
    /// Priority 0-4 (default: 2)
    pub priority: Option<i32>,
    /// Parent bead ID (for subtasks)
    pub parent_id: Option<String>,
}

/// POST /api/beads/create
///
/// Creates a new bead. For `dolt://` paths, inserts directly via Dolt SQL.
/// For filesystem paths, delegates to `bd create` CLI.
pub async fn create_bead_handler(
    manager: Extension<Arc<DoltManager>>,
    req: Json<CreateBeadRequest>,
) -> impl IntoResponse {
    let board = req.path.clone();
    let answer = create_bead(manager, req).await;
    // The board now holds a card it did not before, whichever way the write
    // went, so nothing read of it before this may be handed out again.
    forget_board(&board);
    answer
}

async fn create_bead(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Json(req): Json<CreateBeadRequest>,
) -> impl IntoResponse {
    let title = req.title.trim();
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Title is required" })),
        );
    }

    let issue_type = req.issue_type.as_deref().unwrap_or("task");
    let priority = req.priority.unwrap_or(2).clamp(0, 4);

    // Dolt-only path: insert via SQL
    if let Some(db_name) = req.path.strip_prefix(DOLT_PATH_PREFIX) {
        if !dolt_manager.is_available() && !dolt_manager.check_server().await {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "error": "Dolt server is not running" })),
            );
        }

        // Generate a unique ID: prefix-shortid
        let prefix = db_name.strip_prefix("beads_").unwrap_or(db_name);
        let short_id = &Utc::now().timestamp_millis().to_string()[6..];
        let bead_id = format!("{}-{}", prefix, short_id);

        match dolt_manager.create_bead(
            db_name,
            &bead_id,
            title,
            req.description.as_deref(),
            issue_type,
            priority,
            req.parent_id.as_deref(),
        ).await {
            Ok(()) => {
                return (
                    StatusCode::CREATED,
                    Json(serde_json::json!({ "id": bead_id })),
                );
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": e.to_string() })),
                );
            }
        }
    }

    // Filesystem path: delegate to bd CLI
    let project_path = std::path::PathBuf::from(&req.path);
    if let Err(e) = validate_path_security(&project_path) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e })));
    }

    let mut args = vec![
        "create".to_string(),
        format!("--title={}", title),
    ];
    if let Some(ref desc) = req.description {
        if !desc.trim().is_empty() {
            args.push(format!("-d={}", desc));
        }
    }
    args.push(format!("--type={}", issue_type));
    args.push(format!("--priority={}", priority));
    if let Some(ref parent) = req.parent_id {
        args.push(format!("--parent={}", parent));
    }

    let Some(bd_path) = super::find_bd() else {
        super::forget_tools();
        return (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({ "error": super::BD_MISSING })));
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(bd_path).args(&args).current_dir(&project_path).output(),
    ).await;

    match result {
        Ok(Ok(output)) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Try to extract bead ID from CLI output
                let id = stdout.lines()
                    .find_map(|line| {
                        // bd create typically outputs the new bead ID
                        let trimmed = line.trim();
                        if !trimmed.is_empty() && !trimmed.starts_with("Created") {
                            Some(trimmed.to_string())
                        } else if trimmed.starts_with("Created") {
                            // "Created beads-xxx" pattern
                            trimmed.split_whitespace().last().map(|s| s.to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| stdout.trim().to_string());
                (StatusCode::CREATED, Json(serde_json::json!({ "id": id, "stdout": stdout.trim() })))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": stderr.trim() })))
            }
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Failed to execute bd: {}", e) })),
        ),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({ "error": "bd command timed out" })),
        ),
    }
}

/// Request body for updating a bead.
#[derive(Debug, Deserialize)]
pub struct UpdateBeadRequest {
    /// Project path or `dolt://dbname`
    pub path: String,
    /// Bead ID to update
    pub id: String,
    /// New title (optional)
    pub title: Option<String>,
    /// New description (optional)
    pub description: Option<String>,
    /// New status (optional)
    pub status: Option<String>,
    /// New issue type: task, bug, feature, epic (optional)
    pub issue_type: Option<String>,
    /// New priority 0-4 (optional)
    pub priority: Option<i32>,
    /// A label to add, left in place if already there (optional)
    pub add_label: Option<String>,
    /// A label to take off, ignored if it is not there (optional)
    pub remove_label: Option<String>,
}

fn lifecycle_status(status: Option<&str>) -> bool {
    matches!(status, Some("inreview" | "in_review" | "manager_review" | "closed"))
}

async fn lifecycle_denial(project: &Path, id: &str, status: &str) -> Option<String> {
    let local = project.join("machinery").join("hooks").join("board-status-gate.py");
    let installed = crate::identity::rules_dir()
        .map(|p| p.join("machinery").join("hooks").join("board-status-gate.py"));
    let Some(gate) = std::iter::once(local).chain(installed).find(|p| p.is_file()) else {
        return Some("Atelier cannot verify this lifecycle transition on this host; run project setup here first".to_string());
    };
    let input = serde_json::json!({
        "tool_name": "Bash",
        "tool_input": {"command": format!("bd update {} --status {}", id, status)},
        "cwd": project,
        "session_id": "atelier-api"
    });
    let Some(python) = super::find_python() else {
        super::forget_tools();
        return Some("Atelier found no python on this computer, and its lifecycle gate is written in it".to_string());
    };
    let mut child = match Command::new(python)
        .arg(gate).current_dir(project).stdin(Stdio::piped())
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
    {
        Ok(child) => child,
        Err(e) => return Some(format!("Atelier could not run its lifecycle gate: {e}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(input.to_string().as_bytes()).await {
            return Some(format!("Atelier could not ask its lifecycle gate: {e}"));
        }
    }
    let output = match tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Some(format!("Atelier's lifecycle gate failed: {e}")),
        Err(_) => return Some("Atelier's lifecycle gate timed out".to_string()),
    };
    if !output.status.success() {
        return Some(format!("Atelier's lifecycle gate failed: {}",
                            String::from_utf8_lossy(&output.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let answer: serde_json::Value = match serde_json::from_str(text.trim()) {
        Ok(answer) => answer,
        Err(_) if text.trim().is_empty() => return None,
        Err(_) => return Some("Atelier's lifecycle gate returned an unreadable answer".to_string()),
    };
    answer.pointer("/hookSpecificOutput/permissionDecision")
        .and_then(|v| v.as_str()).filter(|v| *v == "deny")
        .map(|_| answer.pointer("/hookSpecificOutput/permissionDecisionReason")
             .and_then(|v| v.as_str()).unwrap_or("The lifecycle gate rejected this transition")
             .to_string())
}

/// PATCH /api/beads/update
///
/// Updates a bead's fields. For `dolt://` paths, updates via Dolt SQL.
/// For filesystem paths, delegates to `bd update` CLI.
pub async fn update_bead_handler(
    manager: Extension<Arc<DoltManager>>,
    req: Json<UpdateBeadRequest>,
) -> impl IntoResponse {
    let board = req.path.clone();
    let answer = update_bead(manager, req).await;
    forget_board(&board);
    answer
}

async fn update_bead(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Json(req): Json<UpdateBeadRequest>,
) -> impl IntoResponse {
    if req.id.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Bead ID is required" })),
        );
    }

    let has_changes = req.title.is_some()
        || req.description.is_some()
        || req.status.is_some()
        || req.issue_type.is_some()
        || req.priority.is_some()
        || req.add_label.is_some()
        || req.remove_label.is_some();
    if !has_changes {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "No fields to update" })),
        );
    }

    if let Some(p) = req.priority {
        if !(0..=4).contains(&p) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Priority must be between 0 and 4" })),
            );
        }
    }

    if lifecycle_status(req.status.as_deref()) && req.path.starts_with(DOLT_PATH_PREFIX) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "Atelier cannot verify commit and merge prerequisites from a board-only Dolt address; update through the project on the host that owns its checkout"
            })),
        );
    }

    // Dolt-only path: update via SQL
    if let Some(db_name) = req.path.strip_prefix(DOLT_PATH_PREFIX) {
        if !dolt_manager.is_available() && !dolt_manager.check_server().await {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({ "error": "Dolt server is not running" })),
            );
        }

        match dolt_manager.update_bead(
            db_name,
            &req.id,
            req.title.as_deref(),
            req.description.as_deref(),
            req.status.as_deref(),
            req.issue_type.as_deref(),
            req.priority,
            req.add_label.as_deref(),
            req.remove_label.as_deref(),
        ).await {
            Ok(()) => {
                return (StatusCode::OK, Json(serde_json::json!({ "success": true })));
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": e.to_string() })),
                );
            }
        }
    }

    // Filesystem path: delegate to bd CLI
    let project_path = std::path::PathBuf::from(&req.path);
    if let Err(e) = validate_path_security(&project_path) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e })));
    }
    if let Some(status) = req.status.as_deref().filter(|_| lifecycle_status(req.status.as_deref())) {
        if let Some(reason) = lifecycle_denial(&project_path, &req.id, status).await {
            return (StatusCode::CONFLICT, Json(serde_json::json!({ "error": reason })));
        }
    }

    // Build bd update args
    let mut args = vec!["update".to_string(), req.id.clone()];
    if let Some(ref t) = req.title {
        args.push(format!("--title={}", t));
    }
    if let Some(ref d) = req.description {
        args.push(format!("-d={}", d));
    }
    if let Some(ref s) = req.status {
        args.push(format!("--status={}", s));
    }
    if let Some(ref t) = req.issue_type {
        args.push(format!("--type={}", t));
    }
    if let Some(p) = req.priority {
        args.push(format!("--priority={}", p));
    }
    if let Some(ref l) = req.add_label {
        args.push(format!("--add-label={}", l));
    }
    if let Some(ref l) = req.remove_label {
        args.push(format!("--remove-label={}", l));
    }

    let Some(bd_path) = super::find_bd() else {
        super::forget_tools();
        return (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({ "error": super::BD_MISSING })));
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(bd_path).args(&args).current_dir(&project_path).output(),
    ).await;

    match result {
        Ok(Ok(output)) => {
            if output.status.success() {
                (StatusCode::OK, Json(serde_json::json!({ "success": true })))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": stderr.trim() })))
            }
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Failed to execute bd: {}", e) })),
        ),
        Err(_) => (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({ "error": "bd command timed out" })),
        ),
    }
}

/// Post-processes beads: resolves dependencies, infers parent-child from ID patterns, sets children.
fn post_process_beads(mut beads: Vec<Bead>) -> Vec<Bead> {
    let mut parent_to_children: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    // First pass: Extract relationships from dependencies (both old and new format)
    for bead in &mut beads {
        if let Some(raw_deps) = bead.dependencies.take() {
            match raw_deps {
                RawDependencies::Legacy(legacy_deps) => {
                    let mut blocking = Vec::new();
                    let mut related = Vec::new();
                    for dep in &legacy_deps {
                        match dep.dep_type.as_str() {
                            "parent-child" => {
                                bead.parent_id = Some(dep.depends_on_id.clone());
                                parent_to_children
                                    .entry(dep.depends_on_id.clone())
                                    .or_default()
                                    .push(bead.id.clone());
                            }
                            "relates-to" => {
                                related.push(dep.depends_on_id.clone());
                            }
                            _ => {
                                blocking.push(dep.depends_on_id.clone());
                            }
                        }
                    }
                    if !blocking.is_empty() && bead.deps.is_none() {
                        bead.deps = Some(blocking);
                    }
                    if !related.is_empty() && bead.relates_to.is_none() {
                        bead.relates_to = Some(related);
                    }
                }
                RawDependencies::StringIds(ids) => {
                    if !ids.is_empty() && bead.deps.is_none() {
                        bead.deps = Some(ids);
                    }
                }
            }
        }

        if let Some(parent_id) = &bead.parent_id {
            parent_to_children
                .entry(parent_id.clone())
                .or_default()
                .push(bead.id.clone());
        }
    }

    for children in parent_to_children.values_mut() {
        children.sort();
        children.dedup();
    }

    // Second pass: Infer parent-child from ID patterns (e.g., "64n.1" -> parent "64n")
    let bead_ids: std::collections::HashSet<String> =
        beads.iter().map(|b| b.id.clone()).collect();

    let inferred: Vec<(String, String)> = beads
        .iter()
        .filter_map(|bead| {
            if bead.parent_id.is_some() {
                return None;
            }
            let dot_pos = bead.id.rfind('.')?;
            let potential_parent = &bead.id[..dot_pos];
            if bead_ids.contains(potential_parent) {
                Some((bead.id.clone(), potential_parent.to_string()))
            } else {
                None
            }
        })
        .collect();

    for (child_id, inferred_parent_id) in &inferred {
        if let Some(bead) = beads.iter_mut().find(|b| &b.id == child_id) {
            bead.parent_id = Some(inferred_parent_id.clone());
        }
        parent_to_children
            .entry(inferred_parent_id.clone())
            .or_default()
            .push(child_id.clone());
    }

    // Third pass: Set children on parent beads
    for bead in &mut beads {
        if let Some(children) = parent_to_children.get(&bead.id) {
            bead.children = Some(children.clone());
        }
    }

    beads
}

/// Computes the appropriate status for an epic based on its children's statuses.
///
/// The first live stage any child still stands in, in LIVE_STAGES order, which
/// is the order src/lib/bead-utils.ts places a card by; then all-closed reads as
/// inreview and all-open as open. An epic is never auto-closed.
fn compute_epic_status_from_children(child_statuses: &[&str]) -> Option<&'static str> {
    if child_statuses.is_empty() {
        return None;
    }

    for (stage, spellings) in LIVE_STAGES {
        if child_statuses.iter().any(|s| spellings.contains(s)) {
            return Some(stage);
        }
    }

    if child_statuses.iter().all(|s| *s == "closed") {
        return Some("inreview");
    }

    if child_statuses.iter().all(|s| *s == "open") {
        return Some("open");
    }

    None
}

/// Recomputes and updates epic statuses based on their children's statuses.
///
/// This function reads the issues.jsonl file, finds all epics with children,
/// computes the appropriate status for each epic based on its children,
/// and writes back the file if any epic status changed.
///
/// # Arguments
///
/// * `issues_path` - Path to the .beads/issues.jsonl file
///
/// # Returns
///
/// * `Ok(Vec<String>)` - List of epic IDs that were updated
/// * `Err(String)` - Error message if something went wrong
pub fn recompute_epic_statuses(issues_path: &Path) -> Result<Vec<String>, String> {
    // Skip if JSONL doesn't exist (Dolt mode — bd manages its own data)
    if !issues_path.exists() {
        return Ok(vec![]);
    }

    // Read the file contents
    let contents = std::fs::read_to_string(issues_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    // Parse JSONL as both raw Values (for lossless write-back) and Beads (for logic)
    let mut raw_lines: Vec<serde_json::Value> = Vec::new();
    let mut beads: Vec<Bead> = Vec::new();
    for (line_num, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) => {
                // Skip non-issue service records (e.g. `bd remember` memories),
                // but keep them in raw_lines for lossless write-back.
                if value
                    .as_object()
                    .is_some_and(|o| o.contains_key("_type"))
                {
                    raw_lines.push(value);
                    continue;
                }
                match serde_json::from_value::<Bead>(value.clone()) {
                    Ok(bead) => beads.push(bead),
                    Err(e) => {
                        tracing::warn!(
                            "Failed to parse bead at line {}: {}",
                            line_num + 1,
                            e
                        );
                    }
                }
                raw_lines.push(value);
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to parse JSON at line {}: {}",
                    line_num + 1,
                    e
                );
            }
        }
    }

    // Build parent-child relationships
    let mut parent_to_children: HashMap<String, Vec<String>> = HashMap::new();

    // First pass: Extract from dependencies and parent field
    for bead in &mut beads {
        if let Some(RawDependencies::Legacy(ref legacy_deps)) = bead.dependencies {
            for dep in legacy_deps {
                if dep.dep_type == "parent-child" {
                    bead.parent_id = Some(dep.depends_on_id.clone());
                    parent_to_children
                        .entry(dep.depends_on_id.clone())
                        .or_default()
                        .push(bead.id.clone());
                }
            }
        }

        if let Some(parent_id) = &bead.parent_id {
            let children = parent_to_children.entry(parent_id.clone()).or_default();
            if !children.contains(&bead.id) {
                children.push(bead.id.clone());
            }
        }
    }

    // Second pass: Infer parent-child from ID patterns
    let bead_ids: std::collections::HashSet<String> =
        beads.iter().map(|b| b.id.clone()).collect();

    for bead in &beads {
        if bead.parent_id.is_none() && bead.id.contains('.') {
            if let Some(dot_pos) = bead.id.rfind('.') {
                let potential_parent = &bead.id[..dot_pos];
                if bead_ids.contains(potential_parent) {
                    let children = parent_to_children
                        .entry(potential_parent.to_string())
                        .or_default();
                    if !children.contains(&bead.id) {
                        children.push(bead.id.clone());
                    }
                }
            }
        }
    }

    // Build status map
    let status_map: HashMap<String, String> = beads
        .iter()
        .map(|b| (b.id.clone(), b.status.clone()))
        .collect();

    // Find which epics need updates
    let mut epic_updates: Vec<(String, String)> = Vec::new();

    for bead in &beads {
        if bead.issue_type.as_deref() != Some("epic") {
            continue;
        }
        if bead.status == "closed" {
            continue;
        }
        let children = match parent_to_children.get(&bead.id) {
            Some(c) => c,
            None => continue,
        };
        let child_statuses: Vec<&str> = children
            .iter()
            .filter_map(|child_id| status_map.get(child_id).map(String::as_str))
            .collect();
        if let Some(new_status) = compute_epic_status_from_children(&child_statuses) {
            if bead.status != new_status {
                epic_updates.push((bead.id.clone(), new_status.to_string()));
            }
        }
    }

    // Apply updates to raw JSON values (preserving original field names)
    let mut updated_epic_ids: Vec<String> = Vec::new();

    for (epic_id, new_status) in &epic_updates {
        for value in &mut raw_lines {
            if let Some(obj) = value.as_object_mut() {
                if obj.get("id").and_then(|v| v.as_str()) == Some(epic_id) {
                    tracing::info!(
                        "Updating epic {} status to {}",
                        epic_id,
                        new_status
                    );
                    obj.insert("status".to_string(), serde_json::json!(new_status));
                    obj.insert("updated_at".to_string(), serde_json::json!(Utc::now().to_rfc3339()));
                    updated_epic_ids.push(epic_id.clone());
                    break;
                }
            }
        }
    }

    // Write back if any epic was updated (using raw values to preserve format)
    if !updated_epic_ids.is_empty() {
        let file = std::fs::File::create(issues_path)
            .map_err(|e| format!("Failed to open file for writing: {}", e))?;

        let mut writer = std::io::BufWriter::new(file);
        for value in &raw_lines {
            let json_line = serde_json::to_string(value)
                .map_err(|e| format!("Failed to serialize: {}", e))?;
            writeln!(writer, "{}", json_line)
                .map_err(|e| format!("Failed to write to file: {}", e))?;
        }
        writer
            .flush()
            .map_err(|e| format!("Failed to flush file: {}", e))?;
    }

    Ok(updated_epic_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_non_issue_record_memory() {
        assert!(is_non_issue_record(
            r#"{"_type":"memory","key":"k","value":"v"}"#
        ));
    }

    #[test]
    fn test_is_non_issue_record_issue() {
        assert!(!is_non_issue_record(
            r#"{"id":"x-1","title":"T","status":"open"}"#
        ));
    }

    #[test]
    fn test_is_non_issue_record_garbage() {
        assert!(!is_non_issue_record("not json"));
    }

    /// One card, stamped.
    fn stamped(id: &str, updated_at: Option<&str>) -> Bead {
        let mut bead: Bead = serde_json::from_str(
            r#"{"id":"x","title":"T","status":"open","priority":2}"#,
        )
        .unwrap();
        bead.id = id.to_string();
        bead.updated_at = updated_at.map(str::to_string);
        bead
    }

    fn ids(beads: SharedBoard) -> Vec<String> {
        beads.iter().map(|b| b.id.clone()).collect()
    }

    fn one_card(id: &str) -> SharedBoard {
        Arc::new(vec![stamped(id, Some("2026-08-20T09:00:00Z"))])
    }

    #[test]
    fn board_cache_keeps_only_the_two_most_recently_used_boards() {
        let mut cache = BoardCache::default();
        cache.insert("one".into(), "cli".into(), one_card("one"));
        cache.insert("two".into(), "cli".into(), one_card("two"));
        cache.get("one").expect("using one makes it most recent");
        cache.insert("three".into(), "cli".into(), one_card("three"));

        assert_eq!(cache.entries.len(), BOARD_CACHE_CAPACITY);
        assert!(cache.entries.contains_key("one"));
        assert!(cache.entries.contains_key("three"));
        assert!(!cache.entries.contains_key("two"), "the least recent board is forgotten");

        let projects = (0..4)
            .map(|n| Project {
                id: n.to_string(),
                name: format!("project-{n}"),
                path: format!("/project-{n}"),
                local_path: None,
                last_opened: format!("2026-08-2{n}T00:00:00Z"),
                created_at: "2026-08-20T00:00:00Z".into(),
                archived_at: None,
                is_test: false,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            boards_to_read_ahead(&projects).iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["0", "1"],
            "startup reads only the most-recent projects that fit in memory",
        );
    }

    #[test]
    fn cached_board_reuses_the_same_cards_without_a_deep_copy() {
        let mut cache = BoardCache::default();
        let original = one_card("large");
        cache.insert("large".into(), "cli".into(), Arc::clone(&original));

        let (first, _, _) = cache.get("large").expect("held");
        let (second, _, _) = cache.get("large").expect("held again");

        assert!(Arc::ptr_eq(&original, &first));
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(Arc::strong_count(&original), 4, "one allocation is shared by the cache and callers");

        let encoded = serde_json::to_value(BoardAnswer::Cards {
            beads: Arc::clone(&original),
            source: "cli".into(),
        })
        .expect("the shared board serializes");
        assert_eq!(encoded["source"], "cli");
        assert_eq!(encoded["beads"][0]["id"], "large");
        assert_eq!(encoded.as_object().expect("object").len(), 2, "the API shape does not change");
    }

    #[test]
    fn a_read_of_what_changed_is_answered_from_the_board_already_read() {
        let path = "/tmp/a-board-that-was-read";
        keep_board(
            path,
            "cli",
            vec![
                stamped("old-1", Some("2026-08-19T10:00:00Z")),
                stamped("moved-1", Some("2026-08-20T09:00:00Z")),
            ],
        );

        let (beads, source, fresh) = kept_board(path).expect("the board just read is kept");
        assert_eq!(source, "cli");
        assert!(fresh, "a board read a moment ago stands on its own");
        assert_eq!(
            ids(changed_since(beads, Some("2026-08-20T00:00:00Z"))),
            vec!["moved-1"],
            "only what moved since the moment asked about"
        );
    }

    #[test]
    fn a_board_read_once_is_handed_back_however_old_it_is() {
        // The whole of what a board open used to wait for is a `bd` run —
        // 0.6s quiet, 4.3s while other agents write. Past the memo the board
        // we hold is still handed back at once; it is only marked stale, and
        // the caller reads it again behind the answer (bw-uiyz.17).
        let path = "/tmp/a-board-nobody-has-read-lately";
        keep_board(path, "cli", vec![stamped("still-here", Some("2026-08-19T10:00:00Z"))]);
        {
            let mut kept = boards().lock().unwrap();
            let held = kept.entries.get_mut(path).expect("kept");
            held.at = Instant::now()
                .checked_sub(BOARD_MEMO + Duration::from_secs(1))
                .expect("a moment before the memo ran out");
        }

        let (beads, source, fresh) = kept_board(path).expect("an old board is still a board");
        assert_eq!(source, "cli");
        assert_eq!(ids(beads), vec!["still-here"]);
        assert!(!fresh, "and the caller is told to read it again behind the answer");
    }

    #[test]
    fn no_moment_asked_about_means_the_whole_board() {
        let board = Arc::new(vec![
            stamped("a", Some("2026-08-19T10:00:00Z")),
            stamped("b", Some("2026-08-20T09:00:00Z")),
        ]);
        assert_eq!(ids(changed_since(board, None)), vec!["a", "b"]);
    }

    #[test]
    fn a_card_with_no_stamp_counts_as_changed() {
        // Leaving it out would leave the board wrong until something else
        // happened to that card; one extra card costs one redraw.
        let board = Arc::new(vec![stamped("nameless", None)]);
        assert_eq!(ids(changed_since(board, Some("2026-08-20T00:00:00Z"))), vec!["nameless"]);
    }

    #[test]
    fn a_stamp_and_a_moment_in_different_zones_are_still_compared_as_times() {
        // 09:00 in Karachi is 04:00 UTC — earlier than the moment asked about,
        // though the text of it sorts later.
        let board = Arc::new(vec![stamped("karachi-morning", Some("2026-08-20T09:00:00+05:00"))]);
        assert!(changed_since(board, Some("2026-08-20T06:00:00Z")).is_empty());
        let board = Arc::new(vec![stamped("karachi-evening", Some("2026-08-20T18:00:00+05:00"))]);
        assert_eq!(
            ids(changed_since(board, Some("2026-08-20T06:00:00Z"))),
            vec!["karachi-evening"]
        );
    }

    #[test]
    fn test_parse_bead() {
        let json = r#"{"id":"test-123","title":"Test Bead","status":"open","priority":2}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert_eq!(bead.id, "test-123");
        assert_eq!(bead.title, "Test Bead");
        assert_eq!(bead.status, "open");
        assert_eq!(bead.priority, Some(2));
    }

    #[test]
    fn test_parse_bead_with_comments() {
        let json = r#"{"id":"test-456","title":"With Comments","status":"closed","comments":[{"id":1,"issue_id":"test-456","author":"user","text":"A comment","created_at":"2026-01-01T00:00:00Z"}]}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert_eq!(bead.comments.as_ref().unwrap().len(), 1);
        assert_eq!(bead.comments.as_ref().unwrap()[0].text, "A comment");
    }

    #[test]
    fn test_parse_bead_with_design_and_notes() {
        let json = r#"{"id":"test-789","title":"With Design","status":"open","design":"some design notes","notes":"some extra notes"}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert_eq!(bead.design, Some("some design notes".to_string()));
        assert_eq!(bead.notes, Some("some extra notes".to_string()));
    }

    #[test]
    fn test_compute_epic_status_any_in_progress() {
        // Any child in_progress -> Epic in_progress
        let statuses = vec!["open", "in_progress", "closed"];
        assert_eq!(
            compute_epic_status_from_children(&statuses),
            Some("in_progress")
        );
    }

    #[test]
    fn test_compute_epic_status_all_open() {
        // All children open -> Epic open
        let statuses = vec!["open", "open", "open"];
        assert_eq!(compute_epic_status_from_children(&statuses), Some("open"));
    }

    #[test]
    fn test_compute_epic_status_all_inreview_or_closed_with_inreview() {
        // All children inreview or closed (with at least one inreview) -> Epic inreview
        let statuses = vec!["inreview", "closed", "inreview"];
        assert_eq!(
            compute_epic_status_from_children(&statuses),
            Some("inreview")
        );
    }

    #[test]
    fn test_compute_epic_status_all_closed() {
        // All children closed -> Epic should be inreview (ready for final review)
        let statuses = vec!["closed", "closed"];
        assert_eq!(compute_epic_status_from_children(&statuses), Some("inreview"));
    }

    #[test]
    fn test_compute_epic_status_mixed_open_closed() {
        // Mixed open and closed (no in_progress or inreview) -> No change
        let statuses = vec!["open", "closed"];
        assert_eq!(compute_epic_status_from_children(&statuses), None);
    }

    #[test]
    fn test_compute_epic_status_empty() {
        // No children -> No change
        let statuses: Vec<&str> = vec![];
        assert_eq!(compute_epic_status_from_children(&statuses), None);
    }

    #[test]
    fn test_compute_epic_status_single_in_progress() {
        let statuses = vec!["in_progress"];
        assert_eq!(
            compute_epic_status_from_children(&statuses),
            Some("in_progress")
        );
    }

    #[test]
    fn test_compute_epic_status_single_inreview() {
        let statuses = vec!["inreview"];
        assert_eq!(
            compute_epic_status_from_children(&statuses),
            Some("inreview")
        );
    }

    #[test]
    fn test_infer_parent_from_id_pattern() {
        // Test the ID pattern inference logic
        // Bead "64n.1" should be inferred as child of "64n" if parent exists
        let bead_id = "64n.1";
        let dot_pos = bead_id.rfind('.');
        assert!(dot_pos.is_some());
        let parent_id = &bead_id[..dot_pos.unwrap()];
        assert_eq!(parent_id, "64n");
    }

    #[test]
    fn test_infer_parent_multiple_dots() {
        // Test that we extract the correct parent when ID has multiple dots
        // Bead "prefix.64n.1" should have parent "prefix.64n"
        let bead_id = "prefix.64n.1";
        let dot_pos = bead_id.rfind('.');
        assert!(dot_pos.is_some());
        let parent_id = &bead_id[..dot_pos.unwrap()];
        assert_eq!(parent_id, "prefix.64n");
    }

    #[test]
    fn test_no_inference_without_dot() {
        // Bead without dot should not have inferred parent
        let bead_id = "simple-id";
        let dot_pos = bead_id.rfind('.');
        assert!(dot_pos.is_none());
    }

    #[test]
    fn test_parse_old_format_dependencies() {
        // Old format: dependencies as array of objects
        let json = r#"{"id":"bead-a","title":"Bead A","status":"open","dependencies":[{"issue_id":"bead-a","depends_on_id":"bead-b","type":"relates-to","created_at":"2026-01-27T00:00:00Z","created_by":"user"},{"issue_id":"bead-a","depends_on_id":"bead-c","type":"parent-child","created_at":"2026-01-27T00:00:00Z","created_by":"user"}]}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert!(bead.dependencies.is_some());
        if let Some(RawDependencies::Legacy(deps)) = &bead.dependencies {
            assert_eq!(deps.len(), 2);
            assert_eq!(deps[0].dep_type, "relates-to");
            assert_eq!(deps[0].depends_on_id, "bead-b");
            assert_eq!(deps[1].dep_type, "parent-child");
        } else {
            panic!("Expected Legacy dependencies");
        }
    }

    #[test]
    fn test_parse_new_format_dependencies() {
        // New format: dependencies as array of strings
        let json = r#"{"id":"task-71","title":"New Task","status":"open","parent":"epic-65","dependencies":["task-67"],"related":["task-35"]}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        // parent field should be deserialized into parent_id
        assert_eq!(bead.parent_id, Some("epic-65".to_string()));
        // related field should be deserialized into relates_to
        assert_eq!(bead.relates_to, Some(vec!["task-35".to_string()]));
        // dependencies should be parsed as StringIds
        if let Some(RawDependencies::StringIds(ids)) = &bead.dependencies {
            assert_eq!(ids, &vec!["task-67".to_string()]);
        } else {
            panic!("Expected StringIds dependencies");
        }
    }

    #[test]
    fn test_parse_new_format_closed_at_camel_case() {
        // New format uses closedAt instead of closed_at
        let json = r#"{"id":"task-67","title":"Done","status":"closed","closedAt":"2026-02-28T12:53:27.963Z"}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert_eq!(bead.closed_at, Some("2026-02-28T12:53:27.963Z".to_string()));
    }

    #[test]
    fn test_parse_empty_dependencies_array() {
        // Empty dependencies array should parse as None
        let json = r#"{"id":"task-1","title":"No deps","status":"open","dependencies":[]}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert!(bead.dependencies.is_none());
    }

    #[test]
    fn test_parse_no_dependencies_field() {
        // Missing dependencies field should parse fine
        let json = r#"{"id":"task-2","title":"Simple","status":"open"}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert!(bead.dependencies.is_none());
    }

    #[test]
    fn test_relates_to_serialized_in_json() {
        // Test that relates_to is included in serialized JSON output
        // (unlike dependencies which has skip_serializing)
        let bead = Bead {
            id: "bead-s".to_string(),
            title: "Serialization Test".to_string(),
            description: None,
            status: "open".to_string(),
            priority: None,
            issue_type: None,
            owner: None,
            created_at: None,
            created_by: None,
            updated_at: None,
            closed_at: None,
            close_reason: None,
            comments: None,
            parent_id: None,
            children: None,
            design: None,
            notes: None,
            deps: None,
            relates_to: Some(vec!["bead-r1".to_string(), "bead-r2".to_string()]),
            labels: None,
            dependencies: None,
        };

        let json = serde_json::to_string(&bead).unwrap();

        // relates_to SHOULD be serialized
        assert!(json.contains("relates_to"));
        assert!(json.contains("bead-r1"));
        assert!(json.contains("bead-r2"));

        // dependencies should NOT be serialized (skip_serializing)
        assert!(!json.contains("dependencies"));
    }

    #[test]
    fn test_parse_real_new_format_line() {
        // Real line from updated bd CLI
        let json = r#"{"id":"ai-photo-factory-71","title":"Миграция лендинга","description":"Описание задачи","status":"open","priority":2,"issue_type":"task","owner":"user@email.com","created_at":"2026-02-28T11:30:26.430Z","created_by":"weselow","updated_at":"2026-02-28T11:30:26.430Z","parent":"ai-photo-factory-65","dependencies":["ai-photo-factory-67"]}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert_eq!(bead.id, "ai-photo-factory-71");
        assert_eq!(bead.parent_id, Some("ai-photo-factory-65".to_string()));
        if let Some(RawDependencies::StringIds(ids)) = &bead.dependencies {
            assert_eq!(ids, &vec!["ai-photo-factory-67".to_string()]);
        } else {
            panic!("Expected StringIds dependencies");
        }
    }

    #[test]
    fn test_parse_new_format_with_related() {
        // New format with related field
        let json = r#"{"id":"task-75","title":"Post-processing","status":"open","parent":"epic-65","dependencies":["task-66"],"related":["task-35"]}"#;
        let bead: Bead = serde_json::from_str(json).unwrap();
        assert_eq!(bead.relates_to, Some(vec!["task-35".to_string()]));
        assert_eq!(bead.parent_id, Some("epic-65".to_string()));
    }

    #[test]
    fn test_roundtrip_via_raw_value_preserves_format() {
        // Simulate what add_comment and recompute_epic_statuses now do:
        // parse as serde_json::Value, modify, write back
        let input = r#"{"id":"task-71","title":"Migration","status":"open","parent":"epic-65","dependencies":["task-67"],"related":["task-35"],"closedAt":"2026-02-28T12:00:00Z"}"#;

        // Parse as raw Value (as server now does)
        let value: serde_json::Value = serde_json::from_str(input).unwrap();

        // Serialize back
        let output = serde_json::to_string(&value).unwrap();

        println!("INPUT:  {}", input);
        println!("OUTPUT: {}", output);

        // All original field names must be preserved
        assert!(output.contains("\"parent\":\"epic-65\""), "parent field preserved");
        assert!(output.contains("\"dependencies\":[\"task-67\"]"), "dependencies preserved");
        assert!(output.contains("\"related\":[\"task-35\"]"), "related field preserved");
        assert!(output.contains("\"closedAt\":\"2026-02-28T12:00:00Z\""), "closedAt preserved");

        // No mangled field names
        assert!(!output.contains("parent_id"), "no parent_id in output");
        assert!(!output.contains("relates_to"), "no relates_to in output");
        assert!(!output.contains("closed_at"), "no closed_at in output");
    }

    // ── resolve_issues_path tests ──────────────────────────────────────

    #[test]
    fn test_resolve_no_config_file() {
        // When .beads/config.yaml does not exist, fall back to default
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        std::fs::create_dir_all(project.join(".beads")).unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_empty_config_file() {
        // Empty config file -> default path
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(beads_dir.join("config.yaml"), "").unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_commented_out_sync_branch() {
        // sync-branch is commented out -> default path
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "# sync-branch: \"beads-sync\"\n",
        )
        .unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_valid_sync_branch() {
        // Valid sync-branch with existing worktree dir -> sync path
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();

        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: \"beads-sync\"\n",
        )
        .unwrap();

        // Create the worktree directory
        let worktree_beads = project
            .join(".git")
            .join("beads-worktrees")
            .join("beads-sync")
            .join(".beads");
        std::fs::create_dir_all(&worktree_beads).unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, worktree_beads.join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_malformed_yaml() {
        // Malformed YAML -> default path
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: [invalid: yaml: {{\n",
        )
        .unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_worktree_dir_missing() {
        // sync-branch set but worktree directory does not exist -> default
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: \"nonexistent-branch\"\n",
        )
        .unwrap();
        // Do NOT create .git/beads-worktrees/nonexistent-branch

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_spaces_in_branch_name() {
        // Branch name with spaces (unusual but valid YAML string)
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: \"my branch\"\n",
        )
        .unwrap();

        let worktree_dir = project
            .join(".git")
            .join("beads-worktrees")
            .join("my branch");
        std::fs::create_dir_all(&worktree_dir).unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(
            result,
            worktree_dir.join(".beads").join("issues.jsonl")
        );
    }

    #[test]
    fn test_resolve_empty_string_sync_branch() {
        // sync-branch set to empty string -> default path
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: \"\"\n",
        )
        .unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_sync_branch_without_quotes() {
        // YAML allows unquoted strings
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: beads-sync\n",
        )
        .unwrap();

        let worktree_beads = project
            .join(".git")
            .join("beads-worktrees")
            .join("beads-sync")
            .join(".beads");
        std::fs::create_dir_all(&worktree_beads).unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, worktree_beads.join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_sync_branch_with_other_keys() {
        // Config has other keys alongside sync-branch
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "issue-prefix: myproject\nsync-branch: beads-sync\nno-db: true\n",
        )
        .unwrap();

        let worktree_beads = project
            .join(".git")
            .join("beads-worktrees")
            .join("beads-sync")
            .join(".beads");
        std::fs::create_dir_all(&worktree_beads).unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, worktree_beads.join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_sync_branch_null_value() {
        // sync-branch set to YAML null -> default path
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(
            beads_dir.join("config.yaml"),
            "sync-branch: null\n",
        )
        .unwrap();

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    #[test]
    fn test_resolve_no_beads_dir() {
        // No .beads directory at all -> default path (read fails gracefully)
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        // Do NOT create .beads/

        let result = resolve_issues_path(project);
        assert_eq!(result, project.join(".beads").join("issues.jsonl"));
    }

    // ── CreateBeadRequest deserialization tests ──────────────────────────

    #[test]
    fn test_create_bead_request_all_fields() {
        let json = r#"{
            "path": "/projects/my-app",
            "title": "New feature",
            "description": "Implement the thing",
            "issue_type": "feature",
            "priority": 3,
            "parent_id": "EPIC-001"
        }"#;
        let req: CreateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "/projects/my-app");
        assert_eq!(req.title, "New feature");
        assert_eq!(req.description, Some("Implement the thing".to_string()));
        assert_eq!(req.issue_type, Some("feature".to_string()));
        assert_eq!(req.priority, Some(3));
        assert_eq!(req.parent_id, Some("EPIC-001".to_string()));
    }

    #[test]
    fn test_create_bead_request_required_fields_only() {
        let json = r#"{"path": "dolt://beads_myproject", "title": "Minimal bead"}"#;
        let req: CreateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "dolt://beads_myproject");
        assert_eq!(req.title, "Minimal bead");
        assert!(req.description.is_none());
        assert!(req.issue_type.is_none());
        assert!(req.priority.is_none());
        assert!(req.parent_id.is_none());
    }

    #[test]
    fn test_create_bead_request_missing_title_fails() {
        let json = r#"{"path": "/projects/my-app"}"#;
        let result = serde_json::from_str::<CreateBeadRequest>(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_bead_request_missing_path_fails() {
        let json = r#"{"title": "No path"}"#;
        let result = serde_json::from_str::<CreateBeadRequest>(json);
        assert!(result.is_err());
    }

    // ── UpdateBeadRequest deserialization tests ──────────────────────────

    #[test]
    fn test_update_bead_request_all_fields() {
        let json = r#"{
            "path": "/projects/my-app",
            "id": "TASK-042",
            "title": "Updated title",
            "description": "Updated desc",
            "status": "in_progress",
            "issue_type": "bug",
            "priority": 1
        }"#;
        let req: UpdateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "/projects/my-app");
        assert_eq!(req.id, "TASK-042");
        assert_eq!(req.title, Some("Updated title".to_string()));
        assert_eq!(req.description, Some("Updated desc".to_string()));
        assert_eq!(req.status, Some("in_progress".to_string()));
        assert_eq!(req.issue_type, Some("bug".to_string()));
        assert_eq!(req.priority, Some(1));
    }

    #[test]
    fn test_update_bead_request_required_fields_only() {
        let json = r#"{"path": "dolt://beads_db", "id": "BUG-007"}"#;
        let req: UpdateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "dolt://beads_db");
        assert_eq!(req.id, "BUG-007");
        assert!(req.title.is_none());
        assert!(req.description.is_none());
        assert!(req.status.is_none());
        assert!(req.issue_type.is_none());
        assert!(req.priority.is_none());
    }

    #[test]
    fn test_update_bead_request_issue_type_only() {
        let json = r#"{"path": "dolt://beads_db", "id": "TASK-1", "issue_type": "feature"}"#;
        let req: UpdateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.issue_type, Some("feature".to_string()));
        assert!(req.priority.is_none());
        assert!(req.title.is_none());
    }

    #[test]
    fn test_update_bead_request_priority_only() {
        let json = r#"{"path": "dolt://beads_db", "id": "TASK-1", "priority": 0}"#;
        let req: UpdateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.priority, Some(0));
        assert!(req.issue_type.is_none());
    }

    #[test]
    fn test_update_bead_request_out_of_range_priority_deserializes() {
        // Deserialization is permissive; range validation (0..=4) happens in the
        // handler, which returns HTTP 400 for out-of-range values.
        let json = r#"{"path": "dolt://beads_db", "id": "TASK-1", "priority": 9}"#;
        let req: UpdateBeadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.priority, Some(9));
        assert!(!(0..=4).contains(&req.priority.unwrap()));

        let json_neg = r#"{"path": "dolt://beads_db", "id": "TASK-1", "priority": -1}"#;
        let req_neg: UpdateBeadRequest = serde_json::from_str(json_neg).unwrap();
        assert_eq!(req_neg.priority, Some(-1));
        assert!(!(0..=4).contains(&req_neg.priority.unwrap()));
    }

    #[test]
    fn test_update_bead_request_missing_id_fails() {
        let json = r#"{"path": "/projects/my-app"}"#;
        let result = serde_json::from_str::<UpdateBeadRequest>(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_bead_request_missing_path_fails() {
        let json = r#"{"id": "TASK-001"}"#;
        let result = serde_json::from_str::<UpdateBeadRequest>(json);
        assert!(result.is_err());
    }

    // ── DOLT_PATH_PREFIX constant test ──────────────────────────────────

    #[test]
    fn test_dolt_path_prefix_is_correct() {
        assert_eq!(DOLT_PATH_PREFIX, "dolt://");
        // Verify it works for stripping prefix
        let path = "dolt://beads_mydb";
        let db_name = path.strip_prefix(DOLT_PATH_PREFIX);
        assert_eq!(db_name, Some("beads_mydb"));
    }

    #[test]
    fn test_extract_json_array_clean() {
        let output = r#"[{"id":"test-1","title":"T","status":"open"}]"#;
        assert_eq!(extract_json_array(output).unwrap(), output);
    }

    #[test]
    fn test_extract_json_array_with_prefix() {
        let output = "Warning: something\n2026/03/17 migration...\nFlushed working set\n[{\"id\":\"test-1\"}]";
        let result = extract_json_array(output).unwrap();
        assert!(result.starts_with('['));
    }

    #[test]
    fn test_extract_json_array_no_json() {
        let output = "Error: something went wrong";
        assert!(extract_json_array(output).is_err());
    }

    #[test]
    fn test_parse_comment_with_uuid_id() {
        let json = r#"{"id":"9960209c-37d3-40a8-b608-2d54e40b25e8","issue_id":"beads-web-ccz","author":"weselow","text":"A comment","created_at":"2026-03-16T12:10:05Z"}"#;
        let comment: Comment = serde_json::from_str(json).unwrap();
        assert_eq!(comment.id, "9960209c-37d3-40a8-b608-2d54e40b25e8");
        assert_eq!(comment.issue_id, "beads-web-ccz");
    }

    #[test]
    fn test_parse_comment_with_numeric_id() {
        let json = r#"{"id":42,"issue_id":"test-1","author":"user","text":"Old format","created_at":"2026-01-01T00:00:00Z"}"#;
        let comment: Comment = serde_json::from_str(json).unwrap();
        assert_eq!(comment.id, "42");
    }

    #[test]
    fn test_extract_json_array_with_bd_v061_output() {
        let output = "Warning: Dolt server endpoint changed: port 14302 → 50726 (auto-start)\n\
            \x20 Previous port was unreachable.\n\
            2026/03/17 22:44:01 migration 010: converting events.id from bigint to CHAR(36) UUID\n\
            2026/03/17 22:44:01 migration 010: events.id migrated to CHAR(36) UUID successfully\n\
            Flushed working set for 1 database(s) before server stop\n\
            [{\"id\":\"test-1\",\"title\":\"Test\",\"status\":\"open\"}]";
        let result = extract_json_array(output).unwrap();
        assert!(result.starts_with('['));
        let beads: Vec<Bead> = serde_json::from_str(result).unwrap();
        assert_eq!(beads.len(), 1);
        assert_eq!(beads[0].id, "test-1");
    }

    #[test]
    fn test_extract_json_array_with_empty_array() {
        let output = "Flushed working set\n[]";
        let result = extract_json_array(output).unwrap();
        let beads: Vec<Bead> = serde_json::from_str(result).unwrap();
        assert_eq!(beads.len(), 0);
    }
}
