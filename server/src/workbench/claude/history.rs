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
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use uuid::Uuid;

const IMPORTED_MESSAGES: usize = 200;
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

fn summary(path: PathBuf) -> Option<ClaudeSessionSummary> {
    let session_id = path.file_stem()?.to_str()?.to_string();
    let rows = jsonl(&path);
    let mut cwd = None;
    let mut branch = None;
    let mut custom_title = None;
    let mut summary = None;
    let mut first_prompt = None;
    let mut programmatic = false;
    for row in &rows {
        cwd = as_nonempty(&row["cwd"]).map(PathBuf::from).or(cwd);
        branch = as_nonempty(&row["gitBranch"]).or(branch);
        custom_title = as_nonempty(&row["customTitle"]).or(custom_title);
        summary = as_nonempty(&row["summary"]).or(summary);
        programmatic |= row["isApiErrorMessage"] == true
            || row["source"]
                .as_str()
                .is_some_and(|source| source.contains("sdk"));
        if first_prompt.is_none() && visible(row) && row["type"] == "user" {
            let text = message_text(&row["message"]);
            if human_words(&text) {
                first_prompt = Some(text);
            }
        }
    }
    Some(ClaudeSessionSummary {
        session_id,
        last_modified: modified(&path),
        name: custom_title.or(summary).or(first_prompt),
        cwd,
        git_branch: branch,
        programmatic,
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
        .filter_map(summary)
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
    output: i64,
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
        let input = fields["input_tokens"].as_i64().unwrap_or_default()
            + fields["cache_creation_input_tokens"]
                .as_i64()
                .unwrap_or_default()
            + fields["cache_read_input_tokens"]
                .as_i64()
                .unwrap_or_default();
        let output = fields["output_tokens"].as_i64().unwrap_or_default();
        if input + output > 0 {
            out.context = Some(input + output);
        }
        let key = as_nonempty(&message["id"]).unwrap_or_else(|| format!("line-{index}"));
        if seen.insert(key) {
            out.input += input;
            out.output += output;
            out.total += input + output;
        }
    }
    out
}

fn settings(rows: &[Value]) -> ClaudeSettings {
    let mut found = ClaudeSettings::default();
    for row in rows {
        found.permission_mode = as_nonempty(&row["permissionMode"]).or(found.permission_mode);
        found.effort = as_nonempty(&row["effort"]).or(found.effort);
        found.model = as_nonempty(&row["message"]["model"]).or(found.model);
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
                        (result_text(&block["content"]), block["is_error"] != true),
                    );
                }
            }
        }
    }
    let mut events = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if !visible(row) {
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
            let (output, ok) = results.get(call_id).cloned().unwrap_or_default();
            events.push(json!({
                "type":"tool.completed", "toolCallId":call_id, "ok":ok,
                "output":cut(output, KEPT)
            }));
        }
    }
    events
}

