//! Production provider factory and supervised native driver adapters.

use super::actor::ChatDb;
use super::claude::session::NativeClaudeSession;
use super::claude::transport::{ClaudeSessionOptions, ClaudeTransportConfig};
use super::codex::live::StartOptions as CodexStartOptions;
use super::codex::session::NativeCodexSession;
use super::codex::transport::CodexTransportConfig;
use super::metadata::conversation_title;
use super::protocol::{Command, CommandKind, Event};
use super::registry::{
    DriverFuture, LaunchFuture, LaunchedSession, ProviderDriver, SessionFactory,
};
use super::store::{Session, SessionPatch};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct NativeProviderFactory {
    claude_config: PathBuf,
}

impl NativeProviderFactory {
    pub fn new(claude_config: PathBuf) -> Self {
        Self { claude_config }
    }
}

fn field<'a>(command: &'a Command, name: &str) -> Option<&'a str> {
    command
        .fields
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn required<'a>(command: &'a Command, name: &str) -> Result<&'a str, String> {
    field(command, name).ok_or_else(|| format!("{name} is required"))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn new_session(
    command: &Command,
    id: String,
    external_id: Option<String>,
    claude_config: &Path,
) -> Result<Session, String> {
    let brand = required(command, "brand")?.to_string();
    if brand != "claude" && brand != "codex" {
        return Err(format!("unknown provider {brand}"));
    }
    let project_path = required(command, "projectPath")?.to_string();
    let at = field(command, "lastActiveAt")
        .map(str::to_string)
        .unwrap_or_else(now);
    let owner = (brand == "claude").then(|| {
        super::provider_defaults::read_owner_settings(claude_config, Path::new(&project_path))
    });
    Ok(Session {
        id,
        brand: brand.clone(),
        external_id,
        project_id: required(command, "projectId")?.to_string(),
        project_path: project_path.clone(),
        cwd: field(command, "cwd")
            .map(str::to_string)
            .unwrap_or(project_path),
        model: field(command, "model")
            .filter(|model| *model != "default")
            .map(str::to_string)
            .or_else(|| owner.as_ref().and_then(|settings| settings.model.clone())),
        permission_mode: field(command, "permissionMode")
            .map(str::to_string)
            .or_else(|| {
                owner
                    .as_ref()
                    .and_then(|settings| settings.permission_mode.clone())
            })
            .unwrap_or_else(|| {
                if brand == "codex" {
                    "on-request"
                } else {
                    "default"
                }
                .to_string()
            }),
        effort: field(command, "effort")
            .map(str::to_string)
            .or_else(|| owner.as_ref().and_then(|settings| settings.effort.clone())),
        collaboration_mode: field(command, "collaborationMode").map(str::to_string),
        title: field(command, "title").map(str::to_string),
        state: if command.kind == CommandKind::SessionOpen {
            "dormant"
        } else {
            "starting"
        }
        .to_string(),
        origin: if command.kind == CommandKind::SessionStart {
            "app"
        } else {
            "terminal"
        }
        .to_string(),
        created_at: at.clone(),
        last_active_at: at,
        last_spoke_at: field(command, "lastSpokeAt").map(str::to_string),
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

async fn append_state(
    database: &ChatDb,
    session_id: &str,
    state: &str,
    label: &str,
) -> Result<(), String> {
    let event: Event = serde_json::from_value(json!({
        "type":"session.state", "sessionId":session_id, "seq":0, "at":now(),
        "state":state, "label":label
    }))
    .map_err(|error| error.to_string())?;
    database.append(event).await?;
    Ok(())
}

async fn append_notice(database: &ChatDb, session_id: &str, text: &str) -> Result<(), String> {
    let event: Event = serde_json::from_value(json!({
        "type":"notice", "sessionId":session_id, "seq":0, "at":now(), "text":text
    }))
    .map_err(|error| error.to_string())?;
    database.append(event).await?;
    Ok(())
}

async fn append_reset(database: &ChatDb, session_id: &str) -> Result<(), String> {
    let event = reset_event(session_id)?;
    database.append(event).await?;
    Ok(())
}

fn reset_event(session_id: &str) -> Result<Event, String> {
    serde_json::from_value(json!({
        "type":"transcript.reset", "sessionId":session_id, "seq":0, "at":now()
    }))
    .map_err(|error| error.to_string())
}

async fn append_started(database: &ChatDb, session: &Session) -> Result<(), String> {
    let event: Event = serde_json::from_value(json!({
        "type":"session.started","sessionId":session.id,"seq":0,"at":now(),
        "brand":session.brand,"externalId":session.external_id,"model":session.model,
        "cwd":session.cwd,"permissionMode":session.permission_mode,"effort":session.effort,
        "collaborationMode":session.collaboration_mode,"readOnly":true
    }))
    .map_err(|error| error.to_string())?;
    database.append(event).await?;
    Ok(())
}

async fn append_import_menu(
    database: &ChatDb,
    session: &Session,
    provider: &str,
    value: Value,
) -> Result<(), String> {
    database
        .append(import_event(session, provider, value)?)
        .await?;
    Ok(())
}

fn import_event(session: &Session, provider: &str, mut value: Value) -> Result<Event, String> {
    let event_id =
        super::protocol::record_event_id_at(&value, super::store::import_recipe(provider));
    let object = value
        .as_object_mut()
        .ok_or_else(|| "provider menu was not an object".to_string())?;
    object.insert(
        "providerEvent".into(),
        json!({"provider":provider,"threadId":session.external_id,"eventId":event_id,"delivery":"replay"}),
    );
    object.insert("sessionId".into(), json!(session.id));
    object.insert("seq".into(), json!(0));
    object.insert("at".into(), json!(session.last_active_at));
    serde_json::from_value(value).map_err(|error| error.to_string())
}

async fn append_import_pinned(
    database: &ChatDb,
    session: &Session,
    provider: &str,
    fields: impl IntoIterator<Item = (&'static str, Value)>,
) -> Result<(), String> {
    let mut value = json!({"type":"session.pinned"});
    let object = value.as_object_mut().expect("pin is an object");
    for (field, setting) in fields {
        object.insert(field.into(), setting);
    }
    append_import_menu(database, session, provider, value).await
}

async fn import_claude_history(
    database: &ChatDb,
    config: &Path,
    session: &Session,
) -> Result<(), String> {
    let Some(external_id) = session.external_id.as_deref() else {
        return Ok(());
    };
    let Some(record) = super::claude::history::find_record(config, external_id) else {
        return Ok(());
    };
    let choice =
        super::provider_reconciliation::complete_history_choice(database, &session.id).await?;
    if choice != super::provider_reconciliation::HistoryChoice::Read {
        // Controls are useful even when the transcript is already durable.
        // Build them from the stored pins without reparsing the whole record.
        let menu = super::claude::live::ClaudeLiveState::new(
            json!({}),
            session.model.clone(),
            session.permission_mode.clone(),
            session.effort.clone(),
        )
        .menu();
        append_import_menu(database, session, "claude", menu).await?;
        if choice == super::provider_reconciliation::HistoryChoice::KeepLocal {
            database.mark_imported(session.id.clone()).await?;
            if let Ok(size) = std::fs::metadata(&record).map(|meta| meta.len() as i64) {
                database.remember_followed(session.id.clone(), size).await?;
            }
        }
        return Ok(());
    }
    // The follower resumes from where the record stood before this read. A
    // writer may append while normalization and storage run; marking the size
    // afterwards would skip those new lines permanently.
    let followed_from = std::fs::metadata(&record)
        .ok()
        .map(|meta| meta.len() as i64);
    let history = super::claude::history::read_history(&record);
    let menu = super::claude::live::ClaudeLiveState::new(
        json!({}),
        history.settings.model.clone(),
        history
            .settings
            .permission_mode
            .clone()
            .unwrap_or_else(|| "default".into()),
        history.settings.effort.clone(),
    )
    .menu();
    let reset =
        !history.events.is_empty() && database.timeline_count(session.id.clone()).await? > 0;
    database
        .update_session(
            session.id.clone(),
            SessionPatch {
                model: Some(history.settings.model.clone()),
                permission_mode: history.settings.permission_mode.clone(),
                effort: Some(history.settings.effort.clone()),
                ..SessionPatch::default()
            },
            None,
        )
        .await?;
    let mut pinned = json!({"type":"session.pinned"});
    let pinned_fields = [
        ("model", json!(history.settings.model)),
        ("effort", json!(history.settings.effort)),
    ]
    .into_iter()
    .chain(
        history
            .settings
            .permission_mode
            .clone()
            .map(|mode| ("permissionMode", json!(mode))),
    );
    pinned
        .as_object_mut()
        .expect("pin is an object")
        .extend(pinned_fields.map(|(key, value)| (key.into(), value)));
    let identified = super::claude::history::identified_replay(history.events, external_id);
    let mut imported = Vec::with_capacity(identified.len() + 3);
    imported.push(import_event(session, "claude", menu)?);
    if reset {
        imported.push(reset_event(&session.id)?);
    }
    imported.push(import_event(session, "claude", pinned)?);
    for mut value in identified {
        let Some(object) = value.as_object_mut() else {
            continue;
        };
        object.insert("sessionId".into(), json!(session.id));
        object.insert("seq".into(), json!(0));
        object
            .entry("at")
            .or_insert_with(|| json!(session.last_active_at));
        imported.push(serde_json::from_value(value).map_err(|error| error.to_string())?);
    }
    database.append_many(imported).await?;
    if let Some(at) = followed_from {
        database.remember_followed(session.id.clone(), at).await?;
    }
    Ok(())
}

async fn import_codex_history(database: &ChatDb, session: &Session) -> Result<(), String> {
    let Some(external_id) = session.external_id.as_deref() else {
        return Ok(());
    };
    let choice =
        super::provider_reconciliation::complete_history_choice(database, &session.id).await?;
    let mut config = CodexTransportConfig::app_server(Path::new(&session.cwd));
    if let Some(executable) = crate::routes::find_tool("codex", &[]) {
        config.executable = executable;
    }
    let transport = super::codex::transport::CodexTransport::start(config)
        .await
        .map_err(|error| error.to_string())?;
    let (thread, mut menu) = if choice == super::provider_reconciliation::HistoryChoice::Read {
        let (thread, menu) = tokio::join!(
            super::codex::history::read_thread(&transport, external_id),
            super::codex::history::menu(
                &transport,
                Path::new(&session.cwd),
                session.model.as_deref()
            ),
        );
        (Some(thread), menu)
    } else {
        (
            None,
            super::codex::history::menu(
                &transport,
                Path::new(&session.cwd),
                session.model.as_deref(),
            )
            .await,
        )
    };
    transport.close().await;
    if let Some(object) = menu.as_object_mut() {
        object.remove("skillPaths");
        object.remove("collaborationPresets");
        object.remove("defaultEffort");
        object.insert("type".into(), json!("session.menu"));
    }
    append_import_menu(database, session, "codex", menu).await?;
    if choice == super::provider_reconciliation::HistoryChoice::Leave {
        return Ok(());
    }
    if choice == super::provider_reconciliation::HistoryChoice::KeepLocal {
        database.mark_imported(session.id.clone()).await?;
        return Ok(());
    }
    let thread = thread
        .expect("read choice has a thread")
        .map_err(|error| error.to_string())?;
    // `thread/read` omits the settings that owned the latest turn. The rollout
    // is their durable source, just as it was in the final Node implementation.
    // Reading only its bounded tail keeps a large external chat off the open
    // path while restoring the exact model, approval and collaboration pins.
    let settings = super::codex::history::thread_settings(thread["path"].as_str().map(Path::new));
    database
        .update_session(
            session.id.clone(),
            SessionPatch {
                model: Some(Some(settings.model.clone())),
                permission_mode: Some(settings.permission_mode.clone()),
                collaboration_mode: Some(settings.collaboration_mode.clone()),
                ..SessionPatch::default()
            },
            None,
        )
        .await?;
    append_import_pinned(
        database,
        session,
        "codex",
        [
            ("model", json!(settings.model)),
            ("permissionMode", json!(settings.permission_mode)),
            ("collaborationMode", json!(settings.collaboration_mode)),
        ],
    )
    .await?;
    let mut normalizer = super::codex::normalize::CodexNormalizer::default();
    let replay = normalizer.replay_thread(&thread);
    if !replay.is_empty() && database.timeline_count(session.id.clone()).await? > 0 {
        append_reset(database, &session.id).await?;
    }
    let mut imported = Vec::with_capacity(replay.len());
    for mut value in replay {
        let event_id = super::protocol::record_event_id(&value);
        let Some(object) = value.as_object_mut() else {
            continue;
        };
        object.insert("providerEvent".into(),json!({"provider":"codex","threadId":external_id,"eventId":event_id,"delivery":"replay"}));
        object.insert("sessionId".into(), json!(session.id));
        object.insert("seq".into(), json!(0));
        object
            .entry("at")
            .or_insert_with(|| json!(session.last_active_at));
        imported.push(serde_json::from_value(value).map_err(|error| error.to_string())?);
    }
    database.append_many(imported).await?;
    if let Some(path) = thread["path"].as_str() {
        if let Ok(size) = std::fs::metadata(path).map(|meta| meta.len() as i64) {
            database.remember_followed(session.id.clone(), size).await?;
        }
    } else {
        database.mark_imported(session.id.clone()).await?;
    }
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
                        database
                            .update_session(
                                session.id.clone(),
                                SessionPatch {
                                    state: Some("dormant".into()),
                                    ..SessionPatch::default()
                                },
                                None,
                            )
                            .await?;
                        append_state(&database, &session.id, "dormant", "Asleep").await?;
                        session
                    }
                    None => {
                        let id = field(command, "sessionId")
                            .map(str::to_string)
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let session = new_session(
                            command,
                            id,
                            field(command, "externalId").map(str::to_string),
                            &self.claude_config,
                        )?;
                        database.create_session(session.clone()).await?;
                        append_state(&database, &session.id, "dormant", "Asleep").await?;
                        session
                    }
                };
                append_started(&database, &session).await?;
                // Opening is a read-only UI operation. Return immediately and
                // stream the one-time import into the event log; awaiting file
                // parsing or a Codex app-server here regresses open latency.
                let import_db = database.clone();
                let import_session = session.clone();
                let claude_config = self.claude_config.clone();
                tokio::spawn(async move {
                    if import_session.brand == "claude" {
                        let _ = import_claude_history(&import_db, &claude_config, &import_session)
                            .await;
                    } else if import_session.brand == "codex" {
                        let _ = import_codex_history(&import_db, &import_session).await;
                    }
                });
                return Ok(LaunchedSession {
                    session_id: session.id.clone(),
                    reply: reply(&session)?,
                    driver: None,
                });
            }

            let (session, create) = match found {
                Some(mut session) => {
                    session.state = "starting".into();
                    (session, false)
                }
                None => {
                    let id = field(command, "sessionId")
                        .map(str::to_string)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    (
                        new_session(
                            command,
                            id,
                            field(command, "externalId").map(str::to_string),
                            &self.claude_config,
                        )?,
                        true,
                    )
                }
            };
            let brand = session.brand.clone();
            let mut driver: Box<dyn ProviderDriver> = match brand.as_str() {
                "claude" => Box::new(
                    ClaudeDriver::connect(database.clone(), session.clone(), create).await?,
                ),
                "codex" => {
                    Box::new(CodexDriver::connect(database.clone(), session.clone(), create).await?)
                }
                _ => return Err(format!("unknown provider {brand}")),
            };
            if !create {
                append_notice(&database, &session.id, "Continuing this chat.").await?;
            }
            let stored = database
                .get_session(session.id.clone())
                .await?
                .unwrap_or(session);
            if let Some(brief) = command
                .fields
                .get("brief")
                .filter(|brief| brief.is_object())
            {
                if let Some(bead_id) = brief["beadId"].as_str() {
                    let linked: Event = serde_json::from_value(json!({"type":"link.bead","sessionId":stored.id,"seq":0,"at":now(),"beadId":bead_id,"via":"brief"})).map_err(|error|error.to_string())?;
                    database.append(linked).await?;
                }
                if let Some(text) = brief["text"].as_str().filter(|text| !text.is_empty()) {
                    let prompt = Command {
                        kind: CommandKind::PromptSend,
                        fields: serde_json::Map::from_iter([
                            ("sessionId".into(), json!(stored.id)),
                            ("text".into(), json!(text)),
                        ]),
                    };
                    driver.command(&prompt).await?;
                }
            }
            Ok(LaunchedSession {
                session_id: stored.id.clone(),
                reply: reply(&stored)?,
                driver: Some(driver),
            })
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
        database
            .update_session(
                session.id.clone(),
                SessionPatch {
                    title: Some(conversation_title(text)),
                    ..SessionPatch::default()
                },
                Some(at.clone()),
            )
            .await?;
    }
    database.mark_spoke(session.id.clone(), at).await?;
    Ok(id)
}

