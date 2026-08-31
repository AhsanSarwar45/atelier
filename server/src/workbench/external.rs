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
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

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
        if let Some(block) = content.into_iter().flatten().rev().find(|block| {
            block["type"] == "tool_use" && matches!(block["name"].as_str(), Some("Agent" | "Task"))
        }) {
            let detail = block["input"]["description"]
                .as_str()
                .or_else(|| block["input"]["subagent_type"].as_str())
                .map(|text| text.chars().take(120).collect());
            return Some((
                HeldDoing::Helping,
                Some(moved),
                detail.or_else(|| Some("1 helper".into())),
            ));
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
    Some((
        if now_ms - moved < 10_000 {
            HeldDoing::Working
        } else {
            HeldDoing::Idle
        },
        (now_ms - moved < 10_000).then_some(moved),
        None,
    ))
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
        unsafe { libc::kill(marker.pid as i32, 0) == 0 }
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

/// Live Codex CLI processes grouped by their current thread. App-server is
/// excluded: it can list a thread without owning an interactive turn.
pub fn codex_thread_processes(
    proc_root: &Path,
    codex_home: &Path,
) -> (BTreeMap<String, BTreeSet<u32>>, HashMap<String, PathBuf>) {
    let mut found: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    let mut rollout_paths = HashMap::new();
    if !cfg!(target_os = "linux") && proc_root == Path::new("/proc") {
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
        found.entry(id).or_default().insert(pid);
    }
    (found, rollout_paths)
}

pub fn codex_doing_from_lines<'a>(lines: impl IntoIterator<Item = &'a str>) -> HeldDoing {
    let rows: Vec<Value> = lines
        .into_iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let mut started = None;
    let mut ended = None;
    for (at, row) in rows.iter().enumerate() {
        let kind = row
            .pointer("/payload/type")
            .or_else(|| row.get("type"))
            .and_then(Value::as_str);
        if kind == Some("task_started") {
            started = Some(at);
        }
        if matches!(kind, Some("task_complete" | "turn_aborted")) {
            ended = Some(at);
        }
    }
    let Some(started) = started else {
        return HeldDoing::Idle;
    };
    if ended.is_some_and(|ended| ended > started) {
        return HeldDoing::Idle;
    }
    for row in rows[started + 1..].iter().rev() {
        let payload = row.get("payload").unwrap_or(row);
        let kind = payload
            .get("type")
            .or_else(|| row.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let item = payload
            .pointer("/item/type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if kind.contains("approval")
            || kind.contains("permission")
            || kind.contains("request_user_input")
            || item.contains("approval")
            || item.contains("permission")
        {
            return HeldDoing::Waiting;
        }
        if kind.contains("compact")
            || kind.contains("summary")
            || item.contains("compact")
            || item.contains("summary")
        {
            return HeldDoing::Summarising;
        }
        if (kind.contains("custom_tool_call") || kind.contains("function_call"))
            && !kind.ends_with("_output")
            || item.contains("commandexecution")
            || item.contains("filechange")
        {
            return HeldDoing::Running;
        }
        if item.contains("agentmessage") || kind == "message" {
            return HeldDoing::Answering;
        }
        if kind.contains("reason") || item.contains("reason") {
            return HeldDoing::Thinking;
        }
    }
    HeldDoing::Working
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
        let doing = rollouts
            .get(&id)
            .map(|path| tail_lines(path, 256 * 1024))
            .map(|lines| codex_doing_from_lines(lines.iter().map(String::as_str)))
            .unwrap_or(HeldDoing::Unknown);
        holds
            .entry(id.clone())
            .and_modify(|hold| hold.pids.extend(&pids))
            .or_insert(ProviderHold {
                id,
                holder: Holder::Terminal,
                doing,
                detail: None,
                told: false,
                since: None,
                turn_since: None,
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
        assert_eq!(threads[&OTHER.to_string()], BTreeSet::from([52]));
        assert_eq!(paths[OTHER], rollout);
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
