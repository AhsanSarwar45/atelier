//! Production provider factory and supervised native driver adapters.

use super::actor::ChatDb;
use super::claude::session::NativeClaudeSession;
use super::claude::transport::{ClaudeSessionOptions, ClaudeTransportConfig};
use super::codex::live::StartOptions as CodexStartOptions;
use super::codex::session::NativeCodexSession;
use super::codex::transport::CodexTransportConfig;
use super::metadata::conversation_title;
use super::protocol::{Command, CommandKind, Event};
use super::registry::{DriverFuture, LaunchFuture, LaunchedSession, ProviderDriver, SessionFactory};
use super::store::{Session, SessionPatch};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Default)]
pub struct NativeProviderFactory;

fn field<'a>(command: &'a Command, name: &str) -> Option<&'a str> {
    command.fields.get(name).and_then(Value::as_str).filter(|value| !value.is_empty())
}

fn required<'a>(command: &'a Command, name: &str) -> Result<&'a str, String> {
    field(command, name).ok_or_else(|| format!("{name} is required"))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn new_session(command: &Command, id: String, external_id: Option<String>) -> Result<Session, String> {
    let brand = required(command, "brand")?.to_string();
    if brand != "claude" && brand != "codex" {
        return Err(format!("unknown provider {brand}"));
    }
    let project_path = required(command, "projectPath")?.to_string();
    let at = field(command, "lastActiveAt").map(str::to_string).unwrap_or_else(now);
    Ok(Session {
        id,
        brand: brand.clone(),
        external_id,
        project_id: required(command, "projectId")?.to_string(),
        project_path: project_path.clone(),
        cwd: field(command, "cwd").map(str::to_string).unwrap_or(project_path),
        model: field(command, "model").filter(|model| *model != "default").map(str::to_string),
        permission_mode: field(command, "permissionMode")
            .unwrap_or(if brand == "codex" { "on-request" } else { "default" })
            .to_string(),
        effort: field(command, "effort").map(str::to_string),
        collaboration_mode: field(command, "collaborationMode").map(str::to_string),
        title: field(command, "title").map(str::to_string),
        state: if command.kind == CommandKind::SessionOpen { "dormant" } else { "starting" }.to_string(),
        origin: if command.kind == CommandKind::SessionStart { "app" } else { "terminal" }.to_string(),
        created_at: at.clone(),
        last_active_at: at,
        last_spoke_at: None,
    })
}

async fn existing(database: &ChatDb, command: &Command) -> Result<Option<Session>, String> {
    if let Some(id) = field(command, "sessionId") {
        if let Some(session) = database.get_session(id.to_string()).await? {
            return Ok(Some(session));
        }
    }
    if let Some(id) = field(command, "externalId") {
        return database.session_by_external_id(id.to_string()).await;
    }
    Ok(None)
}

fn reply(session: &Session) -> Result<Value, String> {
    serde_json::to_value(session).map_err(|error| error.to_string())
}

async fn append_state(database: &ChatDb, session_id: &str, state: &str, label: &str) -> Result<(), String> {
    let event: Event = serde_json::from_value(json!({
        "type":"session.state", "sessionId":session_id, "seq":0, "at":now(),
        "state":state, "label":label
    })).map_err(|error| error.to_string())?;
    database.append(event).await?;
    Ok(())
}

impl SessionFactory for NativeProviderFactory {
    fn launch<'a>(&'a self, database: ChatDb, command: &'a Command) -> LaunchFuture<'a> {
        Box::pin(async move {
            let found = existing(&database, command).await?;
            if command.kind == CommandKind::SessionOpen {
                let session = match found {
                    Some(mut session) => {
                        session.state = "dormant".into();
                        database.update_session(session.id.clone(), SessionPatch { state: Some("dormant".into()), ..SessionPatch::default() }, None).await?;
                        append_state(&database, &session.id, "dormant", "Asleep").await?;
                        session
                    },
                    None => {
                        let id = field(command, "sessionId").map(str::to_string)
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let session = new_session(command, id, field(command, "externalId").map(str::to_string))?;
                        database.create_session(session.clone()).await?;
                        append_state(&database, &session.id, "dormant", "Asleep").await?;
                        session
                    }
                };
                return Ok(LaunchedSession { session_id: session.id.clone(), reply: reply(&session)?, driver: None });
            }

            let (session, create) = match found {
                Some(mut session) => {
                    session.state = "starting".into();
                    (session, false)
                }
                None => {
                    let id = field(command, "sessionId").map(str::to_string)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    (new_session(command, id, field(command, "externalId").map(str::to_string))?, true)
                }
            };
            let brand = session.brand.clone();
            let driver: Box<dyn ProviderDriver> = match brand.as_str() {
                "claude" => Box::new(ClaudeDriver::connect(database.clone(), session.clone(), create).await?),
                "codex" => Box::new(CodexDriver::connect(database.clone(), session.clone(), create).await?),
                _ => return Err(format!("unknown provider {brand}")),
            };
            let stored = database.get_session(session.id.clone()).await?.unwrap_or(session);
            Ok(LaunchedSession { session_id: stored.id.clone(), reply: reply(&stored)?, driver: Some(driver) })
        })
    }
}

