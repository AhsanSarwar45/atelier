//! The AI search run, and the two tools its agent searches with (bw-21a2.5).
//!
//! `POST /search/ask` starts the agent chosen in Settings on a question and
//! streams what happens as one JSON object per line: `started`, a `step` for
//! every search or reading, a `chat` for every chat it named that exists, then
//! `done` or `failed`. Closing the request stops the agent.
//!
//! The agent searches through `POST /search/mcp`, a Model Context Protocol
//! server (the 2025-11-25 Streamable HTTP transport, answered as plain JSON)
//! that answers only the token of a run in progress. It is MCP, not a command
//! the agent runs, because Codex's read-only sandbox lets no command reach this
//! server or open the index; MCP calls are made by the agent's own process,
//! outside that sandbox. The chosen agent gets these tools and no others.

use super::{projects_named, ApiError, WorkbenchState};
use crate::routes::search_settings::{search_settings, SearchSettings, DEFAULT_TIME_LIMIT};
use crate::workbench::ai_search::named_chats;
use crate::workbench::search_index::Sort;
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// How to search, handed to the agent with the question.
const SKILL: &str = include_str!("../../../../machinery/skills/chat-search/SKILL.md");

/// The protocol revisions the endpoint speaks; a client asking for another is
/// answered with the newest.
const VERSIONS: &[&str] = &["2025-03-26", "2025-06-18", "2025-11-25"];

/// The runs in progress, by token, each with where its steps are told.
fn runs() -> &'static Mutex<HashMap<String, mpsc::UnboundedSender<String>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

/// A run's token, forgotten when the run ends however it ends.
struct Registered(String);

impl Registered {
    fn new(token: &str, steps: mpsc::UnboundedSender<String>) -> Self {
        runs().lock().unwrap().insert(token.to_string(), steps);
        Self(token.to_string())
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        runs().lock().unwrap().remove(&self.0);
    }
}

fn refused(message: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        message: message.into(),
    }
}

/// The skill without its front matter, then the question.
fn prompt(question: &str) -> String {
    let skill = SKILL
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("\n---"))
        .map(|(_, body)| body.trim_start())
        .unwrap_or(SKILL);
    format!(
        "{skill}\n## The request\n\nToday is {}. The person is looking for:\n\n{question}\n",
        chrono::Local::now().format("%Y-%m-%d")
    )
}

#[derive(Deserialize)]
pub(super) struct Asking {
    question: String,
}

