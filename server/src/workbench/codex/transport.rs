//! Owned newline-delimited request transport for `codex app-server`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

#[derive(Debug, Error)]
pub enum CodexTransportError {
    #[error("could not start Codex app-server: {0}")]
    Start(String),
    #[error("Codex app-server stopped")]
    Stopped,
    #[error("Codex {method} timed out")]
    Timeout { method: String },
    #[error("Codex request failed: {0}")]
    Request(String),
}

#[derive(Clone, Debug)]
pub struct CodexTransportConfig {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub environment: Vec<(String, String)>,
    pub initialize_timeout: Duration,
}

impl CodexTransportConfig {
    pub fn app_server(cwd: &Path) -> Self {
        Self {
            executable: std::env::var_os("CODEX_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("codex")),
            args: vec!["app-server".into(), "--stdio".into()],
            cwd: cwd.to_path_buf(),
            environment: Vec::new(),
            initialize_timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodexInbound {
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    ProtocolLine(String),
    Stderr(String),
    Exited(String),
}

enum Control {
    Call {
        id: u64,
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    Cancel(u64),
    Notify {
        method: String,
        params: Value,
    },
    Respond {
        id: Value,
        result: Result<Value, Value>,
    },
    Shutdown,
}

struct Owner {
    controls: mpsc::UnboundedSender<Control>,
    task: Mutex<Option<JoinHandle<()>>>,
    stopped: Arc<Notify>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        // The task owns a kill-on-drop Child. Sending shutdown gives it the
        // normal wait/reap path; runtime teardown still drops only that child.
        let _ = self.controls.send(Control::Shutdown);
        let _ = self.task.lock().unwrap().take();
    }
}

#[derive(Clone)]
pub struct CodexTransport {
    owner: Arc<Owner>,
    next_id: Arc<AtomicU64>,
    inbound: Arc<Mutex<Option<mpsc::UnboundedReceiver<CodexInbound>>>>,
    child_id: u32,
}

impl CodexTransport {
    pub async fn start(config: CodexTransportConfig) -> Result<Self, CodexTransportError> {
        let mut command = Command::new(&config.executable);
        command
            .args(&config.args)
            .current_dir(&config.cwd)
            .envs(config.environment.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| CodexTransportError::Start(error.to_string()))?;
        let child_id = child.id().ok_or_else(|| {
            CodexTransportError::Start("spawned process has no process id".to_string())
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CodexTransportError::Start("Codex stdin was not piped".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CodexTransportError::Start("Codex stdout was not piped".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| CodexTransportError::Start("Codex stderr was not piped".to_string()))?;
        let (controls, control_rx) = mpsc::unbounded_channel();
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let stopped = Arc::new(Notify::new());
        let task_stopped = stopped.clone();
        let task = tokio::spawn(async move {
            supervise(child, stdin, stdout, stderr, control_rx, inbound_tx).await;
            task_stopped.notify_one();
        });
        let transport = Self {
            owner: Arc::new(Owner {
                controls,
                task: Mutex::new(Some(task)),
                stopped,
            }),
            next_id: Arc::new(AtomicU64::new(2)),
            inbound: Arc::new(Mutex::new(Some(inbound_rx))),
            child_id,
        };
        let initialized = transport
            .call(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "beads-workbench",
                        "title": "Beads Workbench",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": { "experimentalApi": true, "requestAttestation": false }
                }),
                config.initialize_timeout,
            )
            .await;
        if let Err(error) = initialized {
            transport.close().await;
            return Err(error);
        }
        transport.notify("initialized", json!({}))?;
        Ok(transport)
    }

    pub fn child_id(&self) -> u32 {
        self.child_id
    }

    pub fn take_inbound(&self) -> Option<mpsc::UnboundedReceiver<CodexInbound>> {
        self.inbound.lock().unwrap().take()
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CodexTransportError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = oneshot::channel();
        self.owner
            .controls
            .send(Control::Call {
                id,
                method: method.to_string(),
                params,
                reply,
            })
            .map_err(|_| CodexTransportError::Stopped)?;
        match tokio::time::timeout(timeout, receive).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(CodexTransportError::Request(error)),
            Ok(Err(_)) => Err(CodexTransportError::Stopped),
            Err(_) => {
                let _ = self.owner.controls.send(Control::Cancel(id));
                Err(CodexTransportError::Timeout {
                    method: method.to_string(),
                })
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), CodexTransportError> {
        self.owner
            .controls
            .send(Control::Notify {
                method: method.to_string(),
                params,
            })
            .map_err(|_| CodexTransportError::Stopped)
    }

    pub fn respond(
        &self,
        id: Value,
        result: Result<Value, Value>,
    ) -> Result<(), CodexTransportError> {
        self.owner
            .controls
            .send(Control::Respond { id, result })
            .map_err(|_| CodexTransportError::Stopped)
    }

    pub async fn close(&self) {
        let stopped = self.owner.stopped.notified();
        let _ = self.owner.controls.send(Control::Shutdown);
        stopped.await;
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

fn fail_pending(pending: &mut HashMap<u64, oneshot::Sender<Result<Value, String>>>, error: &str) {
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
    inbound: mpsc::UnboundedSender<CodexInbound>,
) {
    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = BufReader::new(stderr).lines();
    let mut stderr_open = true;
    let mut pending = HashMap::<u64, oneshot::Sender<Result<Value, String>>>::new();
    loop {
        tokio::select! {
            control = controls.recv() => match control {
                Some(Control::Call { id, method, params, reply }) => {
                    pending.insert(id, reply);
                    if write_line(&mut stdin, &json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})).await.is_err() {
                        fail_pending(&mut pending, "Codex stdin closed");
                        break;
                    }
                }
                Some(Control::Cancel(id)) => { pending.remove(&id); }
                Some(Control::Notify { method, params }) => {
                    if write_line(&mut stdin, &json!({"jsonrpc":"2.0", "method":method, "params":params})).await.is_err() { break; }
                }
                Some(Control::Respond { id, result }) => {
                    let message = match result {
                        Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
                        Err(error) => json!({"jsonrpc":"2.0", "id":id, "error":error}),
                    };
                    if write_line(&mut stdin, &message).await.is_err() { break; }
                }
                Some(Control::Shutdown) | None => break,
            },
            line = stdout.next_line() => match line {
                Ok(Some(line)) => receive_line(&line, &mut pending, &inbound),
                Ok(None) | Err(_) => break,
            },
            line = stderr.next_line(), if stderr_open => match line {
                Ok(Some(line)) if !line.trim().is_empty() => { let _ = inbound.send(CodexInbound::Stderr(line)); }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => { stderr_open = false; }
            },
        }
    }
    fail_pending(&mut pending, "Codex app-server stopped");
    drop(stdin);
    let _ = child.start_kill();
    let status = child.wait().await.ok();
    let detail = status.map_or_else(|| "unknown".to_string(), |status| status.to_string());
    let _ = inbound.send(CodexInbound::Exited(detail));
}

fn receive_line(
    line: &str,
    pending: &mut HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    inbound: &mpsc::UnboundedSender<CodexInbound>,
) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        let _ = inbound.send(CodexInbound::ProtocolLine(line.to_string()));
        return;
    };
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id");
    if method.is_none() {
        if let Some(id) = id.and_then(Value::as_u64) {
            if let Some(reply) = pending.remove(&id) {
                let result = match message.get("error") {
                    Some(error) if !error.is_null() => Err(error["message"]
                        .as_str()
                        .unwrap_or("Codex request failed")
                        .to_string()),
                    _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = reply.send(result);
            }
        }
        return;
    }
    let method = method.unwrap().to_string();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let event = match id {
        Some(id) => CodexInbound::Request {
            id: id.clone(),
            method,
            params,
        },
        None => CodexInbound::Notification { method, params },
    };
    let _ = inbound.send(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};

    #[test]
    fn native_codex_fake_app_server() {
        if std::env::var_os("ATELIER_FAKE_CODEX").is_none() {
            return;
        }
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let method = message["method"].as_str().unwrap_or_default();
            if method == "initialized" {
                continue;
            }
            if method == "never" {
                continue;
            }
            let id = message["id"].clone();
            let result = match method {
                "initialize" => json!({"server": "fake"}),
                "echo" => message["params"].clone(),
                "thread/list" => {
                    if message["params"]["cursor"].is_null() {
                        json!({"data":[
                            {"id":"inside","cwd":"/project","path":"/rollout/inside.jsonl"},
                            {"id":"outside","cwd":"/elsewhere","path":"/rollout/outside.jsonl"}
                        ],"nextCursor":"next"})
                    } else {
                        json!({"data":[{"id":"nested","cwd":"/project/nested","path":"/rollout/nested.jsonl"}],"nextCursor":null})
                    }
                }
                "thread/read" => json!({"thread":{"id":message["params"]["threadId"],"turns":[]}}),
                "account/usage/read" => json!({"threadUsage":{"groups":[
                    {"inputTokens":2,"outputTokens":3,"totalTokens":5},
                    {"inputTokens":7,"outputTokens":11}
                ]}}),
                "model/list" => {
                    json!({"data":[{"model":"gpt-5","displayName":"GPT-5","description":"Model","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"high"}],"defaultReasoningEffort":"high"}]})
                }
                "skills/list" => {
                    json!({"data":[{"skills":[{"name":"beads","description":"Use beads","path":"/skills/beads","enabled":true}]}]})
                }
                "collaborationMode/list" => json!({"data":[{"mode":"plan","name":"Plan"}]}),
                "fail" => {
                    writeln!(stdout, "{}", json!({"jsonrpc":"2.0", "id":id, "error":{"code":-1,"message":"deliberate"}})).unwrap();
                    stdout.flush().unwrap();
                    continue;
                }
                "events" => {
                    writeln!(stdout, "not-json").unwrap();
                    writeln!(stdout, "{}", json!({"jsonrpc":"2.0", "method":"turn/started", "params":{"turn":{"id":"turn-1"}}})).unwrap();
                    writeln!(stdout, "{}", json!({"jsonrpc":"2.0", "id":"ask-1", "method":"currentTime/read", "params":{}})).unwrap();
                    json!({"sent": true})
                }
                _ => Value::Null,
            };
            writeln!(
                stdout,
                "{}",
                json!({"jsonrpc":"2.0", "id":id, "result":result})
            )
            .unwrap();
            stdout.flush().unwrap();
        }
    }

    fn fake_config() -> CodexTransportConfig {
        CodexTransportConfig {
            executable: std::env::current_exe().unwrap(),
            args: vec![
                "--exact".into(),
                "workbench::codex::transport::tests::native_codex_fake_app_server".into(),
                "--nocapture".into(),
            ],
            cwd: std::env::current_dir().unwrap(),
            environment: vec![("ATELIER_FAKE_CODEX".into(), "1".into())],
            initialize_timeout: Duration::from_secs(2),
        }
    }

    async fn inbound_matching(
        inbound: &mut mpsc::UnboundedReceiver<CodexInbound>,
        wanted: impl Fn(&CodexInbound) -> bool,
    ) -> CodexInbound {
        loop {
            let message = inbound.recv().await.unwrap();
            if wanted(&message) {
                return message;
            }
        }
    }

    #[tokio::test]
    async fn native_codex_transport_correlates_replies_errors_and_inbound_messages() {
        let transport = CodexTransport::start(fake_config()).await.unwrap();
        let mut inbound = transport.take_inbound().unwrap();
        assert_eq!(
            transport
                .call("echo", json!({"kept": 42}), Duration::from_secs(1))
                .await
                .unwrap(),
            json!({"kept": 42})
        );
        assert!(matches!(
            transport.call("fail", json!({}), Duration::from_secs(1)).await,
            Err(CodexTransportError::Request(error)) if error == "deliberate"
        ));
        assert_eq!(
            transport
                .call("events", json!({}), Duration::from_secs(1))
                .await
                .unwrap(),
            json!({"sent": true})
        );
        assert_eq!(
            inbound_matching(&mut inbound, |message| {
                message == &CodexInbound::ProtocolLine("not-json".into())
            })
            .await,
            CodexInbound::ProtocolLine("not-json".into())
        );
        assert!(
            matches!(inbound_matching(&mut inbound, |message| matches!(message, CodexInbound::Notification { method, .. } if method == "turn/started")).await, CodexInbound::Notification { .. })
        );
        assert!(
            matches!(inbound_matching(&mut inbound, |message| matches!(message, CodexInbound::Request { method, .. } if method == "currentTime/read")).await, CodexInbound::Request { .. })
        );
        transport.close().await;
    }

    #[tokio::test]
    async fn native_codex_transport_times_out_and_reaps_only_its_owned_child() {
        let transport = CodexTransport::start(fake_config()).await.unwrap();
        let pid = transport.child_id();
        assert!(matches!(
            transport.call("never", json!({}), Duration::from_millis(20)).await,
            Err(CodexTransportError::Timeout { method }) if method == "never"
        ));
        transport.close().await;
        #[cfg(target_os = "linux")]
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "owned fake child still exists"
        );
    }

    #[tokio::test]
    async fn native_codex_transport_reports_startup_failure_without_a_background_task() {
        let mut config = fake_config();
        config.executable = PathBuf::from("/definitely/not/a/codex-executable");
        assert!(matches!(
            CodexTransport::start(config).await,
            Err(CodexTransportError::Start(_))
        ));
    }

    #[tokio::test]
    async fn native_codex_history_discovers_all_pages_filters_folders_and_reads_one_chat() {
        use crate::workbench::codex::history::{list_threads, menu, read_thread, thread_usage};
        let transport = CodexTransport::start(fake_config()).await.unwrap();
        let found = list_threads(&transport, Some(Path::new("/project")), true)
            .await
            .unwrap();
        assert_eq!(
            found
                .iter()
                .map(|thread| thread["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["inside", "nested"]
        );
        assert_eq!(
            read_thread(&transport, "inside").await.unwrap()["id"],
            "inside"
        );
        assert_eq!(
            thread_usage(&transport, "inside").await.unwrap(),
            Some((9, 14, 23))
        );
        let capabilities = menu(&transport, Path::new("/project"), Some("gpt-5")).await;
        assert_eq!(capabilities["models"][1]["value"], "gpt-5");
        assert_eq!(capabilities["efforts"][0]["value"], "high");
        assert_eq!(capabilities["collaborationModes"][0]["value"], "plan");
        assert_eq!(capabilities["skills"], json!(["beads"]));
        transport.close().await;
    }
}