async fn record_user(database: &ChatDb, session: &Session, text: &str) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let at = now();
    for value in [
        json!({"type":"message.started","sessionId":session.id,"seq":0,"at":at,"messageId":id,"role":"user"}),
        json!({"type":"text.delta","sessionId":session.id,"seq":0,"at":at,"messageId":id,"text":text}),
        json!({"type":"message.completed","sessionId":session.id,"seq":0,"at":at,"messageId":id}),
    ] {
        let event = serde_json::from_value(value).map_err(|error| error.to_string())?;
        database.append(event).await?;
    }
    if session.title.is_none() {
        database.update_session(session.id.clone(), SessionPatch { title: Some(conversation_title(text)), ..SessionPatch::default() }, Some(at.clone())).await?;
    }
    database.mark_spoke(session.id.clone(), at).await?;
    Ok(id)
}

struct ClaudeDriver {
    database: ChatDb,
    session: Session,
    options: ClaudeSessionOptions,
    native: NativeClaudeSession,
}

impl ClaudeDriver {
    async fn connect(database: ChatDb, session: Session, create: bool) -> Result<Self, String> {
        let executable = std::env::var_os("CLAUDE_PATH").map(PathBuf::from)
            .or_else(|| crate::routes::find_tool("claude", &[]))
            .ok_or_else(|| "Claude Code is not installed. Install and sign in at https://docs.anthropic.com/en/docs/claude-code, then choose its path in Settings → Dependencies.".to_string())?;
        let mut options = ClaudeSessionOptions {
            cwd: PathBuf::from(&session.cwd), resume: session.external_id.clone(), model: session.model.clone(),
            permission_mode: Some(session.permission_mode.clone()), effort: session.effort.clone(), instructions: String::new(),
        };
        let mut config = ClaudeTransportConfig::session(&options);
        config.executable = executable;
        let native = if create {
            NativeClaudeSession::start(database.clone(), config, session.clone()).await?
        } else {
            NativeClaudeSession::reconnect(database.clone(), config, session.clone()).await?
        };
        let session = database.get_session(session.id.clone()).await?.unwrap_or(session);
        options.resume = session.external_id.clone();
        Ok(Self { database, session, options, native })
    }

    async fn run(&mut self, command: &Command) -> Result<Value, String> {
        match command.kind {
            CommandKind::PromptSend => {
                let text = required(command, "text")?;
                let id = record_user(&self.database, &self.session, text).await?;
                let images = command.fields.get("images").and_then(Value::as_array).cloned().unwrap_or_default();
                self.native.send(text, &images).await?;
                Ok(json!({"ok":true,"messageId":id}))
            }
            CommandKind::AskAnswer => { self.native.answer_permission(required(command,"askId")?, required(command,"optionId")?).await?; Ok(json!({"ok":true})) }
            CommandKind::QuestionAnswer => { self.native.answer_questions(required(command,"requestId")?, command.fields.get("response").unwrap_or(&Value::Null)).await?; Ok(json!({"ok":true})) }
            CommandKind::PlanRespond => {
                let response = command.fields.get("response").unwrap_or(&Value::Null);
                self.native.respond_plan(required(command,"proposalId")?, response["actionId"].as_str().unwrap_or_default(), response["feedback"].as_str()).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionStop => { self.native.interrupt().await?; Ok(json!({"ok":true})) }
            CommandKind::SessionMode => { self.native.set_mode(required(command,"mode")?).await?; Ok(json!({"ok":true})) }
            CommandKind::SessionModel => { self.native.set_model(required(command,"model")?).await?; Ok(json!({"ok":true})) }
            CommandKind::SessionEffort => { self.native.set_effort(required(command,"effort")?).await?; Ok(json!({"ok":true})) }
            CommandKind::AgentStop => { self.native.stop_agent(required(command,"agentId")?).await?; Ok(json!({"ok":true})) }
            CommandKind::AgentPark => { let parked = self.native.park_agent(required(command,"agentId")?).await?; Ok(json!({"ok":true,"parked":parked})) }
            CommandKind::AgentSay => {
                let text = format!("Send this message to agent {}:\n\n{}", required(command,"agentId")?, required(command,"text")?);
                self.native.send(&text, &[]).await?; Ok(json!({"ok":true}))
            }
            CommandKind::SessionClose => { append_state(&self.database, &self.session.id, "dormant", "Asleep").await?; Ok(json!({"ok":true})) },
            CommandKind::SessionCollaborationMode => Err("Claude does not support collaboration modes".into()),
            _ => Err("command is not a live Claude command".into()),
        }
    }
}

impl ProviderDriver for ClaudeDriver {
    fn brand(&self) -> &'static str { "claude" }
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> { Box::pin(async move { self.run(command).await }) }
    fn next<'a>(&'a mut self) -> DriverFuture<'a> { Box::pin(async move { self.native.next().await.map(|events| json!({"events":events.len()})) }) }
    fn reconnect<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            let config = ClaudeTransportConfig::session(&self.options);
            self.native = NativeClaudeSession::reconnect(self.database.clone(), config, self.session.clone()).await?;
            Ok(json!({"ok":true}))
        })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> { Box::pin(async move { self.native.close().await; Ok(json!({"ok":true})) }) }
}

