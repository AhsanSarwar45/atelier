//! Supervised ACP client driver backed by the official Rust SDK.

use super::adapter;
use super::client_io::ClientIo;
use super::normalize::AcpNormalizer;
use crate::workbench::actor::ChatDb;
use crate::workbench::protocol::{Command, CommandKind, Event};
use crate::workbench::registry::{DriverFuture, ProviderDriver};
use crate::workbench::session_policy;
use crate::workbench::store::{Session, SessionPatch};
use agent_client_protocol::schema::v1::{
    CancelNotification, CloseSessionRequest, ContentBlock, CreateElicitationRequest,
    CreateElicitationResponse, CreateTerminalRequest, ElicitationMode, ImageContent,
    KillTerminalRequest, ListSessionsRequest, LoadSessionRequest, Meta, NewSessionRequest,
    PromptRequest, ReadTextFileRequest, ReleaseTerminalRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, ResumeSessionRequest,
    SelectedPermissionOutcome, SessionConfigOptionValue, SetSessionConfigOptionRequest,
    SetSessionModeRequest, TerminalOutputRequest, TextContent, WaitForTerminalExitRequest,
    WriteTextFileRequest,
};
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo, UntypedMessage};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

type Reply = oneshot::Sender<Result<Value, String>>;

const MAX_SESSION_LIST_PAGES: usize = 100;

/// Provider-neutral metadata returned by ACP `session/list`.
///
/// This is deliberately the only discovery shape the workbench consumes. An
/// adapter's `_meta` remains intact for future standardized or extension
/// fields; no Claude/Codex knowledge belongs in the discovery layer.
#[derive(Clone, Debug, PartialEq)]
pub struct ListedSession {
    pub session_id: String,
    pub cwd: PathBuf,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub meta: Value,
}

fn initialize_request() -> Result<UntypedMessage, agent_client_protocol::Error> {
    UntypedMessage::new(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientInfo": {
                "name":"atelier", "title":"Atelier",
                "version":env!("CARGO_PKG_VERSION")
            },
            "clientCapabilities": {
                "fs": {"readTextFile":true,"writeTextFile":true},
                "terminal": true,
                "subagents": {},
                "plan": {},
                "elicitation": {"form":{},"url":{}},
                "session": {"configOptions":{"boolean":{}}},
                "_meta": {
                    "subagent-transcript": true,
                    "jetbrains": {"air": {"version":1,"capabilities":["nativeSubagentSessions"]}}
                }
            }
        }),
    )
}

/// Enumerate every session an ACP agent knows, following its opaque cursors.
/// A caller may fall back to legacy discovery only when this returns an error
/// (adapter unavailable, capability absent, authentication, or bad peer).
pub async fn list_sessions(brand: &str, cwd: Option<&Path>) -> Result<Vec<ListedSession>, String> {
    let config = adapter::launch_config(brand, None)
        .ok_or_else(|| format!("bundled {brand} ACP adapter is incomplete or unavailable"))?;
    let filter = cwd.map(Path::to_path_buf);
    let client = agent_client_protocol::Client.builder();
    client
        .connect_with(
            AcpAgent::new(config),
            async move |connection: ConnectionTo<Agent>| {
                let initialized = connection
                    .send_request(initialize_request()?)
                    .block_task()
                    .await?;
                if initialized
                    .pointer("/agentCapabilities/sessionCapabilities/list")
                    .is_none()
                {
                    return Err(acp_error("agent does not advertise session/list"));
                }

                let mut listed = Vec::new();
                let mut cursor: Option<String> = None;
                let mut seen = HashSet::new();
                for _ in 0..MAX_SESSION_LIST_PAGES {
                    let response = connection
                        .send_request(
                            ListSessionsRequest::new()
                                .cwd(filter.clone())
                                .cursor(cursor.clone()),
                        )
                        .block_task()
                        .await?;
                    listed.extend(response.sessions.into_iter().map(|session| ListedSession {
                        session_id: session.session_id.to_string(),
                        cwd: session.cwd,
                        title: session.title,
                        updated_at: session.updated_at,
                        meta: serde_json::to_value(session.meta).unwrap_or(Value::Null),
                    }));
                    let Some(next) = response.next_cursor else {
                        return Ok(listed);
                    };
                    if !seen.insert(next.clone()) {
                        return Err(acp_error("agent repeated a session/list cursor"));
                    }
                    cursor = Some(next);
                }
                Err(acp_error(
                    "agent exceeded the session/list page safety bound",
                ))
            },
        )
        .await
        .map_err(|error| error.to_string())
}

fn replay_delivery(event: Event) -> Event {
    let mut value = serde_json::to_value(event).expect("canonical ACP event serializes");
    if let Some(provider) = value["providerEvent"].as_object_mut() {
        provider.insert("delivery".into(), json!("replay"));
    }
    serde_json::from_value(value).expect("delivery does not change the event shape")
}

/// Load a saved provider session through ACP and materialize the replay through
/// the same normalizer used for live `session/update` notifications.
pub async fn load_history(database: &ChatDb, session: &Session) -> Result<(), String> {
    match super::super::provider_reconciliation::complete_history_choice(database, &session.id)
        .await?
    {
        super::super::provider_reconciliation::HistoryChoice::Leave => return Ok(()),
        super::super::provider_reconciliation::HistoryChoice::KeepLocal => {
            database.mark_imported(session.id.clone()).await?;
            return Ok(());
        }
        super::super::provider_reconciliation::HistoryChoice::Read => {}
    }
    let remote_id = session
        .external_id
        .clone()
        .ok_or_else(|| "saved session has no provider id".to_string())?;
    let config =
        adapter::launch_config(&session.brand, session.model.as_deref()).ok_or_else(|| {
            format!(
                "bundled {} ACP adapter is incomplete or unavailable",
                session.brand
            )
        })?;
    let policy = session_policy::build(Path::new(&session.cwd))?;
    let meta = session_meta(&session.brand, &policy);
    let local_id = session.id.clone();
    let brand = session.brand.clone();
    let cwd = PathBuf::from(&session.cwd);
    let normalizer = Arc::new(Mutex::new(AcpNormalizer::new(cwd.clone())));
    let collected = Arc::new(Mutex::new(Vec::<Event>::new()));
    let update_normalizer = normalizer.clone();
    let update_events = collected.clone();
    let update_session = local_id.clone();
    let update_brand = brand.clone();
    let client = agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: UntypedMessage, _connection| {
                if notification.method() != "session/update" {
                    return Ok(());
                }
                let raw = notification.params().clone();
                let events = update_normalizer
                    .lock()
                    .await
                    .update(&update_session, &update_brand, &raw)
                    .into_iter()
                    .map(replay_delivery);
                update_events.lock().await.extend(events);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        );
    let finish_normalizer = normalizer.clone();
    let finish_events = collected.clone();
    let finish_session = local_id.clone();
    let finish_brand = brand.clone();
    let (modes, config_options, agent_controls) = client
        .connect_with(
            AcpAgent::new(config),
            async move |connection: ConnectionTo<Agent>| {
                let initialized = connection
                    .send_request(initialize_request()?)
                    .block_task()
                    .await?;
                if initialized.pointer("/agentCapabilities/loadSession") != Some(&Value::Bool(true))
                {
                    return Err(acp_error("agent does not advertise session/load"));
                }
                let agent_controls = initialized
                    .pointer("/_meta/atelier/subagentControls")
                    .filter(|controls| controls.is_array())
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let response = connection
                    .send_request(LoadSessionRequest::new(remote_id.clone(), cwd).meta(meta))
                    .block_task()
                    .await?;
                let end = json!({"sessionId":remote_id,"stopReason":"end_turn"});
                let closing = finish_normalizer
                    .lock()
                    .await
                    .finish_turn(&finish_session, &finish_brand, &end)
                    .into_iter()
                    .map(replay_delivery);
                finish_events.lock().await.extend(closing);
                Ok((
                    serde_json::to_value(response.modes).map_err(acp_error)?,
                    serde_json::to_value(response.config_options).map_err(acp_error)?,
                    agent_controls,
                ))
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let mut events = std::mem::take(&mut *collected.lock().await);
    let menu = menu_fields(
        &session.brand,
        session.model.as_deref(),
        &modes,
        &config_options,
        &agent_controls,
        &json!([]),
    );
    let pinned_model = menu["currentModel"].as_str().map(str::to_string);
    let pinned_mode = menu["currentMode"].as_str().map(str::to_string);
    let pinned_effort = menu["currentEffort"].as_str().map(str::to_string);
    let pinned_collaboration = menu["currentCollaborationMode"]
        .as_str()
        .map(str::to_string);
    let mut replay = Vec::with_capacity(events.len() + 2);
    replay.push(menu_event(&session.id, menu)?);
    if !events.is_empty() && database.timeline_count(session.id.clone()).await? > 0 {
        replay.push(super::super::provider::reset_event(&session.id)?);
    }
    replay.append(&mut events);
    replay.push(
        serde_json::from_value(json!({
            "type":"session.state", "sessionId":session.id, "seq":0, "at":now(),
            "state":"dormant", "label":"Asleep"
        }))
        .map_err(|error| error.to_string())?,
    );
    // ACP session/update carries no event timestamp. A historical load must
    // never make an old chat look newly active merely because it was opened.
    // Use the authoritative session/list clock for the entire replay batch.
    for event in &mut replay {
        event
            .fields
            .insert("at".into(), json!(session.last_active_at));
    }
    database.append_replay(replay).await?;
    database
        .update_session(
            session.id.clone(),
            SessionPatch {
                model: Some(pinned_model),
                permission_mode: pinned_mode,
                effort: Some(pinned_effort),
                collaboration_mode: Some(pinned_collaboration),
                state: Some("dormant".into()),
                ..SessionPatch::default()
            },
            None,
        )
        .await?;
    database.mark_imported(session.id.clone()).await
}

enum Control {
    Prompt {
        content: Vec<ContentBlock>,
        reply: Reply,
    },
    Steer {
        content: Vec<ContentBlock>,
        suppress_echo: bool,
        reply: Reply,
    },
    Subagent {
        action: String,
        agent_id: String,
        reply: Reply,
    },
    Cancel {
        reply: Reply,
    },
    Mode {
        value: String,
        reply: Reply,
    },
    Config {
        target: ConfigTarget,
        value: Value,
        reply: Reply,
    },
    WindowNow {
        reply: Reply,
    },
    Close {
        reply: Reply,
    },
}

enum ConfigTarget {
    Model,
    Effort,
    Collaboration,
    Exact(String),
}

#[derive(Default)]
struct PermissionBroker {
    pending: Mutex<HashMap<String, PendingPermission>>,
    plan_options: Mutex<HashMap<String, (String, String)>>,
}

struct PendingPermission {
    answer: oneshot::Sender<String>,
    reject: String,
}

#[derive(Default)]
struct ElicitationBroker {
    pending: Mutex<HashMap<String, PendingElicitation>>,
}

struct PendingElicitation {
    answer: oneshot::Sender<Value>,
    schema: Option<Value>,
    custom_fields: HashMap<String, String>,
    native_questions: bool,
}

impl PermissionBroker {
    async fn is_pending(&self, id: &str) -> bool {
        self.pending.lock().await.contains_key(id)
    }

    async fn answer(&self, id: &str, option: &str) -> Result<(), String> {
        self.pending
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("permission request {id} is no longer pending"))?
            .answer
            .send(option.to_string())
            .map_err(|_| format!("permission request {id} closed"))
    }

    async fn answer_plan(&self, id: &str, action: &str) -> Result<(), String> {
        let options = self
            .plan_options
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("plan {id} is no longer pending"))?;
        let option = if action == "approve" {
            options.0
        } else {
            options.1
        };
        self.answer(id, &option).await
    }

    async fn cancel_all(&self) {
        self.plan_options.lock().await.clear();
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, permission) in pending {
            let _ = permission.answer.send(permission.reject);
        }
    }
}

