//! Read Claude Code's durable conversations without an SDK or a Node runtime.
//!
//! Claude writes append-only JSONL below `<config>/projects`.  The final line
//! may be incomplete while another process is writing it, so every reader is
//! deliberately best-effort: one malformed line never hides the conversation.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;
use uuid::Uuid;

const KEPT: usize = 4_000;
const COMMAND_KEPT: usize = 20_000;
const PICTURE_KEPT: usize = 1_000_000;
const DEFAULT_WINDOW: i64 = 200_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionSummary {
    pub session_id: String,
    pub last_modified: String,
    pub name: Option<String>,
    pub cwd: Option<PathBuf>,
    pub git_branch: Option<String>,
    pub last_spoke_at: Option<String>,
    pub programmatic: bool,
    pub record: PathBuf,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaudeSettings {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClaudeHistory {
    pub events: Vec<Value>,
    pub settings: ClaudeSettings,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub context_used: Option<i64>,
    pub context_window: i64,
}

pub fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| directories::UserDirs::new().map(|dirs| dirs.home_dir().join(".claude")))
}

fn projects_dir(config: &Path) -> PathBuf {
    if config.file_name().is_some_and(|name| name == "projects") {
        config.to_path_buf()
    } else {
        config.join("projects")
    }
}

fn valid_session_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok()
}

fn jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .into_iter()
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn byte_window(path: &Path, from: i64, limit: usize) -> Vec<Value> {
    let Ok(mut file) = fs::File::open(path) else {
        return vec![];
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or_default();
    let start = if from < 0 {
        size.saturating_sub((-from) as u64)
    } else {
        from as u64
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return vec![];
    }
    let mut bytes = Vec::new();
    if file.take(limit as u64).read_to_end(&mut bytes).is_err() {
        return vec![];
    }
    if start > 0 {
        if let Some(newline) = bytes.iter().position(|b| *b == b'\n') {
            bytes.drain(..=newline);
        } else {
            return vec![];
        }
    }
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect()
}
fn edge_jsonl(path: &Path) -> (Vec<Value>, Vec<Value>) {
    let mut rows = byte_window(path, 0, 128 * 1024);
    let mut seen: HashSet<String> = rows.iter().map(Value::to_string).collect();
    let tail = byte_window(path, -(256 * 1024), 256 * 1024);
    for row in &tail {
        if seen.insert(row.to_string()) {
            rows.push(row.clone())
        }
    }
    (rows, tail)
}

fn human_spoke_at(row: &Value) -> Option<String> {
    (visible(row) && row["type"] == "user" && human_words(&message_text(&row["message"])))
        .then(|| as_nonempty(&row["timestamp"]))
        .flatten()
}

/// The newest thing the person said, read backwards in complete JSONL rows.
/// Long command output can put that row megabytes behind the file's end; a
/// fixed tail window silently turns the agent's last write into the person's
/// clock. Blocks are joined across their boundary and reading stops at the
/// first matching row, so the common case remains one bounded tail read.
fn last_spoke_at(path: &Path, tail: &[Value]) -> Option<String> {
    const BLOCK: u64 = 256 * 1024;
    if let Some(at) = tail.iter().rev().find_map(human_spoke_at) {
        return Some(at);
    }
    let mut file = fs::File::open(path).ok()?;
    let mut end = file.metadata().ok()?.len();
    let mut suffix = Vec::new();
    while end > 0 {
        let start = end.saturating_sub(BLOCK);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = vec![0; (end - start) as usize];
        file.read_exact(&mut bytes).ok()?;
        bytes.extend_from_slice(&suffix);
        let complete_from = if start == 0 {
            0
        } else if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            suffix = bytes[..newline].to_vec();
            newline + 1
        } else {
            suffix = bytes;
            end = start;
            continue;
        };
        let text = String::from_utf8_lossy(&bytes[complete_from..]);
        if let Some(at) = text.lines().rev().find_map(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|row| human_spoke_at(&row))
        }) {
            return Some(at);
        }
        end = start;
    }
    None
}

fn record_files(config: &Path) -> Vec<PathBuf> {
    let Ok(projects) = fs::read_dir(projects_dir(config)) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for project in projects.flatten() {
        let Ok(entries) = fs::read_dir(project.path()) else {
            continue;
        };
        found.extend(entries.flatten().filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?;
            (path.extension().is_some_and(|ext| ext == "jsonl") && valid_session_id(id))
                .then_some(path)
        }));
    }
    found
}

pub fn find_record(config: &Path, session_id: &str) -> Option<PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    record_files(config).into_iter().find(|path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case(session_id))
    })
}

fn as_nonempty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

fn visible(row: &Value) -> bool {
    matches!(row["type"].as_str(), Some("user" | "assistant"))
        && row["isMeta"] != true
        && row["isSidechain"] != true
        && row.get("teamName").is_none_or(Value::is_null)
}

fn recorded_entry(row: &Value) -> bool {
    matches!(
        row["type"].as_str(),
        Some("user" | "assistant" | "progress" | "system" | "attachment")
    ) && row["uuid"].is_string()
}

fn conversation_row(row: &Value, include_sidechains: bool) -> bool {
    matches!(row["type"].as_str(), Some("user" | "assistant"))
        && row["isMeta"] != true
        && (include_sidechains || row["isSidechain"] != true)
        && (include_sidechains || row.get("teamName").is_none_or(Value::is_null))
}

fn message_api_id(row: &Value) -> Option<&str> {
    (row["type"] == "assistant")
        .then(|| row["message"]["id"].as_str())
        .flatten()
}

/// Identity used only to coalesce a UUID-less provider echo with the same
/// logical row. Different turns with the same words remain distinct because
/// their provider timestamps differ; a row with neither identity nor time is
/// retained because guessing would be data loss.
fn identityless_message_key(row: &Value) -> Option<String> {
    let role = row["type"].as_str()?;
    let message = as_nonempty(&row["message"]["id"]);
    let at = as_nonempty(&row["timestamp"]);
    if message.is_none() && at.is_none() {
        return None;
    }
    Some(format!(
        "{role}\u{1f}{}\u{1f}{}\u{1f}{}",
        message.unwrap_or_default(),
        at.unwrap_or_default(),
        message_text(&row["message"]),
    ))
}