pub(super) async fn ask(
    State(state): State<WorkbenchState>,
    Json(asking): Json<Asking>,
) -> Result<Response, ApiError> {
    let question = asking.question.trim().to_string();
    if question.is_empty() {
        return Err(refused("Say what the chat was about."));
    }
    let Some(index) = state.search.clone() else {
        return Err(ApiError::unavailable("the search index is not open".into()));
    };
    let settings = match &state.projects {
        Some(db) => search_settings(db).map_err(ApiError::from)?,
        None => SearchSettings {
            provider: None,
            profile: None,
            model: None,
            effort: None,
            time_limit_seconds: DEFAULT_TIME_LIMIT,
        },
    };
    let brand = match settings.provider.as_deref() {
        Some("local") => {
            return Err(refused(
                "AI search runs on Claude or Codex. Choose one in Settings.",
            ))
        }
        Some(brand) => brand.to_string(),
        None => ["claude", "codex"]
            .into_iter()
            .find(|brand| crate::routes::find_tool(brand, &[]).is_some())
            .ok_or_else(|| refused("Neither Claude nor Codex is installed."))?
            .to_string(),
    };
    let Some(program) = crate::routes::find_tool(&brand, &[]) else {
        return Err(refused(format!("{brand} is not installed.")));
    };
    let system = if brand == "claude" {
        state.registry.claude_config_directory().to_path_buf()
    } else {
        state.registry.codex_home_directory().to_path_buf()
    };
    let home = crate::workbench::profiles::chat_dir(&brand, settings.profile.as_deref(), &system);

    let token = uuid::Uuid::new_v4().to_string();
    let port = std::env::var("ATELIER_PORT")
        .or_else(|_| std::env::var("BEADS_WEB_PORT"))
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    let url = format!("http://127.0.0.1:{port}/api/workbench/search/mcp");
    let scratch = std::env::temp_dir().join(format!("atelier-ai-search-{token}"));
    std::fs::create_dir_all(&scratch).map_err(|error| error.to_string())?;
    let answer_file = scratch.join("answer.txt");
    let command = agent_command(
        &program,
        &brand,
        &settings,
        &home,
        &scratch,
        &answer_file,
        &url,
        &token,
        &prompt(&question),
    );

    let (out, lines) = mpsc::channel::<String>(64);
    let (steps_to, mut steps) = mpsc::unbounded_channel::<String>();
    let registered = Registered::new(&token, steps_to);
    let limit = Duration::from_secs(u64::from(settings.time_limit_seconds));
    let model = settings.model.clone();
    tokio::spawn(async move {
        let _registered = registered;
        say(
            &out,
            json!({"type":"started","provider":brand,"model":model}),
        )
        .await;
        let outcome = run(command, &brand, &answer_file, limit, &out, &mut steps).await;
        let _ = std::fs::remove_dir_all(&scratch);
        let said = match outcome {
            Ok(said) => said,
            Err(Stop::Stopped) => return,
            Err(Stop::Failed(error)) => {
                say(&out, json!({"type":"failed","error":error})).await;
                return;
            }
        };
        let Some(named) = named_chats(&said) else {
            say(
                &out,
                json!({"type":"failed","error":"The agent finished without naming any chats."}),
            )
            .await;
            return;
        };
        let checked = tokio::task::spawn_blocking(move || {
            named
                .into_iter()
                .map(|named| {
                    let chat = index.chat_words(&named.id, 0, 0).ok().flatten();
                    (named, chat)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut dropped = 0;
        for (named, chat) in checked {
            let Some(chat) = chat else {
                dropped += 1;
                continue;
            };
            say(
                &out,
                json!({"type":"chat","chat":{
                    "sessionId": chat.session_id,
                    "title": chat.title,
                    "projectId": chat.project_id,
                    "projectPath": chat.project_path,
                    "brand": chat.brand,
                    "lastActiveAt": chat.last_active_at,
                    "reason": named.reason,
                    "messageId": named.message,
                }}),
            )
            .await;
        }
        say(&out, json!({"type":"done","dropped":dropped})).await;
    });

    let body = Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(lines).map(Ok::<_, Infallible>),
    );
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap())
}

/// A TOML string, for a Codex `-c` override.
fn toml_string(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

#[allow(clippy::too_many_arguments)]
fn agent_command(
    program: &Path,
    brand: &str,
    settings: &SearchSettings,
    home: &Path,
    scratch: &Path,
    answer_file: &Path,
    url: &str,
    token: &str,
    prompt: &str,
) -> Command {
    let mut command = Command::new(program);
    command
        .current_dir(scratch)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(variable) = crate::workbench::profiles::variable(brand) {
        command.env(variable, home);
    }
    if brand == "claude" {
        let servers = json!({"mcpServers":{"chats":{
            "type":"http","url":url,"headers":{"Authorization":format!("Bearer {token}")}
        }}})
        .to_string();
        // No built-in tool at all, only the two searching ones, and a record of
        // the run is never written, so it is never listed as a chat.
        command.args([
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--tools",
            "",
            "--allowedTools",
            "mcp__chats",
            "--permission-mode",
            "dontAsk",
            "--strict-mcp-config",
            "--mcp-config",
            &servers,
            "--no-session-persistence",
        ]);
        if let Some(model) = &settings.model {
            command.args(["--model", model]);
        }
        if let Some(effort) = &settings.effort {
            command.args(["--effort", effort]);
        }
    } else {
        // `exec` never asks for approval, so the tools are approved up front;
        // its sandbox stays read-only for anything else.
        command
            .env("ATELIER_SEARCH_TOKEN", token)
            .args([
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
            ])
            .arg("-c")
            .arg(format!("mcp_servers.chats.url={}", toml_string(url)))
            .arg("-c")
            .arg("mcp_servers.chats.bearer_token_env_var=\"ATELIER_SEARCH_TOKEN\"")
            .arg("-c")
            .arg("mcp_servers.chats.default_tools_approval_mode=\"approve\"")
            .arg("-o")
            .arg(answer_file);
        if let Some(model) = &settings.model {
            command.args(["-m", model]);
        }
        if let Some(effort) = &settings.effort {
            command
                .arg("-c")
                .arg(format!("model_reasoning_effort={}", toml_string(effort)));
        }
        command.arg(prompt);
    }
    command
}

/// Told to the browser; false once nobody is reading.
async fn say(out: &mpsc::Sender<String>, event: Value) -> bool {
    out.send(format!("{event}\n")).await.is_ok()
}

enum Stop {
    /// The person closed the request; there is nobody to tell.
    Stopped,
    Failed(String),
}

/// The agent's last words, once it has finished.
async fn run(
    mut command: Command,
    brand: &str,
    answer_file: &Path,
    limit: Duration,
    out: &mpsc::Sender<String>,
    steps: &mut mpsc::UnboundedReceiver<String>,
) -> Result<String, Stop> {
    let mut child = command
        .spawn()
        .map_err(|error| Stop::Failed(format!("The agent could not start: {error}")))?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let reading = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let (mut result, mut last_text, mut error) = (None, None, None);
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match event["type"].as_str() {
                Some("result") if event["is_error"].as_bool() == Some(true) => {
                    error = Some(
                        event["result"]
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| event["errors"].to_string()),
                    );
                }
                Some("result") => result = event["result"].as_str().map(str::to_string),
                Some("assistant") => {
                    let text = event["message"]["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|block| block["text"].as_str())
                        .collect::<String>();
                    if !text.is_empty() {
                        last_text = Some(text);
                    }
                }
                _ => {}
            }
        }
        (result.or(last_text), error)
    });
    let complaining = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });

    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            Some(step) = steps.recv() => {
                if !say(out, json!({"type":"step","text":step})).await {
                    let _ = child.start_kill();
                    return Err(Stop::Stopped);
                }
            }
            _ = out.closed() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(Stop::Stopped);
            }
            _ = &mut deadline => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(Stop::Failed(format!(
                    "The search ran past its limit of {} seconds.",
                    limit.as_secs()
                )));
            }
        }
    };
    while let Ok(step) = steps.try_recv() {
        say(out, json!({"type":"step","text":step})).await;
    }
    let (mut said, error) = reading.await.unwrap_or((None, None));
    let complaint = complaining.await.unwrap_or_default();
    if brand == "codex" {
        said = std::fs::read_to_string(answer_file).ok().or(said);
    }
    if let Some(error) = error {
        return Err(Stop::Failed(error));
    }
    match said.filter(|said| !said.trim().is_empty()) {
        Some(said) => Ok(said),
        None => {
            let tail = complaint.trim();
            let tail = &tail[tail.len().saturating_sub(400)..];
            let tail = tail.trim_start_matches(|c: char| !c.is_ascii());
            Err(Stop::Failed(match status {
                Ok(status) if !tail.is_empty() => {
                    format!("The agent stopped ({status}): {tail}")
                }
                Ok(status) => format!("The agent stopped ({status}) without an answer."),
                Err(error) => format!("The agent could not be watched: {error}"),
            }))
        }
    }
}