struct CodexDriver {
    database: ChatDb,
    session: Session,
    config: CodexTransportConfig,
    options: CodexStartOptions,
    native: NativeCodexSession,
}

impl CodexDriver {
    async fn connect(database: ChatDb, session: Session, create: bool) -> Result<Self, String> {
        let executable = std::env::var_os("CODEX_PATH").map(PathBuf::from)
            .or_else(|| crate::routes::find_tool("codex", &[]))
            .ok_or_else(|| "Codex CLI is not installed. Install and sign in at https://developers.openai.com/codex/cli, then choose its path in Settings → Dependencies.".to_string())?;
        let mut options = CodexStartOptions { cwd: PathBuf::from(&session.cwd), resume: session.external_id.clone(), model: session.model.clone(), permission_mode: session.permission_mode.clone(), effort: session.effort.clone(), collaboration_mode: session.collaboration_mode.clone(), instructions: String::new() };
        let mut config = CodexTransportConfig::app_server(Path::new(&session.cwd));
        config.executable = executable;
        let native = if create {
            NativeCodexSession::start(database.clone(), config.clone(), options.clone(), session.clone()).await?
        } else {
            NativeCodexSession::reconnect(database.clone(), config.clone(), options.clone(), session.clone()).await?
        };
        let session = database.get_session(session.id.clone()).await?.unwrap_or(session);
        options.resume = session.external_id.clone();
        Ok(Self { database, session, config, options, native })
    }

    async fn run(&mut self, command: &Command) -> Result<Value, String> {
        match command.kind {
            CommandKind::PromptSend => {
                let text = required(command,"text")?;
                let id = record_user(&self.database, &self.session, text).await?;
                self.native.send(text).await?; Ok(json!({"ok":true,"messageId":id}))
            }
            CommandKind::AskAnswer => { self.native.answer(required(command,"askId")?, required(command,"optionId")?, field(command,"value")).await?; Ok(json!({"ok":true})) }
            CommandKind::QuestionAnswer => { self.native.answer_questions(required(command,"requestId")?, command.fields.get("response").unwrap_or(&Value::Null)).await?; Ok(json!({"ok":true})) }
            CommandKind::PlanRespond => {
                let response = command.fields.get("response").unwrap_or(&Value::Null);
                self.native.respond_plan(required(command,"proposalId")?, response["actionId"].as_str().unwrap_or_default(), response["feedback"].as_str()).await?; Ok(json!({"ok":true}))
            }
            CommandKind::SessionStop => { self.native.interrupt().await?; Ok(json!({"ok":true})) }
            CommandKind::SessionMode => { self.native.set_mode(required(command,"mode")?).await?; Ok(json!({"ok":true})) }
            CommandKind::SessionModel => { self.native.set_model(required(command,"model")?).await?; Ok(json!({"ok":true})) }
            CommandKind::SessionEffort => { self.native.set_effort(required(command,"effort")?).await?; Ok(json!({"ok":true})) }
            CommandKind::SessionCollaborationMode => { self.native.set_collaboration_mode(required(command,"mode")?).await?; Ok(json!({"ok":true})) }
            CommandKind::AgentStop => { self.native.stop_agent(required(command,"agentId")?).await?; Ok(json!({"ok":true})) }
            CommandKind::AgentSay => { let text = format!("Send this message to agent {}:\n\n{}", required(command,"agentId")?, required(command,"text")?); self.native.send(&text).await?; Ok(json!({"ok":true})) }
            CommandKind::AgentPark => Err("Codex does not support parking agents".into()),
            CommandKind::SessionClose => { append_state(&self.database, &self.session.id, "dormant", "Asleep").await?; Ok(json!({"ok":true})) },
            _ => Err("command is not a live Codex command".into()),
        }
    }
}

impl ProviderDriver for CodexDriver {
    fn brand(&self) -> &'static str { "codex" }
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> { Box::pin(async move { self.run(command).await }) }
    fn next<'a>(&'a mut self) -> DriverFuture<'a> { Box::pin(async move { self.native.next().await.map(|events| json!({"events":events.len()})) }) }
    fn reconnect<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            self.native = NativeCodexSession::reconnect(self.database.clone(), self.config.clone(), self.options.clone(), self.session.clone()).await?;
            Ok(json!({"ok":true}))
        })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> { Box::pin(async move { self.native.close().await; Ok(json!({"ok":true})) }) }
}
