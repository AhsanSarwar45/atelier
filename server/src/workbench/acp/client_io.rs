//! ACP client-side filesystem and terminal services.
//!
//! Every provider gets this same implementation. Paths are confined to the
//! session workspace, commands are executed directly (never through a shell),
//! and terminal output retains a bounded UTF-8-safe tail.

use agent_client_protocol::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    TerminalExitStatus, TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::Error;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch, Mutex};

const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;
const MAX_OUTPUT_LIMIT: usize = 16 * 1024 * 1024;

fn error(value: impl ToString) -> Error {
    Error::internal_error().data(value.to_string())
}

#[derive(Default)]
struct OutputTail {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl OutputTail {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > self.limit {
            let remove = self.bytes.len() - self.limit;
            self.bytes.drain(..remove);
            self.truncated = true;
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

#[derive(Clone)]
struct Terminal {
    output: Arc<Mutex<OutputTail>>,
    status: watch::Receiver<Option<TerminalExitStatus>>,
    kill: mpsc::Sender<()>,
}

#[derive(Clone)]
pub struct ClientIo {
    root: PathBuf,
    session_id: Arc<Mutex<Option<String>>>,
    terminals: Arc<Mutex<HashMap<String, Terminal>>>,
}

impl ClientIo {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|cause| format!("cannot resolve ACP workspace {}: {cause}", root.display()))?;
        Ok(Self {
            root,
            session_id: Arc::new(Mutex::new(None)),
            terminals: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn set_session(&self, session_id: impl Into<String>) {
        *self.session_id.lock().await = Some(session_id.into());
    }

    async fn validate_session(&self, session_id: &str) -> Result<(), Error> {
        match self.session_id.lock().await.as_deref() {
            Some(expected) if expected == session_id => Ok(()),
            Some(_) => Err(Error::invalid_params().data("ACP request named another session")),
            None => Err(Error::invalid_request().data("ACP session is not initialized")),
        }
    }

    fn confined_existing(&self, path: &Path) -> Result<PathBuf, Error> {
        let resolved = path.canonicalize().map_err(error)?;
        if resolved.starts_with(&self.root) {
            Ok(resolved)
        } else {
            Err(Error::invalid_params().data(format!(
                "path is outside the session workspace: {}",
                path.display()
            )))
        }
    }

    fn confined_write(&self, path: &Path) -> Result<PathBuf, Error> {
        if path.exists() {
            return self.confined_existing(path);
        }
        let parent = path
            .parent()
            .ok_or_else(|| Error::invalid_params().data("file path has no parent"))?;
        let parent = self.confined_existing(parent)?;
        let name = path
            .file_name()
            .ok_or_else(|| Error::invalid_params().data("file path has no name"))?;
        Ok(parent.join(name))
    }

    pub async fn read(&self, request: ReadTextFileRequest) -> Result<ReadTextFileResponse, Error> {
        self.validate_session(request.session_id.0.as_ref()).await?;
        let path = self.confined_existing(&request.path)?;
        let content = tokio::fs::read_to_string(path).await.map_err(error)?;
        let line = request.line.unwrap_or(1).max(1) as usize;
        let limit = request
            .limit
            .map(|value| value as usize)
            .unwrap_or(usize::MAX);
        let content = content
            .split_inclusive('\n')
            .skip(line - 1)
            .take(limit)
            .collect::<String>();
        Ok(ReadTextFileResponse::new(content))
    }

    pub async fn write(
        &self,
        request: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse, Error> {
        self.validate_session(request.session_id.0.as_ref()).await?;
        let path = self.confined_write(&request.path)?;
        tokio::fs::write(path, request.content)
            .await
            .map_err(error)?;
        Ok(WriteTextFileResponse::new())
    }

    pub async fn create_terminal(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, Error> {
        self.validate_session(request.session_id.0.as_ref()).await?;
        if request.command.trim().is_empty() {
            return Err(Error::invalid_params().data("terminal command is empty"));
        }
        let cwd = match request.cwd.as_deref() {
            Some(cwd) => self.confined_existing(cwd)?,
            None => self.root.clone(),
        };
        let limit = request
            .output_byte_limit
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(DEFAULT_OUTPUT_LIMIT)
            .clamp(1, MAX_OUTPUT_LIMIT);
        let mut command = Command::new(&request.command);
        command
            .args(&request.args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for variable in request.env {
            if variable.name.is_empty()
                || variable.name.contains('=')
                || variable.name.contains('\0')
                || variable.value.contains('\0')
            {
                return Err(Error::invalid_params().data("invalid terminal environment variable"));
            }
            command.env(variable.name, variable.value);
        }
        let mut child = command.spawn().map_err(error)?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let output = Arc::new(Mutex::new(OutputTail::new(limit)));
        let stdout = stdout.map(|stdout| tokio::spawn(copy_output(stdout, output.clone())));
        let stderr = stderr.map(|stderr| tokio::spawn(copy_output(stderr, output.clone())));
        let (kill, mut killed) = mpsc::channel(1);
        let (status_send, status) = watch::channel(None);
        tokio::spawn(async move {
            let result = tokio::select! {
                result = child.wait() => result,
                _ = killed.recv() => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            if let Some(stdout) = stdout {
                let _ = stdout.await;
            }
            if let Some(stderr) = stderr {
                let _ = stderr.await;
            }
            let exit = match result {
                Ok(status) => TerminalExitStatus::new()
                    .exit_code(status.code().and_then(|code| u32::try_from(code).ok()))
                    .signal(status.code().is_none().then(|| "signal".to_string())),
                Err(cause) => TerminalExitStatus::new().signal(format!("wait failed: {cause}")),
            };
            let _ = status_send.send(Some(exit));
        });
        let id = uuid::Uuid::new_v4().to_string();
        self.terminals.lock().await.insert(
            id.clone(),
            Terminal {
                output,
                status,
                kill,
            },
        );
        Ok(CreateTerminalResponse::new(id))
    }

    async fn terminal(&self, session_id: &str, terminal_id: &str) -> Result<Terminal, Error> {
        self.validate_session(session_id).await?;
        self.terminals
            .lock()
            .await
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| Error::invalid_params().data("unknown ACP terminal"))
    }

    /// What one of this client's terminals has printed so far, for the reader
    /// rather than for the agent: no session check, because nobody asked —
    /// this is the client reading its own terminal to draw it.
    async fn terminal_snapshot(&self, terminal_id: &str) -> Option<(String, bool)> {
        let terminal = self.terminals.lock().await.get(terminal_id).cloned()?;
        let output = terminal.output.lock().await;
        Some((output.text(), output.truncated))
    }

    pub async fn terminal_output(
        &self,
        request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, Error> {
        let terminal = self
            .terminal(
                request.session_id.0.as_ref(),
                request.terminal_id.0.as_ref(),
            )
            .await?;
        let status = terminal.status.borrow().clone();
        let output = terminal.output.lock().await;
        Ok(TerminalOutputResponse::new(output.text(), output.truncated).exit_status(status))
    }

    pub async fn wait_terminal(
        &self,
        request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, Error> {
        let mut terminal = self
            .terminal(
                request.session_id.0.as_ref(),
                request.terminal_id.0.as_ref(),
            )
            .await?;
        loop {
            if let Some(status) = terminal.status.borrow().clone() {
                return Ok(WaitForTerminalExitResponse::new(status));
            }
            terminal.status.changed().await.map_err(error)?;
        }
    }

    pub async fn kill_terminal(
        &self,
        request: KillTerminalRequest,
    ) -> Result<KillTerminalResponse, Error> {
        let terminal = self
            .terminal(
                request.session_id.0.as_ref(),
                request.terminal_id.0.as_ref(),
            )
            .await?;
        if terminal.status.borrow().is_none() {
            terminal.kill.send(()).await.map_err(error)?;
        }
        Ok(KillTerminalResponse::new())
    }

    pub async fn release_terminal(
        &self,
        request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, Error> {
        self.validate_session(request.session_id.0.as_ref()).await?;
        let terminal = self
            .terminals
            .lock()
            .await
            .remove(request.terminal_id.0.as_ref())
            .ok_or_else(|| Error::invalid_params().data("unknown ACP terminal"))?;
        if terminal.status.borrow().is_none() {
            let _ = terminal.kill.send(()).await;
        }
        Ok(ReleaseTerminalResponse::new())
    }

    pub async fn shutdown(&self) {
        let terminals = std::mem::take(&mut *self.terminals.lock().await);
        for terminal in terminals.into_values() {
            if terminal.status.borrow().is_none() {
                let _ = terminal.kill.send(()).await;
            }
        }
    }
}

async fn copy_output(mut reader: impl AsyncRead + Unpin, output: Arc<Mutex<OutputTail>>) {
    let mut bytes = [0_u8; 8192];
    loop {
        match reader.read(&mut bytes).await {
            Ok(0) | Err(_) => break,
            Ok(read) => output.lock().await.push(&bytes[..read]),
        }
    }
}

/// A `session/update` with every terminal it points at read into it.
///
/// ACP lets a tool call carry `{"type":"terminal","terminalId":…}` in place of
/// its output: the client is the one holding the terminal, so the client is
/// the one that can read it. Nothing did, so a call that ran its command in a
/// terminal drew a row with nothing in it — the command ran, the reader
/// watched an empty box. Read here, before the update is normalized, because
/// the normalizer is a pure reading of one message and this is a question only
/// the running client can answer. Each update re-reads it, which is what makes
/// the output grow on the row while the command is still going (bw-t26l.20).
pub async fn with_terminal_output(io: &ClientIo, raw: &Value) -> Value {
    let Some(rows) = raw["update"]["content"].as_array() else {
        return raw.clone();
    };
    if !rows.iter().any(|row| row["type"] == "terminal") {
        return raw.clone();
    }
    let mut filled = Vec::with_capacity(rows.len());
    for row in rows {
        let read = match (row["type"].as_str(), row["terminalId"].as_str()) {
            (Some("terminal"), Some(id)) => io.terminal_snapshot(id).await,
            _ => None,
        };
        match read {
            Some((text, truncated)) => {
                let text = if truncated {
                    format!("[earlier output dropped]\n{text}")
                } else {
                    text
                };
                filled.push(json!({"type":"content","content":{"type":"text","text":text}}));
            }
            // Not this client's terminal: on a live chat that is an agent
            // naming an id nobody handed it, and on a replay it is a terminal
            // that closed with the session it belonged to. Either way the row
            // said NOTHING -- the normalizer reads content that is words and a
            // terminal block is not words -- so the reader was left looking at
            // a command with an empty box under it, which is the same thing
            // this function was written to stop (bw-t26l.20).
            None => filled.push(json!({"type":"content","content":{"type":"text",
                "text":"[this command's terminal is closed, so what it printed cannot be read back]"}})),
        }
    }
    let mut out = raw.clone();
    out["update"]["content"] = Value::Array(filled);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_service_preserves_line_endings_and_refuses_workspace_escape() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = workspace.path().join("notes.txt");
        std::fs::write(&path, "one\ntwo\nthree").unwrap();
        let io = ClientIo::new(workspace.path().to_path_buf()).unwrap();
        io.set_session("session-1").await;

        let read = io
            .read(
                ReadTextFileRequest::new("session-1", &path)
                    .line(2)
                    .limit(1),
            )
            .await
            .unwrap();
        assert_eq!(read.content, "two\n");

        let escaped = io
            .read(ReadTextFileRequest::new(
                "session-1",
                outside.path().join("missing.txt"),
            ))
            .await;
        assert!(escaped.is_err());
        assert!(!outside.path().join("missing.txt").exists());
    }

    #[tokio::test]
    async fn file_service_writes_only_inside_the_session_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let path = workspace.path().join("written.txt");
        let io = ClientIo::new(workspace.path().to_path_buf()).unwrap();
        io.set_session("session-1").await;
        io.write(WriteTextFileRequest::new(
            "session-1",
            &path,
            "kept exactly",
        ))
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "kept exactly");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_service_waits_reports_a_bounded_tail_and_releases() {
        let workspace = tempfile::tempdir().unwrap();
        let io = ClientIo::new(workspace.path().to_path_buf()).unwrap();
        io.set_session("session-1").await;
        let created = io
            .create_terminal(
                CreateTerminalRequest::new("session-1", "/bin/sh")
                    .args(vec!["-c".into(), "printf abcdef".into()])
                    .output_byte_limit(4),
            )
            .await
            .unwrap();
        let terminal_id = created.terminal_id.0.to_string();
        let exited = io
            .wait_terminal(WaitForTerminalExitRequest::new(
                "session-1",
                terminal_id.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(exited.exit_status.exit_code, Some(0));
        let output = io
            .terminal_output(TerminalOutputRequest::new("session-1", terminal_id.clone()))
            .await
            .unwrap();
        assert_eq!(output.output, "cdef");
        assert!(output.truncated);
        io.release_terminal(ReleaseTerminalRequest::new(
            "session-1",
            terminal_id.clone(),
        ))
        .await
        .unwrap();
        assert!(io
            .terminal_output(TerminalOutputRequest::new("session-1", terminal_id))
            .await
            .is_err());
    }

    /// A tool call that keeps its output in a terminal, drawn with its output
    /// in it. The reader is not holding the terminal; this client is, and
    /// until it read it the row was empty while the command ran (bw-t26l.20).
    #[tokio::test]
    async fn a_call_that_points_at_a_terminal_is_filled_in_with_what_it_printed() {
        let workspace = tempfile::tempdir().unwrap();
        let io = ClientIo::new(workspace.path().to_path_buf()).unwrap();
        io.set_session("session-1").await;
        let created = io
            .create_terminal(
                CreateTerminalRequest::new("session-1", "/bin/sh")
                    .args(vec!["-c".into(), "printf ran-it".into()]),
            )
            .await
            .unwrap();
        let terminal_id = created.terminal_id.0.to_string();
        io.wait_terminal(WaitForTerminalExitRequest::new(
            "session-1",
            terminal_id.clone(),
        ))
        .await
        .unwrap();

        let update = json!({"sessionId":"remote","update":{
            "sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed",
            "content":[{"type":"terminal","terminalId":terminal_id}]
        }});
        let filled = with_terminal_output(&io, &update).await;
        assert_eq!(
            filled["update"]["content"][0],
            json!({"type":"content","content":{"type":"text","text":"ran-it"}})
        );

        // A terminal this client never opened -- an id nobody handed it, or one
        // that closed with the session it belonged to -- says so. Left as it
        // came it read as nothing at all, and the reader was looking at a
        // command with an empty box under it.
        let stranger = json!({"sessionId":"remote","update":{
            "sessionUpdate":"tool_call_update","toolCallId":"call-2",
            "content":[{"type":"terminal","terminalId":"not-ours"}]
        }});
        let said = with_terminal_output(&io, &stranger).await;
        let text = said["update"]["content"][0]["content"]["text"]
            .as_str()
            .expect("a closed terminal is a sentence, not a silence");
        assert!(text.contains("terminal is closed"), "{text}");
    }
}
