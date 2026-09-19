//! Beads API route handlers.
//!
//! Provides endpoints for reading beads data.
//! Supports two data sources:
//! - **Dolt** (preferred): reads via `bd list --json` + `bd sql` CLI commands
//! - **JSONL** (fallback): reads from `.beads/issues.jsonl` if bd CLI is unavailable

pub mod search;

use axum::{
    extract::{Extension, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::process::Command;

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
    /// Ask for the cards without their long text: no notes, design, close
    /// reason or comments, only how many comments there are. A board of four
    /// thousand cards was 7 MiB whole, and the board draws none of that text;
    /// the card panel fetches it for the one card that opens (bw-fbzd.7).
    pub brief: Option<String>,
    /// Ask for each card's id and status only. A chat colours card names by
    /// status and needs nothing else (bw-fbzd.7).
    pub ids: Option<String>,
}

/// Query parameters for one card.
#[derive(Debug, Deserialize)]
pub struct CardParams {
    pub path: String,
    pub id: String,
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

/// Runs a read-only `bd` CLI command and returns stdout.
///
/// Uses `find_bd()` to locate the binary — searches PATH and common install locations.
fn readonly_bd_args<'a>(args: &'a [&'a str]) -> impl Iterator<Item = &'a str> {
    std::iter::once("--readonly").chain(args.iter().copied())
}

async fn run_bd(args: &[&str], cwd: &Path) -> Result<String, String> {
    let Some(bd_path) = super::find_bd() else {
        super::forget_tools();
        return Err(super::BD_MISSING.to_string());
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        // An embedded Dolt opens writable unless bd is told otherwise. Even a
        // SELECT then rewrites its journal and manifest, which the board file
        // watcher reads as a real edit and answers by running this read again.
        // The result was an endless read -> watch -> read loop on an idle board
        // (bw-hou2.1). Every caller here is a query, so make that contract real.
        Command::new(bd_path)
            .args(readonly_bd_args(args))
            .current_dir(cwd)
            .output(),
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
    // Whether any card has a comment to find, so a board with none costs no
    // second run looking for them.
    let has_comments = serde_json::from_str::<Vec<Counted>>(json_str)
        .map(|all| all.iter().any(|card| card.comment_count > 0))
        .unwrap_or(true);

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
                    if !load_comments_from_jsonl(project_path, &mut comments_map) && has_comments {
                        load_comments_from_export(project_path, &mut comments_map).await;
                    }
                }
            }
        }
        Err(_) => {
            if !load_comments_from_jsonl(project_path, &mut comments_map) && has_comments {
                load_comments_from_export(project_path, &mut comments_map).await;
            }
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

/// A card as `bd list` counts its comments.
#[derive(Deserialize)]
struct Counted {
    #[serde(default)]
    comment_count: usize,
}

/// One line of `bd export`: an issue with its comments, or a record of
/// another kind, which is skipped.
#[derive(Deserialize)]
struct Exported {
    id: String,
    #[serde(rename = "_type")]
    kind: Option<String>,
    #[serde(default)]
    comments: Option<Vec<Comment>>,
}

/// The comments in `bd export`'s output, by the card they are on.
fn comments_from_export(output: &str, comments_map: &mut HashMap<String, Vec<Comment>>) {
    for line in output.lines() {
        let Ok(record) = serde_json::from_str::<Exported>(line) else {
            continue;
        };
        if record.kind.as_deref().is_some_and(|kind| kind != "issue") {
            continue;
        }
        if let Some(comments) = record.comments.filter(|comments| !comments.is_empty()) {
            comments_map.insert(record.id, comments);
        }
    }
}

/// Reads comments from `bd export`, which embeds them per issue.
///
/// A board kept in embedded Dolt — what `bd init` makes — refuses `bd sql` and
/// has no issues file, so neither read above finds a comment on it, and every
/// comment on such a board was missing from the board, the card panel and the
/// search alike (bw-21a2.7). The export is one run for the whole board.
async fn load_comments_from_export(project_path: &Path, comments_map: &mut HashMap<String, Vec<Comment>>) {
    match run_bd(&["export"], project_path).await {
        Ok(output) => comments_from_export(&output, comments_map),
        Err(e) => tracing::warn!("Comments could not be exported ({}); continuing without comments", e),
    }
}

/// Reads comments from the project's issues file and inserts them into
/// `comments_map`. Used when `bd sql` is unavailable (embedded mode). Answers
/// whether there was an issues file to read.
fn load_comments_from_jsonl(project_path: &Path, comments_map: &mut HashMap<String, Vec<Comment>>) -> bool {
    // The same file the beads themselves are read from. This built the default
    // path by hand, so on a project whose `.beads/config.yaml` names a
    // sync-branch — where the real issues file lives in a beads worktree under
    // `.git` — the board was read from the worktree and its comments from a
    // file beside it, and every comment silently went missing (bw-t26l.20).
    let issues_path = resolve_issues_path(project_path);
    // A project with no board has no issues file, and that is not a failure:
    // there is simply nothing to read. Warning about it wrote one line per
    // board poll, so a run that asked about a boardless project buried every
    // real error in the server log under hundreds of copies of a normal state
    // — 371 of them in one e2e run, against five lines worth reading
    // (bw-t26l.20).
    if !issues_path.exists() {
        tracing::debug!("no {} to read comments from", issues_path.display());
        return false;
    }
    let jsonl_beads = match read_beads_from_jsonl(&issues_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("Failed to load comments from JSONL ({}); continuing without comments", e);
            return true;
        }
    };
    for bead in jsonl_beads {
        if let Some(comments) = bead.comments {
            if !comments.is_empty() {
                comments_map.insert(bead.id, comments);
            }
        }
    }
    true
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
    Brief {
        #[serde(serialize_with = "serialize_brief_board")]
        beads: SharedBoard,
        source: String,
    },
    Statuses {
        #[serde(serialize_with = "serialize_statuses")]
        beads: SharedBoard,
        source: String,
    },
    Card {
        bead: Bead,
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

/// A card as the board list carries it: everything but the long text, which
/// is serialized from the held board rather than copied out of it, because
/// this answer is polled (bw-fbzd.7).
#[derive(Serialize)]
struct BriefBead<'a> {
    id: &'a str,
    title: &'a str,
    description: &'a Option<String>,
    status: &'a str,
    priority: &'a Option<i32>,
    issue_type: &'a Option<String>,
    owner: &'a Option<String>,
    created_at: &'a Option<String>,
    created_by: &'a Option<String>,
    updated_at: &'a Option<String>,
    closed_at: &'a Option<String>,
    comment_count: usize,
    parent_id: &'a Option<String>,
    children: &'a Option<Vec<String>>,
    deps: &'a Option<Vec<String>>,
    relates_to: &'a Option<Vec<String>>,
    labels: &'a Option<Vec<String>>,
}

impl<'a> From<&'a Bead> for BriefBead<'a> {
    fn from(bead: &'a Bead) -> Self {
        BriefBead {
            id: &bead.id,
            title: &bead.title,
            description: &bead.description,
            status: &bead.status,
            priority: &bead.priority,
            issue_type: &bead.issue_type,
            owner: &bead.owner,
            created_at: &bead.created_at,
            created_by: &bead.created_by,
            updated_at: &bead.updated_at,
            closed_at: &bead.closed_at,
            comment_count: bead.comments.as_ref().map_or(0, Vec::len),
            parent_id: &bead.parent_id,
            children: &bead.children,
            deps: &bead.deps,
            relates_to: &bead.relates_to,
            labels: &bead.labels,
        }
    }
}

/// A card's id and status. The stamp rides along so a reader asking only for
/// what changed knows what to ask after next; it is the same stamp
/// `changed_since` compares. `dropped` marks a closed card labelled
/// `cancelled`, which the screens colour apart from finished work, and is
/// left out when false.
#[derive(Serialize)]
struct CardStatus<'a> {
    id: &'a str,
    status: &'a str,
    updated_at: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    dropped: bool,
}

fn serialize_brief_board<S>(board: &SharedBoard, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.collect_seq(board.iter().map(BriefBead::from))
}

fn serialize_statuses<S>(board: &SharedBoard, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.collect_seq(board.iter().map(|bead| CardStatus {
        id: &bead.id,
        status: &bead.status,
        updated_at: bead.updated_at.as_deref().or(bead.created_at.as_deref()),
        dropped: bead.labels.as_ref().is_some_and(|labels| labels.iter().any(|l| l == "cancelled")),
    }))
}

/// What a read asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asked {
    Cards,
    Brief,
    Statuses,
    Counts,
}