fn tool_result_row(row: &Value) -> bool {
    row["type"] == "user"
        && row["parentUuid"].is_string()
        && row["message"]["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
}

/// Choose the canonical branch inside one uninterrupted context segment.
/// This is the native equivalent of the final Node reader's pinned Agent SDK
/// `getSessionMessages`: repair links, choose the newest valid leaf, walk its
/// ancestry, and place streamed assistant variants/results beside the
/// canonical assistant row they belong to.
fn latest_conversation(rows: &[Value], include_sidechains: bool) -> Vec<Value> {
    let mut by_id = HashMap::<String, Value>::new();
    let mut position = HashMap::<String, usize>::new();
    let mut insertion_order = Vec::new();
    for (index, row) in rows
        .iter()
        .enumerate()
        .filter(|(_, row)| recorded_entry(row))
    {
        let id = row["uuid"].as_str().unwrap().to_string();
        if !by_id.contains_key(&id) {
            insertion_order.push(id.clone());
        }
        by_id.insert(id.clone(), row.clone());
        position.insert(id, index);
    }
    // Normal Claude records carry UUIDs and take the graph path below. Keep
    // synthetic/legacy helper transcripts useful when every row predates that
    // identity contract; file order is the only ordering information they
    // contain, and dropping them would erase the helper altogether.
    if by_id.is_empty() {
        return rows
            .iter()
            .filter(|row| conversation_row(row, include_sidechains))
            .cloned()
            .collect();
    }

    let compact_rows = insertion_order
        .iter()
        .filter_map(|id| by_id.get(id))
        .filter(|row| row["type"] == "system" && row["subtype"] == "compact_boundary")
        .cloned()
        .collect::<Vec<_>>();
    for row in compact_rows {
        let metadata = row
            .get("compactMetadata")
            .or_else(|| row.get("compact_metadata"))
            .unwrap_or(&Value::Null);
        if let Some(preserved) = metadata.get("preservedMessages") {
            let uuids = preserved["uuids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let Some(anchor) = preserved["anchorUuid"].as_str() else {
                continue;
            };
            if uuids.is_empty() || uuids.iter().any(|id| !by_id.contains_key(id)) {
                continue;
            }
            let mut parent = anchor.to_string();
            for id in &uuids {
                by_id.get_mut(id).unwrap()["parentUuid"] = json!(parent);
                parent = id.clone();
            }
            let first = &uuids[0];
            let tail = uuids.last().unwrap().clone();
            for (id, candidate) in &mut by_id {
                if candidate["parentUuid"] == anchor && id != first {
                    candidate["parentUuid"] = json!(tail);
                }
            }
        } else if let Some(preserved) = metadata.get("preservedSegment") {
            let (Some(head), Some(anchor), Some(tail)) = (
                preserved["headUuid"].as_str(),
                preserved["anchorUuid"].as_str(),
                preserved["tailUuid"].as_str(),
            ) else {
                continue;
            };
            if let Some(entry) = by_id.get_mut(head) {
                entry["parentUuid"] = json!(anchor);
            }
            for (id, candidate) in &mut by_id {
                if candidate["parentUuid"] == anchor && id != head {
                    candidate["parentUuid"] = json!(tail);
                }
            }
        }
    }

    let parents = by_id
        .values()
        .filter_map(|row| row["parentUuid"].as_str().map(str::to_string))
        .collect::<HashSet<_>>();
    let mut candidates = Vec::<String>::new();
    for leaf in insertion_order.iter().filter(|id| !parents.contains(*id)) {
        let mut current = Some(leaf.clone());
        let mut seen = HashSet::new();
        while let Some(id) = current {
            if !seen.insert(id.clone()) {
                break;
            }
            let Some(row) = by_id.get(&id) else {
                break;
            };
            if matches!(row["type"].as_str(), Some("user" | "assistant")) {
                candidates.push(id);
                break;
            }
            current = row["parentUuid"].as_str().map(str::to_string);
        }
    }
    let preferred = candidates
        .iter()
        .filter(|id| {
            by_id
                .get(*id)
                .is_some_and(|row| conversation_row(row, include_sidechains))
        })
        .cloned()
        .collect::<Vec<_>>();
    let eligible = if preferred.is_empty() {
        &candidates
    } else {
        &preferred
    };
    let leaf = eligible
        .iter()
        .max_by_key(|id| position.get(*id).copied().unwrap_or_default())
        .cloned();
    let Some(leaf) = leaf else {
        return Vec::new();
    };

    let mut branch = Vec::new();
    let mut branch_ids = HashSet::new();
    let mut current = Some(leaf);
    while let Some(id) = current {
        if !branch_ids.insert(id.clone()) {
            break;
        }
        let Some(row) = by_id.get(&id) else {
            break;
        };
        branch.push(row.clone());
        current = row["parentUuid"].as_str().map(str::to_string);
    }
    branch.reverse();

    let mut canonical = HashMap::<String, String>::new();
    for row in &branch {
        if let (Some(message), Some(uuid)) = (message_api_id(row), row["uuid"].as_str()) {
            canonical.insert(message.to_string(), uuid.to_string());
        }
    }
    let mut variants = HashMap::<String, Vec<Value>>::new();
    let mut results = HashMap::<String, Vec<Value>>::new();
    for row in by_id.values() {
        if let Some(message) = message_api_id(row) {
            variants
                .entry(message.to_string())
                .or_default()
                .push(row.clone());
        } else if tool_result_row(row) {
            results
                .entry(row["parentUuid"].as_str().unwrap().to_string())
                .or_default()
                .push(row.clone());
        }
    }
    let mut additions = HashMap::<String, Vec<Value>>::new();
    let mut handled = HashSet::new();
    for row in branch.iter().filter(|row| row["type"] == "assistant") {
        let Some(message) = message_api_id(row) else {
            continue;
        };
        if !handled.insert(message.to_string()) {
            continue;
        }
        let mut extra_variants = variants
            .get(message)
            .into_iter()
            .flatten()
            .filter(|candidate| {
                candidate["uuid"]
                    .as_str()
                    .is_some_and(|id| !branch_ids.contains(id))
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut extra_results = variants
            .get(message)
            .into_iter()
            .flatten()
            .filter_map(|variant| variant["uuid"].as_str())
            .flat_map(|id| results.get(id).into_iter().flatten())
            .filter(|candidate| {
                candidate["uuid"]
                    .as_str()
                    .is_some_and(|id| !branch_ids.contains(id))
            })
            .cloned()
            .collect::<Vec<_>>();
        extra_variants.sort_by(|left, right| {
            left["timestamp"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["timestamp"].as_str().unwrap_or_default())
        });
        extra_results.sort_by(|left, right| {
            left["timestamp"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["timestamp"].as_str().unwrap_or_default())
        });
        extra_variants.extend(extra_results);
        if let Some(canonical_id) = canonical.get(message) {
            additions.insert(canonical_id.clone(), extra_variants);
        }
    }

    let mut ordered = Vec::new();
    for row in branch {
        let id = row["uuid"].as_str().unwrap_or_default().to_string();
        ordered.push(row);
        if let Some(extra) = additions.remove(&id) {
            ordered.extend(extra);
        }
    }
    let mut selected = ordered
        .into_iter()
        .filter(|row| conversation_row(row, include_sidechains))
        .filter_map(|row| {
            let at = position.get(row["uuid"].as_str()?).copied()?;
            Some((at, row))
        })
        .collect::<Vec<_>>();
    let mut semantic = selected
        .iter()
        .filter_map(|(_, row)| identityless_message_key(row))
        .collect::<HashSet<_>>();
    // SDK and legacy hosts can append ordinary conversation rows without a
    // UUID beside UUID-bearing Claude Code rows. The graph has no edge by
    // which to discover them, but file position is still exact. Dropping them
    // was why mixed external transcripts opened with only the last few rows.
    //
    // Each is placed after the last row already ordered that precedes it in
    // the file, never by sorting the whole conversation into file order: the
    // work above exists precisely because file order is wrong for rows the
    // graph does know. A streamed variant and its result are written where the
    // stream happened to end and belong beside the message they are a variant
    // of, so re-sorting by position undid every placement it had just made
    // and put the retry ahead of the answer that replaced it (bw-t26l.20).
    for (at, row) in rows.iter().enumerate() {
        if row["uuid"].is_string() || !conversation_row(row, include_sidechains) {
            continue;
        }
        if identityless_message_key(row).is_some_and(|key| !semantic.insert(key)) {
            continue;
        }
        let after = selected
            .iter()
            .rposition(|(placed, _)| *placed < at)
            .map_or(0, |index| index + 1);
        selected.insert(after, (at, row.clone()));
    }
    selected.into_iter().map(|(_, row)| row).collect()
}

/// Claude's JSONL is an append-only graph split into context-sized segments.
/// A `compact_boundary` deliberately makes the following summary a new graph
/// root. The SDK reader returns only the newest root because that is exactly
/// what a model resume needs; using it once over the whole file in a history UI
/// permanently hides everything before the latest compaction.
///
/// Canonicalize each segment independently, then concatenate them in durable
/// file order. This retains the SDK's retry/variant selection within a context
/// while recovering the complete user-visible conversation in one linear pass.
fn ordered_conversation(rows: &[Value], include_sidechains: bool) -> Vec<Value> {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut start = 0;
    for (index, row) in rows.iter().enumerate() {
        if row["type"] != "system" || row["subtype"] != "compact_boundary" {
            continue;
        }
        ordered.extend(
            latest_conversation(&rows[start..index], include_sidechains)
                .into_iter()
                .filter(|row| {
                    row["uuid"]
                        .as_str()
                        .is_none_or(|id| seen.insert(id.to_string()))
                }),
        );
        start = index;
    }
    ordered.extend(
        latest_conversation(&rows[start..], include_sidechains)
            .into_iter()
            .filter(|row| {
                row["uuid"]
                    .as_str()
                    .is_none_or(|id| seen.insert(id.to_string()))
            }),
    );
    ordered
}

fn human_words(text: &str) -> bool {
    let text = text.trim_start();
    !text.is_empty()
        && ![
            "<task-notification",
            "<system-reminder",
            "<local-command-",
            "<command-name",
            "<command-message",
            "<command-args",
            "<user-prompt-submit-hook",
            "<function_results",
            "<budget",
        ]
        .iter()
        .any(|opening| text.starts_with(opening))
}

fn modified(path: &Path) -> String {
    let time = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    DateTime::<Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Clone)]
struct CachedSummary {
    len: u64,
    modified: SystemTime,
    summary: ClaudeSessionSummary,
}

static SUMMARIES: OnceLock<Mutex<HashMap<PathBuf, CachedSummary>>> = OnceLock::new();

fn cached_summary(path: PathBuf) -> Option<ClaudeSessionSummary> {
    let metadata = fs::metadata(&path).ok()?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let cache = SUMMARIES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(summary) = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&path)
        .filter(|cached| cached.len == metadata.len() && cached.modified == modified)
        .map(|cached| cached.summary.clone())
    {
        return Some(summary);
    }
    let summary = summary(path.clone())?;
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            path,
            CachedSummary {
                len: metadata.len(),
                modified,
                summary: summary.clone(),
            },
        );
    Some(summary)
}