struct ClaudeDriver {
    database: ChatDb,
    session: Session,
    native: NativeClaudeSession,
}

impl ClaudeDriver {
    async fn connect(database: ChatDb, session: Session, create: bool) -> Result<Self, String> {
        let executable = std::env::var_os("CLAUDE_PATH").map(PathBuf::from)
            .or_else(|| crate::routes::find_tool("claude", &[]))
            .ok_or_else(|| "Claude Code is not installed. Install and sign in at https://docs.anthropic.com/en/docs/claude-code, then choose its path in Settings → Dependencies.".to_string())?;
        let instructions = super::session_policy::build(Path::new(&session.cwd))?;
        let mut options = ClaudeSessionOptions {
            cwd: PathBuf::from(&session.cwd),
            resume: session.external_id.clone(),
            model: session.model.clone(),
            permission_mode: Some(session.permission_mode.clone()),
            effort: session.effort.clone(),
            instructions,
        };
        let mut config = ClaudeTransportConfig::session(&options);
        config.executable = executable;
        let native = if create {
            NativeClaudeSession::start(database.clone(), config, session.clone()).await?
        } else {
            NativeClaudeSession::reconnect(database.clone(), config, session.clone()).await?
        };
        let session = database
            .get_session(session.id.clone())
            .await?
            .unwrap_or(session);
        options.resume = session.external_id.clone();
        Ok(Self {
            database,
            session,
            native,
        })
    }