impl Asked {
    fn of(params: &BeadsParams) -> Self {
        if params.counts.is_some() {
            Asked::Counts
        } else if params.ids.is_some() {
            Asked::Statuses
        } else if params.brief.is_some() {
            Asked::Brief
        } else {
            Asked::Cards
        }
    }
}

/// The answer to a read: the cards, the cards without their long text, only
/// their statuses, or only how many there are.
fn board_answer(beads: SharedBoard, source: &str, asked: Asked) -> Json<BoardAnswer> {
    let source = source.to_string();
    Json(match asked {
        Asked::Counts => BoardAnswer::Counts {
            counts: counts_of(&beads, &source),
            source,
        },
        Asked::Cards => BoardAnswer::Cards { beads, source },
        Asked::Brief => BoardAnswer::Brief { beads, source },
        Asked::Statuses => BoardAnswer::Statuses { beads, source },
    })
}

/// One card whole, out of the board already held.
fn card_answer(beads: &SharedBoard, source: &str, id: &str) -> (StatusCode, Json<BoardAnswer>) {
    match beads.iter().find(|bead| bead.id == id) {
        Some(bead) => (
            StatusCode::OK,
            Json(BoardAnswer::Card {
                bead: bead.clone(),
                source: source.to_string(),
            }),
        ),
        None => (
            StatusCode::NOT_FOUND,
            board_error(format!("No card {id} on this board")),
        ),
    }
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
    let asked = Asked::of(&params);
    // A count is always of the whole board: how many cards changed in the last
    // minute is not a count of anything the screen shows.
    let since = if asked == Asked::Counts {
        None
    } else {
        params.updated_after.as_deref()
    };
    match shared_board(&dolt_manager, &db, &params.path).await {
        Ok((beads, source)) => (
            StatusCode::OK,
            board_answer(changed_since(beads, since), &source, asked),
        ),
        Err(failed) => failed,
    }
}