fn summary(path: PathBuf) -> Option<ClaudeSessionSummary> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let (rows, tail) = edge_jsonl(&path);
    let mut cwd = None;
    let mut branch = None;
    let mut custom_title = None;
    let mut own_title = None;
    let mut summary = None;
    let mut first_prompt = None;
    let mut has_conversation = false;
    let mut has_primary_conversation = false;
    for row in &rows {
        cwd = as_nonempty(&row["cwd"]).map(PathBuf::from).or(cwd);
        branch = as_nonempty(&row["gitBranch"]).or(branch);
        custom_title = as_nonempty(&row["customTitle"]).or(custom_title);
        own_title = as_nonempty(&row["aiTitle"]).or(own_title);
        summary = as_nonempty(&row["summary"]).or(summary);
        if matches!(row["type"].as_str(), Some("user" | "assistant"))
            && row["isMeta"] != true
            && row.get("teamName").is_none_or(Value::is_null)
        {
            has_conversation = true;
            has_primary_conversation |= row["isSidechain"] != true;
        }
        if first_prompt.is_none() && visible(row) && row["type"] == "user" {
            let text = message_text(&row["message"]);
            if human_words(&text) {
                first_prompt = Some(text);
            }
        }
    }
    // Claude's resume index does not offer a record that contains only
    // initialization metadata. Keep explicitly titled/summarized records, but
    // do not turn every abandoned process start into an external chat row.
    if !has_conversation
        && custom_title.is_none()
        && own_title.is_none()
        && summary.is_none()
        && first_prompt.is_none()
    {
        return None;
    }
    Some(ClaudeSessionSummary {
        session_id,
        last_modified: modified(&path),
        // A name someone set for this chat, then the name the chat made for
        // itself, and only for a chat that has neither, one of ours cut down
        // from what was asked. Claude titles its own conversations now; naming
        // one "Reply Exactly READY" when it calls itself "READY" is the app
        // talking over it (bw-t26l.20).
        name: custom_title.or(own_title).or_else(|| {
            summary
                .as_deref()
                .and_then(crate::workbench::metadata::conversation_title)
                .or_else(|| {
                    first_prompt
                        .as_deref()
                        .and_then(crate::workbench::metadata::conversation_title)
                })
        }),
        cwd,
        git_branch: branch,
        last_spoke_at: last_spoke_at(&path, &tail),
        // Agent-SDK child sessions are sidechains throughout. Entrypoint and
        // API-error fields describe transport/outcome, not authorship: using
        // either hid ordinary terminal and editor conversations.
        programmatic: has_conversation && !has_primary_conversation,
        record: path,
    })
}

/// List all Claude conversations whose recorded cwd is the project or one of
/// its worktrees.  Scanning records rather than guessing Claude's escaped
/// directory name also survives changes to that private encoding.
pub fn list_sessions(
    config: &Path,
    project: Option<&Path>,
    include_programmatic: bool,
) -> Vec<ClaudeSessionSummary> {
    let mut sessions: Vec<_> = record_files(config)
        .into_iter()
        .filter_map(cached_summary)
        .filter(|session| include_programmatic || !session.programmatic)
        .filter(|session| {
            project.is_none_or(|project| {
                session
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| cwd == project || cwd.starts_with(project))
            })
        })
        .collect();
    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    sessions
}

fn cut(text: String, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text;
    }
    let byte = text
        .char_indices()
        .nth(limit)
        .map(|(at, _)| at)
        .unwrap_or(text.len());
    let omitted = text.chars().count() - limit;
    format!("{}\n… and {omitted} more characters", &text[..byte])
}

fn trim_value(value: &Value, depth: usize, key: &str) -> Value {
    match value {
        Value::String(text) => Value::String(cut(
            text.clone(),
            if key == "command" { COMMAND_KEPT } else { KEPT },
        )),
        Value::Array(values) if depth > 0 => Value::Array(
            values
                .iter()
                .map(|value| trim_value(value, depth - 1, key))
                .collect(),
        ),
        Value::Object(values) if depth > 0 => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), trim_value(value, depth - 1, key)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn measured(data: Option<&str>) -> String {
    let bytes = data.map_or(0, |data| (data.len() * 3 + 2) / 4);
    if bytes >= 1024 {
        format!("{} KB", (bytes as f64 / 1024.0).round() as usize)
    } else {
        format!("{bytes} bytes")
    }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| match block["type"].as_str() {
                Some("text") => block["text"].as_str().unwrap_or_default().to_string(),
                Some("image") => format!(
                    "[{}, {}]",
                    block["source"]["media_type"].as_str().unwrap_or("image"),
                    measured(block["source"]["data"].as_str())
                ),
                Some(kind) => format!("[{kind}]"),
                None => "[unknown]".into(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn result_images(content: &Value) -> Vec<Value> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            if block["type"] != "image" {
                return None;
            }
            let source = block.get("source")?;
            let mime = source["media_type"].as_str().unwrap_or("image/*");
            let data_url = match source["type"].as_str()? {
                "base64" => format!("data:{mime};base64,{}", source["data"].as_str()?),
                "url" => source["url"].as_str()?.to_string(),
                _ => return None,
            };
            Some(json!({
                "mime": mime,
                "dataUrl": data_url,
                "alt": "Agent-produced image"
            }))
        })
        .collect()
}

fn result_image_events(call_id: &str, pictures: Vec<Value>, parent: Option<&str>) -> Vec<Value> {
    if pictures.is_empty() {
        return Vec::new();
    }
    let message_id = format!("{call_id}:images");
    let mut started = json!({
        "type":"message.started", "messageId":message_id, "role":"assistant"
    });
    if let Some(parent) = parent {
        started["parentToolCallId"] = json!(parent);
    }
    let mut events = vec![started];
    events.extend(pictures.into_iter().map(|image| {
        let mut event = json!({"type":"image", "messageId":message_id, "image":image});
        if let Some(parent) = parent {
            event["parentToolCallId"] = json!(parent);
        }
        event
    }));
    let mut completed = json!({"type":"message.completed", "messageId":message_id});
    if let Some(parent) = parent {
        completed["parentToolCallId"] = json!(parent);
    }
    events.push(completed);
    events
}

fn message_id(row: &Value, index: usize) -> String {
    as_nonempty(&row["uuid"])
        .or_else(|| as_nonempty(&row["message"]["id"]))
        .unwrap_or_else(|| format!("claude-message-{index}"))
}

fn images(message: &Value) -> (String, Vec<Value>) {
    let mut text = message_text(message);
    let mut pictures = Vec::new();
    let mut undrawn = Vec::new();
    for block in message["content"].as_array().into_iter().flatten() {
        if block["type"] != "image" {
            continue;
        }
        let mime = block["source"]["media_type"]
            .as_str()
            .unwrap_or("image/png");
        let data = block["source"]["data"].as_str();
        if block["source"]["type"] == "base64"
            && data.is_some_and(|data| data.len() <= PICTURE_KEPT)
        {
            pictures.push(json!({
                "mime": mime,
                "dataUrl": format!("data:{mime};base64,{}", data.unwrap()),
                "alt": format!("Picture {}", pictures.len() + 1)
            }));
        } else {
            undrawn.push(format!("[{mime}, {}]", measured(data)));
        }
    }
    if !pictures.is_empty() || !undrawn.is_empty() {
        text = text
            .lines()
            .filter_map(|line| {
                if !line.contains("[Image #") {
                    return Some(line.to_string());
                }
                let mut out = line.to_string();
                while let Some(start) = out.find("[Image #") {
                    let Some(end) = out[start..].find(']') else {
                        break;
                    };
                    out.replace_range(start..start + end + 1, "");
                }
                (!out.trim().is_empty()).then(|| out.trim().to_string())
            })
            .chain(undrawn)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
    }
    (text, pictures)
}

#[derive(Default)]
struct Usage {
    input: i64,
    fresh: i64,
    cache_write: i64,
    cache_read: i64,
    output: i64,
    thinking: i64,
    total: i64,
    context: Option<i64>,
    window: i64,
}

fn usage(rows: &[Value]) -> Usage {
    let mut out = Usage {
        window: DEFAULT_WINDOW,
        ..Usage::default()
    };
    let mut seen = HashSet::new();
    for (index, row) in rows.iter().enumerate() {
        if let Some(window) = row["context_usage"]["raw_max_tokens"]
            .as_i64()
            .filter(|n| *n > 0)
        {
            out.window = window;
        }
        let message = &row["message"];
        let fields = &message["usage"];
        if !fields.is_object() {
            continue;
        }
        let fresh = fields["input_tokens"].as_i64().unwrap_or_default();
        let cache_write = fields["cache_creation_input_tokens"]
            .as_i64()
            .unwrap_or_default();
        let cache_read = fields["cache_read_input_tokens"]
            .as_i64()
            .unwrap_or_default();
        let input = fresh + cache_write + cache_read;
        let output = fields["output_tokens"].as_i64().unwrap_or_default();
        let thinking = fields["output_tokens_details"]["thinking_tokens"]
            .as_i64()
            .unwrap_or_default();
        if input + output > 0 {
            out.context = Some(input + output);
        }
        let key = as_nonempty(&message["id"]).unwrap_or_else(|| format!("line-{index}"));
        if seen.insert(key) {
            out.input += input;
            out.fresh += fresh;
            out.cache_write += cache_write;
            out.cache_read += cache_read;
            out.output += output;
            out.thinking += thinking;
            out.total += input + output;
        }
    }
    out
}

fn split_json(usage: &Usage) -> Value {
    json!({"input":usage.fresh,"cacheWrite":usage.cache_write,"cacheRead":usage.cache_read,"output":usage.output,"thinking":usage.thinking,"total":usage.total})
}
fn plus_usage(to: &mut Usage, from: &Usage) {
    to.fresh += from.fresh;
    to.cache_write += from.cache_write;
    to.cache_read += from.cache_read;
    to.input += from.input;
    to.output += from.output;
    to.thinking += from.thinking;
    to.total += from.total;
}

/// What each agent this chat sent off spent, and the model it spent it on.
///
/// Their turns are written to a file apiece beside the record and appear in
/// none of its own rows, so a reading that stops at the record undercounts a
/// chat that delegated by everything it delegated (bw-t26l.20).
fn helper_spend(record: &Path) -> Vec<(Usage, String)> {
    let Some(stem) = record.file_stem().and_then(|stem| stem.to_str()) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(record.with_file_name(stem).join("subagents")) else {
        return Vec::new();
    };
    let mut spent = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        {
            continue;
        }
        let rows = jsonl(&path);
        let one = usage(&rows);
        if one.total == 0 {
            continue;
        }
        let model = rows
            .iter()
            .find_map(|row| as_nonempty(&row["message"]["model"]))
            .unwrap_or_else(|| "unnamed".into());
        spent.push((one, model));
    }
    spent
}