fn tools() -> Value {
    let read_only = json!({"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false});
    json!([
        {
            "name": "search_chats",
            "description": "Search every chat. Every word must appear somewhere in a chat. Supports \"phrases\", -word, title:, me:, agent:, tool:, project:, provider:, after:, before: and card:. Returns each chat once with its id, title, project, provider, last activity, match count and up to three snippets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type":"string","description":"The words and keys to search for"},
                    "sort": {"type":"string","enum":["relevance","newest"]},
                    "offset": {"type":"integer","minimum":0},
                    "limit": {"type":"integer","minimum":1,"maximum":30}
                },
                "required": ["query"]
            },
            "annotations": read_only,
        },
        {
            "name": "read_chat",
            "description": "Read one chat by id: its title and project, then what was said in order, a page at a time. Pass the returned next as offset for more.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type":"string","description":"A chat id from search_chats"},
                    "offset": {"type":"integer","minimum":0},
                    "limit": {"type":"integer","minimum":1,"maximum":200}
                },
                "required": ["id"]
            },
            "annotations": read_only,
        }
    ])
}

fn tool_text(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})
}

fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

pub(super) async fn mcp(
    State(state): State<WorkbenchState>,
    headers: HeaderMap,
    Json(message): Json<Value>,
) -> Response {
    let steps = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(|token| runs().lock().unwrap().get(token.trim()).cloned());
    let Some(steps) = steps else {
        return (
            StatusCode::UNAUTHORIZED,
            "no search is running with that token",
        )
            .into_response();
    };
    if message.is_array() {
        return (StatusCode::BAD_REQUEST, "one message at a time").into_response();
    }
    // A notification, or an answer to something never asked: nothing to say.
    let (Some(id), Some(method)) = (message.get("id").cloned(), message["method"].as_str()) else {
        return StatusCode::ACCEPTED.into_response();
    };
    let answered = match method {
        "initialize" => {
            let version = message["params"]["protocolVersion"]
                .as_str()
                .filter(|asked| VERSIONS.contains(asked))
                .unwrap_or("2025-11-25");
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "chats", "version": env!("CARGO_PKG_VERSION")},
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => call(&state, &steps, &message["params"]).await,
        _ => Err((-32601, format!("No method {method}"))),
    };
    Json(match answered {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, error)) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":error}})
        }
    })
    .into_response()
}

