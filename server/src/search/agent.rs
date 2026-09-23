//! Asking an agent to find what a person describes in their own words.
//!
//! [`start`] runs the agent chosen in Settings on a question and streams what
//! happens as one JSON object per line: `started`, a `step` for every search
//! or reading, a `found` for every thing it named that exists, then `done` or
//! `failed`. Closing the request stops the agent.
//!
//! The agent searches through [`mcp`], a Model Context Protocol server (the
//! 2025-11-25 Streamable HTTP transport, answered as plain JSON) that answers
//! only the token of a run in progress, with the tools of that run's source.
//! It is MCP, not a command the agent runs, because Codex's read-only sandbox
//! lets no command reach this server or open an index; MCP calls are made by
//! the agent's own process, outside that sandbox. The agent gets these tools
//! and no others.

use super::named::{named, Named};
use crate::routes::search_settings::SearchSettings;
use axum::{
    body::Body,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::future::BoxFuture;
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Where a run's steps are told.
pub type Steps = mpsc::UnboundedSender<String>;

/// A tool's answer, or a JSON-RPC error code and message.
pub type Called = Result<Value, (i64, String)>;

/// A refusal in the words the person should see.
pub type Refusal = (StatusCode, String);

/// One thing that can be searched: the chats, the board, the files.
pub trait Source: Send + Sync + 'static {
    /// One word for what it holds: the tools' server name, and the list the
    /// agent names its finds under — `chats`, `cards`, `files`.
    fn name(&self) -> &'static str;
    /// How to search it, handed to the agent ahead of the question.
    fn skill(&self) -> &'static str;
    /// The MCP tool list, every one read-only.
    fn tools(&self) -> Value;
    /// Answer one tool call, telling `steps` what was searched or read.
    fn call(
        self: Arc<Self>,
        tool: String,
        arguments: Value,
        steps: Steps,
    ) -> BoxFuture<'static, Called>;
    /// Each named thing as the browser draws it, in order, or `None` for one
    /// that does not exist.
    fn found(self: Arc<Self>, named: Vec<Named>) -> BoxFuture<'static, Vec<Option<Value>>>;
}

/// The protocol revisions the endpoint speaks; a client asking for another is
/// answered with the newest.
const VERSIONS: &[&str] = &["2025-03-26", "2025-06-18", "2025-11-25"];

struct Run {
    steps: Steps,
    source: Arc<dyn Source>,
}

/// The runs in progress, by token.
fn runs() -> &'static Mutex<HashMap<String, Run>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Run>>> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

/// A run's token, forgotten when the run ends however it ends.
pub struct Registered(String);

impl Registered {
    pub fn new(token: &str, source: Arc<dyn Source>, steps: Steps) -> Self {
        runs()
            .lock()
            .unwrap()
            .insert(token.to_string(), Run { steps, source });
        Self(token.to_string())
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        runs().lock().unwrap().remove(&self.0);
    }
}

fn refused(message: impl Into<String>) -> Refusal {
    (StatusCode::UNPROCESSABLE_ENTITY, message.into())
}

/// The skill without its front matter, then the question.
pub fn prompt(skill: &str, question: &str) -> String {
    let body = skill
        .strip_prefix("---")
        .and_then(|rest| rest.split_once("\n---"))
        .map(|(_, body)| body.trim_start())
        .unwrap_or(skill);
    format!(
        "{body}\n## The request\n\nToday is {}. The person is looking for:\n\n{question}\n",
        chrono::Local::now().format("%Y-%m-%d")
    )
}

/// Start `source`'s agent on a question. `system` is the account directory a
/// brand uses when no profile was chosen.
pub fn start(
    source: Arc<dyn Source>,
    question: &str,
    settings: SearchSettings,
    system: impl Fn(&str) -> PathBuf,
) -> Result<Response, Refusal> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(refused("Say what you are looking for."));
    }
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
    let home =
        crate::workbench::profiles::chat_dir(&brand, settings.profile.as_deref(), &system(&brand));

    let token = uuid::Uuid::new_v4().to_string();
    let port = std::env::var("ATELIER_PORT")
        .or_else(|_| std::env::var("BEADS_WEB_PORT"))
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    let url = format!("http://127.0.0.1:{port}/api/search/mcp");
    let scratch = std::env::temp_dir().join(format!("atelier-ai-search-{token}"));
    std::fs::create_dir_all(&scratch)
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let answer_file = scratch.join("answer.txt");
    let command = agent_command(&Agent {
        program: &program,
        brand: &brand,
        name: source.name(),
        settings: &settings,
        home: &home,
        scratch: &scratch,
        answer_file: &answer_file,
        url: &url,
        token: &token,
        prompt: &prompt(source.skill(), &question),
    });

    let (out, lines) = mpsc::channel::<String>(64);
    let (steps_to, mut steps) = mpsc::unbounded_channel::<String>();
    let registered = Registered::new(&token, source.clone(), steps_to);
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
        let Some(named) = named(&said, source.name()) else {
            let error = format!("The agent finished without naming any {}.", source.name());
            say(&out, json!({"type":"failed","error":error})).await;
            return;
        };
        let reasons = named.clone();
        let found = source.found(named).await;
        let mut dropped = 0;
        for (named, item) in reasons.into_iter().zip(found) {
            let Some(mut item) = item else {
                dropped += 1;
                continue;
            };
            item["reason"] = json!(named.reason);
            item["at"] = json!(named.at);
            say(&out, json!({"type":"found","item":item})).await;
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

struct Agent<'a> {
    program: &'a Path,
    brand: &'a str,
    /// The tools' server name.
    name: &'a str,
    settings: &'a SearchSettings,
    home: &'a Path,
    scratch: &'a Path,
    answer_file: &'a Path,
    url: &'a str,
    token: &'a str,
    prompt: &'a str,
}