/// Exact all-time token arithmetic used by the former sidecar: each assistant
/// turn is counted once by message id, helpers come from their own records,
/// and cache/thinking categories remain separate for the token inspector.
pub fn token_spend(record: &Path) -> Option<Value> {
    let rows = jsonl(record);
    if rows.is_empty() {
        return None;
    }
    let own = usage(&rows);
    if own.total == 0 {
        return None;
    }
    let mut helpers = Usage::default();
    let mut helper_count = 0i64;
    let mut models: HashMap<String, (Usage, i64)> = HashMap::new();
    let mut seen = HashSet::new();
    let mut turns = 0i64;
    for (index, row) in rows.iter().enumerate() {
        let message = &row["message"];
        if !message["usage"].is_object() {
            continue;
        }
        let key = as_nonempty(&message["id"]).unwrap_or_else(|| format!("line-{index}"));
        if !seen.insert(key) {
            continue;
        }
        let one = usage(std::slice::from_ref(row));
        if one.total == 0 {
            continue;
        }
        turns += 1;
        let model = as_nonempty(&message["model"]).unwrap_or_else(|| "unnamed".into());
        let entry = models.entry(model).or_default();
        plus_usage(&mut entry.0, &one);
        entry.1 += 1;
    }
    for (spent, model) in helper_spend(record) {
        helper_count += 1;
        plus_usage(&mut helpers, &spent);
        plus_usage(&mut models.entry(model).or_default().0, &spent);
    }
    let mut total = Usage::default();
    plus_usage(&mut total, &own);
    plus_usage(&mut total, &helpers);
    let tool_calls = rows
        .iter()
        .flat_map(|row| row["message"]["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_use")
        .count();
    let forgettings = rows
        .iter()
        .filter(|row| row["isCompactSummary"] == true)
        .count();
    let mut model_rows:Vec<_>=models.into_iter().filter(|(_, (spend,_))|spend.total>0).map(|(model,(spend,turns))|json!({"model":model,"spend":split_json(&spend),"turns":turns})).collect();
    model_rows
        .sort_by_key(|row| std::cmp::Reverse(row["spend"]["total"].as_i64().unwrap_or_default()));
    Some(
        json!({"own":split_json(&own),"helpers":split_json(&helpers),"total":split_json(&total),"turns":turns,"toolCalls":tool_calls,"forgettings":forgettings,"helperCount":helper_count,"models":model_rows}),
    )
}

fn settings(rows: &[Value]) -> ClaudeSettings {
    let mut found = ClaudeSettings::default();
    for row in rows {
        found.permission_mode = as_nonempty(&row["permissionMode"]).or(found.permission_mode);
        if row["type"] == "assistant" && row["isSidechain"] != true {
            found.effort = as_nonempty(&row["effort"]).or(found.effort);
            found.model = as_nonempty(&row["message"]["model"])
                .filter(|model| model != "<synthetic>")
                .or(found.model);
        }
    }
    found
}

fn transcript_events(rows: &[Value], parent: Option<&str>) -> Vec<Value> {
    let mut results = HashMap::new();
    for row in rows {
        for block in row["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_result" {
                if let Some(id) = block["tool_use_id"].as_str() {
                    results.insert(
                        id.to_string(),
                        (
                            result_text(&block["content"]),
                            block["is_error"] != true,
                            result_images(&block["content"]),
                        ),
                    );
                }
            }
        }
    }
    let mut events = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let nested = parent.is_some()
            && matches!(row["type"].as_str(), Some("user" | "assistant"))
            && row["isMeta"] != true
            && row.get("teamName").is_none_or(Value::is_null);
        if !visible(row) && !nested {
            continue;
        }
        let role = row["type"].as_str().unwrap();
        let id = message_id(row, index);
        let (text, pictures) = images(&row["message"]);
        if human_words(&text) || !pictures.is_empty() {
            let mut opened = json!({"type":"message.started", "messageId":id, "role":role});
            if let Some(parent) = parent {
                opened["parentToolCallId"] = json!(parent);
            }
            events.push(opened);
            events.extend(
                pictures
                    .into_iter()
                    .map(|image| json!({"type":"image", "messageId":id, "image":image})),
            );
            if !text.is_empty() {
                events.push(json!({"type":"text.delta", "messageId":id, "text":text}));
            }
            events.push(json!({"type":"message.completed", "messageId":id}));
            if role == "assistant" {
                if parent.is_none() {
                    if let Some(mut signal) = crate::workbench::provider_messages::from_text(&text)
                    {
                        signal["sourceMessageId"] = json!(id);
                        events.push(json!({"type":"provider.message","signal":signal}));
                    }
                }
                for widget in crate::workbench::media::widget_specs(&text) {
                    events.push(json!({"type":"widget","messageId":id,"widget":widget}));
                }
                if let Some(cwd) = rows.iter().find_map(|row| as_nonempty(&row["cwd"])) {
                    for comparison in
                        crate::workbench::media::comparison_specs(&text, Path::new(&cwd))
                    {
                        events.push(
                            json!({"type":"image.compare","messageId":id,"comparison":comparison}),
                        );
                    }
                }
            }
        }
        for block in row["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_use" {
                continue;
            }
            let Some(call_id) = block["id"].as_str() else {
                continue;
            };
            let Some(name) = block["name"].as_str() else {
                continue;
            };
            let input = trim_value(&block["input"], 4, "");
            events.push(json!({
                "type":"tool.started", "toolCallId":call_id, "name":name,
                "input": input.as_object().cloned().unwrap_or_default(),
                "title":name, "parentToolCallId":parent
            }));
            // A record being written can end at `tool_use`. No result means
            // the command is still running, not that it failed with empty
            // output. The follower will append the completion when the
            // matching `tool_result` lands.
            if let Some((output, ok, pictures)) = results.remove(call_id) {
                events.push(json!({
                    "type":"tool.completed", "toolCallId":call_id, "ok":ok,
                    "output":cut(output, KEPT)
                }));
                events.extend(result_image_events(call_id, pictures, parent));
            }
        }
    }
    // Incremental following often receives the result in a later byte window
    // than its tool_use. Emit that completion by identity even when this
    // window does not repeat the start; the durable reducer joins it to the
    // row already on screen.
    let mut unmatched = results.into_iter().collect::<Vec<_>>();
    unmatched.sort_by(|a, b| a.0.cmp(&b.0));
    for (call_id, (output, ok, pictures)) in unmatched {
        events.push(json!({
            "type":"tool.completed", "toolCallId":call_id, "ok":ok,
            "output":cut(output, KEPT)
        }));
        events.extend(result_image_events(&call_id, pictures, parent));
    }
    events
}

#[derive(Clone)]
struct HelperFacts {
    agent_id: String,
    tool_call_id: Option<String>,
    first_at: String,
    events: Vec<Value>,
    finish: Value,
}

