//! Read-only Codex discovery and persisted-setting helpers.

use super::transport::{CodexTransport, CodexTransportError};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

const MODES: &[&str] = &["untrusted", "on-request", "never"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub fn last_spoke_at(path: &Path) -> Option<String> {
    const BLOCK: u64 = 256 * 1024;
    let mut file = File::open(path).ok()?;
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
        for line in String::from_utf8_lossy(&bytes[complete_from..])
            .lines()
            .rev()
        {
            let Ok(row) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if row["type"] == "event_msg" && row["payload"]["type"] == "user_message" {
                return row["timestamp"].as_str().map(str::to_string);
            }
        }
        end = start;
    }
    None
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenRequest {
    pub method: &'static str,
    pub params: Value,
}

pub fn thread_open_request(
    resume: Option<&str>,
    cwd: &Path,
    model: Option<&str>,
    approval_policy: &str,
    effort: Option<&str>,
    instructions: &str,
) -> OpenRequest {
    let mut common = json!({
        "cwd": cwd,
        "model": model,
        "approvalPolicy": approval_policy,
        "config": {
            "sandbox_workspace_write": { "network_access": true },
            "developer_instructions": instructions
        },
        "effort": effort,
    });
    if let Some(thread_id) = resume {
        common["threadId"] = json!(thread_id);
        common["excludeTurns"] = json!(true);
        OpenRequest {
            method: "thread/resume",
            params: common,
        }
    } else {
        common["sandbox"] = json!("workspace-write");
        common["ephemeral"] = json!(false);
        OpenRequest {
            method: "thread/start",
            params: common,
        }
    }
}

pub async fn list_threads(
    transport: &CodexTransport,
    cwd: Option<&Path>,
    everything: bool,
) -> Result<Vec<Value>, CodexTransportError> {
    let source_kinds = everything.then(|| {
        json!([
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown"
        ])
    });
    let mut threads = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let mut params = json!({
            "limit": 100, "cursor": cursor, "sortKey": "updated_at", "sortDirection": "desc"
        });
        if let Some(source_kinds) = &source_kinds {
            params["sourceKinds"] = source_kinds.clone();
        }
        let result = transport
            .call("thread/list", params, REQUEST_TIMEOUT)
            .await?;
        threads.extend(result["data"].as_array().cloned().unwrap_or_default());
        cursor = result.get("nextCursor").cloned().unwrap_or(Value::Null);
        if cursor.is_null() {
            break;
        }
    }
    let Some(cwd) = cwd else { return Ok(threads) };
    let cwd = cwd.to_string_lossy();
    let root = format!("{}/", cwd.trim_end_matches('/'));
    Ok(threads
        .into_iter()
        .filter(|thread| {
            thread["cwd"]
                .as_str()
                .is_some_and(|found| found == cwd || found.starts_with(&root))
        })
        .collect())
}

pub async fn read_thread(
    transport: &CodexTransport,
    thread_id: &str,
) -> Result<Value, CodexTransportError> {
    let result = transport
        .call(
            "thread/read",
            json!({"threadId": thread_id, "includeTurns": true}),
            REQUEST_TIMEOUT,
        )
        .await?;
    Ok(result.get("thread").cloned().unwrap_or(Value::Null))
}

pub async fn thread_usage(
    transport: &CodexTransport,
    thread_id: &str,
) -> Result<Option<(i64, i64, i64)>, CodexTransportError> {
    let result = transport
        .call(
            "account/usage/read",
            json!({"threadId": thread_id}),
            REQUEST_TIMEOUT,
        )
        .await?;
    let Some(usage) = result.get("threadUsage").filter(|usage| !usage.is_null()) else {
        return Ok(None);
    };
    let (mut input, mut output, mut total) = (0, 0, 0);
    for group in usage["groups"].as_array().into_iter().flatten() {
        let group_input = group["inputTokens"].as_i64().unwrap_or_default();
        let group_output = group["outputTokens"].as_i64().unwrap_or_default();
        input += group_input;
        output += group_output;
        total += group["totalTokens"]
            .as_i64()
            .unwrap_or(group_input + group_output);
    }
    Ok(Some((input, output, total)))
}

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadSettings {
    pub model: String,
    pub permission_mode: String,
    pub collaboration_mode: Option<String>,
}

