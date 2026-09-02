//! Production provider factory and supervised native driver adapters.

use super::actor::ChatDb;
use super::codex::transport::CodexTransportConfig;
use super::metadata::conversation_title;
use super::protocol::{Command, CommandKind, Event};
use super::registry::{LaunchFuture, LaunchedSession, ProviderDriver, SessionFactory};
use super::store::{Session, SessionPatch};
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Clone)]
pub struct NativeProviderFactory {
    claude_config: PathBuf,
    imports: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl NativeProviderFactory {
    pub fn new(claude_config: PathBuf) -> Self {
        Self {
            claude_config,
            imports: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn schedule_import(&self, database: ChatDb, session: Session) {
        let mut imports = self.imports.lock().await;
        if imports
            .get(&session.id)
            .is_some_and(|task| !task.is_finished())
        {
            return;
        }
        imports.remove(&session.id);
        let session_id = session.id.clone();
        let claude_config = self.claude_config.clone();
        imports.insert(
            session_id,
            tokio::spawn(async move {
                if session.brand == "claude" {
                    let _ = import_claude_history(&database, &claude_config, &session).await;
                } else if session.brand == "codex" {
                    let _ = import_codex_history(&database, &session).await;
                } else if session.brand == super::local::BRAND {
                    let models = json!(super::local::catalog().await);
                    if let Ok(menu) = database.steering_menu(session.id.clone()).await {
                        if let Some(event) = refreshed_local_menu(menu, &session.id, models) {
                            let _ = database.append(event).await;
                        }
                    }
                }
            }),
        );
    }

    /// A live provider must never race the detached cold-read reconciliation.
    /// Joining here keeps transcript.reset/import batches strictly before the
    /// first new prompt and lets the live driver become the sole event source.
    async fn finish_import(&self, session_id: &str) {
        let task = self.imports.lock().await.remove(session_id);
        if let Some(task) = task {
            let _ = task.await;
        }
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

fn refreshed_local_menu(mut menu: Value, session_id: &str, models: Value) -> Option<Event> {
    if models.as_array().is_none_or(|models| models.is_empty()) || menu["models"] == models {
        return None;
    }
    menu["models"] = models;
    menu["type"] = json!("session.menu");
    menu["sessionId"] = json!(session_id);
    menu["seq"] = json!(0);
    menu["at"] = json!(now());
    serde_json::from_value(menu).ok()
}

fn new_session(
    command: &Command,
    id: String,
    external_id: Option<String>,
    claude_config: &Path,
) -> Result<Session, String> {
    let brand = required(command, "brand")?.to_string();
    if brand != "claude" && brand != "codex" && brand != super::local::BRAND {
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
                if brand == "codex" || brand == super::local::BRAND {
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

pub(super) async fn append_started(
    database: &ChatDb,
    session: &Session,
    read_only: bool,
) -> Result<(), String> {
    let event: Event = serde_json::from_value(json!({
        "type":"session.started","sessionId":session.id,"seq":0,"at":now(),
        "brand":session.brand,"externalId":session.external_id,"model":session.model,
        "cwd":session.cwd,"permissionMode":session.permission_mode,"effort":session.effort,
        "collaborationMode":session.collaboration_mode,"readOnly":read_only
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

fn claude_import_menu(session: &Session) -> Value {
    let model = session.model.as_deref().unwrap_or("default");
    json!({
        "type":"session.menu",
        "commands":[],
        "skills":[],
        "models":[{
            "value":model,
            "displayName":model,
            "description":"Saved session selection; the live provider catalog loads when the chat resumes.",
            "group":"session"
        }],
        "permissionModes":["default","acceptEdits","bypassPermissions","plan","dontAsk","auto"],
        "efforts":session.effort.as_ref().map(|effort| vec![json!({
            "value":effort,
            "displayName":effort
        })]).unwrap_or_default(),
        "agentDefinitions":[],
        "agentControls":["stop","park","say"]
    })
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
        let menu = claude_import_menu(session);
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
    let mut historical_session = session.clone();
    historical_session.model = history.settings.model.clone();
    historical_session.effort = history.settings.effort.clone();
    let menu = claude_import_menu(&historical_session);
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
    database.append_replay(imported).await?;
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
        let event_id = super::protocol::provider_record_event_id("codex", &value);
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
    database.append_replay(imported).await?;
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
                append_started(&database, &session, true).await?;
                // Opening is a read-only UI operation. Return immediately and
                // stream the one-time import into the event log; awaiting file
                // parsing or a Codex app-server here regresses open latency.
                self.schedule_import(database.clone(), session.clone())
                    .await;
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
            if !create {
                self.finish_import(&session.id).await;
            }
            let brand = session.brand.clone();
            if create && brand == super::local::BRAND && session.model.is_none() {
                database.create_session(session.clone()).await?;
                append_started(&database, &session, false).await?;
                let models = super::local::catalog().await;
                let menu: Event = serde_json::from_value(json!({
                    "type":"session.menu", "sessionId":session.id, "seq":0, "at":now(),
                    "commands":[], "skills":[], "agentDefinitions":[], "agentControls":[],
                    "permissionModes":["on-request","never"], "currentMode":"on-request",
                    "models":models, "currentModel":Value::Null, "efforts":[],
                    "currentEffort":Value::Null, "collaborationModes":[],
                    "currentCollaborationMode":Value::Null, "configOptions":[], "transport":"acp"
                }))
                .map_err(|error| error.to_string())?;
                database.append(menu).await?;
                if let Some(bead_id) = command
                    .fields
                    .get("brief")
                    .and_then(|brief| brief["beadId"].as_str())
                {
                    let linked: Event = serde_json::from_value(json!({
                        "type":"link.bead", "sessionId":session.id, "seq":0, "at":now(),
                        "beadId":bead_id, "via":"brief"
                    }))
                    .map_err(|error| error.to_string())?;
                    database.append(linked).await?;
                }
                append_state(&database, &session.id, "idle", "Choose a model").await?;
                let stored = database
                    .get_session(session.id.clone())
                    .await?
                    .unwrap_or(session);
                return Ok(LaunchedSession {
                    session_id: stored.id.clone(),
                    reply: reply(&stored)?,
                    driver: None,
                });
            }
            let mut driver: Box<dyn ProviderDriver> = match brand.as_str() {
                "claude" | "codex" | super::local::BRAND => Box::new(
                    super::acp::client::AcpDriver::connect(
                        database.clone(),
                        session.clone(),
                        create,
                    )
                    .await?,
                ),
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

pub(super) async fn record_user_for_transport(
    database: &ChatDb,
    session: &Session,
    text: &str,
    images: &[Value],
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let at = now();
    let mut values = vec![
        json!({"type":"message.started","sessionId":session.id,"seq":0,"at":at,"messageId":id,"role":"user"}),
    ];
    values.extend(images.iter().map(|image| {
        json!({
            "type":"image", "sessionId":session.id, "seq":0, "at":at,
            "messageId":id, "image":image
        })
    }));
    values.extend([
        json!({"type":"text.delta","sessionId":session.id,"seq":0,"at":at,"messageId":id,"text":text}),
        json!({"type":"message.completed","sessionId":session.id,"seq":0,"at":at,"messageId":id}),
    ]);
    for value in values {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn locally_sent_images_are_durable_parts_of_the_user_turn() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let session = Session {
            id: "chat-1".into(),
            brand: "codex".into(),
            external_id: Some("thread-1".into()),
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: None,
            permission_mode: "on-request".into(),
            effort: None,
            collaboration_mode: None,
            title: Some("Images".into()),
            state: "idle".into(),
            origin: "app".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            last_active_at: "2026-09-02T00:00:00Z".into(),
            last_spoke_at: None,
        };
        database.create_session(session.clone()).await.unwrap();
        record_user_for_transport(
            &database,
            &session,
            "What is shown?",
            &[json!({"mimeType":"image/png","data":"aGVsbG8="})],
        )
        .await
        .unwrap();

        let events = database.events_since("chat-1".into(), 0).await.unwrap();
        let image = events
            .iter()
            .find(|event| event.kind == crate::workbench::protocol::EventKind::Image)
            .expect("the attachment is part of the durable transcript");
        assert_eq!(image.fields["image"]["mimeType"], "image/png");
        assert_eq!(image.fields["image"]["data"], "aGVsbG8=");
        assert_eq!(
            image.fields["messageId"],
            events
                .iter()
                .find(|event| event.kind == crate::workbench::protocol::EventKind::MessageStarted)
                .unwrap()
                .fields["messageId"]
        );
    }

    #[tokio::test]
    async fn live_attach_waits_for_cold_history_reconciliation() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let factory = NativeProviderFactory::new(PathBuf::from("/unused"));
        let completed = Arc::new(AtomicBool::new(false));
        let task_completed = completed.clone();
        factory.imports.lock().await.insert(
            "chat-1".into(),
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                task_completed.store(true, Ordering::SeqCst);
            }),
        );

        factory.finish_import("chat-1").await;

        assert!(completed.load(Ordering::SeqCst));
        assert!(!factory.imports.lock().await.contains_key("chat-1"));
    }

    #[test]
    fn a_reopened_local_chat_refreshes_only_a_changed_nonempty_catalog() {
        let menu = json!({
            "models":[{"value":"ollama::old","displayName":"old"}],
            "permissionModes":["on-request"], "currentMode":"on-request",
            "commands":[], "skills":[], "agentDefinitions":[], "agentControls":[],
            "efforts":[], "collaborationModes":[], "configOptions":[]
        });
        assert!(refreshed_local_menu(menu.clone(), "local-1", json!([])).is_none());
        assert!(refreshed_local_menu(menu.clone(), "local-1", menu["models"].clone()).is_none());
        let event = refreshed_local_menu(
            menu,
            "local-1",
            json!([{"value":"ollama::new","displayName":"new"}]),
        )
        .unwrap();
        assert_eq!(event.fields["models"][0]["value"], "ollama::new");
    }

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

    #[test]
    fn archived_claude_menu_keeps_saved_selectors_without_a_catalog_guess() {
        let mut session = imported_session();
        session.brand = "claude".into();
        session.model = Some("provider-model".into());
        session.effort = Some("provider-effort".into());
        let menu = claude_import_menu(&session);
        assert_eq!(menu["models"][0]["value"], "provider-model");
        assert_eq!(menu["efforts"][0]["value"], "provider-effort");
        assert_eq!(menu["permissionModes"][0], "default");

        session.model = None;
        assert_eq!(
            claude_import_menu(&session)["models"][0]["value"],
            "default"
        );
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
