//! Read-only observation of conversations held by another provider process.
//!
//! Atelier must not offer to resume a conversation while a terminal or a
//! different host owns it. Claude publishes exact process markers; Codex does
//! not, so its CLI argv/open rollout descriptors and its own process log form
//! the equivalent signal. Nothing in this module signals or modifies those
//! processes or their files.

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

fn record_cwd(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut front = Vec::with_capacity(64_000);
    file.by_ref().take(64_000).read_to_end(&mut front).ok()?;
    String::from_utf8_lossy(&front).lines().find_map(|line| {
        let row: Value = serde_json::from_str(line).ok()?;
        row["cwd"]
            .as_str()
            .or_else(|| row["payload"]["cwd"].as_str())
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_string)
    })
}

fn claude_folder_cwd(folder: &Path) -> Option<String> {
    fs::read_dir(folder).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "jsonl")
            .then(|| record_cwd(&path))
            .flatten()
    })
}

/// Scope a settled burst of provider record writes to affected projects.
/// `None` means at least one path could not be placed, so consumers must
/// conservatively refresh every visible project rather than miss a chat.
pub(crate) fn changed_record_folders(
    paths: &HashSet<PathBuf>,
    claude_projects: &Path,
    codex_sessions: &Path,
    known: &mut HashMap<PathBuf, String>,
) -> Option<Vec<String>> {
    if paths.is_empty() {
        return None;
    }
    let mut moved = Vec::new();
    for path in paths {
        let key = if let Ok(relative) = path.strip_prefix(claude_projects) {
            let project = relative.components().next()?.as_os_str();
            claude_projects.join(project)
        } else if path.starts_with(codex_sessions) {
            path.clone()
        } else {
            continue;
        };
        let cwd = known.get(&key).cloned().or_else(|| {
            let found = if key.starts_with(claude_projects) {
                claude_folder_cwd(&key)
            } else {
                record_cwd(&key)
            }?;
            known.insert(key.clone(), found.clone());
            Some(found)
        })?;
        moved.push(cwd);
    }
    moved.sort();
    moved.dedup();
    (!moved.is_empty()).then_some(moved)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHold {
    pub id: String,
    pub holder: Holder,
    pub doing: HeldDoing,
    pub detail: Option<String>,
    pub told: bool,
    pub since: Option<i64>,
    pub turn_since: Option<i64>,
    pub typical_ms: Option<i64>,
    pub pids: BTreeSet<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Holder {
    Terminal,
    Program,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HeldDoing {
    Unknown,
    Idle,
    Working,
    Thinking,
    Answering,
    Running,
    Summarising,
    Waiting,
    Retrying,
    Helping,
}

/** One provider-neutral reading of activity observed in a native record. */
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderActivity {
    pub doing: HeldDoing,
    pub detail: Option<String>,
    pub since: Option<i64>,
    pub turn_since: Option<i64>,
}

impl ProviderActivity {
    fn idle() -> Self {
        Self {
            doing: HeldDoing::Idle,
            detail: None,
            since: None,
            turn_since: None,
        }
    }
}

fn last_record_row(path: &Path) -> Option<Value> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let length = size.min(1_048_576);
    file.seek(SeekFrom::Start(size.saturating_sub(length)))
        .ok()?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    text.lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
}

fn words(message: &Value) -> String {
    if let Some(text) = message["content"].as_str() {
        return text.into();
    }
    message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

const RECORD_QUIET_MS: i64 = 10_000;
const HELPER_QUIET_MS: i64 = 120_000;

fn answer_owed(row: &Value) -> bool {
    if row["type"] == "assistant" {
        let Some(content) = row["message"]["content"].as_array() else {
            return false;
        };
        let mut thought = false;
        let mut spoke = false;
        for block in content {
            match block["type"].as_str() {
                Some("tool_use") => return true,
                Some("thinking") => thought = true,
                Some("text") => spoke = true,
                _ => {}
            }
        }
        return thought && !spoke;
    }
    if row["type"] != "user" || row["isCompactSummary"] == true {
        return false;
    }
    let content = &row["message"]["content"];
    if content
        .as_array()
        .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
    {
        return true;
    }
    let spoken = if let Some(text) = content.as_str() {
        vec![text]
    } else {
        content
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect()
    };
    if spoken.is_empty() {
        return true;
    }
    spoken.into_iter().any(|text| {
        let text = text.replace('\n', " ");
        let text = text.trim();
        !text.is_empty()
            && !text.starts_with("[Request interrupted by user")
            && ![
                "<command-name",
                "<command-message",
                "<command-args",
                "<local-command-stdout",
                "<local-command-stderr",
            ]
            .iter()
            .any(|tag| text.starts_with(tag))
    })
}

fn helper_brief(block: &Value) -> String {
    let text = block["input"]["description"]
        .as_str()
        .or_else(|| block["input"]["subagent_type"].as_str())
        .unwrap_or("1 helper")
        .trim();
    if text.chars().count() <= 48 {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .take_while(|(at, _)| *at < 47)
        .filter(|(_, ch)| ch.is_whitespace())
        .map(|(at, _)| at)
        .last()
        .unwrap_or_else(|| text.char_indices().nth(47).map_or(text.len(), |(at, _)| at));
    format!("{}…", text[..cut].trim_end())
}

fn helper_tail(row: &Value) -> Option<String> {
    let helpers = row["message"]["content"]
        .as_array()?
        .iter()
        .filter(|block| {
            block["type"] == "tool_use" && matches!(block["name"].as_str(), Some("Agent" | "Task"))
        })
        .collect::<Vec<_>>();
    match helpers.as_slice() {
        [] => None,
        [helper] => Some(helper_brief(helper)),
        many => Some(format!("{} helpers", many.len())),
    }
}

fn helpers_working(path: &Path, now_ms: i64) -> (usize, Option<i64>) {
    let Some(stem) = path.file_stem() else {
        return (0, None);
    };
    let Ok(entries) = fs::read_dir(path.with_file_name(stem).join("subagents")) else {
        return (0, None);
    };
    let mut count = 0;
    let mut since = None;
    for entry in entries.flatten() {
        let helper = entry.path();
        let Some(name) = helper.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("agent-") || !name.ends_with(".jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Some(moved) = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as i64)
        else {
            continue;
        };
        if now_ms - moved > HELPER_QUIET_MS
            || !last_record_row(&helper).is_some_and(|row| answer_owed(&row))
        {
            continue;
        }
        count += 1;
        let began = metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as i64)
            .unwrap_or(moved);
        since = Some(since.map_or(began, |old: i64| old.min(began)));
    }
    (count, since)
}

fn record_doing(path: &Path, now_ms: i64) -> Option<(HeldDoing, Option<i64>, Option<String>)> {
    let row = last_record_row(path)?;
    let moved = fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    if row["type"] == "assistant" {
        let content = row["message"]["content"].as_array();
        if row["isApiErrorMessage"] == true {
            let text = words(&row["message"]);
            let lower = text.to_lowercase();
            if lower.contains("limit") && lower.contains("resets") {
                let detail = lower.find("resets").map(|at| {
                    text[at..]
                        .split('·')
                        .next()
                        .unwrap_or_default()
                        .split('(')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_string()
                });
                return Some((HeldDoing::Retrying, Some(moved), detail));
            }
        }
        if let Some(detail) = helper_tail(&row) {
            return Some((HeldDoing::Helping, Some(moved), Some(detail)));
        }
        let owes = content.is_some_and(|blocks| {
            let tool = blocks.iter().any(|block| block["type"] == "tool_use");
            let thought = blocks.iter().any(|block| block["type"] == "thinking");
            let spoke = blocks.iter().any(|block| block["type"] == "text");
            tool || thought && !spoke
        });
        if owes {
            return Some((HeldDoing::Working, Some(moved), None));
        }
    } else if row["type"] == "user" && row["isCompactSummary"] != true {
        let text = words(&row["message"]).replace('\n', " ").trim().to_string();
        let kit = text.starts_with("[Request interrupted by user")
            || [
                "<command-name",
                "<command-message",
                "<command-args",
                "<local-command-stdout",
                "<local-command-stderr",
            ]
            .iter()
            .any(|tag| text.starts_with(tag));
        let tool_result = row["message"]["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"));
        if tool_result || (!text.is_empty() && !kit) {
            return Some((HeldDoing::Working, Some(moved), None));
        }
    }
    if answer_owed(&row) {
        return Some((HeldDoing::Working, Some(moved), None));
    }
    if now_ms - moved < RECORD_QUIET_MS {
        return Some((HeldDoing::Working, Some(moved), None));
    }
    let (helpers, since) = helpers_working(path, now_ms);
    if helpers > 0 {
        return Some((
            HeldDoing::Helping,
            since,
            Some(if helpers == 1 {
                "1 helper".into()
            } else {
                format!("{helpers} helpers")
            }),
        ));
    }
    Some((HeldDoing::Idle, None, None))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeMarker {
    session_id: String,
    pid: u32,
    cwd: String,
    started_at: i64,
    proc_start: String,
    entrypoint: String,
    kind: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "statusUpdatedAt")]
    status_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
struct ToldDoing {
    doing: String,
    since: i64,
    #[serde(default)]
    detail: Option<String>,
}

fn proc_start(stat: &str) -> Option<&str> {
    let close = stat.rfind(')')?;
    stat[close + 1..].split_whitespace().nth(19)
}

fn valid_marker(marker: &ClaudeMarker) -> bool {
    !marker.session_id.is_empty()
        && marker.pid > 0
        && !marker.cwd.is_empty()
        && marker.started_at.is_positive()
        && !marker.proc_start.is_empty()
        && !marker.entrypoint.is_empty()
        && !marker.kind.is_empty()
}

fn marker_alive(marker: &ClaudeMarker, proc_root: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        let stat = proc_root.join(marker.pid.to_string()).join("stat");
        fs::read_to_string(stat)
            .ok()
            .and_then(|line| proc_start(&line).map(str::to_string))
            .is_some_and(|started| started == marker.proc_start)
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        // Signal zero asks only whether the PID exists. Claude's procStart is a
        // Linux clock-tick value, so this matches the provider's own fallback
        // on macOS without pretending it can detect PID reuse there.
        i32::try_from(marker.pid)
            .ok()
            .is_some_and(|pid| unsafe { libc::kill(pid, 0) == 0 })
    }
    #[cfg(windows)]
    {
        let _ = proc_root;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", marker.pid), "/NH"])
            .output()
            .ok()
            .is_some_and(|out| {
                String::from_utf8_lossy(&out.stdout).contains(&marker.pid.to_string())
            })
    }
}

/// Whether an exact provider-holder PID still exists. This is intentionally
/// separate from discovery: callers may only use PIDs already attributed to
/// the requested conversation by `provider_holds`.
pub fn pid_alive(pid: u32, proc_root: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        // An exited child remains in `/proc` as `Z` until its parent reaps it,
        // but it no longer owns files, sockets, or a provider conversation.
        // Treating that bookkeeping row as live makes takeover wait three
        // seconds and then fail even though SIGTERM worked.
        fs::read_to_string(proc_root.join(pid.to_string()).join("stat"))
            .ok()
            .is_some_and(|stat| {
                let Some(close) = stat.rfind(')') else {
                    return false;
                };
                stat[close + 1..]
                    .split_whitespace()
                    .next()
                    .is_some_and(|state| state != "Z")
            })
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = proc_root;
        let Some(pid) = i32::try_from(pid).ok() else {
            return false;
        };
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        // As on Linux, an unreaped child no longer owns the conversation.
        // `kill(pid, 0)` alone cannot distinguish that bookkeeping process.
        !std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .is_some_and(|state| state.trim_start().starts_with('Z'))
    }
    #[cfg(windows)]
    {
        let _ = proc_root;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok()
            .is_some_and(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
    }
}

/// Ask one exact provider-holder process to release its conversation.
pub fn terminate_pid(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let pid = i32::try_from(pid).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "PID is outside Unix range",
            )
        })?;
        let result = unsafe { libc::kill(pid, libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "taskkill refused provider holder {pid}"
            )))
        }
    }
}