fn helper_events(record: &Path) -> Vec<Value> {
    let Some(stem) = record.file_stem().and_then(|stem| stem.to_str()) else {
        return Vec::new();
    };
    let dir = record.with_file_name(stem).join("subagents");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut helpers = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(agent_id) = name
            .strip_prefix("agent-")
            .and_then(|name| name.strip_suffix(".jsonl"))
        else {
            continue;
        };
        let rows = jsonl(&path);
        let meta_path = path.with_file_name(format!("agent-{agent_id}.meta.json"));
        let meta: Value = fs::read_to_string(meta_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let tool = as_nonempty(&meta["toolUseId"]);
        let model = rows
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
        let calls = rows
            .iter()
            .flat_map(|row| row["message"]["content"].as_array().into_iter().flatten())
            .filter(|block| block["type"] == "tool_use")
            .count();
        let result = rows
            .iter()
            .rev()
            .filter(|row| row["type"] == "assistant")
            .map(|row| message_text(&row["message"]))
            .find(|text| !text.is_empty())
            .and_then(|text| text.lines().next().map(str::to_string));
        let under = tool.as_deref().unwrap_or(agent_id);
        let mut events = vec![json!({
            "type":"agent.started", "agentId":agent_id, "toolCallId":tool,
            "kind":"helper", "what":as_nonempty(&meta["description"]).and_then(|text| text.lines().next().map(str::to_string)).unwrap_or_default(),
            "agentType":as_nonempty(&meta["agentType"]), "model":model
        })];
        let nested = transcript_events(&rows, Some(under));
        events.extend(
            nested
                .into_iter()
                .rev()
                .take(IMPORTED_MESSAGES)
                .collect::<Vec<_>>()
                .into_iter()
                .rev(),
        );
        events.push(json!({
            "type":"agent.finished", "agentId":agent_id, "state":"done",
            "seconds":seconds, "tokens":spent.total, "calls":calls,
            "model":model, "result":result
        }));
        helpers.push((first.unwrap_or_default(), events));
    }
    helpers.sort_by(|a, b| a.0.cmp(&b.0));
    helpers.into_iter().flat_map(|(_, events)| events).collect()
}

pub fn read_history(record: &Path) -> ClaudeHistory {
    let rows = jsonl(record);
    let spent = usage(&rows);
    let mut events = transcript_events(&rows, None);
    if events.len() > IMPORTED_MESSAGES {
        let omitted = events.len() - IMPORTED_MESSAGES;
        events = events.split_off(omitted);
        events.insert(0, json!({
            "type":"notice", "family":"memory", "audience":"you",
            "text":format!("{omitted} earlier transcript events are in this chat and are not drawn here.")
        }));
    }
    events.extend(helper_events(record));
    if let Some(used) = spent.context {
        events.push(json!({"type":"context", "used":used, "window":spent.window}));
    }
    if spent.total > 0 {
        events.push(json!({
            "type":"cost", "cost":{"kind":"tokens", "input":spent.input,
            "output":spent.output, "total":spent.total}
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use tempfile::tempdir;

    const CHAT: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let home = tempdir().unwrap();
        let dir = home.path().join("projects/project");
        create_dir_all(&dir).unwrap();
        let record = dir.join(format!("{CHAT}.jsonl"));
        let lines = [
            json!({"type":"user","uuid":"u1","cwd":"/work/repo/tree","gitBranch":"ours","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"YWJj"}},{"type":"text","text":"look [Image #1]"}]}}),
            json!({"type":"assistant","uuid":"a1","permissionMode":"plan","effort":"high","message":{"id":"turn-1","model":"claude-test","usage":{"input_tokens":5,"cache_read_input_tokens":7,"output_tokens":3},"content":[{"type":"text","text":"done"},{"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"/tmp/a"}}]}}),
            json!({"type":"assistant","uuid":"a2","message":{"id":"turn-1","usage":{"input_tokens":5,"cache_read_input_tokens":7,"output_tokens":3},"content":[]}}),
            json!({"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"contents"}]}}),
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
    fn native_claude_history_discovers_worktrees_and_ignores_partial_tail() {
        let (home, _) = fixture();
        let sessions = list_sessions(home.path(), Some(Path::new("/work/repo")), false);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, CHAT);
        assert_eq!(sessions[0].name.as_deref(), Some("look [Image #1]"));
        assert_eq!(sessions[0].git_branch.as_deref(), Some("ours"));
        assert!(find_record(home.path(), CHAT).is_some());
        assert!(find_record(home.path(), "../../etc/passwd").is_none());
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
            json!({"type":"user","timestamp":"2026-08-30T00:00:00Z","message":{"content":"search"}}),
            json!({"type":"assistant","timestamp":"2026-08-30T00:00:02Z","message":{"id":"hturn","model":"haiku","usage":{"input_tokens":2,"output_tokens":1},"content":[{"type":"text","text":"found"}]}})
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
            .any(|event| event["type"] == "agent.finished" && event["seconds"] == 2));
    }
}