impl ElicitationBroker {
    async fn is_pending(&self, id: &str) -> bool {
        self.pending.lock().await.contains_key(id)
    }

    async fn answer(&self, id: &str, value: Value) -> Result<(), String> {
        let mut pending = self.pending.lock().await;
        let question = pending
            .get(id)
            .ok_or_else(|| format!("question {id} is no longer pending"))?;
        if value["action"] == "accept" {
            if let Some(schema) = &question.schema {
                let content = value["content"]
                    .as_object()
                    .ok_or_else(|| "question answers are required".to_string())?;
                for field in schema["required"].as_array().into_iter().flatten() {
                    let Some(field) = field.as_str() else {
                        continue;
                    };
                    if !content.contains_key(field) {
                        return Err(format!("no answer was supplied for {field}"));
                    }
                }
            }
        }
        pending
            .remove(id)
            .expect("pending elicitation was checked")
            .answer
            .send(value)
            .map_err(|_| format!("question {id} closed"))
    }

    async fn question_shape(&self, id: &str) -> Result<(HashMap<String, String>, bool), String> {
        let pending = self.pending.lock().await;
        let question = pending
            .get(id)
            .ok_or_else(|| format!("question {id} is no longer pending"))?;
        Ok((question.custom_fields.clone(), question.native_questions))
    }

    async fn cancel_all(&self) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, question) in pending {
            let _ = question.answer.send(json!({"action":"decline"}));
        }
    }
}

fn acp_error(error: impl ToString) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}

async fn append(database: &ChatDb, events: Vec<Event>) -> Result<(), agent_client_protocol::Error> {
    if events.is_empty() {
        return Ok(());
    }
    database
        .append_many(events)
        .await
        .map(|_| ())
        .map_err(acp_error)
}

fn event(value: Value) -> Result<Event, agent_client_protocol::Error> {
    serde_json::from_value(value).map_err(acp_error)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn session_meta(brand: &str, policy: &str) -> Meta {
    let mut meta = Meta::new();
    meta.insert("atelier".into(), json!({"sessionPolicy": policy}));
    if brand == "claude" {
        meta.insert(
            "systemPrompt".into(),
            json!({
                "type":"preset",
                "preset":"claude_code",
                "append":policy
            }),
        );
    }
    meta
}

async fn record_transport_failure(database: &ChatDb, session: &Session, message: &str) {
    let _ = database
        .update_session(
            session.id.clone(),
            SessionPatch {
                state: Some("errored".into()),
                ..SessionPatch::default()
            },
            None,
        )
        .await;
    let events = [
        json!({"type":"error", "sessionId":session.id, "seq":0, "at":now(), "message":message, "fatal":true, "source":"acp"}),
        json!({"type":"session.state", "sessionId":session.id, "seq":0, "at":now(), "state":"errored", "label":"Provider unavailable"}),
    ].into_iter().filter_map(|value| serde_json::from_value(value).ok()).collect();
    let _ = database.append_many(events).await;
}

async fn permission(
    request: RequestPermissionRequest,
    database: ChatDb,
    local_session_id: String,
    broker: Arc<PermissionBroker>,
) -> Result<RequestPermissionResponse, agent_client_protocol::Error> {
    let raw = serde_json::to_value(&request).map_err(acp_error)?;
    let ask_id = raw["toolCall"]["toolCallId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let options = raw["options"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|option| {
            json!({
                "id": option["optionId"],
                "label": option["name"],
                "kind": option["kind"]
            })
        })
        .collect::<Vec<_>>();
    let tool_title = raw["toolCall"]["title"].as_str().unwrap_or("Provider tool");
    let tool_input = raw["toolCall"]["rawInput"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let (answer, receive) = oneshot::channel();
    let reject = raw["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|option| {
            matches!(
                option["kind"].as_str(),
                Some("reject_once" | "reject_always" | "deny")
            )
        })
        .and_then(|option| option["optionId"].as_str())
        .unwrap_or("reject_once")
        .to_string();
    broker
        .pending
        .lock()
        .await
        .insert(ask_id.clone(), PendingPermission { answer, reject });
    let plan = raw
        .pointer("/toolCall/rawInput/plan")
        .and_then(Value::as_str)
        .filter(|plan| !plan.trim().is_empty());
    let asked = if let Some(markdown) = plan {
        let allowed = raw["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|option| {
                option["kind"]
                    .as_str()
                    .is_some_and(|kind| kind.starts_with("allow"))
            })
            .and_then(|option| option["optionId"].as_str())
            .unwrap_or("allow_once")
            .to_string();
        let denied = raw["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|option| option["kind"] == "reject_once" || option["kind"] == "deny")
            .and_then(|option| option["optionId"].as_str())
            .unwrap_or("reject_once")
            .to_string();
        broker
            .plan_options
            .lock()
            .await
            .insert(ask_id.clone(), (allowed, denied));
        event(json!({
            "type":"plan.proposed", "sessionId":local_session_id, "seq":0, "at":now(),
            "proposalId":ask_id, "markdown":markdown.trim(), "actions":[
                {"id":"approve","kind":"approve","label":"Approve plan","description":"Approve the plan and continue."},
                {"id":"request_changes","kind":"request_changes","label":"Request changes","acceptsFeedback":true,"description":"Keep planning and revise it."}
            ], "acp":raw
        }))?
    } else {
        event(json!({
            "type":"ask.permission", "sessionId":local_session_id, "seq":0, "at":now(),
            "askId":ask_id, "toolName":tool_title,
            "title":tool_title, "input":tool_input,
            "options":options, "acp":raw
        }))?
    };
    let waiting = event(json!({
        "type":"session.state", "sessionId":local_session_id, "seq":0, "at":now(),
        "state":"waiting_permission", "label":"Waiting for your answer"
    }))?;
    if let Err(error) = database.append_many(vec![asked, waiting]).await {
        broker.pending.lock().await.remove(&ask_id);
        return Err(acp_error(error));
    }
    let selected = receive.await.map_err(acp_error)?;
    let resolved = if plan.is_some() {
        json!({"type":"plan.resolved", "sessionId":local_session_id, "seq":0, "at":now(),
            "proposalId":ask_id, "status":if selected.contains("allow"){"approved"}else{"changes_requested"},
            "actionId":if selected.contains("allow"){"approve"}else{"request_changes"}})
    } else {
        json!({"type":"ask.resolved", "sessionId":local_session_id, "seq":0, "at":now(),
            "askId":ask_id, "chosen":selected})
    };
    database
        .append_many(vec![
            event(resolved)?,
            event(json!({
                "type":"session.state", "sessionId":local_session_id, "seq":0, "at":now(),
                "state":"streaming", "label":"Working"
            }))?,
        ])
        .await
        .map_err(acp_error)?;
    Ok(RequestPermissionResponse::new(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(selected)),
    ))
}

fn custom_question_field(property: &Value) -> Option<&str> {
    property
        .pointer("/_meta/_askUserQuestionCustomAnswer/questionId")
        .and_then(Value::as_str)
        .or_else(|| {
            (property
                .pointer("/_meta/codex/isOtherAnswer")
                .and_then(Value::as_bool)
                == Some(true))
            .then(|| {
                property
                    .pointer("/_meta/codex/questionId")
                    .and_then(Value::as_str)
            })
            .flatten()
        })
}

fn question_schema_shape(schema: &Value) -> (HashMap<String, String>, bool) {
    let mut custom_fields = HashMap::new();
    let mut native_questions = false;
    for (id, property) in schema["properties"]
        .as_object()
        .into_iter()
        .flat_map(|properties| properties.iter())
    {
        if let Some(question_id) = custom_question_field(property) {
            custom_fields.insert(question_id.to_string(), id.to_string());
            native_questions = true;
        }
        native_questions |= property.pointer("/_meta/codex/isOther").is_some();
    }
    (custom_fields, native_questions)
}

fn elicitation_fields(schema: &Value, message: Option<&str>) -> Vec<Value> {
    let (custom_fields, _) = question_schema_shape(schema);
    let properties = schema["properties"].as_object();
    let visible = properties
        .into_iter()
        .flat_map(|properties| properties.iter())
        .filter(|(_, property)| custom_question_field(property).is_none())
        .collect::<Vec<_>>();
    let one_question = visible.len() == 1;
    visible
        .into_iter()
        .map(|(id, property)| {
            let variants = property["oneOf"].as_array().or_else(|| property["anyOf"].as_array());
            let options = variants
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let value = option.get("const")?;
                    let id = value.as_str().map(str::to_string)
                        .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default());
                    Some(json!({
                        "id":id,
                        "label":option["title"].as_str().unwrap_or(&id),
                        "description":option["description"],
                        "preview":option.pointer("/_meta/_claude~1askUserQuestionOption/preview")
                    }))
                })
                .chain(property["enum"].as_array().into_iter().flatten().map(|value| {
                    let id = value.as_str().map(str::to_string)
                        .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default());
                    json!({"id":id,"label":id})
                }))
                .collect::<Vec<_>>();
            let options = if options.is_empty() && property["type"] == "boolean" {
                vec![json!({"id":"true","label":"Yes"}), json!({"id":"false","label":"No"})]
            } else {
                options
            };
            let multiple = property["type"] == "array";
            let prompt = one_question
                .then_some(message)
                .flatten()
                .or_else(|| property["description"].as_str())
                .unwrap_or(id);
            json!({
                "id":id,
                "header":property["title"].as_str().unwrap_or(id),
                "prompt":prompt,
                "selection":if multiple {"multiple"} else if options.is_empty() {"text"} else {"single"},
                "options":options,
                "allowCustom":options.is_empty() || custom_fields.contains_key(id),
                "secret":property["format"] == "password"
                    || property.pointer("/_meta/codex/isSecret").and_then(Value::as_bool) == Some(true)
            })
        })
        .collect()
}

