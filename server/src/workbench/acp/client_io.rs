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
}
