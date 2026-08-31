//! Transactional bridge from one native Claude process to the durable chat actor.

use super::history::{claude_config_dir, find_record, read_history};
use super::live::{ClaudeLiveState, DriverEvent};
use super::transport::{ClaudeInbound, ClaudeTransport, ClaudeTransportConfig};
use crate::workbench::actor::ChatDb;
use crate::workbench::protocol::Event;
use crate::workbench::store::Session;
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::mpsc;

pub struct NativeClaudeSession {
    database: ChatDb,
    transport: ClaudeTransport,
    live: ClaudeLiveState,
    inbound: mpsc::UnboundedReceiver<ClaudeInbound>,
    session_id: String,
    cwd: PathBuf,
    words: HashMap<String, String>,
    assistant_messages: HashSet<String>,
    root_assistant_messages: HashSet<String>,
}

impl NativeClaudeSession {
    /// Start and initialize Claude before making a database row visible.  A
    /// missing or incompatible provider can therefore never leave an orphaned
    /// chat which the browser offers but nobody can drive.
    pub async fn start(
        database: ChatDb,
        config: ClaudeTransportConfig,
        session: Session,
    ) -> Result<Self, String> {
        Self::connect(database, config, session, true).await
    }

    /// Reattach the same durable row after its provider process or stream
    /// disappears. Imported provider events carry stable identities, so the
    /// chat actor drops replayed duplicates before assigning a new sequence.
    pub async fn reconnect(
        database: ChatDb,
        config: ClaudeTransportConfig,
        session: Session,
    ) -> Result<Self, String> {
        Self::connect(database, config, session, false).await
    }

    async fn connect(
        database: ChatDb,
        config: ClaudeTransportConfig,
        mut session: Session,
        create: bool,
    ) -> Result<Self, String> {
        let resume = session.external_id.clone().or_else(|| {
            config
                .args
                .windows(2)
                .find(|pair| pair[0] == "--resume")
                .map(|pair| pair[1].clone())
        });
        let cwd = config.cwd.clone();
        let transport = ClaudeTransport::start(config)
            .await
            .map_err(|error| error.to_string())?;
        let initialization = transport.initialization().clone();
        let inbound = transport
            .take_inbound()
            .ok_or_else(|| "Claude event stream was already taken".to_string())?;
        if resume.is_some() {
            session.external_id = resume.clone();
        } else {
            session.external_id = initialization["session_id"]
                .as_str()
                .or_else(|| initialization["sessionId"].as_str())
                .map(str::to_string);
        }
        let live = ClaudeLiveState::new(
            initialization,
            session.model.clone(),
            session.permission_mode.clone(),
            session.effort.clone(),
        );
        if create {
            if let Err(error) = database.create_session(session.clone()).await {
                transport.close().await;
                return Err(error);
            }
        }
        let mut native = Self {
            database,
            transport,
            live,
            inbound,
            session_id: session.id,
            cwd,
            words: HashMap::new(),
            assistant_messages: HashSet::new(),
            root_assistant_messages: HashSet::new(),
        };
        if let Err(error) = native
            .persist(vec![
                native.live.menu(),
                json!({"type":"session.state","state":"idle","label":"Ready"}),
            ])
            .await
        {
            native.close().await;
            if create {
                let _ = native
                    .database
                    .delete_session(native.session_id.clone())
                    .await;
            }
            return Err(error);
        }
        if let Some(resume) = resume {
            if let Err(error) = native.import_history(&resume).await {
                native.close().await;
                if create {
                    let _ = native
                        .database
                        .delete_session(native.session_id.clone())
                        .await;
                }
                return Err(error);
            }
        }
        Ok(native)
    }

    async fn import_history(&mut self, external_id: &str) -> Result<(), String> {
        let Some(config) = claude_config_dir() else {
            return Ok(());
        };
        let Some(record) = find_record(&config, external_id) else {
            return Ok(());
        };
        let events=read_history(&record).events.into_iter().map(|mut event|{let event_id=crate::workbench::protocol::replay_event_id(&event);if let Some(object)=event.as_object_mut(){object.insert("providerEvent".into(),json!({"provider":"claude","threadId":external_id,"eventId":event_id,"delivery":"replay"}));}event}).collect();
        self.persist(events).await?;
        Ok(())
    }