fn typed_elicitation_value(property: &Value, value: &Value) -> Value {
    let choices = property["oneOf"]
        .as_array()
        .or_else(|| property["anyOf"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("const"))
        .chain(property["enum"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    if let Some(selected) = value.as_str().and_then(|selected| {
        choices.iter().copied().find(|choice| {
            choice
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| serde_json::to_string(choice).unwrap_or_default())
                == selected
        })
    }) {
        return selected.clone();
    }
    match property["type"].as_str() {
        Some("boolean") => value
            .as_str()
            .and_then(|value| value.parse::<bool>().ok())
            .map(Value::Bool)
            .unwrap_or_else(|| value.clone()),
        Some("integer") => value
            .as_str()
            .and_then(|value| value.parse::<i64>().ok())
            .map(Value::from)
            .unwrap_or_else(|| value.clone()),
        Some("number") => value
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| value.clone()),
        Some("array") => {
            let item = &property["items"];
            Value::Array(
                value
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![value.clone()])
                    .iter()
                    .map(|value| typed_elicitation_value(item, value))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn typed_elicitation_content(schema: &Value, content: &Value) -> Value {
    let mut content = content.as_object().cloned().unwrap_or_default();
    for (id, value) in &mut content {
        if let Some(property) = schema["properties"].get(id) {
            *value = typed_elicitation_value(property, value);
        }
    }
    Value::Object(content)
}

async fn elicitation(
    request: CreateElicitationRequest,
    database: ChatDb,
    local_session_id: String,
    broker: Arc<ElicitationBroker>,
) -> Result<CreateElicitationResponse, agent_client_protocol::Error> {
    let raw = serde_json::to_value(&request).map_err(acp_error)?;
    let request_id = raw["elicitationId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (answer, receive) = oneshot::channel();
    let (custom_fields, native_questions) = question_schema_shape(&raw["requestedSchema"]);
    broker.pending.lock().await.insert(
        request_id.clone(),
        PendingElicitation {
            answer,
            schema: (raw["mode"] == "form").then(|| raw["requestedSchema"].clone()),
            custom_fields,
            native_questions,
        },
    );
    let asked = match request.mode {
        ElicitationMode::Form(_) => event(json!({
            "type":"question.requested", "sessionId":local_session_id, "seq":0, "at":now(),
            "requestId":request_id, "blocking":true,
            "questions":elicitation_fields(&raw["requestedSchema"], Some(request.message.as_str())), "acp":raw
        }))?,
        ElicitationMode::Url(_) => event(json!({
            "type":"ask.permission", "sessionId":local_session_id, "seq":0, "at":now(),
            "askId":request_id, "toolName":"Open sign-in link", "title":request.message,
            "input":{"url":raw["url"]}, "href":raw["url"], "options":[
                {"id":"accept","label":"Continue","kind":"allow_once"},
                {"id":"decline","label":"Cancel","kind":"deny"}
            ], "acp":raw
        }))?,
        _ => return serde_json::from_value(json!({"action":"decline"})).map_err(acp_error),
    };
    database.append(asked).await.map_err(acp_error)?;
    database
        .append(event(json!({
            "type":"session.state", "sessionId":local_session_id, "seq":0, "at":now(),
            "state":"waiting_permission", "label":"Waiting for your answer"
        }))?)
        .await
        .map_err(acp_error)?;
    let response = receive.await.map_err(acp_error)?;
    let accepted = response["action"] == "accept";
    let resolved_type = if raw["mode"] == "form" {
        "question.resolved"
    } else {
        "ask.resolved"
    };
    database
        .append(event(json!({
            "type":resolved_type, "sessionId":local_session_id, "seq":0, "at":now(),
            "requestId":request_id, "askId":request_id,
            "answers":response["answers"], "chosen":response["action"]
        }))?)
        .await
        .map_err(acp_error)?;
    let wire = if accepted {
        json!({"action":"accept","content":typed_elicitation_content(&raw["requestedSchema"], &response["content"])})
    } else {
        json!({"action":"decline"})
    };
    serde_json::from_value(wire).map_err(acp_error)
}

fn prompt_content(command: &Command) -> Result<Vec<ContentBlock>, String> {
    let text = command
        .fields
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "text is required".to_string())?;
    let mut content = vec![ContentBlock::Text(TextContent::new(text))];
    for image in command
        .fields
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let data = image["data"]
            .as_str()
            .or_else(|| image["base64"].as_str())
            .unwrap_or_default();
        let mime = image["mimeType"].as_str().unwrap_or("image/png");
        if !data.is_empty() {
            content.push(ContentBlock::Image(ImageContent::new(data, mime)));
        }
    }
    Ok(content)
}

fn question_answer_content(
    answers: &[Value],
    custom_fields: &HashMap<String, String>,
    native_questions: bool,
) -> serde_json::Map<String, Value> {
    let mut content = serde_json::Map::new();
    for answer in answers {
        let key = answer["questionId"].as_str().unwrap_or_default();
        let selected = answer["optionIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let custom = answer["customText"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(str::trim);
        if let Some(custom) = custom {
            content.insert(
                custom_fields
                    .get(key)
                    .cloned()
                    .unwrap_or_else(|| key.to_string()),
                json!(custom),
            );
        } else {
            content.insert(
                key.to_string(),
                if selected.len() == 1 {
                    json!(selected[0])
                } else {
                    json!(selected)
                },
            );
        }
        if native_questions {
            if let Some(note) = answer["note"]
                .as_str()
                .map(str::trim)
                .filter(|note| !note.is_empty())
            {
                content.insert(format!("__atelier_note_{key}"), json!(note));
            }
        }
    }
    content
}

fn slash_name(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let command = trimmed.strip_prefix('/')?;
    let name = command.split_whitespace().next()?;
    (!name.is_empty() && !name.contains('/')).then_some(name)
}

fn turn_is_active(state: &str) -> bool {
    matches!(state, "thinking" | "streaming" | "running_tool")
}

fn command_is_offered(name: &str, commands: &[Value]) -> Result<(), String> {
    if commands.iter().any(|command| command["name"] == name) {
        return Ok(());
    }
    Err(format!(
        "/{name} is not available in this {}.",
        if commands.is_empty() {
            "provider"
        } else {
            "session"
        }
    ))
}

async fn validate_offered_command(
    database: &ChatDb,
    session_id: &str,
    text: &str,
) -> Result<(), String> {
    let Some(name) = slash_name(text) else {
        return Ok(());
    };
    // Some ACP adapters publish their command catalog immediately after the
    // session handshake. Give only that empty-catalog startup state a bounded
    // chance to settle; ordinary prompts and populated menus never wait.
    for attempt in 0..=25 {
        let menu = database.steering_menu(session_id.to_string()).await?;
        let commands = menu["commands"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if !commands.is_empty() || attempt == 25 {
            return command_is_offered(name, commands);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    unreachable!("the bounded command-catalog wait always returns")
}

fn select_values(options: &Value, ids: &[&str]) -> Vec<Value> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| {
            let id = option["id"].as_str().unwrap_or_default();
            let category = option["category"].as_str().unwrap_or_default();
            ids.contains(&id) || ids.contains(&category)
        })
        .flat_map(|option| option["options"].as_array().into_iter().flatten())
        .map(|choice| {
            json!({
                "value": choice["value"],
                "id": choice["value"],
                "displayName": choice["name"],
                "label": choice["name"],
                "description": choice["description"]
            })
        })
        .collect()
}

fn current_option(options: &Value, ids: &[&str]) -> Value {
    options
        .as_array()
        .into_iter()
        .flatten()
        .find(|option| {
            let id = option["id"].as_str().unwrap_or_default();
            let category = option["category"].as_str().unwrap_or_default();
            ids.contains(&id) || ids.contains(&category)
        })
        .map(|option| option["currentValue"].clone())
        .unwrap_or(Value::Null)
}

fn extra_config_options(options: &Value) -> Vec<Value> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| {
            let id = option["id"].as_str().unwrap_or_default();
            let category = option["category"].as_str().unwrap_or_default();
            !matches!(
                id,
                "mode"
                    | "model"
                    | "effort"
                    | "reasoning_effort"
                    | "thought_level"
                    | "thinking_effort"
                    | "collaboration_mode"
                    | "provider"
            ) && !matches!(
                category,
                "mode" | "model" | "thought_level" | "collaboration_mode"
            )
        })
        .cloned()
        .collect()
}

fn config_option_value(value: &Value) -> Option<SessionConfigOptionValue> {
    value
        .as_bool()
        .map(SessionConfigOptionValue::from)
        .or_else(|| value.as_str().map(SessionConfigOptionValue::from))
}

fn config_option_id(options: &Value, target: &ConfigTarget) -> Option<String> {
    options.as_array().into_iter().flatten().find_map(|option| {
        let id = option["id"].as_str()?;
        let category = option["category"].as_str().unwrap_or_default();
        let matches = match target {
            ConfigTarget::Model => category == "model" || id == "model",
            ConfigTarget::Effort => {
                category == "thought_level"
                    || matches!(
                        id,
                        "effort" | "reasoning_effort" | "thought_level" | "thinking_effort"
                    )
            }
            ConfigTarget::Collaboration => {
                category == "collaboration_mode" || id == "collaboration_mode"
            }
            ConfigTarget::Exact(exact) => id == exact,
        };
        matches.then(|| id.to_string())
    })
}

pub(super) fn mode_from_acp(brand: &str, mode: &str) -> String {
    if brand != "codex" {
        return mode.to_string();
    }
    match mode {
        "read-only" => "untrusted",
        "agent" => "on-request",
        "agent-full-access" => "never",
        other => other,
    }
    .to_string()
}

fn mode_to_acp(brand: &str, mode: &str) -> String {
    if brand != "codex" {
        return mode.to_string();
    }
    match mode {
        "untrusted" => "read-only",
        "on-request" => "agent",
        "never" => "agent-full-access",
        other => other,
    }
    .to_string()
}

fn options_for_menu(brand: &str, seed_model: Option<&str>, options: &Value) -> Value {
    if brand != super::super::local::BRAND {
        return options.clone();
    }
    let Some((runtime, _)) = seed_model.and_then(super::super::local::decode_model) else {
        return options.clone();
    };
    let mut options = options.clone();
    for option in options.as_array_mut().into_iter().flatten() {
        let id = option["id"].as_str().unwrap_or_default();
        let category = option["category"].as_str().unwrap_or_default();
        if id != "model" && category != "model" {
            continue;
        }
        if let Some(current) = option["currentValue"].as_str().map(str::to_string) {
            option["currentValue"] = json!(super::super::local::encode_model(runtime, &current));
        }
        for choice in option["options"].as_array_mut().into_iter().flatten() {
            if let Some(value) = choice["value"].as_str().map(str::to_string) {
                choice["value"] = json!(super::super::local::encode_model(runtime, &value));
            }
        }
    }
    options
}

pub(super) fn menu_fields(
    brand: &str,
    seed_model: Option<&str>,
    modes: &Value,
    options: &Value,
    agent_controls: &Value,
    agent_definitions: &Value,
) -> Value {
    let options = options_for_menu(brand, seed_model, options);
    let permission_modes = modes["availableModes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|mode| mode["id"].as_str())
        .map(|mode| mode_from_acp(brand, mode))
        .collect::<Vec<_>>();
    json!({
        "commands":[], "skills":[], "agentDefinitions":agent_definitions, "agentControls":agent_controls,
        "permissionModes":permission_modes,
        "currentMode":mode_from_acp(brand, modes["currentModeId"].as_str().unwrap_or_default()),
        "models":select_values(&options, &["model"]),
        "currentModel":current_option(&options, &["model"]),
        "efforts":select_values(&options, &["effort", "reasoning_effort", "thought_level", "thinking_effort"]),
        "currentEffort":current_option(&options, &["effort", "reasoning_effort", "thought_level", "thinking_effort"]),
        "collaborationModes":select_values(&options, &["collaboration_mode"]),
        "currentCollaborationMode":current_option(&options, &["collaboration_mode"]),
        "configOptions":extra_config_options(&options), "transport":"acp"
    })
}

fn menu_fields_with_local_catalog(
    brand: &str,
    seed_model: Option<&str>,
    modes: &Value,
    options: &Value,
    local_models: &Value,
    agent_controls: &Value,
    agent_definitions: &Value,
) -> Value {
    let mut menu = menu_fields(
        brand,
        seed_model,
        modes,
        options,
        agent_controls,
        agent_definitions,
    );
    if brand == super::super::local::BRAND
        && local_models
            .as_array()
            .is_some_and(|models| !models.is_empty())
    {
        menu["models"] = local_models.clone();
    }
    menu
}

fn menu_event(session_id: &str, mut menu: Value) -> Result<Event, String> {
    let object = menu.as_object_mut().expect("ACP menu is an object");
    object.insert("type".into(), json!("session.menu"));
    object.insert("sessionId".into(), json!(session_id));
    object.insert("seq".into(), json!(0));
    object.insert("at".into(), json!(now()));
    serde_json::from_value(menu).map_err(|error| error.to_string())
}

pub struct AcpDriver {
    brand: &'static str,
    database: ChatDb,
    session: Session,
    controls: mpsc::UnboundedSender<Control>,
    ended: mpsc::UnboundedReceiver<String>,
    permissions: Arc<PermissionBroker>,
    elicitations: Arc<ElicitationBroker>,
}

impl AcpDriver {
    async fn submit_user_turn(
        &self,
        text: &str,
        images: &[Value],
        content: Vec<ContentBlock>,
    ) -> Result<Value, String> {
        let active = self
            .database
            .get_session(self.session.id.clone())
            .await?
            .is_some_and(|session| turn_is_active(&session.state));
        super::super::provider::record_user_for_transport(
            &self.database,
            &self.session,
            text,
            images,
        )
        .await?;
        self.database
            .append(
                serde_json::from_value(json!({
                    "type":"session.state", "sessionId":self.session.id,
                    "seq":0, "at":now(), "state":"streaming", "label":"Working"
                }))
                .map_err(|error| error.to_string())?,
            )
            .await?;
        if active {
            self.control(|reply| Control::Steer {
                content,
                suppress_echo: true,
                reply,
            })
            .await
        } else {
            self.control(|reply| Control::Prompt { content, reply })
                .await
        }
    }

    async fn record_agent_control(&self, agent_id: &str, state: &str) -> Result<(), String> {
        let agents = self
            .database
            .projected_agents(self.session.id.clone())
            .await?;
        let Some(agent) = agents
            .iter()
            .find(|agent| agent["id"].as_str() == Some(agent_id))
        else {
            return Ok(());
        };
        if matches!(agent["state"].as_str(), Some("done" | "failed" | "stopped")) {
            return Ok(());
        }
        let shared = json!({
            "sessionId":self.session.id, "seq":0, "at":now(), "agentId":agent_id,
            "seconds":agent["seconds"].as_u64().unwrap_or_default(),
            "tokens":agent["tokens"].as_u64().unwrap_or_default(),
            "calls":agent["calls"].as_u64().unwrap_or_default(),
            "model":agent.get("model").cloned().unwrap_or(Value::Null)
        });
        let value = if state == "stopped" {
            let mut value = shared;
            value["type"] = json!("agent.finished");
            value["state"] = json!("stopped");
            value["result"] = Value::Null;
            value
        } else {
            let mut value = shared;
            value["type"] = json!("agent.progress");
            value["state"] = json!(state);
            value
        };
        self.database
            .append(serde_json::from_value(value).map_err(|error| error.to_string())?)
            .await?;
        Ok(())
    }

    pub async fn connect(database: ChatDb, session: Session, create: bool) -> Result<Self, String> {
        let brand: &'static str = match session.brand.as_str() {
            "claude" => "claude",
            "codex" => "codex",
            super::super::local::BRAND => super::super::local::BRAND,
            other => return Err(format!("ACP adapter is not configured for {other}")),
        };
        let task_policy = session_policy::build(Path::new(&session.cwd))?;
        let create_remote =
            create || (brand == super::super::local::BRAND && session.external_id.is_none());
        if create {
            database.create_session(session.clone()).await?;
            super::super::provider::append_started(&database, &session, false).await?;
        }
        let saved_menu = database
            .steering_menu(session.id.clone())
            .await
            .unwrap_or_else(|_| json!({}));
        let saved_cost = database
            .token_stats(session.id.clone())
            .await
            .ok()
            .and_then(|stats| stats.cost);
        let config = match adapter::launch_config(brand, session.model.as_deref()) {
            Some(config) => config,
            None => {
                let message = format!("bundled {brand} ACP adapter is incomplete or unavailable");
                record_transport_failure(&database, &session, &message).await;
                return Err(message);
            }
        };
        let (controls, receiver) = mpsc::unbounded_channel();
        let (ended_send, ended) = mpsc::unbounded_channel();
        let (ready, initialized) = oneshot::channel();
        let closing = Arc::new(AtomicBool::new(false));
        let permissions = Arc::new(PermissionBroker::default());
        let elicitations = Arc::new(ElicitationBroker::default());
        let task_database = database.clone();
        let task_session = session.clone();
        let task_agent_definitions = if brand == "codex" {
            json!(super::super::codex::history::agent_definitions(Path::new(
                &session.cwd,
            )))
        } else {
            json!([])
        };
        let task_session_meta = session_meta(brand, &task_policy);
        let task_permissions = permissions.clone();
        let task_elicitations = elicitations.clone();
        let task_closing = closing.clone();
        let task_io = ClientIo::new(PathBuf::from(&task_session.cwd))?;
        let task_saved_menu = saved_menu.clone();
        let task_saved_cost = saved_cost.clone();
        let task_local_models = if brand == super::super::local::BRAND {
            if saved_menu["models"]
                .as_array()
                .is_some_and(|models| !models.is_empty())
            {
                saved_menu["models"].clone()
            } else {
                serde_json::to_value(super::super::local::catalog().await)
                    .map_err(|error| error.to_string())?
            }
        } else {
            Value::Null
        };
        tokio::spawn(async move {
            let mut task_normalizer = AcpNormalizer::new(PathBuf::from(&task_session.cwd));
            task_normalizer.seed_usage(task_saved_cost.as_ref());
            let normalizer = Arc::new(Mutex::new(task_normalizer));
            let replaying = Arc::new(AtomicBool::new(false));
            let updates_db = task_database.clone();
            let updates_session = task_session.id.clone();
            let updates_brand = brand;
            let updates_normalizer = normalizer.clone();
            let updates_replaying = replaying.clone();
            let permission_db = task_database.clone();
            let permission_session = task_session.id.clone();
            let permission_broker = task_permissions.clone();
            let elicitation_db = task_database.clone();
            let elicitation_session = task_session.id.clone();
            let elicitation_broker = task_elicitations.clone();
            let stopped_database = task_database.clone();
            let stopped_session = task_session.clone();
            let stopped_closing = task_closing.clone();
            let read_io = task_io.clone();
            let write_io = task_io.clone();
            let create_terminal_io = task_io.clone();
            let terminal_output_io = task_io.clone();
            let release_terminal_io = task_io.clone();
            let wait_terminal_io = task_io.clone();
            let kill_terminal_io = task_io.clone();
            let client = agent_client_protocol::Client
                .builder()
                .on_receive_notification(
                    async move |notification: UntypedMessage, _connection| {
                        if notification.method() != "session/update" {
                            return Ok(());
                        }
                        if updates_replaying.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        let raw = notification.params().clone();
                        let events = updates_normalizer.lock().await.update(
                            &updates_session,
                            updates_brand,
                            &raw,
                        );
                        append(&updates_db, events).await
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _connection| {
                        let response = permission(
                            request,
                            permission_db.clone(),
                            permission_session.clone(),
                            permission_broker.clone(),
                        )
                        .await?;
                        responder.respond(response)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: CreateElicitationRequest, responder, _connection| {
                        let response = elicitation(
                            request,
                            elicitation_db.clone(),
                            elicitation_session.clone(),
                            elicitation_broker.clone(),
                        )
                        .await?;
                        responder.respond(response)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: ReadTextFileRequest, responder, _connection| {
                        responder.respond(read_io.read(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: WriteTextFileRequest, responder, _connection| {
                        responder.respond(write_io.write(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: CreateTerminalRequest, responder, _connection| {
                        responder.respond(create_terminal_io.create_terminal(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: TerminalOutputRequest, responder, _connection| {
                        responder.respond(terminal_output_io.terminal_output(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: ReleaseTerminalRequest, responder, _connection| {
                        responder.respond(release_terminal_io.release_terminal(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: WaitForTerminalExitRequest, responder, _connection| {
                        responder.respond(wait_terminal_io.wait_terminal(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .on_receive_request(
                    async move |request: KillTerminalRequest, responder, _connection| {
                        responder.respond(kill_terminal_io.kill_terminal(request).await?)
                    },
                    agent_client_protocol::on_receive_request!(),
                );
            let agent = AcpAgent::new(config);
            let ready = Arc::new(Mutex::new(Some(ready)));
            let connection_ready = ready.clone();
            let result = client
                .connect_with(agent, move |connection: ConnectionTo<Agent>| {
                    let task_database = task_database.clone();
                    let task_session = task_session.clone();
                    let task_policy = task_policy.clone();
                    let session_meta = task_session_meta.clone();
                    let normalizer = normalizer.clone();
                    let mut receiver = receiver;
                    let ready = connection_ready.clone();
                    let replaying = replaying.clone();
                    let closing = task_closing.clone();
                    let saved_menu = task_saved_menu.clone();
                    let io = task_io.clone();
                    async move {
                        let initialized = connection
                            .send_request(initialize_request()?)
                            .block_task()
                            .await?;
                        let agent_controls = initialized
                            .pointer("/_meta/atelier/subagentControls")
                            .filter(|controls| controls.is_array())
                            .cloned()
                            .unwrap_or_else(|| json!([]));
                        let supports_close = initialized
                            .pointer("/agentCapabilities/sessionCapabilities/close")
                            .is_some();
                        let (remote_id, mut modes, mut config_options) = if create_remote {
                            let response = connection
                                .send_request(NewSessionRequest::new(PathBuf::from(
                                    &task_session.cwd,
                                )).meta(session_meta.clone()))
                                .block_task()
                                .await?;
                            (
                                response.session_id.to_string(),
                                serde_json::to_value(response.modes).map_err(acp_error)?,
                                serde_json::to_value(response.config_options).map_err(acp_error)?,
                            )
                        } else {
                            let remote = task_session
                                .external_id
                                .clone()
                                .ok_or_else(|| acp_error("saved session has no provider id"))?;
                            if initialized.pointer("/agentCapabilities/sessionCapabilities/resume").is_some() {
                                let response = connection
                                    .send_request(ResumeSessionRequest::new(
                                        remote.clone(),
                                        PathBuf::from(&task_session.cwd),
                                    ).meta(session_meta.clone()))
                                    .block_task()
                                    .await?;
                                (
                                    remote,
                                    serde_json::to_value(response.modes).map_err(acp_error)?,
                                    serde_json::to_value(response.config_options).map_err(acp_error)?,
                                )
                            } else if initialized.pointer("/agentCapabilities/loadSession") == Some(&Value::Bool(true)) {
                                replaying.store(true, Ordering::Release);
                                let response = connection
                                    .send_request(LoadSessionRequest::new(
                                        remote.clone(),
                                        PathBuf::from(&task_session.cwd),
                                    ).meta(session_meta.clone()))
                                    .block_task()
                                    .await;
                                replaying.store(false, Ordering::Release);
                                let response = response?;
                                (
                                    remote,
                                    serde_json::to_value(response.modes).map_err(acp_error)?,
                                    serde_json::to_value(response.config_options).map_err(acp_error)?,
                                )
                            } else {
                                return Err(acp_error("agent supports neither session/resume nor session/load"));
                            }
                        };
                        io.set_session(remote_id.clone()).await;
                        if brand == super::super::local::BRAND {
                            connection
                                .send_request(UntypedMessage::new(
                                    "_goose/unstable/session/system-prompt/set",
                                    json!({
                                        "sessionId":&remote_id,
                                        "mode":"append",
                                        "key":"atelier",
                                        "text":task_policy
                                    }),
                                )?)
                                .block_task()
                                .await?;
                        }
                        let mut local_model = task_session.model.clone();
                        if create_remote {
                            let desired_mode = mode_to_acp(brand, &task_session.permission_mode);
                            if !desired_mode.is_empty() && modes["currentModeId"] != desired_mode {
                                connection.send_request(SetSessionModeRequest::new(remote_id.clone(), desired_mode.clone())).block_task().await?;
                                modes["currentModeId"] = json!(desired_mode);
                            }
                            for (target, desired) in [
                                (ConfigTarget::Model, task_session.model.as_deref()),
                                (ConfigTarget::Effort, task_session.effort.as_deref()),
                                (ConfigTarget::Collaboration, task_session.collaboration_mode.as_deref()),
                            ] {
                                if let Some(desired) = desired.filter(|value| !value.is_empty() && *value != "default") {
                                    let Some(key) = config_option_id(&config_options, &target) else { continue };
                                    let desired = if brand == super::super::local::BRAND && matches!(target, ConfigTarget::Model) {
                                        super::super::local::decode_model(desired).map(|(_, model)| model).unwrap_or(desired)
                                    } else { desired };
                                    let response = connection.send_request(SetSessionConfigOptionRequest::new(remote_id.clone(), key, desired)).block_task().await?;
                                    config_options = serde_json::to_value(response.config_options).map_err(acp_error)?;
                                }
                            }
                        }
                        for saved in extra_config_options(&saved_menu["configOptions"]) {
                            let Some(key) = saved["id"].as_str().map(str::to_string) else { continue };
                            let Some(remote) = config_options.as_array().into_iter().flatten().find(|option| option["id"] == key) else { continue };
                            if remote["currentValue"] == saved["currentValue"] { continue; }
                            let Some(desired) = config_option_value(&saved["currentValue"]) else { continue };
                            let response = connection.send_request(SetSessionConfigOptionRequest::new(remote_id.clone(), key, desired)).block_task().await?;
                            config_options = serde_json::to_value(response.config_options).map_err(acp_error)?;
                        }
                        let pinned_mode = mode_from_acp(brand, modes["currentModeId"].as_str().unwrap_or_default());
                        let pinned_model = current_option(&config_options, &["model"]).as_str().map(|model| {
                            local_model.as_deref().and_then(super::super::local::decode_model)
                                .map(|(runtime, _)| super::super::local::encode_model(runtime, model))
                                .unwrap_or_else(|| model.to_string())
                        });
                        local_model = pinned_model.clone();
                        let pinned_effort = current_option(&config_options, &["effort", "reasoning_effort", "thought_level", "thinking_effort"]).as_str().map(str::to_string);
                        let pinned_collaboration = current_option(&config_options, &["collaboration_mode"]).as_str().map(str::to_string);
                        task_database
                            .update_session(
                                task_session.id.clone(),
                                SessionPatch {
                                    external_id: Some(Some(remote_id.clone())),
                                    state: Some("idle".into()),
                                    permission_mode: Some(pinned_mode.clone()),
                                    model: Some(pinned_model.clone()),
                                    effort: Some(pinned_effort.clone()),
                                    collaboration_mode: Some(pinned_collaboration.clone()),
                                    ..SessionPatch::default()
                                },
                                None,
                            )
                            .await
                            .map_err(acp_error)?;
                        let menu = menu_fields_with_local_catalog(
                            brand,
                            local_model.as_deref(),
                            &modes,
                            &config_options,
                            &task_local_models,
                            &agent_controls,
                            &task_agent_definitions,
                        );
                        normalizer.lock().await.set_menu(menu.clone());
                        task_database
                            .append(menu_event(&task_session.id, menu).map_err(acp_error)?)
                            .await
                            .map_err(acp_error)?;
                        task_database.append(event(json!({
                            "type":"session.pinned", "sessionId":task_session.id, "seq":0, "at":now(),
                            "permissionMode":pinned_mode, "model":pinned_model,
                            "effort":pinned_effort, "collaborationMode":pinned_collaboration
                        }))?).await.map_err(acp_error)?;
                        task_database.append(event(json!({
                            "type":"session.state", "sessionId":task_session.id, "seq":0, "at":now(),
                            "state":"idle", "label":"Ready"
                        }))?).await.map_err(acp_error)?;
                        if let Some(ready) = ready.lock().await.take() {
                            let _ = ready.send(Ok(remote_id.clone()));
                        }
                        while let Some(control) = receiver.recv().await {
                            match control {
                                Control::Prompt { content, reply } => {
                                    normalizer.lock().await.begin_local_prompt();
                                    let prompt_connection = connection.clone();
                                    let database = task_database.clone();
                                    let local_id = task_session.id.clone();
                                    let provider = brand;
                                    let remote_id = remote_id.clone();
                                    let normalizer = normalizer.clone();
                                    let spawned = connection.spawn(async move {
                                        let result = prompt_connection
                                            .send_request(PromptRequest::new(remote_id, content))
                                            .block_task()
                                            .await;
                                        let events = match result {
                                            Ok(response) => {
                                                let raw = serde_json::to_value(response).map_err(acp_error)?;
                                                normalizer.lock().await.finish_turn(&local_id, provider, &raw)
                                            }
                                            Err(error) => normalizer.lock().await.fail_turn(
                                                &local_id,
                                                provider,
                                                &error.to_string(),
                                            ),
                                        };
                                        database.append_many(events).await.map_err(acp_error)?;
                                        Ok(())
                                    });
                                    let answer = spawned
                                        .map(|_| json!({"ok":true,"accepted":true}))
                                        .map_err(|error| error.to_string());
                                    let _ = reply.send(answer);
                                }
                                Control::Cancel { reply } => {
                                    let result = connection
                                        .send_notification(CancelNotification::new(remote_id.clone()))
                                        .map(|_| json!({"ok":true}))
                                        .map_err(|error| error.to_string());
                                    let _ = reply.send(result);
                                }
                                Control::Steer { content, suppress_echo, reply } => {
                                    if suppress_echo {
                                        normalizer.lock().await.begin_local_prompt();
                                    }
                                    let result = connection
                                        .send_request(UntypedMessage::new("_session/steering", json!({
                                            "sessionId":remote_id, "prompt":content
                                        }))?)
                                        .block_task()
                                        .await
                                        .map(|response| json!({"ok":true,"response":response}))
                                        .map_err(|error| error.to_string());
                                    let _ = reply.send(result);
                                }
                                Control::Subagent { action, agent_id, reply } => {
                                    let result = connection
                                        .send_request(UntypedMessage::new(
                                            "_atelier/session/subagent-control",
                                            json!({
                                                "sessionId":remote_id,
                                                "agentId":agent_id,
                                                "action":action,
                                            }),
                                        )?)
                                        .block_task()
                                        .await
                                        .map_err(|error| error.to_string());
                                    let _ = reply.send(result);
                                }
                                Control::Mode { value, reply } => {
                                    let selected = mode_from_acp(brand, &value);
                                    let result = connection
                                        .send_request(SetSessionModeRequest::new(remote_id.clone(), value))
                                        .block_task()
                                        .await
                                        .map_err(|error| error.to_string());
                                    let result = match result {
                                        Ok(_) => {
                                            task_database.append(serde_json::from_value(json!({
                                                "type":"session.pinned", "sessionId":task_session.id,
                                                "seq":0, "at":now(), "permissionMode":selected,
                                                "model":Value::Null, "effort":Value::Null,
                                                "collaborationMode":Value::Null
                                            })).map_err(acp_error)?).await.map_err(acp_error)?;
                                            Ok(json!({"ok":true}))
                                        }
                                        Err(error) => Err(error),
                                    };
                                    let _ = reply.send(result);
                                }
                                Control::Config { target, value, reply } => {
                                    let local_selection = if brand == super::super::local::BRAND && matches!(&target, ConfigTarget::Model) {
                                        value.as_str().and_then(super::super::local::decode_model)
                                    } else {
                                        None
                                    };
                                    if brand == super::super::local::BRAND && matches!(&target, ConfigTarget::Model) && local_selection.is_none() {
                                        let _ = reply.send(Err("a local model must include its discovered runtime".into()));
                                        continue;
                                    }
                                    if let Some((runtime, model)) = local_selection {
                                        let current_runtime = local_model.as_deref()
                                            .and_then(super::super::local::decode_model)
                                            .map(|(runtime, _)| runtime);
                                        if current_runtime != Some(runtime) {
                                            let Some(provider_key) = config_option_id(&config_options, &ConfigTarget::Exact("provider".into())) else {
                                                let _ = reply.send(Err("the local agent cannot switch inference runtimes in this session".into()));
                                                continue;
                                            };
                                            let response = connection
                                                .send_request(SetSessionConfigOptionRequest::new(remote_id.clone(), provider_key, runtime.provider()))
                                                .block_task()
                                                .await;
                                            match response {
                                                Ok(response) => {
                                                    config_options = serde_json::to_value(response.config_options).map_err(acp_error)?;
                                                    local_model = Some(super::super::local::encode_model(runtime, model));
                                                    normalizer.lock().await.set_menu(menu_fields_with_local_catalog(
                                                        brand,
                                                        local_model.as_deref(),
                                                        &modes,
                                                        &config_options,
                                                        &task_local_models,
                                                        &agent_controls,
                                                        &task_agent_definitions,
                                                    ));
                                                }
                                                Err(error) => {
                                                    let _ = reply.send(Err(error.to_string()));
                                                    continue;
                                                }
                                            }
                                        }
                                    }
                                    let option_value = if let Some((_, model)) = local_selection {
                                        Some(SessionConfigOptionValue::from(model))
                                    } else {
                                        config_option_value(&value)
                                    };
                                    let Some(option_value) = option_value else {
                                        let _ = reply.send(Err("a session config value must be a boolean or string".into()));
                                        continue;
                                    };
                                    let Some(key) = config_option_id(&config_options, &target) else {
                                        let _ = reply.send(Err("the agent no longer advertises that session option".into()));
                                        continue;
                                    };
                                    let result = connection
                                        .send_request(SetSessionConfigOptionRequest::new(remote_id.clone(), key, option_value))
                                        .block_task()
                                        .await;
                                    let result = match result {
                                        Ok(response) => {
                                            config_options = serde_json::to_value(response.config_options).map_err(acp_error)?;
                                            if let Some((runtime, model)) = local_selection {
                                                local_model = Some(super::super::local::encode_model(runtime, model));
                                            }
                                            let menu = menu_fields_with_local_catalog(
                                                brand,
                                                local_model.as_deref(),
                                                &modes,
                                                &config_options,
                                                &task_local_models,
                                                &agent_controls,
                                                &task_agent_definitions,
                                            );
                                            normalizer.lock().await.set_menu(menu.clone());
                                            task_database.append(menu_event(
                                                &task_session.id,
                                                menu.clone(),
                                            ).map_err(acp_error)?).await.map_err(acp_error)?;
                                            let selected_options = menu["configOptions"].as_array().into_iter().flatten().map(|option| json!({
                                                "id":option["id"], "currentValue":option["currentValue"]
                                            })).collect::<Vec<_>>();
                                            task_database.append(serde_json::from_value(json!({
                                                "type":"session.pinned", "sessionId":task_session.id,
                                                "seq":0, "at":now(), "permissionMode":Value::Null,
                                                "model":menu["currentModel"], "effort":menu["currentEffort"],
                                                "collaborationMode":menu["currentCollaborationMode"],
                                                "configOptions":selected_options
                                            })).map_err(acp_error)?).await.map_err(acp_error)?;
                                            Ok(json!({"ok":true,"configOptions":config_options}))
                                        }
                                        Err(error) => Err(error.to_string()),
                                    };
                                    let _ = reply.send(result);
                                }
                                Control::WindowNow { reply } => {
                                    let result = if brand == "claude" {
                                        connection
                                            .send_request(UntypedMessage::new(
                                                "_atelier/session/window-now",
                                                json!({"sessionId":&remote_id}),
                                            )?)
                                            .block_task()
                                            .await
                                            .map_err(|error| error.to_string())
                                    } else {
                                        Err("This chat's agent does not expose a detailed context-window report.".into())
                                    };
                                    let _ = reply.send(result);
                                }
                                Control::Close { reply } => {
                                    closing.store(true, Ordering::Release);
                                    let result = if supports_close {
                                        connection
                                            .send_request(CloseSessionRequest::new(remote_id.clone()))
                                            .block_task()
                                            .await
                                            .map(|_| json!({"ok":true,"closed":true}))
                                            .map_err(|error| error.to_string())
                                    } else {
                                        connection
                                            .send_notification(CancelNotification::new(remote_id.clone()))
                                            .map(|_| json!({"ok":true,"closed":false}))
                                            .map_err(|error| error.to_string())
                                    };
                                    let _ = reply.send(result);
                                    break;
                                }
                            }
                        }
                        io.shutdown().await;
                        Ok(())
                    }
                })
                .await;
            if let Some(ready) = ready.lock().await.take() {
                let _ = ready.send(Err(result
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "ACP adapter stopped during initialization".into())));
            } else if !stopped_closing.load(Ordering::Acquire) {
                let message = result
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "ACP adapter stopped unexpectedly".into());
                record_transport_failure(&stopped_database, &stopped_session, &message).await;
                let _ = ended_send.send(message);
            };
        });
        let initialized = initialized
            .await
            .map_err(|_| "ACP adapter stopped during initialization".to_string())
            .and_then(|result| result);
        if let Err(message) = initialized {
            record_transport_failure(&database, &session, &message).await;
            return Err(message);
        }
        let session = database
            .get_session(session.id.clone())
            .await?
            .unwrap_or(session);
        Ok(Self {
            brand,
            database,
            session,
            controls,
            ended,
            permissions,
            elicitations,
        })
    }

    async fn control(&self, make: impl FnOnce(Reply) -> Control) -> Result<Value, String> {
        let (reply, receive) = oneshot::channel();
        self.controls
            .send(make(reply))
            .map_err(|_| "ACP adapter stopped".to_string())?;
        receive
            .await
            .map_err(|_| "ACP adapter stopped before replying".to_string())?
    }

    async fn run(&mut self, command: &Command) -> Result<Value, String> {
        match command.kind {
            CommandKind::PromptSend => {
                validate_offered_command(
                    &self.database,
                    &self.session.id,
                    command.fields["text"].as_str().unwrap_or_default(),
                )
                .await?;
                let content = prompt_content(command)?;
                let images = command
                    .fields
                    .get("images")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                self.submit_user_turn(
                    command.fields["text"].as_str().unwrap_or_default(),
                    images,
                    content,
                )
                .await
            }
            CommandKind::AskAnswer => {
                let id = command.fields["askId"].as_str().unwrap_or_default();
                let option = command.fields["optionId"].as_str().unwrap_or_default();
                if self.permissions.is_pending(id).await {
                    self.permissions.answer(id, option).await?;
                } else if self.elicitations.is_pending(id).await {
                    self.elicitations
                        .answer(
                            id,
                            json!({"action":if option=="accept"{"accept"}else{"decline"}}),
                        )
                        .await?;
                } else {
                    return Err(format!("request {id} is no longer pending"));
                }
                Ok(json!({"ok":true}))
            }
            CommandKind::QuestionAnswer => {
                let id = command.fields["requestId"].as_str().unwrap_or_default();
                let (custom_fields, native_questions) =
                    self.elicitations.question_shape(id).await?;
                let answers = command
                    .fields
                    .get("response")
                    .and_then(|response| response["answers"].as_array())
                    .cloned()
                    .unwrap_or_default();
                let content = question_answer_content(&answers, &custom_fields, native_questions);
                self.elicitations
                    .answer(
                        id,
                        json!({"action":"accept","content":content,"answers":answers}),
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::PlanRespond => {
                let id = command.fields["proposalId"].as_str().unwrap_or_default();
                let response = command.fields.get("response").unwrap_or(&Value::Null);
                let action = response["actionId"]
                    .as_str()
                    .ok_or_else(|| "plan action is required".to_string())?;
                if !matches!(action, "approve" | "request_changes") {
                    return Err(format!("unknown plan action {action}"));
                }
                let feedback = response["feedback"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .map(str::to_owned);
                if action == "request_changes" && feedback.is_none() {
                    return Err("plan feedback is required".into());
                }
                // Release the adapter's blocked permission request before sending
                // any steering notification. Waiting for steering first deadlocks
                // adapters that serialize requests behind the plan response.
                self.permissions.answer_plan(id, action).await?;
                if action == "request_changes" {
                    if let Some(feedback) = feedback {
                        let _ = self
                            .control(|reply| Control::Steer {
                                content: vec![ContentBlock::Text(TextContent::new(format!(
                                    "Revise the plan with this feedback: {feedback}"
                                )))],
                                suppress_echo: true,
                                reply,
                            })
                            .await;
                    }
                }
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionStop => {
                self.permissions.cancel_all().await;
                self.elicitations.cancel_all().await;
                let result = self.control(|reply| Control::Cancel { reply }).await?;
                if let Some(message_id) = command
                    .fields
                    .get("retractMessageId")
                    .and_then(Value::as_str)
                {
                    self.database
                        .append(
                            serde_json::from_value(json!({
                                "type":"message.retracted", "sessionId":self.session.id,
                                "seq":0, "at":now(), "messageId":message_id
                            }))
                            .map_err(|error| error.to_string())?,
                        )
                        .await?;
                }
                Ok(result)
            }
            CommandKind::SessionMode => {
                let value = mode_to_acp(
                    self.brand,
                    command.fields["mode"].as_str().unwrap_or_default(),
                );
                self.control(|reply| Control::Mode { value, reply }).await
            }
            CommandKind::SessionModel => {
                let value = command.fields["model"].clone();
                self.control(|reply| Control::Config {
                    target: ConfigTarget::Model,
                    value,
                    reply,
                })
                .await
            }
            CommandKind::SessionEffort => {
                let value = command.fields["effort"].clone();
                self.control(|reply| Control::Config {
                    target: ConfigTarget::Effort,
                    value,
                    reply,
                })
                .await
            }
            CommandKind::SessionCollaborationMode => {
                let value = command.fields["mode"].clone();
                self.control(|reply| Control::Config {
                    target: ConfigTarget::Collaboration,
                    value,
                    reply,
                })
                .await
            }
            CommandKind::SessionConfigOption => {
                let key = command.fields["configId"]
                    .as_str()
                    .filter(|key| !key.is_empty())
                    .ok_or_else(|| "configId is required".to_string())?
                    .to_string();
                let value = command
                    .fields
                    .get("value")
                    .cloned()
                    .ok_or_else(|| "value is required".to_string())?;
                self.control(|reply| Control::Config {
                    target: ConfigTarget::Exact(key),
                    value,
                    reply,
                })
                .await
            }
            CommandKind::AgentStop | CommandKind::AgentPark => {
                let agent_id = command.fields["agentId"].as_str().unwrap_or_default();
                if agent_id.is_empty() {
                    return Err("agentId is required".into());
                }
                let (action, state) = match command.kind {
                    CommandKind::AgentStop => ("stop", "stopped"),
                    CommandKind::AgentPark => ("park", "parked"),
                    _ => unreachable!(),
                };
                let result = self
                    .control(|reply| Control::Subagent {
                        action: action.to_string(),
                        agent_id: agent_id.to_string(),
                        reply,
                    })
                    .await?;
                self.record_agent_control(agent_id, state).await?;
                Ok(result)
            }
            CommandKind::AgentSay => {
                let agent_id = command.fields["agentId"].as_str().unwrap_or_default();
                let text = command.fields["text"].as_str().unwrap_or_default();
                if agent_id.is_empty() || text.trim().is_empty() {
                    return Err("agentId and text are required".into());
                }
                let instruction = format!(
                    "A message for the agent you sent off (id {agent_id}), from the person watching this chat. It could not be handed to it directly, so it comes to you:\n\n{text}"
                );
                let result = self
                    .submit_user_turn(
                        &instruction,
                        &[],
                        vec![ContentBlock::Text(TextContent::new(instruction.clone()))],
                    )
                    .await?;
                self.database
                    .append(
                        serde_json::from_value(json!({
                            "type":"agent.relayed", "sessionId":self.session.id,
                            "seq":0, "at":now(), "agentId":agent_id, "text":text
                        }))
                        .map_err(|error| error.to_string())?,
                    )
                    .await?;
                Ok(result)
            }
            CommandKind::SessionClose => {
                self.permissions.cancel_all().await;
                self.elicitations.cancel_all().await;
                self.database
                    .append(
                        serde_json::from_value(json!({
                            "type":"session.state", "sessionId":self.session.id,
                            "seq":0, "at":now(), "state":"dormant", "label":"Asleep"
                        }))
                        .map_err(|error| error.to_string())?,
                    )
                    .await?;
                Ok(json!({"ok":true}))
            }
            _ => Err("command is not supported by the ACP transport".into()),
        }
    }
}

impl ProviderDriver for AcpDriver {
    fn brand(&self) -> &'static str {
        self.brand
    }

    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
        Box::pin(async move { self.run(command).await })
    }

    fn next<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move {
            Err(self
                .ended
                .recv()
                .await
                .unwrap_or_else(|| "ACP adapter stopped unexpectedly".into()))
        })
    }

    fn window_now<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move { self.control(|reply| Control::WindowNow { reply }).await })
    }

    fn close<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async move { self.control(|reply| Control::Close { reply }).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(state: &str) -> Session {
        Session {
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
            title: Some("Steering".into()),
            state: state.into(),
            origin: "app".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            last_active_at: "2026-09-02T00:00:00Z".into(),
            last_spoke_at: None,
        }
    }

    #[tokio::test]
    async fn a_second_user_turn_steers_the_active_turn_and_stays_durable() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let session = test_session("thinking");
        database.create_session(session.clone()).await.unwrap();
        let (controls, mut requests) = mpsc::unbounded_channel();
        let (_, ended) = mpsc::unbounded_channel();
        let driver = AcpDriver {
            brand: "codex",
            database: database.clone(),
            session,
            controls,
            ended,
            permissions: Arc::new(PermissionBroker::default()),
            elicitations: Arc::new(ElicitationBroker::default()),
        };
        let sent = tokio::spawn(async move {
            driver
                .submit_user_turn(
                    "Use the safer route",
                    &[],
                    vec![ContentBlock::Text(TextContent::new("Use the safer route"))],
                )
                .await
        });
        let control = requests.recv().await.unwrap();
        match control {
            Control::Steer {
                suppress_echo,
                reply,
                ..
            } => {
                assert!(suppress_echo);
                reply.send(Ok(json!({"ok":true}))).unwrap();
            }
            _ => panic!("an active turn must be steered, not queued as another prompt"),
        }
        assert_eq!(sent.await.unwrap().unwrap(), json!({"ok":true}));
        let events = database.events_since("chat-1".into(), 0).await.unwrap();
        assert!(events.iter().any(|event| {
            event.kind == crate::workbench::protocol::EventKind::TextDelta
                && event.fields["text"] == "Use the safer route"
        }));
    }

    #[tokio::test]
    async fn an_immediate_slash_waits_for_the_adapters_initial_catalog() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        database.create_session(test_session("idle")).await.unwrap();
        let publication = database.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            publication
                .append(
                    serde_json::from_value(json!({
                        "type":"session.menu", "sessionId":"chat-1", "seq":0,
                        "at":"2026-09-02T00:00:00Z",
                        "commands":[{"name":"review","description":"Review the changes"}]
                    }))
                    .unwrap(),
                )
                .await
                .unwrap();
        });

        validate_offered_command(&database, "chat-1", "/review please")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn interrupt_releases_every_pending_provider_question_with_its_native_rejection() {
        let permissions = PermissionBroker::default();
        let (permission_answer, permission_result) = oneshot::channel();
        permissions.pending.lock().await.insert(
            "permission-1".into(),
            PendingPermission {
                answer: permission_answer,
                reject: "provider-deny".into(),
            },
        );
        permissions.plan_options.lock().await.insert(
            "permission-1".into(),
            ("provider-allow".into(), "provider-deny".into()),
        );
        permissions.cancel_all().await;
        assert_eq!(permission_result.await.unwrap(), "provider-deny");
        assert!(permissions.pending.lock().await.is_empty());
        assert!(permissions.plan_options.lock().await.is_empty());

        let elicitations = ElicitationBroker::default();
        let (question_answer, question_result) = oneshot::channel();
        elicitations.pending.lock().await.insert(
            "question-1".into(),
            PendingElicitation {
                answer: question_answer,
                schema: None,
                custom_fields: HashMap::new(),
                native_questions: false,
            },
        );
        elicitations.cancel_all().await;
        assert_eq!(question_result.await.unwrap(), json!({"action":"decline"}));
        assert!(elicitations.pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn incomplete_question_answers_stay_pending_instead_of_disappearing() {
        let broker = ElicitationBroker::default();
        let (answer, received) = oneshot::channel();
        broker.pending.lock().await.insert(
            "question-1".into(),
            PendingElicitation {
                answer,
                schema: Some(json!({
                    "type":"object", "properties":{"choice":{"type":"string"}},
                    "required":["choice"]
                })),
                custom_fields: HashMap::new(),
                native_questions: false,
            },
        );

        assert_eq!(
            broker
                .answer("question-1", json!({"action":"accept","content":{}}))
                .await
                .unwrap_err(),
            "no answer was supplied for choice"
        );
        assert!(broker.is_pending("question-1").await);
        broker
            .answer(
                "question-1",
                json!({"action":"accept","content":{"choice":"yes"}}),
            )
            .await
            .unwrap();
        assert_eq!(
            received.await.unwrap(),
            json!({"action":"accept","content":{"choice":"yes"}})
        );
    }

    #[tokio::test]
    async fn native_agent_controls_persist_canonical_lifecycle_edges() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let session = Session {
            id: "chat-1".into(),
            brand: "claude".into(),
            external_id: Some("thread-1".into()),
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            title: None,
            state: "idle".into(),
            origin: "app".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            last_active_at: "2026-09-02T00:00:00Z".into(),
            last_spoke_at: None,
        };
        database.create_session(session.clone()).await.unwrap();
        for (agent_id, tool_id) in [("stop-me", "tool-1"), ("park-me", "tool-2")] {
            for value in [
                json!({"type":"agent.started","sessionId":session.id,"seq":0,"at":"2026-09-02T00:00:00Z","agentId":agent_id,"toolCallId":tool_id,"kind":"task","what":"work"}),
                json!({"type":"agent.progress","sessionId":session.id,"seq":0,"at":"2026-09-02T00:00:01Z","agentId":agent_id,"seconds":9,"tokens":120,"calls":3,"model":"provider-model","state":"running"}),
            ] {
                database
                    .append(serde_json::from_value(value).unwrap())
                    .await
                    .unwrap();
            }
        }
        let (controls, _) = mpsc::unbounded_channel();
        let (_, ended) = mpsc::unbounded_channel();
        let driver = AcpDriver {
            brand: "claude",
            database: database.clone(),
            session,
            controls,
            ended,
            permissions: Arc::new(PermissionBroker::default()),
            elicitations: Arc::new(ElicitationBroker::default()),
        };

        driver
            .record_agent_control("stop-me", "stopped")
            .await
            .unwrap();
        driver
            .record_agent_control("park-me", "parked")
            .await
            .unwrap();

        let agents = database.projected_agents("chat-1".into()).await.unwrap();
        let stopped = agents
            .iter()
            .find(|agent| agent["id"] == "stop-me")
            .unwrap();
        let parked = agents
            .iter()
            .find(|agent| agent["id"] == "park-me")
            .unwrap();
        assert_eq!(stopped["state"], "stopped");
        assert_eq!(parked["state"], "parked");
        for agent in [stopped, parked] {
            assert_eq!(agent["seconds"], 9);
            assert_eq!(agent["tokens"], 120);
            assert_eq!(agent["calls"], 3);
            assert_eq!(agent["model"], "provider-model");
        }
        let events = database.events_since("chat-1".into(), 0).await.unwrap();
        assert!(events.iter().any(|event| {
            event.kind == super::super::super::protocol::EventKind::AgentFinished
                && event.fields["agentId"] == "stop-me"
        }));
        assert!(events.iter().any(|event| {
            event.kind == super::super::super::protocol::EventKind::AgentProgress
                && event.fields["agentId"] == "park-me"
                && event.fields["state"] == "parked"
        }));
    }

    #[tokio::test]
    async fn live_close_persists_the_same_dormant_event_as_an_already_sleeping_chat() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let session = Session {
            id: "chat-1".into(),
            brand: "claude".into(),
            external_id: Some("thread-1".into()),
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            title: None,
            state: "idle".into(),
            origin: "app".into(),
            created_at: "2026-09-02T00:00:00Z".into(),
            last_active_at: "2026-09-02T00:00:00Z".into(),
            last_spoke_at: None,
        };
        database.create_session(session.clone()).await.unwrap();
        let (controls, _) = mpsc::unbounded_channel();
        let (_, ended) = mpsc::unbounded_channel();
        let mut driver = AcpDriver {
            brand: "claude",
            database: database.clone(),
            session,
            controls,
            ended,
            permissions: Arc::new(PermissionBroker::default()),
            elicitations: Arc::new(ElicitationBroker::default()),
        };

        driver
            .run(&Command {
                kind: CommandKind::SessionClose,
                fields: serde_json::Map::from_iter([("sessionId".into(), json!("chat-1"))]),
            })
            .await
            .unwrap();

        assert_eq!(
            database
                .get_session("chat-1".into())
                .await
                .unwrap()
                .unwrap()
                .state,
            "dormant"
        );
        let events = database.events_since("chat-1".into(), 0).await.unwrap();
        assert!(events.iter().any(|event| {
            event.kind == super::super::super::protocol::EventKind::SessionState
                && event.fields["state"] == "dormant"
                && event.fields["label"] == "Asleep"
        }));
    }

    #[test]
    fn acp_config_options_fill_the_existing_provider_neutral_menu() {
        let menu = menu_fields_with_local_catalog(
            "codex",
            None,
            &json!({
                "currentModeId":"agent", "availableModes":[
                    {"id":"read-only"},{"id":"agent"},{"id":"agent-full-access"}
                ]
            }),
            &json!([
                {"id":"model","category":"model","currentValue":"gpt-5.6-sol","options":[{"value":"gpt-5.6-sol","name":"GPT-5.6-Sol"}]},
                {"id":"reasoning_effort","category":"thought_level","currentValue":"high","options":[{"value":"high","name":"High"}]},
                {"id":"collaboration_mode","category":"collaboration_mode","currentValue":"plan","options":[{"value":"plan","name":"Plan"}]},
                {"id":"fast-mode","name":"Fast mode","description":"Run with lower latency","type":"boolean","currentValue":false}
            ]),
            &Value::Null,
            &json!(["stop", "say"]),
            &json!([{"name":"reviewer"}]),
        );
        let menu = menu_event("local", menu).unwrap();
        let menu = serde_json::to_value(menu).unwrap();
        assert_eq!(
            menu["permissionModes"],
            json!(["untrusted", "on-request", "never"])
        );
        assert_eq!(menu["models"][0]["value"], "gpt-5.6-sol");
        assert_eq!(menu["efforts"][0]["value"], "high");
        assert_eq!(menu["collaborationModes"][0]["value"], "plan");
        assert_eq!(menu["configOptions"][0]["id"], "fast-mode");
        assert_eq!(menu["configOptions"][0]["currentValue"], false);
        assert_eq!(menu["agentControls"], json!(["stop", "say"]));
        assert_eq!(menu["agentDefinitions"], json!([{"name":"reviewer"}]));
    }

    #[test]
    fn steering_uses_the_option_ids_the_agent_advertised() {
        let options = json!([
            {"id":"engine","category":"model","currentValue":"one"},
            {"id":"thinking_effort","category":"thought_level","currentValue":"high"},
            {"id":"teamwork","category":"collaboration_mode","currentValue":"solo"}
        ]);
        assert_eq!(
            config_option_id(&options, &ConfigTarget::Model).as_deref(),
            Some("engine")
        );
        assert_eq!(
            config_option_id(&options, &ConfigTarget::Effort).as_deref(),
            Some("thinking_effort")
        );
        assert_eq!(
            config_option_id(&options, &ConfigTarget::Collaboration).as_deref(),
            Some("teamwork")
        );
        assert_eq!(
            config_option_id(&options, &ConfigTarget::Exact("missing".into())),
            None
        );
    }

    #[test]
    fn slash_commands_are_validated_before_a_turn_is_persisted() {
        let commands = json!([
            {"name":"compact"},
            {"name":"$review","execution":"skill"}
        ]);
        let commands = commands.as_array().unwrap();
        assert_eq!(slash_name("  /compact  "), Some("compact"));
        assert_eq!(slash_name("/$review focus on safety"), Some("$review"));
        assert_eq!(slash_name("ordinary prose"), None);
        assert_eq!(slash_name("//not-a-command"), None);
        assert!(command_is_offered("compact", commands).is_ok());
        assert!(command_is_offered("$review", commands).is_ok());
        assert_eq!(
            command_is_offered("invented", commands).unwrap_err(),
            "/invented is not available in this session."
        );
        assert_eq!(
            command_is_offered("invented", &[]).unwrap_err(),
            "/invented is not available in this provider."
        );
    }

    #[test]
    fn local_menu_keeps_the_discovered_cross_runtime_catalog() {
        let menu = menu_fields_with_local_catalog(
            super::super::super::local::BRAND,
            Some("ollama::qwen3"),
            &json!({"currentModeId":"auto","availableModes":[{"id":"auto"}]}),
            &json!([
                {"id":"provider","currentValue":"ollama","options":[{"value":"ollama","name":"Ollama"},{"value":"openai","name":"OpenAI"}]},
                {"id":"model","category":"model","currentValue":"qwen3","options":[{"value":"qwen3","name":"qwen3"}]}
            ]),
            &json!([
                {"value":"ollama::qwen3","displayName":"qwen3","runtime":"ollama"},
                {"value":"openai-compatible::gemma","displayName":"gemma","runtime":"openai-compatible"}
            ]),
            &json!([]),
            &json!([]),
        );
        assert_eq!(menu["currentModel"], "ollama::qwen3");
        assert_eq!(menu["models"].as_array().unwrap().len(), 2);
        assert_eq!(menu["models"][1]["value"], "openai-compatible::gemma");
        assert!(menu["configOptions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|option| option["id"] != "provider"));
        assert_eq!(menu["agentControls"], json!([]));
    }

    #[test]
    fn form_elicitation_schema_becomes_the_shared_question_contract() {
        let fields = elicitation_fields(
            &json!({"properties":{
                "choice":{"title":"Choice","description":"Pick one","oneOf":[
                    {"const":"a","title":"A"},{"const":"b","title":"B"}
                ]},
                "details":{"title":"Details","type":"string"}
            }}),
            None,
        );
        assert_eq!(fields[0]["selection"], "single");
        assert_eq!(fields[0]["options"][1]["id"], "b");
        assert_eq!(fields[1]["selection"], "text");
        assert_eq!(fields[1]["allowCustom"], true);
    }

    #[test]
    fn native_question_companions_fold_into_one_rich_shared_field() {
        let schema = json!({"properties":{
            "question_0":{
                "title":"Approach", "type":"string", "oneOf":[{
                    "const":"safe", "title":"Safe", "description":"Prefer safety",
                    "_meta":{"_claude/askUserQuestionOption":{"preview":"**Preview**"}}
                }]
            },
            "question_0_custom":{
                "type":"string", "title":"Other",
                "_meta":{"_askUserQuestionCustomAnswer":{
                    "questionId":"question_0", "isCustomAnswer":true
                }}
            }
        }});
        let fields = elicitation_fields(&schema, Some("Which approach?"));
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0]["id"], "question_0");
        assert_eq!(fields[0]["prompt"], "Which approach?");
        assert_eq!(fields[0]["allowCustom"], true);
        assert_eq!(fields[0]["options"][0]["preview"], "**Preview**");

        let (custom, native) = question_schema_shape(&schema);
        assert!(native);
        assert_eq!(custom["question_0"], "question_0_custom");
        let content = question_answer_content(
            &[json!({
                "questionId":"question_0", "optionIds":["safe"],
                "customText":"A custom route", "note":"Keep the fallback"
            })],
            &custom,
            native,
        );
        assert_eq!(content["question_0_custom"], "A custom route");
        assert_eq!(content["__atelier_note_question_0"], "Keep the fallback");
        assert!(!content.contains_key("question_0"));
    }

    #[test]
    fn form_elicitation_preserves_typed_primitives_and_constants() {
        let schema = json!({"properties":{
            "enabled":{"title":"Enabled","type":"boolean"},
            "retries":{"title":"Retries","type":"integer"},
            "ratio":{"title":"Ratio","type":"number"},
            "levels":{"title":"Levels","type":"array","items":{"type":"integer"},"enum":[1,2]},
            "choice":{"title":"Choice","oneOf":[{"const":7,"title":"Seven"},{"const":"auto","title":"Automatic"}]}
        }});
        let fields = elicitation_fields(&schema, None);
        let field = |id: &str| fields.iter().find(|field| field["id"] == id).unwrap();
        assert_eq!(
            field("enabled")["options"],
            json!([{"id":"true","label":"Yes"},{"id":"false","label":"No"}])
        );
        assert_eq!(field("levels")["selection"], "multiple");
        assert_eq!(field("levels")["options"][0]["id"], "1");
        assert_eq!(field("choice")["options"][0]["id"], "7");
        let typed = typed_elicitation_content(
            &schema,
            &json!({
                "enabled":"true", "retries":"3", "ratio":"0.5", "levels":["1","2"], "choice":"7"
            }),
        );
        assert_eq!(
            typed,
            json!({"enabled":true,"retries":3,"ratio":0.5,"levels":[1,2],"choice":7})
        );
    }

    #[test]
    fn codex_mode_names_round_trip_without_changing_the_frontend_contract() {
        for mode in ["untrusted", "on-request", "never"] {
            assert_eq!(mode_from_acp("codex", &mode_to_acp("codex", mode)), mode);
        }
    }

    #[test]
    fn session_policy_metadata_keeps_a_provider_neutral_copy() {
        let codex = session_meta("codex", "shared policy");
        assert_eq!(codex["atelier"]["sessionPolicy"], "shared policy");
        assert!(!codex.contains_key("systemPrompt"));

        let claude = session_meta("claude", "shared policy");
        assert_eq!(claude["atelier"]["sessionPolicy"], "shared policy");
        assert_eq!(claude["systemPrompt"]["type"], "preset");
        assert_eq!(claude["systemPrompt"]["preset"], "claude_code");
        assert_eq!(claude["systemPrompt"]["append"], "shared policy");
    }
}