impl Default for ThreadSettings {
    fn default() -> Self {
        Self {
            model: "default".into(),
            permission_mode: "on-request".into(),
            collaboration_mode: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RolloutUsage {
    pub input: i64,
    pub output: i64,
    pub total: i64,
    pub context_used: i64,
    pub context_window: i64,
}

fn tail(path: &Path, limit: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let length = size.min(limit);
    file.seek(SeekFrom::Start(size - length)).ok()?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn thread_settings(path: Option<&Path>) -> ThreadSettings {
    let fallback = ThreadSettings::default();
    let Some(text) = path.and_then(|path| tail(path, 8 * 1024 * 1024)) else {
        return fallback;
    };
    for line in text.lines().rev() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = row.get("payload").unwrap_or(&row);
        let settings = if row["type"] == "turn_context" || payload["type"] == "turn_context" {
            Some(payload)
        } else if row["type"] == "event_msg" && payload["type"] == "thread_settings_applied" {
            payload.get("thread_settings")
        } else {
            None
        };
        let Some(settings) = settings else { continue };
        let permission = settings["approval_policy"]
            .as_str()
            .filter(|mode| MODES.contains(mode))
            .unwrap_or(&fallback.permission_mode);
        return ThreadSettings {
            model: settings["model"]
                .as_str()
                .filter(|model| !model.is_empty())
                .unwrap_or(&fallback.model)
                .to_string(),
            permission_mode: permission.to_string(),
            collaboration_mode: settings["collaboration_mode"]["mode"]
                .as_str()
                .map(str::to_string),
        };
    }
    fallback
}

pub fn rollout_usage(path: Option<&Path>) -> Option<RolloutUsage> {
    let text = path.and_then(|path| tail(path, 512 * 1024))?;
    for line in text.lines().rev() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = row.get("payload").unwrap_or(&row);
        let total = payload
            .get("info")
            .and_then(|info| info.get("total_token_usage"));
        if payload["type"] != "token_count" || total.is_none() {
            continue;
        }
        let total = total.unwrap();
        let last = &payload["info"]["last_token_usage"];
        return Some(RolloutUsage {
            input: total["input_tokens"].as_i64().unwrap_or_default(),
            output: total["output_tokens"].as_i64().unwrap_or_default(),
            total: total["total_tokens"].as_i64().unwrap_or_default(),
            context_used: last["total_tokens"].as_i64().unwrap_or_default(),
            context_window: payload["info"]["model_context_window"]
                .as_i64()
                .unwrap_or_default(),
        });
    }
    None
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffortMenu {
    pub efforts: Vec<Value>,
    pub default_effort: Option<String>,
}

fn effort_words(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}

pub fn effort_menu(models: &[Value], active_model: Option<&str>) -> EffortMenu {
    let selected = models
        .iter()
        .find(|model| model["model"].as_str() == active_model)
        .or_else(|| models.iter().find(|model| model["isDefault"] == true))
        .or_else(|| models.first());
    let offered = selected
        .and_then(|model| model["supportedReasoningEfforts"].as_array())
        .cloned()
        .unwrap_or_default();
    let efforts: Vec<Value> = offered
        .into_iter()
        .filter_map(|choice| {
            let value = choice["reasoningEffort"]
                .as_str()
                .or_else(|| choice["effort"].as_str())?;
            if value.is_empty() {
                return None;
            }
            let mut row = json!({"value": value, "displayName": effort_words(value)});
            if let Some(description) = choice.get("description") {
                row["description"] = description.clone();
            }
            Some(row)
        })
        .collect();
    let stated = selected.and_then(|model| {
        model["defaultReasoningEffort"]
            .as_str()
            .or_else(|| model["defaultEffort"].as_str())
    });
    let default_effort = stated
        .filter(|stated| efforts.iter().any(|effort| effort["value"] == *stated))
        .map(str::to_string)
        .or_else(|| {
            efforts
                .first()
                .and_then(|effort| effort["value"].as_str())
                .map(str::to_string)
        });
    EffortMenu {
        efforts,
        default_effort,
    }
}

pub async fn menu(transport: &CodexTransport, cwd: &Path, active_model: Option<&str>) -> Value {
    // Each list is optional across app-server generations. One old method
    // must not erase the capabilities the other two reported.
    let (model_result, skill_result, collaboration_result) = tokio::join!(
        transport.call(
            "model/list",
            json!({"includeHidden":false}),
            REQUEST_TIMEOUT,
        ),
        transport.call(
            "skills/list",
            json!({"cwds":[cwd],"forceReload":false}),
            REQUEST_TIMEOUT,
        ),
        transport.call("collaborationMode/list", json!({}), REQUEST_TIMEOUT),
    );
    let models = model_result
        .ok()
        .and_then(|result| result["data"].as_array().cloned())
        .unwrap_or_default();
    let skill_entries = skill_result
        .ok()
        .and_then(|result| result["data"].as_array().cloned())
        .unwrap_or_default();
    let presets = collaboration_result
        .ok()
        .and_then(|result| result["data"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|preset| preset["mode"].is_string())
        .collect::<Vec<_>>();
    let skills = skill_entries
        .iter()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .filter(|skill| skill["enabled"] != false)
        .cloned()
        .collect::<Vec<_>>();
    let efforts = effort_menu(&models, active_model);
    let native = [
        ("compact","Compact this conversation now",Value::Null),
        ("review","Review uncommitted changes, or follow the supplied instructions",json!("[instructions]")),
        ("status","Show this Codex thread and its background commands",Value::Null),
        ("usage","Show Codex account allowance and reset times",Value::Null),
        ("model","Show or change the model",json!("[model]")),
        ("permissions","Show or change the permission mode",json!("[mode]")),
    ].into_iter().map(|(name,description,hint)|json!({"name":name,"description":description,"argumentHint":hint,"kind":"command","execution":"native"}));
    let commands = native.chain(skills.iter().map(|skill| json!({
            "name":skill["name"],
            "description":skill.get("description").or_else(||skill.get("shortDescription")).cloned().unwrap_or_else(||json!("")),
            "kind":"skill", "execution":"skill"
        }))).collect::<Vec<_>>();
    json!({
        "commands": commands,
        "skills": skills.iter().map(|skill|skill["name"].clone()).collect::<Vec<_>>(),
        "skillPaths": Value::Object(skills.iter().filter_map(|skill|Some((skill["name"].as_str()?.to_string(),skill["path"].clone()))).collect()),
        "models": std::iter::once(json!({"value":"default","displayName":"Default","description":"Use the Codex default model"}))
            .chain(models.iter().map(|model|json!({"value":model["model"],"displayName":model["displayName"],"description":model["description"]}))).collect::<Vec<_>>(),
        "efforts": efforts.efforts,
        "defaultEffort": efforts.default_effort,
        "permissionModes": MODES,
        "collaborationModes": presets.iter().map(|preset|json!({"value":preset["mode"],"displayName":preset.get("name").cloned().unwrap_or_else(||preset["mode"].clone())})).collect::<Vec<_>>(),
        "collaborationPresets": presets,
        "agentControls": ["stop","say"],
        "agentDefinitions": agent_definitions(cwd)
    })
}

fn agent_definitions(cwd: &Path) -> Vec<Value> {
    let personal = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| directories::UserDirs::new().map(|dirs| dirs.home_dir().join(".codex")))
        .map(|home| home.join("agents"));
    let mut found = std::collections::BTreeMap::new();
    for (directory, source) in personal
        .into_iter()
        .map(|path| (path, "user"))
        .chain(std::iter::once((cwd.join(".codex/agents"), "project")))
    {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("toml") {
                continue;
            }
            let Some(name) = path
                .file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let text = fs::read_to_string(path).unwrap_or_default();
            let description = text
                .lines()
                .find_map(|line| {
                    let value = line
                        .trim()
                        .strip_prefix("description")?
                        .trim_start()
                        .strip_prefix('=')?
                        .trim();
                    value
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                        .map(str::to_string)
                })
                .unwrap_or_default();
            found.insert(
                name.clone(),
                json!({"name":name,"description":description,"source":source}),
            );
        }
    }
    found.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn native_codex_history_finds_the_human_clock_before_a_large_final_turn() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"event_msg","timestamp":"2026-08-30T22:05:00Z","payload":{"type":"user_message","message":"Resume"}})
        )
        .unwrap();
        for index in 0..700 {
            writeln!(
                file,
                "{}",
                json!({"type":"response_item","payload":{"type":"function_call_output","output":"x".repeat(2048),"index":index}})
            )
            .unwrap();
        }

        assert_eq!(
            last_spoke_at(file.path()).as_deref(),
            Some("2026-08-30T22:05:00Z")
        );
    }

    #[test]
    fn native_codex_history_reads_latest_settings_and_usage_from_the_rollout_tail() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"turn_context","payload":{"model":"old","approval_policy":"never"}})
        )
        .unwrap();
        writeln!(file, "not json").unwrap();
        writeln!(file, "{}", json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30},"last_token_usage":{"total_tokens":7},"model_context_window":200000}}})).unwrap();
        writeln!(file, "{}", json!({"type":"turn_context","payload":{"model":"gpt-5.4","approval_policy":"on-request","collaboration_mode":{"mode":"plan"}}})).unwrap();
        let settings = thread_settings(Some(file.path()));
        assert_eq!(settings.model, "gpt-5.4");
        assert_eq!(settings.permission_mode, "on-request");
        assert_eq!(settings.collaboration_mode.as_deref(), Some("plan"));
        assert_eq!(
            rollout_usage(Some(file.path())).unwrap(),
            RolloutUsage {
                input: 10,
                output: 20,
                total: 30,
                context_used: 7,
                context_window: 200000
            }
        );
    }

    #[test]
    fn native_codex_history_builds_start_resume_and_effort_contracts() {
        let start = thread_open_request(
            None,
            Path::new("/project"),
            Some("gpt-5"),
            "never",
            Some("high"),
            "rules",
        );
        assert_eq!(start.method, "thread/start");
        assert_eq!(start.params["sandbox"], "workspace-write");
        assert_eq!(start.params["ephemeral"], false);
        let resume = thread_open_request(
            Some("thread-1"),
            Path::new("/project"),
            None,
            "on-request",
            None,
            "",
        );
        assert_eq!(resume.method, "thread/resume");
        assert_eq!(resume.params["threadId"], "thread-1");
        assert_eq!(resume.params["excludeTurns"], true);
        let menu = effort_menu(
            &[
                json!({"model":"gpt-5","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high","description":"More"}],"defaultReasoningEffort":"high"}),
            ],
            Some("gpt-5"),
        );
        assert_eq!(menu.default_effort.as_deref(), Some("high"));
        assert_eq!(
            menu.efforts[1],
            json!({"value":"high","displayName":"High","description":"More"})
        );
    }
}