    async fn persist(&mut self, events: Vec<DriverEvent>) -> Result<Vec<Event>, String> {
        let mut appended = Vec::new();
        for bare in events {
            let replayed = bare["providerEvent"].is_object();
            let kind = bare["type"].as_str().unwrap_or_default().to_string();
            let message = bare["messageId"].as_str().map(str::to_string);
            if kind == "message.started" && bare["role"] == "assistant" {
                if let Some(id) = message.as_ref() {
                    self.assistant_messages.insert(id.clone());
                    if bare["parentToolCallId"].is_null() {
                        self.root_assistant_messages.insert(id.clone());
                    }
                }
            }
            if kind == "text.delta" {
                if let (Some(id), Some(text)) = (message.as_ref(), bare["text"].as_str()) {
                    self.words.entry(id.clone()).or_default().push_str(text)
                }
            }
            let event = envelop(&self.session_id, bare)?;
            if let Some(event) = self.database.append(event).await? {
                appended.push(event);
            }
            if kind == "message.completed" {
                if let Some(id) = message {
                    let text = self.words.remove(&id).unwrap_or_default();
                    let assistant = self.assistant_messages.remove(&id);
                    let root = self.root_assistant_messages.remove(&id);
                    if assistant && !replayed {
                        if root {
                            if let Some(mut signal) =
                                crate::workbench::provider_messages::from_text(&text)
                            {
                                signal["sourceMessageId"] = json!(id);
                                let event = envelop(
                                    &self.session_id,
                                    json!({"type":"provider.message","signal":signal}),
                                )?;
                                if let Some(event) = self.database.append(event).await? {
                                    appended.push(event)
                                }
                            }
                        }
                        for widget in crate::workbench::media::widget_specs(&text) {
                            let event = envelop(
                                &self.session_id,
                                json!({"type":"widget","messageId":id,"widget":widget}),
                            )?;
                            if let Some(event) = self.database.append(event).await? {
                                appended.push(event)
                            }
                        }
                        for comparison in
                            crate::workbench::media::comparison_specs(&text, &self.cwd)
                        {
                            let event = envelop(
                                &self.session_id,
                                json!({"type":"image.compare","messageId":id,"comparison":comparison}),
                            )?;
                            if let Some(event) = self.database.append(event).await? {
                                appended.push(event)
                            }
                        }
                    }
                }
            }
        }
        Ok(appended)
    }

    pub fn child_id(&self) -> u32 {
        self.transport.child_id()
    }

    pub async fn send(&mut self, text: &str, images: &[Value]) -> Result<Vec<Event>, String> {
        self.live.validate_prompt(text)?;
        let events = self
            .live
            .send_prompt(&self.transport, text, images)
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub fn validate_prompt(&self, text: &str) -> Result<(), String> {
        self.live.validate_prompt(text)
    }

    /// Wait for exactly one provider frame and commit every WBP event it
    /// produces before returning. Protocol garbage and stderr are events too;
    /// neither can silently stop the pump.
    pub async fn next(&mut self) -> Result<Vec<Event>, String> {
        let inbound = self
            .inbound
            .recv()
            .await
            .ok_or_else(|| "Claude event stream stopped".to_string())?;
        let events = self.live.handle(inbound);
        self.persist(events).await
    }

    pub async fn answer_permission(
        &mut self,
        ask_id: &str,
        choice: &str,
    ) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .answer_permission(&self.transport, ask_id, choice)
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn answer_questions(
        &mut self,
        request_id: &str,
        response: &Value,
    ) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .answer_questions(&self.transport, request_id, response)?;
        self.persist(events).await
    }