/// One card whole, for the card panel: the board list no longer carries a
/// card's long text (bw-fbzd.7). Answered from the same held board.
pub async fn read_card(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<CardParams>,
) -> impl IntoResponse {
    match shared_board(&dolt_manager, &db, &params.path).await {
        Ok((beads, source)) => card_answer(&beads, &source, &params.id),
        Err(failed) => failed,
    }
}

/// The whole board for a path, from wherever it is held or lives.
async fn shared_board(
    dolt_manager: &Arc<DoltManager>,
    db: &Arc<Database>,
    path: &str,
) -> Result<(SharedBoard, String), (StatusCode, Json<BoardAnswer>)> {
    // Normalize Windows backslashes to forward slashes
    let path = path.replace('\\', "/");

    if let Ok(Some(project)) = db.get_project_by_path(&path) {
        let raw = project.local_path.as_deref().unwrap_or(&project.path);
        let enabled = crate::identity::data_dir().and_then(|data| {
            if raw.starts_with(DOLT_PATH_PREFIX) {
                crate::project_manifest::locate_key(&project.path, &data)
            } else {
                crate::project_manifest::locate(Path::new(raw), &data)
            }
        }).is_some_and(|found| found.manifest.project.use_beads);
        if !enabled {
            return Err((StatusCode::NOT_FOUND, board_error("Beads is disabled for this project")));
        }
    }

    // Direct Dolt read for dolt:// paths (no filesystem needed)
    if let Some(db_name) = path.strip_prefix(DOLT_PATH_PREFIX) {
        if !dolt_manager.is_available() && !dolt_manager.check_server().await {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                board_error("Dolt server is not running"),
            ));
        }
        return match dolt_manager.read_beads(db_name).await {
            Ok(beads) => {
                let beads = Arc::new(post_process_beads(beads));
                upsert_counts_cache(&db, &path, "dolt-direct", &beads);
                Ok((beads, "dolt-direct".to_string()))
            }
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                board_error(e.to_string()),
            )),
        };
    }

    let project_path = PathBuf::from(&path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&project_path) {
        return Err((
            StatusCode::FORBIDDEN,
            board_error(e),
        ));
    }

    // Check that project has a .beads directory
    let beads_dir = project_path.join(".beads");
    if !beads_dir.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            board_error("No .beads directory found at the specified path"),
        ));
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
    if let Some((beads, source, fresh)) = kept_board(&path) {
        if !fresh {
            read_behind(dolt_manager.clone(), db.clone(), path.clone());
        }
        return Ok((beads, source));
    }
    let gate = gate_for(&path);
    let _hold = gate.lock().await;
    // Whoever we waited behind has read it by now.
    if let Some((beads, source, _)) = kept_board(&path) {
        return Ok((beads, source));
    }

    read_board(dolt_manager, db, &path, &project_path, &beads_dir)
        .await
        .map(|(beads, source)| (beads, source.to_string()))
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
        let data_dir = crate::identity::data_dir();
        for project in boards_to_read_ahead(&projects) {
            let raw = project.local_path.as_deref().unwrap_or(&project.path);
            let enabled = if raw.starts_with(DOLT_PATH_PREFIX) {
                data_dir.as_ref().and_then(|data| crate::project_manifest::locate_key(&project.path, data))
            } else {
                data_dir.as_ref().and_then(|data| crate::project_manifest::locate(Path::new(raw), data))
            }.is_some_and(|found| found.manifest.project.use_beads);
            if !enabled { continue; }
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

// Nothing here stands between a person and a column. The screen used to run a
// lifecycle check of its own before writing a status a hand asked for: a card in
// the manager's column could not be dragged out, and review or done needed a
// landed commit, every gate resolved and every child closed. That is the
// discipline agent sessions are held to by their own hooks, and holding the
// owner of the board to it as well left them looking at a column they could not
// drop into with no way to say "I mean it". The board screen now writes what it
// is told, and `--force` below carries the same answer down to `bd` (bw-7vpn).

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
        // `bd` refuses on its own to close a card with an open child or a live
        // blocker. A person asking for that column has already decided; say so
        // rather than handing them back a refusal they cannot act on (bw-7vpn).
        args.push("--force".to_string());
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

    let records: Vec<serde_json::Value> = beads.iter().map(|bead| serde_json::to_value(bead).expect("Bead serialization")).collect();
    let nodes = crate::board_landing::nodes(&records);
    let projection = crate::board_state::project(&nodes);
    for bead in &mut beads {
        if let Some(error) = projection.errors.get(&bead.id) {
            tracing::warn!(card = %bead.id, %error, "Board hierarchy needs repair");
        }
        if let Some(status) = projection.states.get(&bead.id) { bead.status = status.clone(); }
    }
    beads
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_cli_queries_open_embedded_dolt_read_only() {
        assert_eq!(
            readonly_bd_args(&["list", "--json", "--all"]).collect::<Vec<_>>(),
            vec!["--readonly", "list", "--json", "--all"]
        );
    }

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

    fn with_long_text(id: &str) -> Bead {
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","title":"T","status":"open","description":"body","notes":"n","design":"d","close_reason":"r","comments":[{{"id":1,"issue_id":"{id}","author":"a","text":"one","created_at":"2026-08-20T09:00:00Z"}},{{"id":2,"issue_id":"{id}","author":"a","text":"two","created_at":"2026-08-20T09:00:00Z"}}],"updated_at":"2026-08-20T09:00:00Z"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn comments_are_read_from_an_export_and_records_of_other_kinds_are_skipped() {
        let output = [
            r#"{"_type":"issue","id":"sc-1","title":"T","status":"open","comments":[{"id":"26a3","issue_id":"sc-1","author":"sam","text":"the saffron cache","created_at":"2026-09-15T13:38:10Z"}]}"#,
            r#"{"_type":"issue","id":"sc-2","title":"U","status":"open"}"#,
            r#"{"_type":"memory","id":"m-1","comments":[{"id":"1","issue_id":"m-1","author":"a","text":"not a card","created_at":"2026-09-15T13:38:10Z"}]}"#,
            "Warning: not json",
        ]
        .join("\n");
        let mut comments = HashMap::new();
        comments_from_export(&output, &mut comments);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments["sc-1"][0].text, "the saffron cache");
    }

    #[test]
    fn a_brief_board_leaves_out_the_long_text_and_counts_the_comments() {
        let board = Arc::new(vec![with_long_text("a"), stamped("b", None)]);
        let encoded = serde_json::to_value(board_answer(board, "cli", Asked::Brief).0).unwrap();
        let first = encoded["beads"][0].as_object().expect("a card");
        for gone in ["notes", "design", "close_reason", "comments"] {
            assert!(!first.contains_key(gone), "{gone} is left out of a brief card");
        }
        assert_eq!(first["description"], "body", "the board searches descriptions");
        assert_eq!(first["title"], "T");
        assert_eq!(first["comment_count"], 2);
        assert_eq!(encoded["beads"][1]["comment_count"], 0);
        assert_eq!(encoded["source"], "cli");

        let whole = serde_json::to_value(with_long_text("a")).unwrap();
        let whole = whole.as_object().unwrap();
        for (key, value) in first {
            if key != "comment_count" {
                assert_eq!(whole.get(key), Some(value), "{key} reads the same brief as whole");
            }
        }
    }

    #[test]
    fn a_read_of_ids_carries_only_the_id_and_status() {
        let board = Arc::new(vec![with_long_text("a"), stamped("b", None)]);
        let encoded = serde_json::to_value(board_answer(board, "cli", Asked::Statuses).0).unwrap();
        let first = encoded["beads"][0].as_object().expect("a card");
        let mut keys = first.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort();
        assert_eq!(keys, vec!["id", "status", "updated_at"]);
        assert_eq!(first["id"], "a");
        assert_eq!(first["status"], "open");
        assert_eq!(encoded["beads"][1]["updated_at"], serde_json::Value::Null);

        let mut dropped = stamped("c", None);
        dropped.status = "closed".into();
        dropped.labels = Some(vec!["cancelled".into()]);
        let encoded = serde_json::to_value(board_answer(Arc::new(vec![dropped]), "cli", Asked::Statuses).0).unwrap();
        assert_eq!(encoded["beads"][0]["dropped"], true);
        assert_eq!(encoded["source"], "cli");
    }

    #[test]
    fn the_ask_decides_the_shape_and_a_count_wins() {
        let params = |counts: bool, brief: bool, ids: bool| BeadsParams {
            path: "/p".into(),
            updated_after: None,
            counts: counts.then(|| "1".into()),
            brief: brief.then(|| "1".into()),
            ids: ids.then(|| "1".into()),
        };
        assert_eq!(Asked::of(&params(false, false, false)), Asked::Cards);
        assert_eq!(Asked::of(&params(false, true, false)), Asked::Brief);
        assert_eq!(Asked::of(&params(false, true, true)), Asked::Statuses);
        assert_eq!(Asked::of(&params(true, true, true)), Asked::Counts);
    }

    #[test]
    fn one_card_is_found_whole_or_not_found() {
        let board = Arc::new(vec![stamped("b", None), with_long_text("a")]);
        let (status, Json(answer)) = card_answer(&board, "cli", "a");
        assert_eq!(status, StatusCode::OK);
        let encoded = serde_json::to_value(answer).unwrap();
        assert_eq!(encoded["bead"]["notes"], "n");
        assert_eq!(encoded["bead"]["comments"].as_array().map(Vec::len), Some(2));
        assert_eq!(encoded["source"], "cli");

        let (status, Json(answer)) = card_answer(&board, "cli", "missing");
        assert_eq!(status, StatusCode::NOT_FOUND);
        let encoded = serde_json::to_value(answer).unwrap();
        assert!(encoded["error"].as_str().is_some_and(|e| e.contains("missing")));
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

    /// Comments come out of the same file the beads themselves came out of.
    ///
    /// On a project whose `.beads/config.yaml` names a sync-branch, the real
    /// issues file lives in a beads worktree under `.git`. The board was read
    /// from there and its comments from `.beads/issues.jsonl` beside it, so on
    /// every such project each bead arrived with no comments on it at all and
    /// nothing in the log said why (bw-t26l.20).
    #[test]
    fn comments_are_read_from_the_file_the_board_is_read_from() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let beads_dir = project.join(".beads");
        std::fs::create_dir_all(&beads_dir).unwrap();
        std::fs::write(beads_dir.join("config.yaml"), "sync-branch: beads-sync\n").unwrap();
        // The file beside the config, which is NOT the one the board reads.
        std::fs::write(
            beads_dir.join("issues.jsonl"),
            concat!(
                r#"{"id":"a-1","title":"stale","status":"open","comments":[{"id":"c-1","issue_id":"a-1","#,
                r#""author":"someone","text":"from the wrong file","created_at":"2026-09-03T00:00:00Z"}]}"#,
                "\n",
            ),
        )
        .unwrap();

        let worktree_beads = project
            .join(".git")
            .join("beads-worktrees")
            .join("beads-sync")
            .join(".beads");
        std::fs::create_dir_all(&worktree_beads).unwrap();
        std::fs::write(
            worktree_beads.join("issues.jsonl"),
            concat!(
                r#"{"id":"a-1","title":"real","status":"open","comments":[{"id":"c-2","issue_id":"a-1","#,
                r#""author":"someone","text":"from the board's own file","created_at":"2026-09-03T00:00:00Z"}]}"#,
                "\n",
            ),
        )
        .unwrap();

        let mut comments_map: HashMap<String, Vec<Comment>> = HashMap::new();
        load_comments_from_jsonl(project, &mut comments_map);

        let read = comments_map.get("a-1").expect("the bead's comments were found");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].text, "from the board's own file");
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