fn agent_command(agent: &Agent) -> Command {
    let Agent {
        program,
        brand,
        name,
        settings,
        home,
        scratch,
        answer_file,
        url,
        token,
        prompt,
    } = *agent;
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
        let servers = json!({"mcpServers":{name:{
            "type":"http","url":url,"headers":{"Authorization":format!("Bearer {token}")}
        }}})
        .to_string();
        let allowed = format!("mcp__{name}");
        // No built-in tool at all, only the searching ones, and a record of
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
            &allowed,
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
            .arg(format!("mcp_servers.{name}.url={}", toml_string(url)))
            .arg("-c")
            .arg(format!(
                "mcp_servers.{name}.bearer_token_env_var=\"ATELIER_SEARCH_TOKEN\""
            ))
            .arg("-c")
            .arg(format!(
                "mcp_servers.{name}.default_tools_approval_mode=\"approve\""
            ))
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

/// What a tool answers with.
pub fn tool_text(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})
}

/// A tool call that could not be answered, told to the agent rather than
/// failing the protocol, so it can try again.
pub fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":message}],"isError":true})
}

/// The annotations every search tool carries.
pub fn read_only() -> Value {
    json!({"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false})
}

/// POST /api/search/mcp
pub async fn mcp(headers: HeaderMap, Json(message): Json<Value>) -> Response {
    let run = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(|token| {
            runs()
                .lock()
                .unwrap()
                .get(token.trim())
                .map(|run| (run.source.clone(), run.steps.clone()))
        });
    let Some((source, steps)) = run else {
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
                "serverInfo": {"name": source.name(), "version": env!("CARGO_PKG_VERSION")},
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": source.tools()})),
        "tools/call" => {
            let params = &message["params"];
            match params["name"].as_str() {
                Some(tool)
                    if source
                        .tools()
                        .as_array()
                        .is_some_and(|tools| tools.iter().any(|known| known["name"] == tool)) =>
                {
                    source
                        .call(tool.to_string(), params["arguments"].clone(), steps)
                        .await
                }
                other => Err((-32602, format!("Unknown tool: {}", other.unwrap_or("")))),
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use axum::routing::post;
    use futures::FutureExt;
    use tower::ServiceExt;

    struct Echo;

    impl Source for Echo {
        fn name(&self) -> &'static str {
            "things"
        }
        fn skill(&self) -> &'static str {
            "---\nname: t\n---\n# Finding things\n"
        }
        fn tools(&self) -> Value {
            json!([{"name":"echo","inputSchema":{"type":"object"},"annotations":read_only()}])
        }
        fn call(
            self: Arc<Self>,
            _tool: String,
            arguments: Value,
            steps: Steps,
        ) -> BoxFuture<'static, Called> {
            async move {
                let _ = steps.send("Echoed".into());
                Ok(tool_text(arguments))
            }
            .boxed()
        }
        fn found(self: Arc<Self>, named: Vec<Named>) -> BoxFuture<'static, Vec<Option<Value>>> {
            async move { named.into_iter().map(|_| None).collect() }.boxed()
        }
    }

    async fn post_to(app: &axum::Router, token: &str, body: Value) -> (StatusCode, Value) {
        let answer = app
            .clone()
            .oneshot(
                Request::post("/mcp")
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
        let said = prompt(Echo.skill(), "where we fixed the loader");
        assert!(said.starts_with("# Finding things"), "{said}");
        assert!(said.trim_end().ends_with("where we fixed the loader"));
    }

    #[tokio::test]
    async fn the_tools_answer_only_a_search_in_progress_with_its_own_source() {
        let app = axum::Router::new().route("/mcp", post(mcp));
        let hello = json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}});
        let (status, _) = post_to(&app, "nobody", hello.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (steps, mut heard) = mpsc::unbounded_channel();
        let _running = Registered::new("run-token", Arc::new(Echo), steps);
        let (status, answer) = post_to(&app, "run-token", hello).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(answer["result"]["serverInfo"]["name"], "things");
        assert_eq!(answer["id"], 1);

        let (status, _) = post_to(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);

        let (_, listed) = post_to(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await;
        assert_eq!(listed["result"]["tools"][0]["name"], "echo");

        let (_, echoed) = post_to(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"q":"x"}}}),
        )
        .await;
        assert_eq!(echoed["result"]["content"][0]["text"], r#"{"q":"x"}"#);
        assert_eq!(heard.try_recv().unwrap(), "Echoed");

        let (_, unknown) = post_to(
            &app,
            "run-token",
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"delete_chat","arguments":{}}}),
        )
        .await;
        assert_eq!(unknown["error"]["code"], -32602);
    }
}