    pub async fn respond_plan(
        &mut self,
        proposal_id: &str,
        action: &str,
        feedback: Option<&str>,
    ) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .respond_plan(&self.transport, proposal_id, action, feedback)?;
        self.persist(events).await
    }

    pub async fn set_mode(&mut self, mode: &str) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .set_mode(&self.transport, mode)
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn set_model(&mut self, model: &str) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .set_model(&self.transport, model)
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn set_effort(&mut self, effort: &str) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .set_effort(&self.transport, effort)
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn interrupt(&mut self) -> Result<Vec<Event>, String> {
        let events = self
            .live
            .interrupt(&self.transport)
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn stop_agent(&self, agent_id: &str) -> Result<(), String> {
        self.live
            .stop_agent(&self.transport, agent_id)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn park_agent(&self, agent_id: &str) -> Result<bool, String> {
        self.live
            .park_agent(&self.transport, agent_id)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn close(&self) {
        self.transport.close().await;
    }

    pub async fn window_now(&self) -> Result<Value, String> {
        self.transport
            .call(
                json!({"subtype":"get_context_usage"}),
                std::time::Duration::from_secs(15),
            )
            .await
            .map_err(|e| e.to_string())
    }
}

fn envelop(session_id: &str, bare: DriverEvent) -> Result<Event, String> {
    let mut object = bare
        .as_object()
        .cloned()
        .ok_or_else(|| "Claude event was not an object".to_string())?;
    object.insert("sessionId".into(), json!(session_id));
    object.insert("seq".into(), json!(0));
    object.insert(
        "at".into(),
        json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    serde_json::from_value(Value::Object(object)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn session(id: &str) -> Session {
        Session {
            id: id.into(),
            brand: "claude".into(),
            external_id: None,
            project_id: "project-1".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: Some("sonnet".into()),
            permission_mode: "default".into(),
            effort: Some("high".into()),
            collaboration_mode: None,
            title: Some("Chat".into()),
            state: "idle".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00.000Z".into(),
            last_active_at: "2026-08-30T00:00:00.000Z".into(),
            last_spoke_at: None,
        }
    }

    #[test]
    fn native_claude_session_fake_program() {
        if std::env::var_os("ATELIER_SESSION_FAKE_CLAUDE").is_none() {
            return;
        }
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let line = line.unwrap();
            let message: Value = serde_json::from_str(&line).unwrap();
            if message["type"] == "control_response" {
                writeln!(
                    stdout,
                    "{}",
                    json!({"type":"system","subtype":"permission_recorded"})
                )
                .unwrap();
                stdout.flush().unwrap();
                continue;
            }
            if message["type"] == "user" {
                writeln!(stdout, "not-json").unwrap();
                writeln!(stdout, "{}", json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"answer-1"}}})).unwrap();
                writeln!(stdout, "{}", json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}})).unwrap();
                writeln!(stdout, "{}", json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}})).unwrap();
                writeln!(stdout, "{}", json!({"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"cargo test"}}})).unwrap();
                stdout.flush().unwrap();
                continue;
            }
            let request_id = message["request_id"].clone();
            let subtype = message["request"]["subtype"].as_str().unwrap_or_default();
            let response = if subtype == "initialize" {
                json!({"commands":[{"name":"compact"}],"models":[{"value":"sonnet","supportedEffortLevels":["high"]}]})
            } else {
                json!({})
            };
            writeln!(stdout, "{}", json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}})).unwrap();
            stdout.flush().unwrap();
        }
    }

    fn fake_config() -> ClaudeTransportConfig {
        let args = vec![
            "--exact".into(),
            "workbench::claude::session::tests::native_claude_session_fake_program".into(),
            "--nocapture".into(),
        ];
        ClaudeTransportConfig {
            executable: std::env::current_exe().unwrap(),
            args,
            cwd: std::env::current_dir().unwrap(),
            environment: vec![("ATELIER_SESSION_FAKE_CLAUDE".into(), "1".into())],
            initialize_timeout: Duration::from_secs(2),
        }
    }

    #[tokio::test]
    async fn native_claude_process_failed_startup_never_creates_an_orphan_chat() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let mut config = fake_config();
        config.executable = PathBuf::from("/definitely/not/a/claude-executable");
        assert!(
            NativeClaudeSession::start(database.clone(), config, session("orphan"))
                .await
                .is_err()
        );
        assert!(database.list_sessions(None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn native_claude_process_persists_malformed_and_live_frames_and_reaps_its_child() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workbench.db");
        let database = ChatDb::open(&path).unwrap();
        let mut native =
            NativeClaudeSession::start(database.clone(), fake_config(), session("chat-1"))
                .await
                .unwrap();
        let pid = native.child_id();
        native.send("hi", &[]).await.unwrap();
        for _ in 0..10 {
            let arrived = tokio::time::timeout(Duration::from_secs(1), native.next())
                .await
                .expect("the fake should keep producing")
                .unwrap();
            if arrived
                .iter()
                .any(|event| event.kind == crate::workbench::protocol::EventKind::AskPermission)
            {
                break;
            }
        }
        let events = database.events_since("chat-1".into(), 0).await.unwrap();
        assert!(events.iter().any(|event| event.kind
            == crate::workbench::protocol::EventKind::Note
            && event.fields["kind"] == "protocol"));
        assert!(events.iter().any(|event| event.kind
            == crate::workbench::protocol::EventKind::TextDelta
            && event.fields["text"] == "hello"));
        assert!(events
            .iter()
            .any(|event| event.kind == crate::workbench::protocol::EventKind::AskPermission));
        native
            .answer_permission("permission-1", "allow_once")
            .await
            .unwrap();
        native.close().await;
        #[cfg(target_os = "linux")]
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "owned fake Claude child still exists"
        );
        drop(native);
        drop(database);
        let reopened = ChatDb::open(&path).unwrap();
        assert_eq!(reopened.list_sessions(None).await.unwrap().len(), 1);
        assert!(
            reopened
                .events_since("chat-1".into(), 0)
                .await
                .unwrap()
                .len()
                >= events.len()
        );
    }

    #[tokio::test]
    async fn native_claude_process_resume_sets_the_external_id_transactionally() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let chat = "123e4567-e89b-12d3-a456-426614174000";
        let mut resumed = session("chat-1");
        resumed.external_id = Some(chat.into());
        let native = NativeClaudeSession::start(database.clone(), fake_config(), resumed)
            .await
            .unwrap();
        assert_eq!(
            database.list_sessions(None).await.unwrap()[0]
                .external_id
                .as_deref(),
            Some(chat)
        );
        native.close().await;
    }
}