fn told(sessions: &Path, id: &str, now_ms: i64) -> Option<(HeldDoing, i64, Option<String>)> {
    let path = sessions.join(format!("{id}.doing.json"));
    let row: ToldDoing = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    // Keep the vocabulary and lifetime identical to the former shared reader:
    // every concrete status is valid, waiting has no expiry, and every other
    // claim expires after fifteen minutes. Restricting this to summarising and
    // waiting flattened thinking/running/retrying/helping back to "Working".
    let doing = marker_doing(&row.doing)?;
    if row.since > now_ms + 60_000 {
        return None;
    }
    if doing != HeldDoing::Waiting && now_ms - row.since > 900_000 {
        return None;
    }
    Some((
        doing,
        row.since,
        row.detail.filter(|detail| !detail.is_empty()),
    ))
}

fn marker_doing(status: &str) -> Option<HeldDoing> {
    Some(match status {
        "idle" => HeldDoing::Idle,
        "busy" | "working" => HeldDoing::Working,
        "thinking" => HeldDoing::Thinking,
        "answering" => HeldDoing::Answering,
        "running" | "running_tool" => HeldDoing::Running,
        "summarising" | "summarizing" => HeldDoing::Summarising,
        "waiting" | "waiting_permission" => HeldDoing::Waiting,
        "retrying" => HeldDoing::Retrying,
        "helping" => HeldDoing::Helping,
        _ => return None,
    })
}

