//! Owned newline-delimited transport for the user-installed `claude` program.
//!
//! Atelier deliberately keeps this small boundary in-tree. The available Rust
//! wrappers either call the Anthropic Messages API (and therefore cannot reuse
//! Claude Code login/session state), buffer a complete turn before exposing it,
//! or omit controls Atelier already presents in its browser. Keeping raw JSON
//! here also means a new upstream event reaches the normalizer instead of being
//! discarded by a dependency's closed message enum.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

#[derive(Debug, Error)]
pub enum ClaudeTransportError {
    #[error("could not start Claude Code: {0}")]
    Start(String),
    #[error("Claude Code stopped")]
    Stopped,
    #[error("Claude control request {subtype} timed out")]
    Timeout { subtype: String },
    #[error("Claude control request failed: {0}")]
    Request(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaudeSessionOptions {
    pub cwd: PathBuf,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub instructions: String,
}

impl ClaudeSessionOptions {
    /// Arguments shared with the official Agent SDK's persistent stream mode.
    /// Features which are initialization fields rather than command flags
    /// (`agentProgressSummaries` and `forwardSubagentText`) are sent by
    /// [`ClaudeTransport::start`].
    pub fn command_args(&self) -> Vec<String> {
        let mut args = vec![
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--allow-dangerously-skip-permissions".into(),
            "--include-partial-messages".into(),
            "--include-hook-events".into(),
            "--strict-mcp-config".into(),
            "--setting-sources=user,project,local".into(),
        ];
        if !self.instructions.is_empty() {
            args.push("--append-system-prompt".into());
            args.push(self.instructions.clone());
        }
        if let Some(resume) = &self.resume {
            args.push("--resume".into());
            args.push(resume.clone());
        }
        if let Some(model) = &self.model {
            args.push("--model".into());
            args.push(model.clone());
        }
        if let Some(mode) = &self.permission_mode {
            args.push("--permission-mode".into());
            args.push(mode.clone());
        }
        if let Some(effort) = &self.effort {
            args.push("--effort".into());
            args.push(effort.clone());
        }
        args
    }
}

#[derive(Clone, Debug)]
pub struct ClaudeTransportConfig {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub environment: Vec<(String, String)>,
    pub initialize_timeout: Duration,
}

impl ClaudeTransportConfig {
    pub fn session(options: &ClaudeSessionOptions) -> Self {
        Self {
            executable: std::env::var_os("CLAUDE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("claude")),
            args: options.command_args(),
            cwd: options.cwd.clone(),
            environment: vec![
                ("CLAUDE_CODE_ENTRYPOINT".into(), "beads-workbench".into()),
                (
                    "CLAUDE_AGENT_SDK_VERSION".into(),
                    env!("CARGO_PKG_VERSION").into(),
                ),
            ],
            initialize_timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ClaudeInbound {
    Event(Value),
    Request { request_id: String, request: Value },
    ProtocolLine(String),
    Stderr(String),
    Exited(String),
}

enum Control {
    Call {
        request_id: String,
        request: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Cancel(String),
    Send(Value),
    Respond {
        request_id: String,
        result: Result<Value, String>,
    },
    Shutdown,
}

struct Owner {
    controls: mpsc::UnboundedSender<Control>,
    task: Mutex<Option<JoinHandle<()>>>,
    stopped: Arc<Notify>,
    is_stopped: Arc<AtomicBool>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        // The supervisor owns one kill-on-drop child. It receives shutdown if
        // a runtime remains; runtime teardown still drops only that exact child.
        let _ = self.controls.send(Control::Shutdown);
        let _ = self.task.lock().unwrap().take();
    }
}

#[derive(Clone)]
pub struct ClaudeTransport {
    owner: Arc<Owner>,
    next_id: Arc<AtomicU64>,
    inbound: Arc<Mutex<Option<mpsc::UnboundedReceiver<ClaudeInbound>>>>,
    child_id: u32,
    initialization: Value,
}

impl ClaudeTransport {
    pub async fn start(config: ClaudeTransportConfig) -> Result<Self, ClaudeTransportError> {
        let mut command = Command::new(&config.executable);
        command
            .args(&config.args)
            .current_dir(&config.cwd)
            // Claude refuses to nest under an ambient interactive Claude Code
            // session. Atelier is an independent host, so it must not inherit
            // that marker from whichever terminal launched the app.
            .env_remove("CLAUDECODE")
            .envs(config.environment.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| ClaudeTransportError::Start(error.to_string()))?;
        let child_id = child.id().ok_or_else(|| {
            ClaudeTransportError::Start("spawned process has no process id".into())
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ClaudeTransportError::Start("Claude stdin was not piped".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ClaudeTransportError::Start("Claude stdout was not piped".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ClaudeTransportError::Start("Claude stderr was not piped".into()))?;

        let (controls, control_rx) = mpsc::unbounded_channel();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let stopped = Arc::new(Notify::new());
        let is_stopped = Arc::new(AtomicBool::new(false));
        let task_stopped = stopped.clone();
        let task_is_stopped = is_stopped.clone();
        let task = tokio::spawn(async move {
            supervise(child, stdin, stdout, stderr, control_rx, inbound_tx).await;
            task_is_stopped.store(true, Ordering::Release);
            task_stopped.notify_waiters();
        });
        let mut transport = Self {
            owner: Arc::new(Owner {
                controls,
                task: Mutex::new(Some(task)),
                stopped,
                is_stopped,
            }),
            next_id: Arc::new(AtomicU64::new(1)),
            inbound: Arc::new(Mutex::new(Some(inbound_rx))),
            child_id,
            initialization: Value::Null,
        };
        let initialized = transport
            .call(
                json!({
                    "subtype": "initialize",
                    "hooks": null,
                    "agentProgressSummaries": true,
                    "forwardSubagentText": true
                }),
                config.initialize_timeout,
            )
            .await;
        match initialized {
            Ok(initialization) => transport.initialization = initialization,
            Err(error) => {
                transport.close().await;
                return Err(error);
            }
        }
        Ok(transport)
    }

    pub fn child_id(&self) -> u32 {
        self.child_id
    }

    pub fn initialization(&self) -> &Value {
        &self.initialization
    }

    pub fn take_inbound(&self) -> Option<mpsc::UnboundedReceiver<ClaudeInbound>> {
        self.inbound.lock().unwrap().take()
    }

    pub async fn call(
        &self,
        request: Value,
        timeout: Duration,
    ) -> Result<Value, ClaudeTransportError> {
        let subtype = request
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let request_id = format!("atelier_{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (reply, receive) = oneshot::channel();
        self.owner
            .controls
            .send(Control::Call {
                request_id: request_id.clone(),
                request,
                reply,
            })
            .map_err(|_| ClaudeTransportError::Stopped)?;
        match tokio::time::timeout(timeout, receive).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(ClaudeTransportError::Request(error)),
            Ok(Err(_)) => Err(ClaudeTransportError::Stopped),
            Err(_) => {
                let _ = self.owner.controls.send(Control::Cancel(request_id));
                Err(ClaudeTransportError::Timeout { subtype })
            }
        }
    }

    pub fn send(&self, message: Value) -> Result<(), ClaudeTransportError> {
        self.owner
            .controls
            .send(Control::Send(message))
            .map_err(|_| ClaudeTransportError::Stopped)
    }

    pub fn respond(
        &self,
        request_id: impl Into<String>,
        result: Result<Value, String>,
    ) -> Result<(), ClaudeTransportError> {
        self.owner
            .controls
            .send(Control::Respond {
                request_id: request_id.into(),
                result,
            })
            .map_err(|_| ClaudeTransportError::Stopped)
    }

    pub async fn close(&self) {
        if self.owner.is_stopped.load(Ordering::Acquire) {
            return;
        }
        let stopped = self.owner.stopped.notified();
        let _ = self.owner.controls.send(Control::Shutdown);
        if !self.owner.is_stopped.load(Ordering::Acquire) {
            stopped.await;
        }
    }
}

async fn write_line(
    stdin: &mut tokio::process::ChildStdin,
    message: &Value,
) -> Result<(), std::io::Error> {
    stdin.write_all(message.to_string().as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

fn fail_pending(
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, String>>>,
    error: &str,
) {
    for (_, reply) in pending.drain() {
        let _ = reply.send(Err(error.to_string()));
    }
}

async fn supervise(
    mut child: tokio::process::Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    mut controls: mpsc::UnboundedReceiver<Control>,
    inbound: mpsc::UnboundedSender<ClaudeInbound>,
) {
    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = BufReader::new(stderr).lines();
    let mut stderr_open = true;
    let mut pending = HashMap::<String, oneshot::Sender<Result<Value, String>>>::new();
    loop {
        tokio::select! {
            control = controls.recv() => match control {
                Some(Control::Call { request_id, request, reply }) => {
                    pending.insert(request_id.clone(), reply);
                    let message = json!({
                        "type": "control_request",
                        "request_id": request_id,
                        "request": request
                    });
                    if write_line(&mut stdin, &message).await.is_err() {
                        fail_pending(&mut pending, "Claude stdin closed");
                        break;
                    }
                }
                Some(Control::Cancel(request_id)) => { pending.remove(&request_id); }
                Some(Control::Send(message)) => {
                    if write_line(&mut stdin, &message).await.is_err() { break; }
                }
                Some(Control::Respond { request_id, result }) => {
                    let response = match result {
                        Ok(response) => json!({
                            "type": "control_response",
                            "response": {
                                "subtype": "success",
                                "request_id": request_id,
                                "response": response
                            }
                        }),
                        Err(error) => json!({
                            "type": "control_response",
                            "response": {
                                "subtype": "error",
                                "request_id": request_id,
                                "error": error
                            }
                        }),
                    };
                    if write_line(&mut stdin, &response).await.is_err() { break; }
                }
                Some(Control::Shutdown) | None => break,
            },
            line = stdout.next_line() => match line {
                Ok(Some(line)) => receive_line(&line, &mut pending, &inbound),
                Ok(None) | Err(_) => break,
            },
            line = stderr.next_line(), if stderr_open => match line {
                Ok(Some(line)) if !line.trim().is_empty() => {
                    let _ = inbound.send(ClaudeInbound::Stderr(line));
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => { stderr_open = false; }
            },
        }
    }
    fail_pending(&mut pending, "Claude Code stopped");
    drop(stdin);
    let _ = child.start_kill();
    let status = child.wait().await.ok();
    let detail = status.map_or_else(|| "unknown".to_string(), |status| status.to_string());
    let _ = inbound.send(ClaudeInbound::Exited(detail));
}

fn receive_line(
    line: &str,
    pending: &mut HashMap<String, oneshot::Sender<Result<Value, String>>>,
    inbound: &mpsc::UnboundedSender<ClaudeInbound>,
) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        let _ = inbound.send(ClaudeInbound::ProtocolLine(line.to_string()));
        return;
    };
    match message.get("type").and_then(Value::as_str) {
        Some("control_response") => {
            let Some(response) = message.get("response") else {
                return;
            };
            let Some(request_id) = response.get("request_id").and_then(Value::as_str) else {
                return;
            };
            let Some(reply) = pending.remove(request_id) else {
                return;
            };
            let result = match response.get("subtype").and_then(Value::as_str) {
                Some("success") => Ok(response.get("response").cloned().unwrap_or(Value::Null)),
                Some("error") => Err(response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude control request failed")
                    .to_string()),
                _ => Err("malformed Claude control response".into()),
            };
            let _ = reply.send(result);
        }
        Some("control_request") => {
            let Some(request_id) = message.get("request_id").and_then(Value::as_str) else {
                let _ = inbound.send(ClaudeInbound::Event(message));
                return;
            };
            let _ = inbound.send(ClaudeInbound::Request {
                request_id: request_id.to_string(),
                request: message.get("request").cloned().unwrap_or(Value::Null),
            });
        }
        _ => {
            let _ = inbound.send(ClaudeInbound::Event(message));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::path::Path;

    #[test]
    fn native_claude_fake_program() {
        if std::env::var_os("ATELIER_FAKE_CLAUDE").is_none() {
            return;
        }
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if message["type"] == "control_response" {
                if message["response"]["request_id"] == "permission-1" {
                    writeln!(
                        stdout,
                        "{}",
                        json!({"type":"system","subtype":"permission_recorded"})
                    )
                    .unwrap();
                    stdout.flush().unwrap();
                }
                continue;
            }
            if message["type"] == "user" {
                writeln!(
                    stdout,
                    "{}",
                    json!({"type":"system","subtype":"user_received"})
                )
                .unwrap();
                stdout.flush().unwrap();
                continue;
            }
            let request_id = message["request_id"].clone();
            let request = &message["request"];
            let subtype = request["subtype"].as_str().unwrap_or_default();
            if subtype == "never" {
                continue;
            }
            if subtype == "events" {
                writeln!(stdout, "not-json").unwrap();
                writeln!(
                    stdout,
                    "{}",
                    json!({"type":"system","subtype":"status","permissionMode":"default"})
                )
                .unwrap();
                writeln!(stdout, "{}", json!({
                    "type":"control_request",
                    "request_id":"permission-1",
                    "request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"cargo test"}}
                })).unwrap();
            }
            let response = match subtype {
                "initialize" => {
                    json!({"commands":[{"name":"compact"}],"models":[{"value":"sonnet"}]})
                }
                "echo" => request["value"].clone(),
                "fail" => {
                    writeln!(stdout, "{}", json!({
                        "type":"control_response",
                        "response":{"subtype":"error","request_id":request_id,"error":"deliberate"}
                    })).unwrap();
                    stdout.flush().unwrap();
                    continue;
                }
                _ => json!({}),
            };
            writeln!(
                stdout,
                "{}",
                json!({
                    "type":"control_response",
                    "response":{"subtype":"success","request_id":request_id,"response":response}
                })
            )
            .unwrap();
            stdout.flush().unwrap();
        }
    }

    fn fake_config() -> ClaudeTransportConfig {
        ClaudeTransportConfig {
            executable: std::env::current_exe().unwrap(),
            args: vec![
                "--exact".into(),
                "workbench::claude::transport::tests::native_claude_fake_program".into(),
                "--nocapture".into(),
            ],
            cwd: std::env::current_dir().unwrap(),
            environment: vec![("ATELIER_FAKE_CLAUDE".into(), "1".into())],
            initialize_timeout: Duration::from_secs(2),
        }
    }

    async fn inbound_matching(
        inbound: &mut mpsc::UnboundedReceiver<ClaudeInbound>,
        wanted: impl Fn(&ClaudeInbound) -> bool,
    ) -> ClaudeInbound {
        loop {
            let message = inbound.recv().await.unwrap();
            if wanted(&message) {
                return message;
            }
        }
    }

    #[test]
    fn native_claude_transport_builds_the_existing_session_contract() {
        let args = ClaudeSessionOptions {
            cwd: PathBuf::from("/project"),
            resume: Some("chat-1".into()),
            model: Some("sonnet".into()),
            permission_mode: Some("plan".into()),
            effort: Some("high".into()),
            instructions: "Follow the project rules".into(),
        }
        .command_args();
        for expected in [
            "--output-format",
            "--input-format",
            "--permission-prompt-tool",
            "--allow-dangerously-skip-permissions",
            "--include-partial-messages",
            "--include-hook-events",
            "--strict-mcp-config",
            "--resume",
            "--model",
            "--permission-mode",
            "--effort",
            "--append-system-prompt",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "missing {expected}");
        }
        assert!(!args.iter().any(|arg| arg == "--bare"));
        assert!(!args.iter().any(|arg| arg == "--fork-session"));
    }

    #[tokio::test]
    async fn native_claude_transport_correlates_controls_and_preserves_every_event() {
        let transport = ClaudeTransport::start(fake_config()).await.unwrap();
        assert_eq!(transport.initialization()["commands"][0]["name"], "compact");
        let mut inbound = transport.take_inbound().unwrap();
        assert_eq!(
            transport
                .call(
                    json!({"subtype":"echo","value":{"kept":42}}),
                    Duration::from_secs(1)
                )
                .await
                .unwrap(),
            json!({"kept":42})
        );
        assert!(matches!(
            transport.call(json!({"subtype":"fail"}), Duration::from_secs(1)).await,
            Err(ClaudeTransportError::Request(error)) if error == "deliberate"
        ));
        transport
            .call(json!({"subtype":"events"}), Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            inbound_matching(&mut inbound, |message| message
                == &ClaudeInbound::ProtocolLine("not-json".into()))
            .await,
            ClaudeInbound::ProtocolLine("not-json".into())
        );
        assert!(matches!(
            inbound_matching(&mut inbound, |message| matches!(message, ClaudeInbound::Event(value) if value["subtype"] == "status")).await,
            ClaudeInbound::Event(_)
        ));
        let request = inbound_matching(&mut inbound, |message| matches!(message, ClaudeInbound::Request { request_id, .. } if request_id == "permission-1")).await;
        assert!(
            matches!(&request, ClaudeInbound::Request { request, .. } if request["subtype"] == "can_use_tool")
        );
        transport
            .respond(
                "permission-1",
                Ok(json!({"behavior":"allow","updatedInput":{"command":"cargo test"}})),
            )
            .unwrap();
        assert!(matches!(
            inbound_matching(&mut inbound, |message| matches!(message, ClaudeInbound::Event(value) if value["subtype"] == "permission_recorded")).await,
            ClaudeInbound::Event(_)
        ));
        transport
            .send(
                json!({"type":"user","session_id":"","message":{"role":"user","content":"hello"}}),
            )
            .unwrap();
        assert!(matches!(
            inbound_matching(&mut inbound, |message| matches!(message, ClaudeInbound::Event(value) if value["subtype"] == "user_received")).await,
            ClaudeInbound::Event(_)
        ));
        transport.close().await;
    }

    #[tokio::test]
    async fn native_claude_transport_times_out_and_reaps_only_its_owned_child() {
        let transport = ClaudeTransport::start(fake_config()).await.unwrap();
        let pid = transport.child_id();
        assert!(matches!(
            transport.call(json!({"subtype":"never"}), Duration::from_millis(20)).await,
            Err(ClaudeTransportError::Timeout { subtype }) if subtype == "never"
        ));
        transport.close().await;
        #[cfg(target_os = "linux")]
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "owned fake child still exists"
        );
    }

    #[tokio::test]
    async fn native_claude_transport_reports_startup_failure_without_a_background_task() {
        let mut config = fake_config();
        config.executable = PathBuf::from("/definitely/not/a/claude-executable");
        assert!(matches!(
            ClaudeTransport::start(config).await,
            Err(ClaudeTransportError::Start(_))
        ));
    }
}