fn helper_facts(path: &Path) -> Option<HelperFacts> {
    let name = path.file_name()?.to_str()?;
    let agent_id = name
        .strip_prefix("agent-")?
        .strip_suffix(".jsonl")?
        .to_string();
    let rows = jsonl(path);
    let conversation = ordered_conversation(&rows, true);
    let meta_path = path.with_file_name(format!("agent-{agent_id}.meta.json"));
    let meta: Value = fs::read_to_string(meta_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let tool = as_nonempty(&meta["toolUseId"]);
    let model = conversation
        .iter()
        .find_map(|row| as_nonempty(&row["message"]["model"]));
    let first = rows.iter().find_map(|row| as_nonempty(&row["timestamp"]));
    let last = rows
        .iter()
        .rev()
        .find_map(|row| as_nonempty(&row["timestamp"]));
    let seconds = first
        .as_deref()
        .and_then(|first| DateTime::parse_from_rfc3339(first).ok())
        .zip(
            last.as_deref()
                .and_then(|last| DateTime::parse_from_rfc3339(last).ok()),
        )
        .map(|(first, last)| (last - first).num_seconds().max(0))
        .unwrap_or_default();
    let spent = usage(&rows);
    let calls = conversation
        .iter()
        .flat_map(|row| row["message"]["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "tool_use")
        .count();
    let result = conversation
        .iter()
        .rev()
        .filter(|row| row["type"] == "assistant")
        .map(|row| message_text(&row["message"]))
        .find(|text| !text.is_empty())
        .and_then(|text| text.lines().next().map(str::to_string));
    let under = tool.as_deref().unwrap_or(&agent_id);
    let mut events = vec![json!({
        "type":"agent.started", "agentId":agent_id, "toolCallId":tool,
        "kind":"helper", "what":as_nonempty(&meta["description"]).and_then(|text| text.lines().next().map(str::to_string)).unwrap_or_default(),
        "agentType":as_nonempty(&meta["agentType"]), "model":model
    })];
    events.extend(transcript_events(&conversation, Some(under)));
    events.push(json!({
        "type":"agent.progress", "agentId":agent_id, "state":"running",
        "seconds":seconds, "tokens":spent.total, "calls":calls, "model":model
    }));
    let finish = json!({
        "type":"agent.finished", "agentId":agent_id,
        "seconds":seconds, "tokens":spent.total, "calls":calls,
        "model":model, "result":result
    });
    Some(HelperFacts {
        agent_id,
        tool_call_id: tool,
        first_at: first.unwrap_or_default(),
        events,
        finish,
    })
}

fn tool_outcomes(rows: &[Value]) -> HashMap<String, bool> {
    let mut outcomes = HashMap::new();
    for row in rows {
        for block in row["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_result" {
                if let Some(id) = block["tool_use_id"].as_str() {
                    outcomes.insert(id.to_string(), block["is_error"] != true);
                }
            }
        }
    }
    outcomes
}

/// Whether a saved chat ever sent work off to a helper.
///
/// The bundled claude ACP adapter cannot replay that. On `session/load` it
/// suppresses every `Task`/`Agent` call, meaning to send `subagent_spawned` in
/// its place, but it only knows a helper from transcript entries that carry a
/// `parent_tool_use_id` — and this Claude writes helper transcripts to a
/// `subagents/` directory instead, never inline. So the calls vanish and no
/// helper takes their place. A chat that delegated is read here rather than
/// through ACP; one that did not replays faithfully (bw-t26l.20).
pub fn delegates_work(record: &Path) -> bool {
    if let Some(stem) = record.file_stem().and_then(|stem| stem.to_str()) {
        let dir = record.with_file_name(stem).join("subagents");
        if fs::read_dir(dir).is_ok_and(|mut entries| entries.any(|entry| entry.is_ok())) {
            return true;
        }
    }
    jsonl(record).iter().any(|row| {
        row["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|block| {
                block["type"] == "tool_use"
                    && matches!(block["name"].as_str(), Some("Task") | Some("Agent"))
            })
    })
}

fn helper_events(record: &Path, outcomes: &HashMap<String, bool>) -> Vec<Value> {
    let Some(stem) = record.file_stem().and_then(|stem| stem.to_str()) else {
        return Vec::new();
    };
    let dir = record.with_file_name(stem).join("subagents");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut helpers = Vec::new();
    for entry in entries.flatten() {
        let Some(mut helper) = helper_facts(&entry.path()) else {
            continue;
        };
        if let Some(ok) = helper
            .tool_call_id
            .as_ref()
            .and_then(|call| outcomes.get(call))
        {
            helper.finish["state"] = json!(if *ok { "done" } else { "failed" });
            helper.events.push(helper.finish);
        }
        helpers.push((helper.first_at, helper.events));
    }
    helpers.sort_by(|a, b| a.0.cmp(&b.0));
    helpers.into_iter().flat_map(|(_, events)| events).collect()
}

/// Incremental view of the helper records beside one externally-owned chat.
///
/// Claude writes a detached helper's turns into its own JSONL. The parent file
/// contains only the dispatch and its eventual result, so following only that
/// file loses every child turn. A tick lists and stats the helper directory,
/// reads only files whose size changed, and content-addresses the normalized
/// events so growing files do not replay their already-seen prefix.
pub struct HelperFollower {
    record: PathBuf,
    sizes: HashMap<String, u64>,
    calls: HashMap<String, String>,
    outcomes: HashMap<String, bool>,
    ended: HashSet<String>,
    seen: HashSet<String>,
}

impl HelperFollower {
    pub fn after_import(record: &Path) -> Self {
        let rows = jsonl(record);
        let outcomes = tool_outcomes(&rows);
        let mut follower = Self {
            record: record.to_path_buf(),
            sizes: HashMap::new(),
            calls: HashMap::new(),
            outcomes,
            ended: HashSet::new(),
            seen: HashSet::new(),
        };
        // `read_history` has already normalized every current helper file.
        // Seed the incremental cursor and identities from that exact view so
        // the first follower tick cannot replay the imported prefix.
        for path in follower.paths() {
            let Ok(size) = fs::metadata(&path).map(|meta| meta.len()) else {
                continue;
            };
            let Some(mut helper) = helper_facts(&path) else {
                continue;
            };
            follower.sizes.insert(helper.agent_id.clone(), size);
            if let Some(call) = &helper.tool_call_id {
                follower.calls.insert(call.clone(), helper.agent_id.clone());
            }
            for event in &helper.events {
                follower
                    .seen
                    .insert(crate::workbench::protocol::record_event_id_at(
                        event,
                        crate::workbench::store::CLAUDE_IMPORT_RECIPE,
                    ));
            }
            if let Some(ok) = helper
                .tool_call_id
                .as_ref()
                .and_then(|call| follower.outcomes.get(call))
            {
                helper.finish["state"] = json!(if *ok { "done" } else { "failed" });
                follower
                    .seen
                    .insert(crate::workbench::protocol::record_event_id_at(
                        &helper.finish,
                        crate::workbench::store::CLAUDE_IMPORT_RECIPE,
                    ));
                follower.ended.insert(helper.agent_id);
            }
        }
        follower
    }

    /// A provider rewrite follows a transcript reset, so all current helper
    /// rows must be emitted into the new generation rather than treated as an
    /// already-imported prefix.
    pub fn after_reset(record: &Path) -> Self {
        let rows = jsonl(record);
        Self {
            record: record.to_path_buf(),
            sizes: HashMap::new(),
            calls: HashMap::new(),
            outcomes: tool_outcomes(&rows),
            ended: HashSet::new(),
            seen: HashSet::new(),
        }
    }

    fn paths(&self) -> Vec<PathBuf> {
        let Some(stem) = self.record.file_stem() else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(self.record.with_file_name(stem).join("subagents")) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
            })
            .collect()
    }

    /// New child transcript/progress events, then completions that must follow
    /// the parent `tool.completed` events supplied by this same beat.
    pub fn poll(&mut self, parent_events: &[Value]) -> (Vec<Value>, Vec<Value>) {
        for event in parent_events {
            if event["type"] == "tool.completed" {
                if let (Some(call), Some(ok)) =
                    (event["toolCallId"].as_str(), event["ok"].as_bool())
                {
                    self.outcomes.insert(call.to_string(), ok);
                }
            } else if event["type"] == "agent.finished" {
                if let Some(agent) = event["agentId"].as_str() {
                    self.ended.insert(agent.to_string());
                }
            }
        }

        let mut updates = Vec::new();
        let mut facts = HashMap::new();
        for path in self.paths() {
            let Ok(size) = fs::metadata(&path).map(|meta| meta.len()) else {
                continue;
            };
            let Some(helper) = helper_facts(&path) else {
                continue;
            };
            let changed = self.sizes.get(&helper.agent_id).copied() != Some(size);
            self.sizes.insert(helper.agent_id.clone(), size);
            if let Some(call) = &helper.tool_call_id {
                self.calls.insert(call.clone(), helper.agent_id.clone());
            }
            if changed {
                for event in &helper.events {
                    if self.ended.contains(&helper.agent_id) && event["type"] == "agent.progress" {
                        continue;
                    }
                    let id = crate::workbench::protocol::record_event_id_at(
                        event,
                        crate::workbench::store::CLAUDE_IMPORT_RECIPE,
                    );
                    if self.seen.insert(id) {
                        updates.push(event.clone());
                    }
                }
            }
            facts.insert(helper.agent_id.clone(), helper);
        }

        let mut finished = Vec::new();
        for (call, agent) in self.calls.clone() {
            let Some(ok) = self.outcomes.get(&call).copied() else {
                continue;
            };
            if !self.ended.insert(agent.clone()) {
                continue;
            }
            let helper = facts.get(&agent).cloned().or_else(|| {
                self.paths()
                    .into_iter()
                    .find_map(|path| helper_facts(&path).filter(|helper| helper.agent_id == agent))
            });
            let Some(mut helper) = helper else {
                self.ended.remove(&agent);
                continue;
            };
            helper.finish["state"] = json!(if ok { "done" } else { "failed" });
            let id = crate::workbench::protocol::record_event_id_at(
                &helper.finish,
                crate::workbench::store::CLAUDE_IMPORT_RECIPE,
            );
            if self.seen.insert(id) {
                finished.push(helper.finish);
            }
        }
        (updates, finished)
    }
}

pub fn read_history(record: &Path) -> ClaudeHistory {
    // This is the deliberate import boundary, not list discovery and not a
    // follower tick. Read the provider record once, off the request path. The
    // durable event store pages the normalized transcript; truncating here
    // would give external chats a different, permanently incomplete history.
    let rows = jsonl(record);
    let spent = usage(&rows);
    let conversation = ordered_conversation(&rows, false);
    let mut events = transcript_events(&conversation, None);
    events.extend(helper_events(record, &tool_outcomes(&rows)));
    if let Some(used) = spent.context {
        events.push(json!({"type":"context", "used":used, "window":spent.window}));
    }
    // What the chat spent is what it spent, the agents it sent off included:
    // the chip this feeds says "including subagents", and a live chat's own
    // figure already counts them. Their turns are in none of these rows
    // (bw-t26l.20).
    let delegated: i64 = helper_spend(record)
        .iter()
        .map(|(spent, _)| spent.total)
        .sum();
    if spent.total > 0 || delegated > 0 {
        events.push(json!({
            "type":"cost", "cost":{"kind":"tokens", "input":spent.input,
            "output":spent.output, "total":spent.total.saturating_add(delegated),
            "delegated":delegated}
        }));
    }
    ClaudeHistory {
        events,
        settings: settings(&rows),
        input_tokens: spent.input,
        output_tokens: spent.output,
        total_tokens: spent.total,
        context_used: spent.context,
        context_window: spent.window,
    }
}