/// Live Claude markers, newest live marker winning when two name one chat.
pub fn claude_holds(config: &Path, proc_root: &Path, now_ms: i64) -> Vec<ProviderHold> {
    let sessions = config.join("sessions");
    let Ok(entries) = fs::read_dir(&sessions) else {
        return Vec::new();
    };
    let mut newest: HashMap<String, ClaudeMarker> = HashMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".json") || name.ends_with(".doing.json") {
            continue;
        }
        let Some(marker) = fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ClaudeMarker>(&bytes).ok())
            .filter(valid_marker)
            .filter(|marker| marker_alive(marker, proc_root))
        else {
            continue;
        };
        let key = marker.session_id.to_lowercase();
        if newest
            .get(&key)
            .is_none_or(|old| old.started_at < marker.started_at)
        {
            newest.insert(key, marker);
        }
    }
    let mut holds: Vec<_> = newest
        .into_values()
        .map(|marker| {
            let said = told(&sessions, &marker.session_id, now_ms);
            let (doing, since, detail, was_told) = if let Some((doing, since, detail)) = said {
                (doing, Some(since), detail, true)
            } else {
                let read =
                    crate::workbench::claude::history::find_record(config, &marker.session_id)
                        .and_then(|record| record_doing(&record, now_ms));
                let marked = marker.status.as_deref().and_then(marker_doing);
                let (doing, since, detail) = match marked {
                    Some(HeldDoing::Working) => {
                        read.unwrap_or((HeldDoing::Working, marker.status_at, None))
                    }
                    Some(HeldDoing::Idle) => (HeldDoing::Idle, None, None),
                    Some(doing) => (doing, marker.status_at, None),
                    None => read.unwrap_or((HeldDoing::Unknown, None, None)),
                };
                (doing, since, detail, false)
            };
            ProviderHold {
                id: marker.session_id,
                holder: if marker.entrypoint == "cli" {
                    Holder::Terminal
                } else {
                    Holder::Program
                },
                doing,
                detail,
                told: was_told,
                since,
                turn_since: None,
                typical_ms: None,
                pids: BTreeSet::from([marker.pid]),
            }
        })
        .collect();
    holds.sort_by(|a, b| a.id.cmp(&b.id));
    holds
}

fn uuid_in(text: &str) -> Vec<String> {
    // Deliberately validate each UUID-sized ASCII window instead of carrying a
    // regex engine for one fixed shape. This also finds `rollout-<uuid>` where
    // the prefix's hyphen is directly beside the id.
    let mut found = BTreeSet::new();
    for window in text.as_bytes().windows(36) {
        let Ok(word) = std::str::from_utf8(window) else {
            continue;
        };
        if uuid::Uuid::parse_str(word).is_ok() {
            found.insert(word.to_lowercase());
        }
    }
    found.into_iter().collect()
}

fn logged_codex_threads(home: &Path, pids: &[u32]) -> HashMap<u32, String> {
    let path = home.join("logs_2.sqlite");
    let Ok(db) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return HashMap::new();
    };
    let Ok(mut query) = db.prepare(
        "SELECT process_uuid, thread_id FROM logs
         WHERE process_uuid GLOB ?1 AND thread_id IS NOT NULL AND thread_id != ''
         ORDER BY ts DESC, ts_nanos DESC, id DESC",
    ) else {
        return HashMap::new();
    };
    let mut found = HashMap::new();
    for pid in pids {
        let pattern = format!("pid:{pid}:*");
        let Ok(rows) = query.query_map([pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            continue;
        };
        for row in rows.flatten() {
            found.entry(*pid).or_insert_with(|| row.1.to_lowercase());
        }
    }
    found
}