    async fn run(&mut self, command: &Command) -> Result<Value, String> {
        match command.kind {
            CommandKind::PromptSend => {
                let text = required(command, "text")?;
                self.native.validate_prompt(text)?;
                let id = record_user(&self.database, &self.session, text).await?;
                let images = command
                    .fields
                    .get("images")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.native.send(text, &images).await?;
                Ok(json!({"ok":true,"messageId":id}))
            }
            CommandKind::AskAnswer => {
                self.native
                    .answer_permission(required(command, "askId")?, required(command, "optionId")?)
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::QuestionAnswer => {
                self.native
                    .answer_questions(
                        required(command, "requestId")?,
                        command.fields.get("response").unwrap_or(&Value::Null),
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::PlanRespond => {
                let response = command.fields.get("response").unwrap_or(&Value::Null);
                self.native
                    .respond_plan(
                        required(command, "proposalId")?,
                        response["actionId"].as_str().unwrap_or_default(),
                        response["feedback"].as_str(),
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionStop => {
                self.native.interrupt().await?;
                if let Some(message_id) = field(command, "retractMessageId") {
                    self.database.append(serde_json::from_value(json!({
                        "type":"message.retracted","sessionId":self.session.id,"seq":0,"at":now(),
                        "messageId":message_id
                    })).map_err(|error|error.to_string())?).await?;
                }
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionMode => {
                self.native.set_mode(required(command, "mode")?).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionModel => {
                self.native.set_model(required(command, "model")?).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionEffort => {
                self.native.set_effort(required(command, "effort")?).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::AgentStop => {
                self.native
                    .stop_agent(required(command, "agentId")?)
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::AgentPark => {
                let parked = self
                    .native
                    .park_agent(required(command, "agentId")?)
                    .await?;
                Ok(json!({"ok":true,"parked":parked}))
            }
            CommandKind::AgentSay => {
                let agent_id = required(command, "agentId")?;
                let relayed = required(command, "text")?;
                let text = format!(
                    "A message for the agent you sent off (id {agent_id}), from the person watching this chat. It could not be handed to it directly, so it comes to you:\n\n{relayed}"
                );
                self.native.send(&text, &[]).await?;
                self.database
                    .append(
                        serde_json::from_value(json!({
                            "type":"agent.relayed","sessionId":self.session.id,"seq":0,"at":now(),
                            "agentId":agent_id,"text":relayed
                        }))
                        .map_err(|error| error.to_string())?,
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionClose => {
                append_state(&self.database, &self.session.id, "dormant", "Asleep").await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionCollaborationMode => {
                Err("Claude does not support collaboration modes".into())
            }
            _ => Err("command is not a live Claude command".into()),
        }
    }
}

impl ProviderDriver for ClaudeDriver {
    fn brand(&self) -> &'static str {
        "claude"
    }
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
        Box::pin(async move { self.run(command).await })
    }
    fn next<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            self.native
                .next()
                .await
                .map(|events| json!({"events":events.len()}))
        })
    }
    fn window_now<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move { self.native.window_now().await })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            self.native.close().await;
            Ok(json!({"ok":true}))
        })
    }
}

struct CodexDriver {
    database: ChatDb,
    session: Session,
    native: NativeCodexSession,
}

impl CodexDriver {
    async fn connect(database: ChatDb, session: Session, create: bool) -> Result<Self, String> {
        let executable = std::env::var_os("CODEX_PATH").map(PathBuf::from)
            .or_else(|| crate::routes::find_tool("codex", &[]))
            .ok_or_else(|| "Codex CLI is not installed. Install and sign in at https://developers.openai.com/codex/cli, then choose its path in Settings → Dependencies.".to_string())?;
        let instructions = super::session_policy::build(Path::new(&session.cwd))?;
        let mut options = CodexStartOptions {
            cwd: PathBuf::from(&session.cwd),
            resume: session.external_id.clone(),
            model: session.model.clone(),
            permission_mode: session.permission_mode.clone(),
            effort: session.effort.clone(),
            collaboration_mode: session.collaboration_mode.clone(),
            instructions,
        };
        let mut config = CodexTransportConfig::app_server(Path::new(&session.cwd));
        config.executable = executable;
        let native = if create {
            NativeCodexSession::start(
                database.clone(),
                config.clone(),
                options.clone(),
                session.clone(),
            )
            .await?
        } else {
            NativeCodexSession::reconnect(
                database.clone(),
                config.clone(),
                options.clone(),
                session.clone(),
            )
            .await?
        };
        let session = database
            .get_session(session.id.clone())
            .await?
            .unwrap_or(session);
        options.resume = session.external_id.clone();
        Ok(Self {
            database,
            session,
            native,
        })
    }

    async fn run(&mut self, command: &Command) -> Result<Value, String> {
        match command.kind {
            CommandKind::PromptSend => {
                let text = required(command, "text")?;
                self.native.validate_prompt(text)?;
                let id = record_user(&self.database, &self.session, text).await?;
                let images = command
                    .fields
                    .get("images")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.native.send(text, &images).await?;
                Ok(json!({"ok":true,"messageId":id}))
            }
            CommandKind::AskAnswer => {
                self.native
                    .answer(
                        required(command, "askId")?,
                        required(command, "optionId")?,
                        field(command, "value"),
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::QuestionAnswer => {
                self.native
                    .answer_questions(
                        required(command, "requestId")?,
                        command.fields.get("response").unwrap_or(&Value::Null),
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::PlanRespond => {
                let response = command.fields.get("response").unwrap_or(&Value::Null);
                self.native
                    .respond_plan(
                        required(command, "proposalId")?,
                        response["actionId"].as_str().unwrap_or_default(),
                        response["feedback"].as_str(),
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionStop => {
                self.native.interrupt().await?;
                if let Some(message_id) = field(command, "retractMessageId") {
                    self.database.append(serde_json::from_value(json!({
                        "type":"message.retracted","sessionId":self.session.id,"seq":0,"at":now(),
                        "messageId":message_id
                    })).map_err(|error|error.to_string())?).await?;
                }
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionMode => {
                self.native.set_mode(required(command, "mode")?).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionModel => {
                self.native.set_model(required(command, "model")?).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionEffort => {
                self.native.set_effort(required(command, "effort")?).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionCollaborationMode => {
                self.native
                    .set_collaboration_mode(required(command, "mode")?)
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::AgentStop => {
                self.native
                    .stop_agent(required(command, "agentId")?)
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::AgentSay => {
                let agent_id = required(command, "agentId")?;
                let relayed = required(command, "text")?;
                let text = format!(
                    "A message for the agent you sent off (id {agent_id}), from the person watching this chat. It could not be handed to it directly, so it comes to you:\n\n{relayed}"
                );
                self.native.send(&text, &[]).await?;
                self.database
                    .append(
                        serde_json::from_value(json!({
                            "type":"agent.relayed","sessionId":self.session.id,"seq":0,"at":now(),
                            "agentId":agent_id,"text":relayed
                        }))
                        .map_err(|error| error.to_string())?,
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::AgentPark => Err("Codex does not support parking agents".into()),
            CommandKind::SessionClose => {
                append_state(&self.database, &self.session.id, "dormant", "Asleep").await?;
                Ok(json!({"ok":true}))
            }
            _ => Err("command is not a live Codex command".into()),
        }
    }
}

impl ProviderDriver for CodexDriver {
    fn brand(&self) -> &'static str {
        "codex"
    }
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
        Box::pin(async move { self.run(command).await })
    }
    fn next<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            self.native
                .next()
                .await
                .map(|events| json!({"events":events.len()}))
        })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            self.native.close().await;
            Ok(json!({"ok":true}))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_session_keeps_provider_human_clock_separate_from_activity() {
        let command: Command = serde_json::from_value(json!({
            "type":"session.open", "brand":"codex", "projectId":"p1",
            "projectPath":"/project", "externalId":"thread-1",
            "lastActiveAt":"2026-09-01T09:50:00Z",
            "lastSpokeAt":"2026-08-30T22:05:00Z"
        }))
        .unwrap();
        let session = new_session(
            &command,
            "chat-1".into(),
            Some("thread-1".into()),
            Path::new("/unused"),
        )
        .unwrap();

        assert_eq!(session.last_active_at, "2026-09-01T09:50:00Z");
        assert_eq!(
            session.last_spoke_at.as_deref(),
            Some("2026-08-30T22:05:00Z")
        );
    }

    fn imported_session() -> Session {
        Session {
            id: "chat-1".into(),
            brand: "codex".into(),
            external_id: Some("thread-1".into()),
            project_id: "project-1".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: Some("gpt-5".into()),
            permission_mode: "on-request".into(),
            effort: Some("high".into()),
            collaboration_mode: None,
            title: Some("Imported chat".into()),
            state: "idle".into(),
            origin: "terminal".into(),
            created_at: "2026-08-31T00:00:00Z".into(),
            last_active_at: "2026-08-31T00:00:00Z".into(),
            last_spoke_at: None,
        }
    }

    #[tokio::test]
    async fn imported_menu_is_durable_deduplicated_and_refreshable() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let session = imported_session();
        database.create_session(session.clone()).await.unwrap();
        let menu = json!({
            "type": "session.menu",
            "models": [{"id": "gpt-5", "label": "GPT-5"}],
            "permissionModes": [{"id": "on-request", "label": "Ask"}],
            "efforts": [{"id": "high", "label": "High"}]
        });

        append_import_menu(&database, &session, "codex", menu.clone())
            .await
            .unwrap();
        append_import_menu(&database, &session, "codex", menu)
            .await
            .unwrap();
        assert_eq!(
            database
                .events_since(session.id.clone(), 0)
                .await
                .unwrap()
                .len(),
            1
        );

        append_import_menu(
            &database,
            &session,
            "codex",
            json!({
                "type": "session.menu",
                "models": [{"id": "gpt-6", "label": "GPT-6"}]
            }),
        )
        .await
        .unwrap();
        let events = database.events_since(session.id, 0).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].fields["models"][0]["id"], "gpt-6");
    }

    #[tokio::test]
    async fn imported_settings_are_durable_visible_and_deduplicated() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let session = imported_session();
        database.create_session(session.clone()).await.unwrap();
        let settings = [
            ("model", json!("gpt-5.4")),
            ("permissionMode", json!("never")),
            ("collaborationMode", json!("plan")),
        ];

        append_import_pinned(&database, &session, "codex", settings.clone())
            .await
            .unwrap();
        append_import_pinned(&database, &session, "codex", settings)
            .await
            .unwrap();

        let events = database.events_since(session.id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            super::super::protocol::EventKind::SessionPinned
        );
        assert_eq!(events[0].fields["model"], "gpt-5.4");
        assert_eq!(events[0].fields["permissionMode"], "never");
        assert_eq!(events[0].fields["collaborationMode"], "plan");
        let view = super::super::projection::fold_all(&events).view;
        assert_eq!(view["model"], "gpt-5.4");
        assert_eq!(view["permissionMode"], "never");
        assert_eq!(view["collaborationMode"], "plan");
    }
}