async fn call(
    state: &WorkbenchState,
    steps: &mpsc::UnboundedSender<String>,
    params: &Value,
) -> Result<Value, (i64, String)> {
    let arguments = &params["arguments"];
    let number = |name: &str| arguments[name].as_u64().map(|n| n as usize);
    let Some(index) = state.search.clone() else {
        return match params["name"].as_str() {
            Some("search_chats" | "read_chat") => Ok(tool_error("The search index is not open.")),
            other => Err((-32602, format!("Unknown tool: {}", other.unwrap_or("")))),
        };
    };
    match params["name"].as_str() {
        Some("search_chats") => {
            let Some(query) = arguments["query"].as_str().map(str::to_string) else {
                return Ok(tool_error("query is required"));
            };
            let _ = steps.send(format!("Searched {}", query.trim()));
            let sort = match arguments["sort"].as_str() {
                Some("newest") => Sort::Newest,
                _ => Sort::Relevance,
            };
            let offset = number("offset").unwrap_or(0);
            let limit = number("limit").unwrap_or(10).clamp(1, 30);
            let projects = state.projects.clone();
            let found = tokio::task::spawn_blocking(move || {
                let parsed =
                    crate::workbench::search_query::parse(query.trim_start(), chrono::Local::now());
                let ids = match (&projects, parsed.projects.is_empty()) {
                    (Some(projects), false) => projects_named(projects, &parsed.projects),
                    _ => Vec::new(),
                };
                index.search_chats(&parsed, &ids, sort, offset, limit)
            })
            .await
            .map_err(|error| (-32603, error.to_string()))?;
            Ok(match found {
                Err(error) => tool_error(&error),
                Ok(page) => tool_text(json!({
                    "chats": page.chats.iter().map(|chat| json!({
                        "id": chat.session_id,
                        "title": chat.title,
                        "project": chat.project_path,
                        "provider": chat.brand,
                        "lastActiveAt": chat.last_active_at,
                        "matches": chat.matches,
                        "snippets": chat.snippets.iter().map(|snippet| json!({
                            "messageId": snippet.message_id,
                            "field": snippet.field,
                            "text": snippet.segments.iter().map(|s| s.text.as_str()).collect::<String>(),
                        })).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                    "next": page.next,
                })),
            })
        }
        Some("read_chat") => {
            let Some(id) = arguments["id"].as_str().map(str::to_string) else {
                return Ok(tool_error("id is required"));
            };
            let offset = number("offset").unwrap_or(0);
            let limit = number("limit").unwrap_or(60).clamp(1, 200);
            let read = tokio::task::spawn_blocking(move || index.chat_words(&id, offset, limit))
                .await
                .map_err(|error| (-32603, error.to_string()))?;
            Ok(match read {
                Err(error) => tool_error(&error),
                Ok(None) => tool_error("No chat has that id."),
                Ok(Some(chat)) => {
                    let named = chat
                        .title
                        .clone()
                        .unwrap_or_else(|| chat.session_id.clone());
                    let _ = steps.send(format!("Read {named}"));
                    tool_text(serde_json::to_value(chat).unwrap_or_default())
                }
            })
        }
        other => Err((-32602, format!("Unknown tool: {}", other.unwrap_or("")))),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{router, ChatDb, WorkbenchRegistry};
    use super::*;
    use crate::workbench::registry::{RegistryPaths, UnavailableFactory};
    use axum::http::Request;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn app() -> (tempfile::TempDir, axum::Router) {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let paths = RegistryPaths {
            home: directory.path().to_path_buf(),
            claude_config: directory.path().join("claude"),
            codex_home: directory.path().join("codex"),
            profiles: directory.path().join("profiles"),
            media: directory.path().join("media"),
        };
        let registry = WorkbenchRegistry::new(database, paths, Arc::new(UnavailableFactory));
        (directory, router(WorkbenchState::new(registry)))
    }

    async fn post(app: &axum::Router, token: &str, body: Value) -> (StatusCode, Value) {
        let answer = app
            .clone()
            .oneshot(
                Request::post("/search/mcp")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ACCEPT, "application/json, text/event-stream")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = answer.status();
        let bytes = axum::body::to_bytes(answer.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[test]
    fn the_agent_is_given_the_skill_without_its_front_matter_and_then_the_question() {
        let said = prompt("where we fixed the loader");
        assert!(
            said.starts_with("# Finding the chat someone describes"),
            "{said}"
        );
        assert!(said.trim_end().ends_with("where we fixed the loader"));
    }

    #[tokio::test]
    async fn the_tools_answer_only_a_search_in_progress() {
        let (_directory, app) = app();
        let hello = json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}});
        let (status, _) = post(&app, "nobody", hello.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (steps, _heard) = mpsc::unbounded_channel();
        let _running = Registered::new("run-token", steps);
        let (status, answer) = post(&app, "run-token", hello).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(answer["id"], 1);

        let (status, _) = post(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);

        let (_, listed) = post(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert!(tools
            .iter()
            .all(|tool| tool["annotations"]["readOnlyHint"] == true));

        let (_, unknown) = post(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_chat","arguments":{}}}),
        )
        .await;
        assert_eq!(unknown["error"]["code"], -32602);
    }
}