/// Codex terminal processes from the native process table used on machines
/// without `/proc`. The first argument must itself be the Codex executable;
/// matching a later word would mistake shells, editors, and this app for the
/// conversation owner. App-server is a reader, not an interactive owner.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn codex_commands<'a>(rows: impl IntoIterator<Item = &'a str>) -> Vec<(u32, String)> {
    let mut found = Vec::new();
    for row in rows {
        let row = row.trim();
        let Some(split) = row.find(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = row[..split].parse::<u32>() else {
            continue;
        };
        let command = row[split..].trim();
        let mut argv = command.split_whitespace();
        let executable = argv
            .next()
            .map(|arg| arg.trim_matches('"'))
            .and_then(|arg| arg.rsplit(['/', '\\']).next());
        if !matches!(executable, Some("codex" | "codex.exe"))
            || argv.next().is_some_and(|arg| arg == "app-server")
        {
            continue;
        }
        found.push((pid, command.to_string()));
    }
    found
}

#[cfg(all(unix, not(target_os = "linux")))]
fn native_codex_commands() -> Vec<(u32, String)> {
    std::process::Command::new("ps")
        .args(["-axo", "pid=,args="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .map(|output| codex_commands(output.lines()))
        .unwrap_or_default()
}

#[cfg(windows)]
fn native_codex_commands() -> Vec<(u32, String)> {
    // PowerShell and CIM are part of every Windows version Atelier supports.
    // Tabs make the PID boundary unambiguous even when CommandLine has spaces.
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .map(|output| codex_commands(output.lines()))
        .unwrap_or_default()
}

/// Live Codex CLI processes grouped by their current thread. App-server is
/// excluded: it can list a thread without owning an interactive turn.
pub fn codex_thread_processes(
    proc_root: &Path,
    codex_home: &Path,
) -> (BTreeMap<String, BTreeSet<u32>>, HashMap<String, PathBuf>) {
    let mut found: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    let mut rollout_paths = HashMap::new();
    // A thread named on argv is the provider's explicit current selection.
    // Processes started as bare `codex resume` need the latest process-log
    // thread instead; their open descriptors can include old rollouts retained
    // for history and are evidence of access, not current ownership.
    let mut explicit = HashSet::new();
    #[cfg(not(target_os = "linux"))]
    if proc_root == Path::new("/proc") {
        let commands = native_codex_commands();
        let pids: Vec<_> = commands.iter().map(|(pid, _)| *pid).collect();
        for (pid, command) in commands {
            let ids = uuid_in(&command);
            if ids.len() == 1 {
                explicit.insert(pid);
            }
            for id in ids {
                found.entry(id).or_default().insert(pid);
            }
        }
        for (pid, id) in logged_codex_threads(codex_home, &pids) {
            if explicit.contains(&pid) {
                continue;
            }
            found.entry(id).or_default().insert(pid);
        }
        return (found, rollout_paths);
    }
    let Ok(entries) = fs::read_dir(proc_root) else {
        return (found, rollout_paths);
    };
    let mut terminal_pids = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(command) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let argv: Vec<_> = command
            .split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .collect();
        let executable = argv
            .first()
            .and_then(|arg| Path::new(std::str::from_utf8(arg).ok()?).file_name())
            .and_then(|name| name.to_str());
        if executable != Some("codex") || argv.get(1).is_some_and(|arg| *arg == b"app-server") {
            continue;
        }
        terminal_pids.push(pid);
        let mut ids = BTreeSet::new();
        for arg in &argv {
            ids.extend(uuid_in(&String::from_utf8_lossy(arg)));
        }
        if ids.len() == 1 {
            explicit.insert(pid);
        }
        if let Ok(fds) = fs::read_dir(entry.path().join("fd")) {
            for fd in fds.flatten() {
                let Ok(target) = fs::read_link(fd.path()) else {
                    continue;
                };
                let target_text = target.to_string_lossy();
                if !target_text.to_lowercase().contains("rollout-")
                    && !target_text.to_lowercase().contains(".codex/sessions")
                {
                    continue;
                }
                for id in uuid_in(&target_text) {
                    ids.insert(id.clone());
                    rollout_paths.insert(id, target.clone());
                }
            }
        }
        for id in ids {
            found.entry(id).or_default().insert(pid);
        }
    }
    for (pid, id) in logged_codex_threads(codex_home, &terminal_pids) {
        if explicit.contains(&pid) {
            continue;
        }
        for pids in found.values_mut() {
            pids.remove(&pid);
        }
        found.retain(|_, pids| !pids.is_empty());
        found.entry(id).or_default().insert(pid);
    }
    (found, rollout_paths)
}

fn event_millis(row: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(row["timestamp"].as_str()?)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn short_detail(text: &str) -> Option<String> {
    const ROOM: usize = 96;
    let line = text.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= ROOM {
        return Some(line.to_string());
    }
    let mut short = line.chars().take(ROOM).collect::<String>();
    if let Some(end) = short.rfind(char::is_whitespace) {
        short.truncate(end);
    }
    Some(format!("{}…", short.trim_end()))
}

fn codex_item_detail(item: &Value) -> Option<String> {
    let action = item["commandActions"]
        .as_array()
        .and_then(|rows| rows.first());
    if let Some(action) = action {
        let subject = action["query"]
            .as_str()
            .or_else(|| action["path"].as_str())
            .unwrap_or_default();
        let prefix = match action["type"].as_str() {
            Some("search") => "Searching",
            Some("read") => "Reading",
            Some("listFiles") => "Listing",
            _ => "Running",
        };
        if let Some(subject) = short_detail(subject) {
            return Some(format!("{prefix} {subject}"));
        }
    }
    let command = match &item["command"] {
        Value::Array(parts) => {
            let parts: Vec<_> = parts.iter().filter_map(Value::as_str).collect();
            if parts.len() >= 3
                && Path::new(parts[0])
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| matches!(name, "bash" | "sh" | "zsh"))
                && matches!(parts[1], "-c" | "-lc")
            {
                parts[2].to_string()
            } else {
                parts.join(" ")
            }
        }
        Value::String(command) => command.clone(),
        _ => String::new(),
    };
    short_detail(&command)
}

fn codex_tool_detail(payload: &Value) -> Option<String> {
    let name = payload["name"]
        .as_str()
        .or_else(|| payload["item"]["tool"].as_str())?;
    match name.to_ascii_lowercase().as_str() {
        // These are transport method names, not useful activity words. The
        // following CommandExecution row carries the exact command; until it
        // arrives, "Running" is the complete truthful status.
        "exec" | "exec_command" | "write_stdin" | "wait" => None,
        "apply_patch" => Some("Editing files".into()),
        "view_image" => Some("Viewing an image".into()),
        name if name.starts_with("web") => Some("Browsing the web".into()),
        _ => short_detail(name),
    }
}

pub fn codex_activity_from_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> ProviderActivity {
    let rows: Vec<Value> = lines
        .into_iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let mut started = None;
    let mut turn_since = None;
    let mut ended = None;
    for (at, row) in rows.iter().enumerate() {
        let kind = row
            .pointer("/payload/type")
            .or_else(|| row.get("type"))
            .and_then(Value::as_str);
        if kind == Some("task_started") {
            started = Some(at);
            turn_since = event_millis(row);
        }
        if matches!(kind, Some("task_complete" | "turn_aborted")) {
            ended = Some(at);
        }
    }
    if ended.is_some_and(|ended| started.is_none_or(|started| ended > started)) {
        return ProviderActivity::idle();
    }
    // Long tool-heavy turns routinely exceed the bounded tail above. Their
    // task_started anchor is then outside the window while current reasoning
    // and command rows remain inside it. A completion is always written at the
    // end and is the decisive idle anchor; without one, classify the activity
    // visible in the tail instead of flattening a live turn to Idle.
    let after = started.map_or(0, |at| at + 1);
    for row in rows[after..].iter().rev() {
        let payload = row.get("payload").unwrap_or(row);
        let kind = payload
            .get("type")
            .or_else(|| row.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let item_kind = payload
            .pointer("/item/type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if kind.contains("approval")
            || kind.contains("permission")
            || kind.contains("request_user_input")
            || item_kind.contains("approval")
            || item_kind.contains("permission")
        {
            return ProviderActivity {
                doing: HeldDoing::Waiting,
                detail: payload["item"]
                    .get("tool")
                    .or_else(|| payload.get("name"))
                    .and_then(Value::as_str)
                    .and_then(short_detail),
                since: event_millis(row),
                turn_since,
            };
        }
        if kind.contains("compact")
            || kind.contains("summary")
            || item_kind.contains("compact")
            || item_kind.contains("summary")
        {
            return ProviderActivity {
                doing: HeldDoing::Summarising,
                detail: None,
                since: event_millis(row),
                turn_since,
            };
        }
        if (kind.contains("custom_tool_call") || kind.contains("function_call"))
            && !kind.ends_with("_output")
            || item_kind.contains("commandexecution")
            || item_kind.contains("filechange")
        {
            let detail = if item_kind.contains("commandexecution") {
                codex_item_detail(&payload["item"])
            } else {
                codex_tool_detail(payload)
            };
            return ProviderActivity {
                doing: HeldDoing::Running,
                detail,
                since: event_millis(row),
                turn_since,
            };
        }
        if item_kind.contains("agentmessage") || kind == "message" {
            return ProviderActivity {
                doing: HeldDoing::Answering,
                detail: None,
                since: event_millis(row),
                turn_since,
            };
        }
        if kind.contains("reason") || item_kind.contains("reason") {
            return ProviderActivity {
                doing: HeldDoing::Thinking,
                detail: None,
                since: event_millis(row),
                turn_since,
            };
        }
    }
    let doing = if rows.is_empty() {
        HeldDoing::Idle
    } else {
        HeldDoing::Working
    };
    ProviderActivity {
        doing,
        detail: None,
        since: rows.last().and_then(event_millis),
        turn_since,
    }
}

pub fn codex_doing_from_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> HeldDoing {
    codex_activity_from_lines(lines).doing
}

fn tail_lines(path: &Path, limit: u64) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return Vec::new();
    };
    let length = size.min(limit);
    if file.seek(SeekFrom::Start(size - length)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity(length as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<_> = text.lines().map(str::to_string).collect();
    if size > length && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// Honest activity from the bounded tail of one Codex rollout.
///
/// A resumed CLI normally closes its rollout descriptor between writes, so
/// process-FD discovery alone cannot supply this path. The caller also keeps
/// paths learned from the provider index and uses this same bounded reader,
/// matching the former runtime without loading the transcript.
pub fn codex_activity_from_path(path: &Path) -> ProviderActivity {
    let lines = tail_lines(path, 256 * 1024);
    codex_activity_from_lines(lines.iter().map(String::as_str))
}

pub fn codex_doing_from_path(path: &Path) -> HeldDoing {
    codex_activity_from_path(path).doing
}

/// One provider-neutral ownership snapshot. A UUID is case-insensitive and
/// duplicate provider observations are merged instead of drawing two owners.
pub fn provider_holds(
    claude_config: &Path,
    proc_root: &Path,
    codex_home: &Path,
    now_ms: i64,
) -> Vec<ProviderHold> {
    let mut holds: BTreeMap<String, ProviderHold> = claude_holds(claude_config, proc_root, now_ms)
        .into_iter()
        .map(|hold| (hold.id.to_lowercase(), hold))
        .collect();
    let (codex, rollouts) = codex_thread_processes(proc_root, codex_home);
    for (id, pids) in codex {
        let activity = rollouts
            .get(&id)
            .map(|path| codex_activity_from_path(path))
            .unwrap_or(ProviderActivity {
                doing: HeldDoing::Unknown,
                detail: None,
                since: None,
                turn_since: None,
            });
        holds
            .entry(id.clone())
            .and_modify(|hold| hold.pids.extend(&pids))
            .or_insert(ProviderHold {
                id,
                holder: Holder::Terminal,
                doing: activity.doing,
                detail: activity.detail,
                told: false,
                since: activity.since,
                turn_since: activity.turn_since,
                typical_ms: None,
                pids,
            });
    }
    holds.into_values().collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LineGrowth {
    pub lines: Vec<String>,
    pub rewritten: bool,
    pub bytes_read: u64,
}

/// Incremental JSONL/NDJSON follower shared by external Claude and Codex
/// records. It emits only newline-terminated records and never duplicates one.
pub struct LineTail {
    path: PathBuf,
    position: u64,
    partial: Vec<u8>,
}

impl LineTail {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            position: 0,
            partial: Vec::new(),
        }
    }
    pub fn position(&self) -> u64 {
        self.position
    }
    pub fn through_line(&self) -> u64 {
        self.position.saturating_sub(self.partial.len() as u64)
    }
    pub fn seek(&mut self, position: u64) {
        self.position = position;
        self.partial.clear();
    }
    pub fn to_end(&mut self) {
        self.position = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        self.partial.clear();
    }

    pub fn grown(&mut self) -> std::io::Result<LineGrowth> {
        let size = match fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LineGrowth::default())
            }
            Err(error) => return Err(error),
        };
        if size < self.position {
            self.position = size;
            self.partial.clear();
            return Ok(LineGrowth {
                rewritten: true,
                ..LineGrowth::default()
            });
        }
        if size == self.position {
            return Ok(LineGrowth::default());
        }
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.position))?;
        let mut fresh = Vec::with_capacity((size - self.position) as usize);
        file.take(size - self.position).read_to_end(&mut fresh)?;
        let bytes_read = fresh.len() as u64;
        self.position += bytes_read;
        self.partial.extend(fresh);
        let mut lines = Vec::new();
        while let Some(newline) = self.partial.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<_> = self.partial.drain(..=newline).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Ok(line) = String::from_utf8(line) {
                lines.push(line);
            }
        }
        Ok(LineGrowth {
            lines,
            rewritten: false,
            bytes_read,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const CHAT: &str = "6f729ab8-6b7d-4ad6-a78e-5dc8cc05eddb";
    const OTHER: &str = "33f85fdf-a589-44df-88d2-46f3ef386dbc";

    fn stat(start: &str) -> String {
        let mut fields = vec!["S"; 19];
        fields.push(start);
        format!("42 (codex (worker)) {}", fields.join(" "))
    }

    #[cfg(unix)]
    #[test]
    fn provider_pid_signals_fail_closed_outside_the_unix_pid_range() {
        let error = terminate_pid(u32::MAX).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn native_workbench_services_external_claude_markers_require_the_same_process() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("claude");
        let sessions = config.join("sessions");
        let proc_root = root.path().join("proc");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(proc_root.join("42")).unwrap();
        fs::write(proc_root.join("42/stat"), stat("9001")).unwrap();
        let marker = serde_json::json!({
            "sessionId": CHAT, "pid": 42, "cwd": "/project", "startedAt": 100,
            "procStart": "9001", "entrypoint": "cli", "kind": "interactive",
            "status": "busy", "statusUpdatedAt": 123
        });
        fs::write(sessions.join("42.json"), marker.to_string()).unwrap();
        fs::write(
            sessions.join(format!("{CHAT}.doing.json")),
            serde_json::json!({"doing":"summarising","since":500,"detail":"auto"}).to_string(),
        )
        .unwrap();

        let holds = claude_holds(&config, &proc_root, 1_000);
        assert_eq!(holds.len(), 1);
        assert_eq!(holds[0].doing, HeldDoing::Summarising);
        assert_eq!(holds[0].holder, Holder::Terminal);
        assert!(holds[0].told);

        for (word, expected) in [
            ("thinking", HeldDoing::Thinking),
            ("answering", HeldDoing::Answering),
            ("running", HeldDoing::Running),
            ("retrying", HeldDoing::Retrying),
            ("helping", HeldDoing::Helping),
            ("waiting", HeldDoing::Waiting),
        ] {
            fs::write(
                sessions.join(format!("{CHAT}.doing.json")),
                serde_json::json!({"doing":word,"since":500,"detail":"specific"}).to_string(),
            )
            .unwrap();
            let hold = claude_holds(&config, &proc_root, 1_000).remove(0);
            assert_eq!(hold.doing, expected, "{word}");
            assert_eq!(hold.detail.as_deref(), Some("specific"), "{word}");
            assert!(hold.told, "{word}");
        }

        fs::write(proc_root.join("42/stat"), stat("reused")).unwrap();
        assert!(claude_holds(&config, &proc_root, 1_000).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn native_workbench_services_external_codex_uses_argv_fds_and_latest_process_log() {
        let root = tempfile::tempdir().unwrap();
        let proc_root = root.path().join("proc");
        let home = root.path().join("codex");
        fs::create_dir_all(&home).unwrap();
        for pid in [51, 52, 53] {
            fs::create_dir_all(proc_root.join(pid.to_string()).join("fd")).unwrap();
        }
        fs::write(
            proc_root.join("51/cmdline"),
            format!("/usr/bin/codex\0resume\0{CHAT}\0"),
        )
        .unwrap();
        fs::write(proc_root.join("52/cmdline"), b"codex\0resume\0").unwrap();
        fs::write(
            proc_root.join("53/cmdline"),
            format!("codex\0app-server\0{OTHER}\0"),
        )
        .unwrap();
        let rollout = home.join(format!("sessions/rollout-{OTHER}.jsonl"));
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "{}\n").unwrap();
        std::os::unix::fs::symlink(&rollout, proc_root.join("52/fd/7")).unwrap();
        let db = Connection::open(home.join("logs_2.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE logs (id INTEGER, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT);").unwrap();
        db.execute(
            "INSERT INTO logs VALUES (1, 9, 0, ?1, ?2)",
            ("pid:52:process", CHAT),
        )
        .unwrap();
        drop(db);

        let (threads, paths) = codex_thread_processes(&proc_root, &home);
        assert_eq!(threads[&CHAT.to_string()], BTreeSet::from([51, 52]));
        assert!(!threads.contains_key(OTHER));
        assert_eq!(paths[OTHER], rollout);
    }

    #[cfg(unix)]
    #[test]
    fn native_workbench_services_external_codex_wires_rich_activity_into_provider_hold() {
        let root = tempfile::tempdir().unwrap();
        let proc_root = root.path().join("proc");
        let claude_config = root.path().join("claude");
        let codex_home = root.path().join("codex");
        let fd_root = proc_root.join("61/fd");
        fs::create_dir_all(&fd_root).unwrap();
        fs::create_dir_all(&claude_config).unwrap();
        fs::write(
            proc_root.join("61/cmdline"),
            format!("/usr/bin/codex\0resume\0{CHAT}\0"),
        )
        .unwrap();
        let rollout = codex_home.join(format!("sessions/rollout-{CHAT}.jsonl"));
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(
            &rollout,
            concat!(
                r#"{"timestamp":"2026-09-02T10:00:00Z","payload":{"type":"task_started"}}"#,
                "\n",
                r#"{"timestamp":"2026-09-02T10:00:03Z","payload":{"type":"item_started","item":{"type":"CommandExecution","commandActions":[{"type":"read","path":"server/src/routes/workbench.rs"}]}}}"#,
                "\n"
            ),
        )
        .unwrap();
        std::os::unix::fs::symlink(&rollout, fd_root.join("7")).unwrap();

        let hold = provider_holds(&claude_config, &proc_root, &codex_home, 0)
            .into_iter()
            .find(|hold| hold.id == CHAT)
            .unwrap();
        assert_eq!(hold.doing, HeldDoing::Running);
        assert_eq!(
            hold.detail.as_deref(),
            Some("Reading server/src/routes/workbench.rs")
        );
        assert_eq!(
            hold.since
                .zip(hold.turn_since)
                .map(|(step, turn)| step - turn),
            Some(3_000)
        );
    }

    #[test]
    fn native_workbench_services_external_codex_reads_non_linux_process_rows() {
        let rows = format!(
            "  41 /opt/homebrew/bin/codex resume {CHAT}\n\
               42 /opt/homebrew/bin/codex resume\n\
               43 /opt/homebrew/bin/codex app-server {OTHER}\n\
               44 /bin/zsh -lc codex resume {OTHER}\n\
               45 C:\\tools\\codex.exe resume {OTHER}\n"
        );
        let commands = codex_commands(rows.lines());
        assert_eq!(
            commands.iter().map(|row| row.0).collect::<Vec<_>>(),
            vec![41, 42, 45]
        );
        assert_eq!(uuid_in(&commands[0].1), vec![CHAT.to_string()]);
        assert_eq!(uuid_in(&commands[2].1), vec![OTHER.to_string()]);
    }

    #[test]
    fn native_workbench_services_external_codex_activity_is_bounded_and_honest() {
        assert_eq!(
            codex_doing_from_lines([r#"{"payload":{"type":"task_started"}}"#]),
            HeldDoing::Working
        );
        assert_eq!(
            codex_doing_from_lines([
                r#"{"payload":{"type":"task_started"}}"#,
                r#"{"payload":{"type":"reasoning"}}"#,
            ]),
            HeldDoing::Thinking
        );

        let command = codex_activity_from_lines([
            r#"{"timestamp":"2026-09-02T10:00:00Z","payload":{"type":"task_started"}}"#,
            r#"{"timestamp":"2026-09-02T10:00:03Z","payload":{"type":"item_started","item":{"type":"CommandExecution","command":["/bin/bash","-c","rg -n status server/src"],"commandActions":[{"type":"search","query":"status","path":"server/src"}]}}}"#,
        ]);
        assert_eq!(command.doing, HeldDoing::Running);
        assert_eq!(command.detail.as_deref(), Some("Searching status"));
        assert_eq!(
            command
                .since
                .zip(command.turn_since)
                .map(|(step, turn)| step - turn),
            Some(3_000)
        );

        let shell = codex_activity_from_lines([
            r#"{"timestamp":"2026-09-02T10:00:00Z","payload":{"type":"task_started"}}"#,
            r#"{"timestamp":"2026-09-02T10:00:04Z","payload":{"type":"item_started","item":{"type":"CommandExecution","command":["/bin/bash","-c","cargo test --manifest-path server/Cargo.toml external"]}}}"#,
        ]);
        assert_eq!(
            shell.detail.as_deref(),
            Some("cargo test --manifest-path server/Cargo.toml external")
        );
        let transport = codex_activity_from_lines([
            r#"{"timestamp":"2026-09-02T10:00:00Z","payload":{"type":"task_started"}}"#,
            r#"{"timestamp":"2026-09-02T10:00:04Z","payload":{"type":"custom_tool_call","name":"exec"}}"#,
        ]);
        assert_eq!(transport.doing, HeldDoing::Running);
        assert_eq!(transport.detail, None);
        assert_eq!(
            codex_doing_from_lines([
                r#"{"payload":{"type":"task_started"}}"#,
                r#"{"payload":{"type":"request_user_input"}}"#,
            ]),
            HeldDoing::Waiting
        );
        assert_eq!(
            codex_doing_from_lines([
                r#"{"payload":{"type":"task_started"}}"#,
                r#"{"payload":{"type":"task_complete"}}"#,
            ]),
            HeldDoing::Idle
        );
        // The start of a long turn may be older than the bounded status tail.
        // Current activity without a later completion is still current.
        assert_eq!(
            codex_doing_from_lines([
                r#"{"payload":{"type":"item_completed","item":{"type":"CommandExecution"}}}"#,
                r#"{"payload":{"type":"reasoning"}}"#,
            ]),
            HeldDoing::Thinking
        );
        assert_eq!(
            codex_doing_from_lines([
                r#"{"payload":{"type":"reasoning"}}"#,
                r#"{"payload":{"type":"task_complete"}}"#,
            ]),
            HeldDoing::Idle
        );
    }

    #[test]
    fn native_workbench_services_external_claude_tail_keeps_rich_states() {
        let root = tempfile::tempdir().unwrap();
        let record = root.path().join("chat.jsonl");
        fs::write(&record, serde_json::json!({
            "type":"assistant","isApiErrorMessage":true,
            "message":{"content":[{"type":"text","text":"You've hit your session limit · resets 4:40pm (Asia/Karachi)"}]}
        }).to_string()+"\n").unwrap();
        let (doing, _, detail) = record_doing(&record, i64::MAX).unwrap();
        assert_eq!(doing, HeldDoing::Retrying);
        assert_eq!(detail.as_deref(), Some("resets 4:40pm"));

        fs::write(&record, serde_json::json!({
            "type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"description":"Check the migration"}}]}
        }).to_string()+"\n").unwrap();
        let (doing, _, detail) = record_doing(&record, i64::MAX).unwrap();
        assert_eq!(doing, HeldDoing::Helping);
        assert_eq!(detail.as_deref(), Some("Check the migration"));

        fs::write(
            &record,
            serde_json::json!({
                "type":"assistant","message":{"content":[
                    {"type":"tool_use","name":"Agent","input":{"description":"Review the driver"}},
                    {"type":"tool_use","name":"Task","input":{"description":"Review the rows"}}
                ]}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        let (_, _, detail) = record_doing(&record, i64::MAX).unwrap();
        assert_eq!(detail.as_deref(), Some("2 helpers"));

        fs::write(
            &record,
            serde_json::json!({
                "type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{
                    "description":"Work out why the summarising bar holds at the end"
                }}]}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        let (_, _, detail) = record_doing(&record, i64::MAX).unwrap();
        assert_eq!(
            detail.as_deref(),
            Some("Work out why the summarising bar holds at the…")
        );
    }

    #[test]
    fn native_workbench_services_external_claude_counts_only_live_detached_helpers() {
        let root = tempfile::tempdir().unwrap();
        let record = root.path().join("chat.jsonl");
        fs::write(&record, serde_json::json!({
            "type":"assistant","message":{"content":[{"type":"text","text":"I sent those off."}]}
        }).to_string()+"\n").unwrap();
        let helpers = root.path().join("chat/subagents");
        fs::create_dir_all(&helpers).unwrap();
        fs::write(helpers.join("agent-working.jsonl"), serde_json::json!({
            "type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}
        }).to_string()+"\n").unwrap();
        fs::write(
            helpers.join("agent-finished.jsonl"),
            serde_json::json!({
                "type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        fs::write(helpers.join("agent-working.meta.json"), "{}").unwrap();

        let moved = fs::metadata(&record)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let (doing, since, detail) = record_doing(&record, moved + RECORD_QUIET_MS + 1).unwrap();
        assert_eq!(doing, HeldDoing::Helping);
        assert!(since.is_some());
        assert_eq!(detail.as_deref(), Some("1 helper"));
    }

    #[test]
    fn native_workbench_services_external_claude_drops_killed_helper_ghosts() {
        let root = tempfile::tempdir().unwrap();
        let record = root.path().join("chat.jsonl");
        fs::write(&record, serde_json::json!({
            "type":"assistant","message":{"content":[{"type":"text","text":"Waiting elsewhere."}]}
        }).to_string()+"\n").unwrap();
        let helpers = root.path().join("chat/subagents");
        fs::create_dir_all(&helpers).unwrap();
        let helper = helpers.join("agent-killed.jsonl");
        fs::write(&helper, serde_json::json!({
            "type":"assistant","message":{"content":[{"type":"thinking","thinking":"unfinished"}]}
        }).to_string()+"\n").unwrap();
        let moved = fs::metadata(&helper)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let (doing, since, detail) = record_doing(&record, moved + HELPER_QUIET_MS + 1).unwrap();
        assert_eq!((doing, since, detail), (HeldDoing::Idle, None, None));
    }

    #[test]
    fn native_workbench_services_external_tail_never_duplicates_or_emits_partial_lines() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("record.jsonl");
        let mut file = File::create(&path).unwrap();
        file.write_all("one\ntw".as_bytes()).unwrap();
        file.flush().unwrap();
        let mut tail = LineTail::new(&path);
        let first = tail.grown().unwrap();
        assert_eq!(first.lines, ["one"]);
        assert_eq!(tail.through_line(), 4);
        file.write_all("o\nthree\n".as_bytes()).unwrap();
        file.flush().unwrap();
        assert_eq!(tail.grown().unwrap().lines, ["two", "three"]);
        assert!(tail.grown().unwrap().lines.is_empty());

        fs::write(&path, "x\n").unwrap();
        let rewritten = tail.grown().unwrap();
        assert!(rewritten.rewritten);
        assert!(rewritten.lines.is_empty());
    }

    #[test]
    fn native_workbench_services_external_proc_stat_uses_the_last_parenthesis() {
        assert_eq!(proc_start(&stat("12345")), Some("12345"));
    }
}