/// Give a complete Claude-record replay the same stable identity at every
/// ingestion boundary. Opening, resuming, and following must not mint three
/// identities for the same provider event.
pub fn identified_replay(events: Vec<Value>, external_id: &str) -> Vec<Value> {
    events
        .into_iter()
        .map(|mut event| {
            let event_id = crate::workbench::protocol::provider_record_event_id("claude", &event);
            if let Some(object) = event.as_object_mut() {
                object.insert(
                    "providerEvent".into(),
                    json!({
                        "provider":"claude", "threadId":external_id,
                        "eventId":event_id, "delivery":"replay"
                    }),
                );
            }
            event
        })
        .collect()
}

/// Normalize a bounded tail window. The external follower owns byte cursors;
/// this function deliberately knows nothing about, and never opens, the full
/// record behind those newly appended lines.
pub fn replay_lines(lines: &[String]) -> Vec<Value> {
    let rows = lines
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let mut events = transcript_events(&rows, None);
    // Settings are conversation facts, not transport state. External Claude
    // can change them while Atelier only follows the JSONL record, so publish
    // the same pin event the native driver publishes. The durable actor owns
    // persistence and provider-event identity drops unchanged observations.
    let observed = settings(&rows);
    if observed.model.is_some() || observed.permission_mode.is_some() || observed.effort.is_some() {
        events.push(json!({
            "type":"session.pinned",
            "model":observed.model,
            "permissionMode":observed.permission_mode,
            "effort":observed.effort
        }));
    }
    // External Claude sessions report helper lifecycle in system rows beside
    // the conversation.  A follower must translate these just as the native
    // driver does or a running helper becomes an anonymous command until the
    // chat is reopened and its subagent record imported.
    for row in &rows {
        if row["type"] != "system" {
            continue;
        }
        match row["subtype"].as_str() {
            Some("thinking_tokens") => events.push(json!({
                "type":"thinking.progress","tokens":row["estimated_tokens"]
            })),
            Some("task_started") => events.push(json!({
                "type":"agent.started","agentId":row["task_id"],
                "toolCallId":row.get("tool_use_id").cloned().unwrap_or(Value::Null),
                "kind":"helper","what":row.get("description").cloned().unwrap_or(json!("")),
                "agentType":row.get("agent_type").cloned().unwrap_or(Value::Null),"model":Value::Null
            })),
            Some("task_progress") if row["tool_use_id"].is_string() => events.push(json!({
                "type":"agent.progress","agentId":row["task_id"],
                "seconds":row["usage"]["duration_ms"].as_i64().unwrap_or_default()/1000,
                "doing":row.get("summary").cloned().unwrap_or(Value::Null),
                "tokens":row["usage"]["total_tokens"],"calls":row["usage"]["tool_uses"]
            })),
            Some("task_notification") => events.push(json!({
                "type":"agent.finished","agentId":row["task_id"],
                "state":if row["status"]=="failed"{"failed"}else{"done"},
                "seconds":row["usage"]["duration_ms"].as_i64().unwrap_or_default()/1000,
                "tokens":row["usage"]["total_tokens"],"calls":row["usage"]["tool_uses"],
                "model":row.get("model").cloned().unwrap_or(Value::Null),
                "result":row.get("summary").cloned().unwrap_or(Value::Null)
            })),
            _ => {}
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write, OpenOptions};
    use std::io::Write as _;
    use tempfile::tempdir;

    const CHAT: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        let record = dir.join(format!("{CHAT}.jsonl"));
        let lines = [
            json!({"type":"user","uuid":"u1","cwd":"/work/repo/tree","gitBranch":"ours","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"YWJj"}},{"type":"text","text":"look [Image #1]"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","permissionMode":"plan","effort":"high","message":{"id":"turn-1","model":"claude-test","usage":{"input_tokens":5,"cache_read_input_tokens":7,"output_tokens":3},"content":[{"type":"text","text":"done"},{"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"/tmp/a"}}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"a1","message":{"id":"turn-1","usage":{"input_tokens":5,"cache_read_input_tokens":7,"output_tokens":3},"content":[]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a2","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"contents"}]}}),
        ];
        let mut text = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        text.push_str("\n{half-written");
        write(&record, text).unwrap();
        (home, record)
    }

    #[test]
    fn every_claude_replay_boundary_uses_the_current_record_identity() {
        let source = json!({"type":"notice","text":"same provider event"});
        let identified = identified_replay(vec![source.clone()], CHAT);

        assert_eq!(
            identified[0]["providerEvent"]["eventId"],
            crate::workbench::protocol::record_event_id_at(
                &source,
                crate::workbench::store::CLAUDE_IMPORT_RECIPE,
            )
        );
        assert_eq!(identified[0]["providerEvent"]["threadId"], CHAT);
        assert_eq!(identified[0]["providerEvent"]["delivery"], "replay");
    }

    #[test]
    fn claude_history_uses_the_latest_primary_parent_chain_not_file_order() {
        let rows = vec![
            json!({"type":"user","uuid":"u1","message":{"content":"first"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"1","message":{"id":"m1","content":"answer one"}}),
            json!({"type":"user","uuid":"abandoned","parentUuid":"u1","message":{"content":"discarded retry"}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"a1","timestamp":"3","message":{"id":"m2","content":"answer two"}}),
            json!({"type":"attachment","uuid":"tail","parentUuid":"a2","attachment":{"type":"total_tokens_reminder"}}),
            json!({"type":"assistant","uuid":"helper","isSidechain":true,"timestamp":"4","message":{"content":"sidechain leaf"}}),
        ];
        let ordered = ordered_conversation(&rows, false);
        assert_eq!(
            ordered
                .iter()
                .map(|row| row["uuid"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["u1", "a1", "a2"]
        );
    }

    #[test]
    fn claude_history_keeps_identityless_rows_beside_uuid_backed_rows() {
        let rows = vec![
            json!({"type":"user","uuid":"u1","timestamp":"1","message":{"content":"First prompt"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2","message":{"id":"a","content":"First answer"}}),
            json!({"type":"user","source":"sdk-ts","timestamp":"3","message":{"content":"SDK prompt"}}),
            json!({"type":"user","source":"sdk-ts","timestamp":"3","message":{"content":"SDK prompt"}}),
            json!({"type":"assistant","source":"sdk-ts","timestamp":"4","message":{"id":"sdk-answer","content":"SDK answer"}}),
            json!({"type":"user","source":"sdk-ts","timestamp":"5","message":{"content":"SDK prompt"}}),
        ];

        let ordered = ordered_conversation(&rows, false);
        assert_eq!(
            ordered
                .iter()
                .map(|row| (row["type"].as_str().unwrap(), message_text(&row["message"])))
                .collect::<Vec<_>>(),
            [
                ("user", "First prompt".into()),
                ("assistant", "First answer".into()),
                ("user", "SDK prompt".into()),
                ("assistant", "SDK answer".into()),
                ("user", "SDK prompt".into()),
            ]
        );
    }

    #[test]
    fn claude_history_places_streamed_variants_and_results_beside_their_message() {
        let rows = vec![
            json!({"type":"user","uuid":"u1","message":{"content":"prompt"}}),
            json!({"type":"assistant","uuid":"fragment","parentUuid":"u1","timestamp":"2","message":{"id":"turn","content":"words"}}),
            json!({"type":"user","uuid":"result","parentUuid":"fragment","timestamp":"3","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":"done"}]}}),
            json!({"type":"assistant","uuid":"canonical","parentUuid":"u1","timestamp":"1","message":{"id":"turn","content":[]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"canonical","timestamp":"4","message":{"content":"next"}}),
        ];
        let ordered = ordered_conversation(&rows, false);
        assert_eq!(
            ordered
                .iter()
                .map(|row| row["uuid"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["u1", "canonical", "fragment", "result", "u2"]
        );
    }

    #[test]
    fn claude_history_keeps_every_canonical_compaction_segment() {
        let rows = vec![
            json!({"type":"user","uuid":"u1","message":{"content":"first"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"id":"m1","content":"answer one"}}),
            json!({"type":"system","subtype":"compact_boundary","uuid":"boundary"}),
            json!({"type":"user","uuid":"summary","parentUuid":"boundary","isCompactSummary":true,"message":{"content":"summary"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"summary","message":{"id":"m1","content":"answer one"}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","message":{"content":"second"}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","message":{"id":"m2","content":"answer two"}}),
        ];
        let ordered = ordered_conversation(&rows, false);
        assert_eq!(
            ordered
                .iter()
                .map(|row| row["uuid"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["u1", "a1", "summary", "u2", "a2"]
        );
    }

    #[test]
    fn native_claude_history_discovers_worktrees_and_ignores_partial_tail() {
        let (home, _) = fixture();
        let sessions = list_sessions(home.path(), Some(Path::new("/work/repo")), false);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, CHAT);
        assert_eq!(sessions[0].name.as_deref(), Some("Look Image 1"));
        assert_eq!(sessions[0].git_branch.as_deref(), Some("ours"));
        assert!(find_record(home.path(), CHAT).is_some());
        assert!(find_record(home.path(), "../../etc/passwd").is_none());
    }

    #[test]
    fn claude_discovery_keeps_the_name_a_chat_has_and_only_invents_one_for_a_chat_with_none() {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        write(dir.join(format!("{CHAT}.jsonl")), [
            json!({"type":"summary","summary":"currently we don't have ability to close a session in this chat. fix that."}),
            json!({"type":"custom-title","customTitle":"Agent Defined Conversation Name"}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let sessions = list_sessions(home.path(), None, false);
        assert_eq!(
            sessions[0].name.as_deref(),
            Some("Agent Defined Conversation Name")
        );
        // The name the chat made for itself, kept exactly as it wrote it.
        let named = home.path().join("projects/project/11111111-2222-3333-4444-555555555555.jsonl");
        write(&named, [
            json!({"type":"ai-title","aiTitle":"READY"}),
            json!({"type":"user","message":{"role":"user","content":"Reply with exactly: READY"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(
            list_sessions(home.path(), None, false)
                .iter()
                .find(|session| session.session_id.starts_with("11111111"))
                .and_then(|session| session.name.as_deref()),
            Some("READY")
        );
        // And one that named itself nothing still gets a name of ours.
        let unnamed = home.path().join("projects/project/22222222-2222-3333-4444-555555555555.jsonl");
        write(&unnamed, [
            json!({"type":"user","message":{"role":"user","content":"Reply with exactly: READY"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(
            list_sessions(home.path(), None, false)
                .iter()
                .find(|session| session.session_id.starts_with("22222222"))
                .and_then(|session| session.name.as_deref()),
            Some("Reply Exactly READY")
        );
        let record = dir.join(format!("{CHAT}.jsonl"));
        let mut file = OpenOptions::new().append(true).open(record).unwrap();
        writeln!(
            file,
            "\n{}",
            json!({"type":"custom-title","customTitle":"A Newer Name"})
        )
        .unwrap();
        assert_eq!(
            list_sessions(home.path(), None, false)
                .iter()
                .find(|session| session.session_id == CHAT)
                .and_then(|session| session.name.as_deref()),
            Some("A Newer Name")
        );
    }

    #[test]
    fn claude_discovery_omits_abandoned_metadata_only_starts() {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        write(
            dir.join(format!("{CHAT}.jsonl")),
            json!({"type":"system","cwd":"/work/repo","gitBranch":"ours"}).to_string(),
        )
        .unwrap();

        assert!(list_sessions(home.path(), None, false).is_empty());
        assert!(list_sessions(home.path(), None, true).is_empty());
    }

    #[test]
    fn claude_discovery_never_hides_a_persons_chat_for_an_api_error_or_sdk_host() {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        write(dir.join(format!("{CHAT}.jsonl")), [
            json!({"type":"user","isSidechain":false,"source":"sdk-ts","cwd":"/work/repo","timestamp":"2026-08-30T00:00:00Z","message":{"content":"Please continue"}}),
            json!({"type":"assistant","isSidechain":false,"isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 500"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();

        let sessions = list_sessions(home.path(), None, false);
        assert_eq!(sessions.len(), 1);
        assert!(!sessions[0].programmatic);
    }

    #[test]
    fn claude_discovery_hides_sidechain_sessions_until_everything_is_requested() {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        write(
            dir.join(format!("{CHAT}.jsonl")),
            json!({
                "type":"user","isSidechain":true,"cwd":"/work/repo",
                "timestamp":"2026-08-30T00:00:00Z","message":{"content":"Review this change"}
            })
            .to_string(),
        )
        .unwrap();

        assert!(list_sessions(home.path(), None, false).is_empty());
        let sessions = list_sessions(home.path(), None, true);
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].programmatic);
    }

    #[test]
    fn claude_discovery_reads_the_last_human_timestamp_past_a_huge_final_turn() {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        let record = dir.join(format!("{CHAT}.jsonl"));
        let user = json!({
            "type":"user","cwd":"/work/repo","timestamp":"2026-08-30T00:00:00Z",
            "message":{"content":"Run the large report"}
        });
        let assistant = json!({
            "type":"assistant","timestamp":"2026-08-30T00:10:00Z",
            "message":{"content":[{"type":"tool_use","id":"large","name":"Bash","input":{
                "command":"report","output":"x".repeat(400_000)
            }}]}
        });
        write(&record, format!("{user}\n{assistant}\n")).unwrap();

        let sessions = list_sessions(home.path(), None, false);
        assert_eq!(
            sessions[0].last_spoke_at.as_deref(),
            Some("2026-08-30T00:00:00Z")
        );
    }

    #[test]
    fn native_claude_history_rebuilds_words_images_tools_settings_and_unique_usage() {
        let (_home, record) = fixture();
        let history = read_history(&record);
        assert_eq!(history.settings.model.as_deref(), Some("claude-test"));
        assert_eq!(history.settings.permission_mode.as_deref(), Some("plan"));
        assert_eq!(history.settings.effort.as_deref(), Some("high"));
        assert_eq!(
            (
                history.input_tokens,
                history.output_tokens,
                history.total_tokens
            ),
            (12, 3, 15)
        );
        let picture = token_spend(&record).unwrap();
        assert_eq!(
            picture["own"],
            json!({"input":5,"cacheWrite":0,"cacheRead":7,"output":3,"thinking":0,"total":15})
        );
        assert_eq!(picture["turns"], 1);
        assert_eq!(picture["toolCalls"], 1);
        assert!(history.events.iter().any(|event| event["type"] == "image"));
        assert!(history
            .events
            .iter()
            .any(|event| event["type"] == "text.delta" && event["text"] == "look"));
        assert!(history
            .events
            .iter()
            .any(|event| event["type"] == "tool.completed" && event["output"] == "contents"));
        assert_eq!(
            history
                .events
                .iter()
                .filter(|event| event["type"] == "cost")
                .count(),
            1
        );
    }

    #[test]
    fn external_claude_growth_reports_conversation_settings() {
        let lines = vec![
            json!({"type":"assistant","permissionMode":"plan","effort":"high","message":{"model":"claude-sonnet","content":[]}}).to_string(),
        ];
        let events = replay_lines(&lines);
        let pinned = events
            .iter()
            .find(|event| event["type"] == "session.pinned")
            .expect("external settings are visible to the shared session actor");
        assert_eq!(pinned["model"], "claude-sonnet");
        assert_eq!(pinned["permissionMode"], "plan");
        assert_eq!(pinned["effort"], "high");
    }

    #[test]
    fn external_claude_keeps_a_tool_running_until_its_result_exists() {
        let lines = vec![json!({
            "type":"assistant","uuid":"a1","message":{"content":[{
                "type":"tool_use","id":"call-open","name":"Bash","input":{"command":"cargo test"}
            }]}
        })
        .to_string()];
        let events = replay_lines(&lines);
        assert!(events.iter().any(|event| event["type"] == "tool.started"));
        assert!(!events.iter().any(|event| event["type"] == "tool.completed"));

        let result_only = vec![json!({
            "type":"user","uuid":"u2","message":{"content":[{
                "type":"tool_result","tool_use_id":"call-open","content":"passed"
            }]}
        })
        .to_string()];
        let completed = replay_lines(&result_only);
        assert!(completed
            .iter()
            .any(|event| event["type"] == "tool.completed"
                && event["toolCallId"] == "call-open"
                && event["ok"] == true));
    }

    #[test]
    fn claude_tool_result_images_survive_full_replay_and_follower_windows() {
        let result = json!({
            "type":"user","uuid":"result","message":{"content":[{
                "type":"tool_result","tool_use_id":"call-image","content":[
                    {"type":"text","text":"two pictures"},
                    {"type":"image","source":{
                        "type":"base64","media_type":"image/png","data":"YWJj"
                    }},
                    {"type":"image","source":{
                        "type":"url","media_type":"image/jpeg","url":"https://example.test/picture.jpg"
                    }}
                ]
            }]}
        });
        let rows = vec![
            json!({
                "type":"assistant","uuid":"tool","message":{"content":[{
                    "type":"tool_use","id":"call-image","name":"Read","input":{}
                }]}
            }),
            result.clone(),
        ];

        for events in [
            transcript_events(&rows, None),
            transcript_events(&[result], None),
        ] {
            let image_events = events
                .iter()
                .filter(|event| {
                    event["type"] == "image" && event["messageId"] == "call-image:images"
                })
                .collect::<Vec<_>>();
            assert_eq!(image_events.len(), 2);
            assert_eq!(
                image_events[0]["image"],
                json!({
                    "mime":"image/png",
                    "dataUrl":"data:image/png;base64,YWJj",
                    "alt":"Agent-produced image"
                })
            );
            assert_eq!(
                image_events[1]["image"]["dataUrl"],
                "https://example.test/picture.jpg"
            );
            assert!(events.iter().any(|event| {
                event["type"] == "message.started"
                    && event["messageId"] == "call-image:images"
                    && event["role"] == "assistant"
            }));
            assert!(events.iter().any(|event| {
                event["type"] == "message.completed" && event["messageId"] == "call-image:images"
            }));
        }
    }

    #[test]
    fn claude_settings_never_take_a_helpers_or_synthetic_model() {
        let rows = vec![
            json!({"type":"assistant","effort":"xhigh","message":{"model":"opus"}}),
            json!({"type":"assistant","isSidechain":true,"effort":"low","message":{"model":"haiku"}}),
            json!({"type":"assistant","message":{"model":"<synthetic>"}}),
        ];
        let observed = settings(&rows);
        assert_eq!(observed.model.as_deref(), Some("opus"));
        assert_eq!(observed.effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn native_claude_history_restores_helpers_under_their_dispatch_call() {
        let (_home, record) = fixture();
        let helper_dir = record.with_file_name(CHAT).join("subagents");
        create_dir_all(&helper_dir).unwrap();
        write(
            helper_dir.join("agent-h1.meta.json"),
            json!({"toolUseId":"call-1","agentType":"Explore","description":"Find it\nmore"})
                .to_string(),
        )
        .unwrap();
        write(helper_dir.join("agent-h1.jsonl"), [
            json!({"type":"user","isSidechain":true,"timestamp":"2026-08-30T00:00:00Z","message":{"content":"search"}}),
            json!({"type":"assistant","isSidechain":true,"timestamp":"2026-08-30T00:00:02Z","message":{"id":"hturn","model":"haiku","usage":{"input_tokens":2,"output_tokens":1},"content":[{"type":"text","text":"found"}]}})
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let history = read_history(&record);
        assert!(history
            .events
            .iter()
            .any(|event| event["type"] == "agent.started" && event["toolCallId"] == "call-1"));
        assert!(history.events.iter().any(
            |event| event["type"] == "message.started" && event["parentToolCallId"] == "call-1"
        ));
        assert!(history
            .events
            .iter()
            .any(|event| event["type"] == "text.delta" && event["text"] == "found"));
        assert!(history
            .events
            .iter()
            .any(|event| event["type"] == "agent.finished" && event["seconds"] == 2));
    }

    #[test]
    fn a_chat_that_sent_work_off_is_read_from_the_record_not_through_acp() {
        let home = tempdir().unwrap();
        let alone = home.path().join(format!("{CHAT}.jsonl"));
        write(
            &alone,
            json!({"type":"assistant","message":{"content":[{
                "type":"tool_use","id":"call-read","name":"Read","input":{}
            }]}})
            .to_string()
                + "\n",
        )
        .unwrap();
        assert!(
            !delegates_work(&alone),
            "a chat that only read a file replays faithfully through ACP"
        );

        let sent_off = home.path().join("11111111-1111-4111-8111-111111111111.jsonl");
        write(
            &sent_off,
            json!({"type":"assistant","message":{"content":[{
                "type":"tool_use","id":"call-task","name":"Task","input":{}
            }]}})
            .to_string()
                + "\n",
        )
        .unwrap();
        assert!(
            delegates_work(&sent_off),
            "the adapter drops the dispatch call, so this one is read from the record"
        );

        let transcripts = home.path().join("22222222-2222-4222-8222-222222222222.jsonl");
        write(&transcripts, "").unwrap();
        let helper_dir = transcripts
            .with_file_name("22222222-2222-4222-8222-222222222222")
            .join("subagents");
        create_dir_all(&helper_dir).unwrap();
        write(helper_dir.join("helper.jsonl"), "").unwrap();
        assert!(
            delegates_work(&transcripts),
            "a helper transcript on disk is a helper the replay cannot rebuild"
        );
    }

    /// The chip over a chat says "including subagents" and the record says
    /// nothing about them: a helper's turns are in a file of their own. Read
    /// from the chat's rows alone, a chat that did most of its work by sending
    /// it away reports a fraction of its bill (bw-t26l.20).
    #[test]
    fn what_a_chat_spent_counts_the_agents_it_sent_off() {
        let home = tempdir().unwrap();
        let record = home.path().join(format!("{CHAT}.jsonl"));
        write(&record, json!({
            "type":"assistant","message":{"id":"own","model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":20},
            "content":[{"type":"tool_use","id":"call-sent","name":"Task","input":{"description":"Count"}}]}
        }).to_string()+"\n").unwrap();
        let helper_dir = record.with_file_name(CHAT).join("subagents");
        create_dir_all(&helper_dir).unwrap();
        write(helper_dir.join("agent-counted.jsonl"), json!({
            "type":"assistant","isSidechain":true,"timestamp":"2026-08-30T00:00:00Z",
            "message":{"id":"helper","model":"haiku","usage":{"input_tokens":700,"output_tokens":80},
            "content":[{"type":"text","text":"Counted."}]}
        }).to_string()+"\n").unwrap();

        let cost = read_history(&record)
            .events
            .into_iter()
            .find(|event| event["type"] == "cost")
            .expect("a chat that spent anything reports what it spent");
        assert_eq!(cost["cost"]["total"], json!(900), "120 of its own and 780 sent away");
        assert_eq!(cost["cost"]["delegated"], json!(780));
        // Its own halves stay its own, so the two readings can be told apart.
        assert_eq!(cost["cost"]["input"], json!(100));
        assert_eq!(cost["cost"]["output"], json!(20));
    }

    #[test]
    fn native_claude_history_does_not_finish_a_helper_before_its_parent_result() {
        let home = tempdir().unwrap();
        let record = home.path().join(format!("{CHAT}.jsonl"));
        write(&record, json!({
            "type":"assistant","message":{"content":[{
                "type":"tool_use","id":"call-live","name":"Agent","input":{"description":"Inspect"}
            }]}
        }).to_string()+"\n").unwrap();
        let helper_dir = record.with_file_name(CHAT).join("subagents");
        create_dir_all(&helper_dir).unwrap();
        write(
            helper_dir.join("agent-live.meta.json"),
            json!({
                "toolUseId":"call-live","description":"Inspect"
            })
            .to_string(),
        )
        .unwrap();
        write(helper_dir.join("agent-live.jsonl"), json!({
            "type":"assistant","timestamp":"2026-08-30T00:00:00Z",
            "message":{"model":"haiku","content":[{"type":"tool_use","id":"inside","name":"Read","input":{}}]}
        }).to_string()+"\n").unwrap();

        let events = read_history(&record).events;
        assert!(events.iter().any(|event| event["type"] == "agent.progress"
            && event["agentId"] == "live"
            && event["state"] == "running"));
        assert!(!events
            .iter()
            .any(|event| event["type"] == "agent.finished" && event["agentId"] == "live"));
    }

    #[test]
    fn native_claude_history_uses_the_parent_result_for_helper_failure() {
        let home = tempdir().unwrap();
        let record = home.path().join(format!("{CHAT}.jsonl"));
        write(&record, [
            json!({"type":"assistant","message":{"content":[{
                "type":"tool_use","id":"call-failed","name":"Agent","input":{}
            }]}}),
            json!({"type":"user","message":{"content":[{
                "type":"tool_result","tool_use_id":"call-failed","is_error":true,"content":"failed"
            }]}})
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n")+"\n").unwrap();
        let helper_dir = record.with_file_name(CHAT).join("subagents");
        create_dir_all(&helper_dir).unwrap();
        write(
            helper_dir.join("agent-bad.meta.json"),
            json!({"toolUseId":"call-failed"}).to_string(),
        )
        .unwrap();
        write(
            helper_dir.join("agent-bad.jsonl"),
            json!({
                "type":"assistant","message":{"content":[{"type":"text","text":"Could not do it"}]}
            })
            .to_string()
                + "\n",
        )
        .unwrap();

        assert!(read_history(&record).events.iter().any(|event| {
            event["type"] == "agent.finished"
                && event["agentId"] == "bad"
                && event["state"] == "failed"
        }));
    }

    #[test]
    fn native_claude_helper_follower_reads_only_growth_and_settles_by_parent_call() {
        let home = tempdir().unwrap();
        let record = home.path().join(format!("{CHAT}.jsonl"));
        write(&record, "").unwrap();
        let helper_dir = record.with_file_name(CHAT).join("subagents");
        create_dir_all(&helper_dir).unwrap();
        write(
            helper_dir.join("agent-h1.meta.json"),
            json!({
                "toolUseId":"call-1","description":"Watch it"
            })
            .to_string(),
        )
        .unwrap();
        let helper = helper_dir.join("agent-h1.jsonl");
        write(
            &helper,
            json!({
                "type":"user","uuid":"helper-user","timestamp":"2026-08-30T00:00:00Z",
                "message":{"content":"Start"}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        let mut follower = HelperFollower::after_import(&record);

        let (first, done) = follower.poll(&[]);
        assert!(first.is_empty());
        assert!(done.is_empty());

        let next = json!({
            "type":"assistant","uuid":"helper-answer","timestamp":"2026-08-30T00:00:03Z",
            "message":{"model":"haiku","content":[{"type":"text","text":"Done"}]}
        });
        let mut file = OpenOptions::new().append(true).open(&helper).unwrap();
        writeln!(file, "{next}").unwrap();
        let (growth, done) = follower.poll(&[]);
        assert!(done.is_empty());
        assert_eq!(
            growth
                .iter()
                .filter(|event| event["type"] == "text.delta" && event["text"] == "Start")
                .count(),
            0
        );
        assert!(growth
            .iter()
            .any(|event| event["type"] == "text.delta" && event["text"] == "Done"));

        let parent = vec![json!({
            "type":"tool.completed","toolCallId":"call-1","ok":true,"output":"Done"
        })];
        let (growth, done) = follower.poll(&parent);
        assert!(growth.is_empty());
        assert!(done.iter().any(|event| event["type"] == "agent.finished"
            && event["agentId"] == "h1"
            && event["state"] == "done"));
        assert!(follower.poll(&parent).1.is_empty());
    }
}
