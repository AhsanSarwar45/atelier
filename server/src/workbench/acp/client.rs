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

/// How long a chat must be silent before its turn is read as held rather than
/// working. Everything a working chat does says so in events well inside this:
/// a model mid-sentence, a tool's progress beats, a helper's own output.
const HELD_TURN_GRACE: u64 = 25;

/// How often the watch after a stop looks, and how long it keeps looking. The
/// hold it rescues starts at the stop; a chat still working minutes later got
/// past it, and a turn that wedges after that is not this turn's story.
const HELD_TURN_TICK: u64 = 5;
const HELD_TURN_WATCH: u64 = 300;

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

/// How this client introduces itself.
///
/// `live` says whether an agent it sends work off to may be handed over as a
/// session of its own. That is worth having on a chat being driven — a helper
/// gets its own transcript, its own clock and its own bill — but it is a
/// promise about a running agent, and a replay has none: the bundled claude
/// adapter, told this client takes native subagent sessions, withholds every
/// `Task` call from a `session/load` and sends nothing in their place, so the
/// delegation vanishes from a chat read back rather than arriving in a better
/// shape. Measured against the pinned adapter (claude-agent-acp 0.73.0): the
/// same load answers with the call and its result once the promise is dropped
/// (bw-t26l.20).
/// The seven `fs/*` and `terminal/*` handlers, attached to a builder.
///
/// Every handshake this app makes says `fs` and `terminal` are supported, and
/// only the live one had the handlers behind that claim. A replay or a
/// discovery client that an agent took at its word got `method_not_found` back
/// for a capability it had just been promised. A macro rather than a function
/// because a builder's type is the whole chain built so far (bw-t26l.20).
macro_rules! serving_client_io {
    ($builder:expr, $io:expr) => {{
        let read_io = $io.clone();
        let write_io = $io.clone();
        let create_terminal_io = $io.clone();
        let terminal_output_io = $io.clone();
        let release_terminal_io = $io.clone();
        let wait_terminal_io = $io.clone();
        let kill_terminal_io = $io.clone();
        $builder
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
            )
    }};
}

/// The one version of ACP this client speaks.
///
/// Sent on every handshake and checked against what comes back: the agent
/// answers with the version it will actually use, which is not always the one
/// it was asked for.
const SPEAKS: u64 = 1;

/// Whether the version the agent came back with is one this client can speak.
///
/// The handshake negotiates: the agent replies with the version it will use,
/// and a client that cannot speak it is told to stop there rather than talk
/// past it. Nothing read this, so an agent that answered "0" -- the pre-release
/// version, which this app has never spoken -- was carried on with, and the
/// failure surfaced later as unexplained nonsense somewhere in the middle of a
/// turn instead of as one sentence at the door (bw-t26l.20).
///
/// Only a STATED mismatch refuses. An adapter that omits the field has not said
/// it is speaking something else, and the ones this app bundles all speak 1.
fn agreed_version(initialized: &Value) -> Result<(), agent_client_protocol::Error> {
    match initialized["protocolVersion"].as_u64() {
        Some(agreed) if agreed != SPEAKS => Err(acp_error(format!(
            "this agent speaks ACP {agreed}; this app speaks {SPEAKS}"
        ))),
        _ => Ok(()),
    }
}

fn initialize_request(live: bool) -> Result<UntypedMessage, agent_client_protocol::Error> {
    // `subagent-transcript` and `jetbrains` are extensions, and ACP puts an
    // extension under `_meta`. `subagents` is one too -- there is no such field
    // in the spec -- but the adapters this app ships read it off the top level,
    // so it is stated in both places: under `_meta` where the protocol says an
    // extension lives, and beside the real capabilities where the shipped
    // adapter looks for it (bw-t26l.20).
    // `terminal_output` is the other half of ACP's own terminals, for a
    // provider that runs the shell itself rather than asking this client to.
    // Said, a command's tool call arrives as `{"type":"terminal"}` with the
    // bytes and the exit code beside it under `_meta`; unsaid, it arrives as a
    // paragraph of text with no exit code in it, which is what the screen used
    // to draw a shell from (bw-t26l.20).
    let mut meta =
        json!({"subagent-transcript": true, "subagents": {}, "terminal_output": true});
    if live {
        meta["jetbrains"] =
            json!({"air": {"version":1,"capabilities":["nativeSubagentSessions"]}});
    }
    UntypedMessage::new(
        "initialize",
        json!({
            "protocolVersion": SPEAKS,
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
                "_meta": meta
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
                    .send_request(initialize_request(false)?)
                    .block_task()
                    .await?;
                agreed_version(&initialized)?;
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

async fn one_shot_request(
    brand: &str,
    model: Option<&str>,
    capability: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let config = adapter::launch_config(brand, model)
        .ok_or_else(|| format!("bundled {brand} ACP adapter is incomplete or unavailable"))?;
    let capability = capability.map(str::to_string);
    let method = method.to_string();
    agent_client_protocol::Client
        .builder()
        .connect_with(AcpAgent::new(config), async move |connection: ConnectionTo<Agent>| {
            let initialized = connection.send_request(initialize_request(false)?).block_task().await?;
            agreed_version(&initialized)?;
            if capability
                .as_deref()
                .is_some_and(|path| initialized.pointer(path).is_none())
            {
                return Err(acp_error(format!("agent does not advertise {method}")));
            }
            if method == "authenticate" {
                let requested = params["methodId"].as_str().unwrap_or_default();
                let offered = initialized["authMethods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|entry| entry["id"] == requested));
                if !offered {
                    return Err(acp_error("agent did not advertise that authentication method"));
                }
            }
            connection
                .send_request(UntypedMessage::new(&method, params)?)
                .block_task()
                .await
        })
        .await
        .map_err(|error| error.to_string())
}

pub async fn authenticate(brand: &str, method_id: &str) -> Result<Value, String> {
    one_shot_request(
        brand,
        None,
        None,
        "authenticate",
        json!({"methodId":method_id}),
    )
    .await
}

pub async fn logout(brand: &str) -> Result<Value, String> {
    one_shot_request(
        brand,
        None,
        Some("/agentCapabilities/auth/logout"),
        "logout",
        json!({}),
    )
    .await
}

pub async fn delete_session(session: &Session) -> Result<Value, String> {
    let external_id = session
        .external_id
        .as_deref()
        .ok_or_else(|| "saved session has no provider id".to_string())?;
    one_shot_request(
        &session.brand,
        session.model.as_deref(),
        Some("/agentCapabilities/sessionCapabilities/delete"),
        "session/delete",
        json!({"sessionId":external_id}),
    )
    .await
}

pub async fn fork_session(session: &Session) -> Result<Value, String> {
    let external_id = session
        .external_id
        .as_deref()
        .ok_or_else(|| "saved session has no provider id".to_string())?;
    one_shot_request(
        &session.brand,
        session.model.as_deref(),
        Some("/agentCapabilities/sessionCapabilities/fork"),
        "session/fork",
        json!({"sessionId":external_id,"cwd":session.cwd,"mcpServers":[]}),
    )
    .await
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
    // A replay serves the same `fs/*` and `terminal/*` calls a live chat does.
    // It advertises them either way -- the handshake is the same one -- and
    // until now there was nothing behind that claim here: an agent that took
    // the client at its word mid-load got `method_not_found` for a capability
    // it had just been promised (bw-t26l.20).
    let io = ClientIo::new(cwd.clone())?;
    let updates_io = io.clone();
    let client = agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: UntypedMessage, _connection| {
                if notification.method() != "session/update" {
                    return Ok(());
                }
                let raw =
                    super::client_io::with_terminal_output(&updates_io, notification.params()).await;
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
    let client = serving_client_io!(client, io);
    let finish_normalizer = normalizer.clone();
    let finish_events = collected.clone();
    let finish_session = local_id.clone();
    let finish_brand = brand.clone();
    let (modes, config_options, agent_controls) = client
        .connect_with(
            AcpAgent::new(config),
            async move |connection: ConnectionTo<Agent>| {
                let initialized = connection
                    .send_request(initialize_request(false)?)
                    .block_task()
                    .await?;
                agreed_version(&initialized)?;
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
    answer: oneshot::Sender<PermissionAnswer>,
}

/// What a permission card was settled by.
///
/// A stopped turn is not a refusal. ACP is explicit that a client sending
/// `session/cancel` "MUST respond to all pending `session/request_permission`
/// requests with this `Cancelled` outcome"
/// (agent-client-protocol-schema, `v1/client.rs`, `RequestPermissionOutcome`).
/// This used to answer them with the agent's own rejection option instead, so
/// pressing Stop while a card was up was recorded by the agent as the owner
/// refusing that tool — and an agent that remembers refusals carried a "no"
/// the owner never said into every turn after it (bw-t26l.20).
enum PermissionAnswer {
    /// The owner pressed one of the options the agent offered.
    Chose(String),
    /// The turn was stopped before he pressed anything.
    Cancelled,
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
            .send(PermissionAnswer::Chose(option.to_string()))
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
            let _ = permission.answer.send(PermissionAnswer::Cancelled);
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

/// The message an ACP failure is recorded under, and whether it is a sign-in.
///
/// `Display` for the crate's error prints the message and drops the code, so
/// anything that stringifies first can no longer tell -32000 from a crash. Read
/// the code here, while it is still there.
fn transport_failure(error: &agent_client_protocol::Error) -> (String, bool) {
    let signing_in = i32::from(error.code) == -32000;
    let said = error.to_string();
    if signing_in && said.trim().is_empty() {
        return ("This provider needs you to sign in.".into(), true);
    }
    (said, signing_in)
}

async fn record_transport_failure(database: &ChatDb, session: &Session, message: &str) {
    record_failure(database, session, message, false).await
}

async fn record_failure(
    database: &ChatDb,
    session: &Session,
    message: &str,
    signing_in: bool,
) {
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
    // "Provider unavailable" for a provider that is perfectly available and
    // simply wants signing into reads as a broken install, and it offered
    // nothing to do about it. The app already knows how to draw a sign-in --
    // `provider-messages.ts` has had the words for it all along -- it was only
    // ever told by sniffing the provider's prose (bw-t26l.20).
    let mut events = vec![
        json!({"type":"error", "sessionId":session.id, "seq":0, "at":now(), "message":message, "fatal":true, "source":"acp"}),
        json!({"type":"session.state", "sessionId":session.id, "seq":0, "at":now(), "state":"errored",
            "label":if signing_in { "Sign in to continue" } else { "Provider unavailable" }}),
    ];
    if signing_in {
        events.insert(
            0,
            json!({"type":"provider.message", "sessionId":session.id, "seq":0, "at":now(),
                "signal":crate::workbench::provider_messages::needs_signing_in(message)}),
        );
    }
    let events = events
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();
    let _ = database.append_many(events).await;
}

async fn permission(
    request: RequestPermissionRequest,
    database: ChatDb,
    local_session_id: String,
    broker: Arc<PermissionBroker>,
    normalizer: Option<Arc<Mutex<AcpNormalizer>>>,
) -> Result<RequestPermissionResponse, agent_client_protocol::Error> {
    let raw = serde_json::to_value(&request).map_err(acp_error)?;
    // A question a sent-away helper raised is stamped with the call that sent
    // it, in the same place the helper's work is: `_meta.claudeCode`. Without
    // it every question read as the chat's own, so a helper's question was
    // drawn with no word about who was waiting on the answer, and the helper's
    // own pane — which finds its rows by that call — never showed the question
    // at all (measured against the pinned claude adapter, 2026-09-03).
    let sent_by = match raw.pointer("/toolCall/_meta/claudeCode/parentToolUseId") {
        Some(Value::String(call)) if !call.is_empty() => match normalizer.as_ref() {
            Some(state) => Value::String(state.lock().await.agent_asking(call)),
            None => Value::String(call.clone()),
        },
        _ => Value::Null,
    };
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
    broker
        .pending
        .lock()
        .await
        .insert(ask_id.clone(), PendingPermission { answer });
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
            "parentToolCallId":sent_by,
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
    let selected = match receive.await.map_err(acp_error)? {
        PermissionAnswer::Chose(option) => option,
        // Stopped before he answered. The card is closed saying so rather than
        // left open forever, and the agent is told the turn was cancelled
        // rather than handed a refusal the owner never made. No "Working"
        // state follows it: the turn is over, and the stop path has already
        // said where the chat came to rest.
        PermissionAnswer::Cancelled => {
            let resolved = if plan.is_some() {
                json!({"type":"plan.resolved", "sessionId":local_session_id, "seq":0, "at":now(),
                    "proposalId":ask_id, "status":"dismissed",
                    "actionId":crate::workbench::lifecycle::NOBODY_ANSWERED, "feedback":null})
            } else {
                json!({"type":"ask.resolved", "sessionId":local_session_id, "seq":0, "at":now(),
                    "askId":ask_id, "chosen":crate::workbench::lifecycle::NOBODY_ANSWERED})
            };
            database
                .append_many(vec![event(resolved)?])
                .await
                .map_err(acp_error)?;
            return Ok(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled,
            ));
        }
    };
    // Whether the plan was approved is settled by the kind of the option that
    // was pressed, not by the letters in its id. The ids are the agent's own
    // vocabulary — Claude approves with "allow-once" and refuses with "reject",
    // and reading either for the substring "allow" is a guess that happens to
    // hold for that one agent and for nothing else (bw-t26l.20).
    let resolved = if plan.is_some() {
        let approved = raw["options"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|option| option["optionId"] == selected.as_str())
            .and_then(|option| option["kind"].as_str())
            .is_some_and(|kind| kind.starts_with("allow"));
        json!({"type":"plan.resolved", "sessionId":local_session_id, "seq":0, "at":now(),
            "proposalId":ask_id, "status":if approved{"approved"}else{"changes_requested"},
            "actionId":if approved{"approve"}else{"request_changes"}})
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

/// Whether a notification was the agent reporting that a URL elicitation is
/// over, and if so, closing it.
///
/// A URL elicitation finishes somewhere else entirely — the sign-in page in the
/// owner's browser — so the agent, watching for the callback, is the one who
/// knows it is done, and says so with `elicitation/complete`. Every notification
/// but `session/update` used to be dropped, which left the "Open sign-in link"
/// card standing after the sign-in had already succeeded and made the only way
/// past it a Continue click that told the agent nothing it did not already know
/// (bw-t26l.20).
///
/// Accepting is what that click would have done, so the card resolves and the
/// prompt goes on. A completion for an elicitation that is no longer pending is
/// not an error: the person may have clicked Continue first, and the agent is
/// entitled to say so anyway.
async fn elicitation_completed(broker: &ElicitationBroker, method: &str, params: &Value) -> bool {
    if method != "elicitation/complete" {
        return false;
    }
    if let Some(id) = params["elicitationId"].as_str() {
        let _ = broker.answer(id, json!({"action":"accept"})).await;
    }
    true
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

/// The base64 payload and the media type of one attached picture.
///
/// The app carries a picture as `{mime, dataUrl}`: that is the shape the writing
/// box sends, the shape the transcript is drawn from, and the shape every other
/// reader of a picture in this tree expects. ACP wants the two halves apart, so
/// the data URL has to be taken apart here — and reading `data`, `base64` and
/// `mimeType` keys that nothing in the app has ever set meant the payload came
/// back empty every time, the block was dropped by the emptiness guard, and the
/// prompt went out as text alone. The picture sat in the person's own bubble
/// looking delivered while the agent answered "there was no picture attached to
/// your message" and went looking for one on disk instead (bw-t26l.20).
///
/// The older key names are still read first, so a caller that already holds the
/// two halves apart does not have to build a data URL to hand them over.
fn attached_picture(image: &Value) -> Option<(String, String)> {
    let (declared, encoded) = match image["dataUrl"]
        .as_str()
        .and_then(|url| url.strip_prefix("data:"))
        .and_then(|rest| rest.split_once(";base64,"))
    {
        Some((mime, payload)) => (Some(mime), Some(payload)),
        None => (None, None),
    };
    let data = image["data"]
        .as_str()
        .or_else(|| image["base64"].as_str())
        .or(encoded)
        .filter(|data| !data.is_empty())?;
    let mime = image["mimeType"]
        .as_str()
        .or_else(|| image["mime"].as_str())
        .or(declared)
        .filter(|mime| !mime.is_empty())
        .unwrap_or("image/png");
    Some((data.to_string(), mime.to_string()))
}

/// What is sent for a message, with the attachments the agent will take.
///
/// `takes_pictures` is what the agent said about `promptCapabilities.image`.
/// An agent that cannot take one is told so in words rather than handed a
/// block it will refuse: the refusal fails the entire `session/prompt`, and
/// what is lost with it is the sentence the owner typed (bw-t26l.20). The
/// picture cannot be delivered either way; the difference is whether his turn
/// happens and he is told why, or neither.
fn prompt_content(command: &Command, takes_pictures: bool) -> Result<Vec<ContentBlock>, String> {
    let text = command
        .fields
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "text is required".to_string())?;
    let mut content = vec![ContentBlock::Text(TextContent::new(text))];
    let mut refused = 0usize;
    for image in command
        .fields
        .get("images")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some((data, mime)) = attached_picture(image) {
            if !takes_pictures {
                refused += 1;
                continue;
            }
            content.push(ContentBlock::Image(ImageContent::new(data, mime)));
        }
    }
    if refused > 0 {
        content.push(ContentBlock::Text(TextContent::new(format!(
            "[{refused} {} left off: this agent says it cannot be sent pictures.]",
            if refused == 1 { "picture was" } else { "pictures were" }
        ))));
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

/// Whether the agent said it has this mode, in the one place ACP says so.
///
/// `session/set_mode` is not a request to invent a mode; it names one of the
/// modes the agent listed in `availableModes` at `session/new`. Atelier's
/// saved permission mode is its own, and an agent under no obligation to share
/// its vocabulary — goose lists no modes at all — answers a mode it never
/// offered with a fatal `Invalid params`, which is how a local chat that had
/// just started correctly ended up reading 'Provider unavailable'. So the list
/// is consulted before the ask. An agent that lists nothing is asked for
/// nothing and keeps whatever mode it starts in, which the menu then reports
/// honestly (bw-u6cl.11).
fn offers_mode(modes: &Value, mode: &str) -> bool {
    modes["availableModes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|offered| offered["id"] == mode)
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
    providers: &Value,
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
    // Asked for once, at the handshake, and carried on every menu after it: a
    // menu rebuilt for a model change that dropped the endpoint would take the
    // line off the screen for a reason that has nothing to do with it.
    menu["providers"] = providers.clone();
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
    /// Whether this agent said it can be sent a picture.
    ///
    /// ACP gates image blocks in a prompt on `promptCapabilities.image`
    /// (schema `v1/content.rs`: "Requires the `image` prompt capability when
    /// included in prompts"). We never read it and always sent the block, so
    /// attaching a picture to a chat on an agent that cannot take one failed
    /// the whole `session/prompt` — losing what he had typed along with the
    /// attachment, under a red error that named neither (bw-t26l.20). Set
    /// from the initialize answer; true until it says otherwise, because an
    /// agent that declares nothing is not thereby refusing.
    takes_pictures: Arc<AtomicBool>,
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

    /**
     * The turn a stopped helper leaves open, and the only thing that closes it.
     *
     * The kit holds a turn's `session/prompt` open while the helpers that turn
     * spawned are still live, so their output, their questions and the summary
     * the model writes afterwards all land inside the turn. A helper the reader
     * STOPS never wakes the model: no summary is written, no idle follows, and
     * the adapter's own note calls this an accepted residual — naming the two
     * things that settle a held turn, a cancel or the next prompt. Left alone
     * the chat says "Working" with nothing working, until somebody speaks
     * (measured 2026-09-03: the last event of such a turn at 10:02:33, and
     * silence for the five minutes after it).
     *
     * Cancelling is the reader's own instruction carried out, not a guess: they
     * stopped the only work outstanding. It is only sent when the chat is quiet
     * — no event of any kind for a while — still counted as working, and has
     * nothing of its own left running. A chat still doing something says so, in
     * events, and keeps its turn.
     *
     * The watch waits for that quiet rather than sampling for it once. A stop
     * usually wakes the model one last time (measured: the stop at 10:16:38,
     * the model's closing sentence at 10:16:42, then nothing), so a single look
     * a few seconds later finds the chat busy, walks away, and leaves the wedge
     * it was written to clear standing.
     */
    fn rescue_held_turn(&self) {
        let database = self.database.clone();
        let controls = self.controls.clone();
        let session_id = self.session.id.clone();
        tokio::spawn(async move {
            let tick = std::time::Duration::from_secs(HELD_TURN_TICK);
            let grace = std::time::Duration::from_secs(HELD_TURN_GRACE);
            let started = std::time::Instant::now();
            let mut quiet_since = started;
            let Ok(mut seen) = database.event_count(session_id.clone()).await else {
                return;
            };
            while started.elapsed() < std::time::Duration::from_secs(HELD_TURN_WATCH) {
                tokio::time::sleep(tick).await;
                let Ok(count) = database.event_count(session_id.clone()).await else {
                    return;
                };
                if count != seen {
                    seen = count;
                    quiet_since = std::time::Instant::now();
                    continue;
                }
                if quiet_since.elapsed() < grace {
                    continue;
                }
                let Ok(Some(session)) = database.get_session(session_id.clone()).await else {
                    return;
                };
                if !turn_is_active(&session.state) {
                    return;
                }
                let Ok(agents) = database.projected_agents(session_id.clone()).await else {
                    return;
                };
                // A helper still running — or parked, which is running out of
                // sight — is a turn held for a reason. Wait it out rather than
                // giving up: the reader may stop that one too.
                if agents.iter().any(|agent| {
                    !matches!(agent["state"].as_str(), Some("done" | "failed" | "stopped"))
                }) {
                    quiet_since = std::time::Instant::now();
                    continue;
                }
                let (reply, _answer) = oneshot::channel();
                let _ = controls.send(Control::Cancel { reply });
                return;
            }
        });
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
        let takes_pictures = Arc::new(AtomicBool::new(true));
        let task_takes_pictures = takes_pictures.clone();
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
            let updates_io = task_io.clone();
            let updates_replaying = replaying.clone();
            let permission_db = task_database.clone();
            let permission_session = task_session.id.clone();
            let permission_broker = task_permissions.clone();
            let permission_normalizer = normalizer.clone();
            let elicitation_db = task_database.clone();
            let elicitation_session = task_session.id.clone();
            let elicitation_broker = task_elicitations.clone();
            let completed_elicitations = task_elicitations.clone();
            let stopped_database = task_database.clone();
            let stopped_session = task_session.clone();
            let stopped_closing = task_closing.clone();
            let client = agent_client_protocol::Client
                .builder()
                .on_receive_notification(
                    async move |notification: UntypedMessage, _connection| {
                        if elicitation_completed(
                            &completed_elicitations,
                            notification.method(),
                            notification.params(),
                        )
                        .await
                        {
                            return Ok(());
                        }
                        if notification.method() != "session/update" {
                            return Ok(());
                        }
                        if updates_replaying.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        let raw = super::client_io::with_terminal_output(
                            &updates_io,
                            notification.params(),
                        )
                        .await;
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
                            Some(permission_normalizer.clone()),
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
                ;
            let client = serving_client_io!(client, task_io);
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
                            .send_request(initialize_request(true)?)
                            .block_task()
                            .await?;
                        agreed_version(&initialized)?;
                        let agent_controls = initialized
                            .pointer("/_meta/atelier/subagentControls")
                            .filter(|controls| controls.is_array())
                            .cloned()
                            .unwrap_or_else(|| json!([]));
                        let supports_close = initialized
                            .pointer("/agentCapabilities/sessionCapabilities/close")
                            .is_some();
                        // Only a stated `false` is a refusal. An agent that
                        // declares no promptCapabilities at all has not said
                        // it cannot take a picture, and the ones this app
                        // bundles all can.
                        if initialized.pointer("/agentCapabilities/promptCapabilities/image")
                            == Some(&Value::Bool(false))
                        {
                            task_takes_pictures.store(false, Ordering::SeqCst);
                        }
                        // Which API the agent is actually talking to. An agent
                        // that says it has providers is asked; one that does
                        // not is not, and its chat says nothing about an
                        // endpoint it cannot report (bw-t26l.20).
                        let providers = if initialized
                            .pointer("/agentCapabilities/providers")
                            .is_some()
                        {
                            connection
                                .send_request(UntypedMessage::new("providers/list", json!({}))?)
                                .block_task()
                                .await
                                .ok()
                                .and_then(|answer| answer.get("providers").cloned())
                                .filter(Value::is_array)
                                .unwrap_or_else(|| json!([]))
                        } else {
                            json!([])
                        };
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
                            if !desired_mode.is_empty()
                                && modes["currentModeId"] != desired_mode
                                && offers_mode(&modes, &desired_mode)
                            {
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
                            &providers,
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
                                    let local_model = task_session.model.clone();
                                    let spawned = connection.spawn(async move {
                                        let result = prompt_connection
                                            .send_request(PromptRequest::new(remote_id, content))
                                            .block_task()
                                            .await;
                                        let events = match result {
                                            Ok(response) => {
                                                let raw = serde_json::to_value(response).map_err(acp_error)?;
                                                // A turn that says it ended is
                                                // taken at its word unless the
                                                // runtime it ran on has gone,
                                                // which is the one ending an
                                                // agent cannot report.
                                                let cut_off = match (provider, local_model.as_deref()) {
                                                    (super::super::local::BRAND, Some(model)) => {
                                                        super::super::local::unreachable_endpoint(model).await
                                                    }
                                                    _ => None,
                                                };
                                                let mut normalizer = normalizer.lock().await;
                                                match cut_off {
                                                    Some(endpoint) => normalizer
                                                        .finish_turn_cut_off(&local_id, provider, &raw, &endpoint),
                                                    None => normalizer.finish_turn(&local_id, provider, &raw),
                                                }
                                            }
                                            // The error whole — code, message
                                            // and data — rather than the
                                            // sentence `Display` makes of it.
                                            // Stringifying here is what left
                                            // every reader downstream matching
                                            // English to get the meaning back
                                            // (bw-d516).
                                            Err(error) => {
                                                let failure = serde_json::to_value(&error)
                                                    .unwrap_or_else(|_| json!({
                                                        "code": i32::from(error.code),
                                                        "message": error.to_string(),
                                                    }));
                                                normalizer
                                                    .lock()
                                                    .await
                                                    .fail_turn(&local_id, provider, &failure)
                                            }
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
                                                        &providers,
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
                                                &providers,
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
            // Read before it is stringified: `Display` for an ACP error prints
            // the message and drops the code, and -32000 is the difference
            // between "this is broken" and "sign in" (bw-t26l.20).
            let failure = result.as_ref().err().map(transport_failure);
            if let Some(ready) = ready.lock().await.take() {
                let _ = ready.send(Err(failure.unwrap_or_else(|| {
                    ("ACP adapter stopped during initialization".into(), false)
                })));
            } else if !stopped_closing.load(Ordering::Acquire) {
                let (message, signing_in) = failure
                    .unwrap_or_else(|| ("ACP adapter stopped unexpectedly".into(), false));
                record_failure(&stopped_database, &stopped_session, &message, signing_in).await;
                let _ = ended_send.send(message);
            };
        });
        let initialized = initialized
            .await
            .map_err(|_| ("ACP adapter stopped during initialization".to_string(), false))
            .and_then(|result| result);
        if let Err((message, signing_in)) = initialized {
            record_failure(&database, &session, &message, signing_in).await;
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
            takes_pictures,
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
                let content = prompt_content(command, self.takes_pictures.load(Ordering::SeqCst))?;
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
                // The kit answers a park with whether it actually moved the
                // work, and a refusal is an answer: it has no live background
                // task for this agent. Recorded regardless, the row said
                // "background" about a helper still running in the foreground
                // — the one thing the button exists to tell the reader, said
                // wrongly (bw-t26l.20).
                if result["parked"] == Value::Bool(false) {
                    return Err("the kit has no background task for this agent".into());
                }
                self.record_agent_control(agent_id, state).await?;
                if matches!(command.kind, CommandKind::AgentStop) {
                    self.rescue_held_turn();
                }
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

/// How long an adapter that turned this app away is left alone.
///
/// Starting an adapter to be told "Authentication required" costs what starting
/// one that answers costs, and a provider that is not signed in says it to
/// every endpoint, not one. The refusal is therefore worth remembering across
/// endpoints: the chat list learns it first, on a timer, and the transcript
/// that opens a moment later would otherwise pay for the same discovery again.
///
/// Brand-wide, and short. A refusal that was really about one chat sends the
/// next minute's asks down the compatibility readers, which read the same
/// records and produce the same transcripts — a slower way to be right
/// (bw-t26l.20).
const ADAPTER_REFUSED_FOR: std::time::Duration = std::time::Duration::from_secs(60);

fn adapter_refusals() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    static REFUSALS: std::sync::OnceLock<Mutex<HashMap<String, std::time::Instant>>> =
        std::sync::OnceLock::new();
    REFUSALS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether this brand's adapter turned the app away a moment ago, whichever
/// endpoint found out.
pub async fn adapter_refused_recently(brand: &str) -> bool {
    adapter_refusals()
        .lock()
        .await
        .get(brand)
        .is_some_and(|refused| refused.elapsed() < ADAPTER_REFUSED_FOR)
}

/// Write down what an adapter just did, so the next endpoint need not find out.
pub async fn note_adapter_answer(brand: &str, refused: bool) {
    let mut refusals = adapter_refusals().lock().await;
    if refused {
        refusals.insert(brand.to_string(), std::time::Instant::now());
    } else {
        refusals.remove(brand);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One refusal answers for every endpoint that would have found it out.
    ///
    /// The chat list asks first and the transcript opens a moment later; both
    /// used to start an adapter to hear the same "Authentication required"
    /// (bw-t26l.20).
    #[tokio::test]
    async fn an_adapter_that_refused_one_endpoint_is_left_alone_by_the_next() {
        let brand = "brand-that-refuses";
        assert!(!adapter_refused_recently(brand).await);
        note_adapter_answer(brand, true).await;
        assert!(adapter_refused_recently(brand).await);
        note_adapter_answer(brand, false).await;
        assert!(!adapter_refused_recently(brand).await);
    }

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

    fn prompt_with_images(images: Value) -> Command {
        let mut fields = serde_json::Map::new();
        fields.insert("text".into(), json!("what is in this picture?"));
        fields.insert("images".into(), images);
        Command {
            kind: CommandKind::PromptSend,
            fields,
        }
    }

    /// The writing box attaches a picture as `{mime, dataUrl, alt}`, so that is
    /// the shape the prompt has to survive. It used to be read for `data` and
    /// `base64` keys that the app has never sent: the block was dropped, the
    /// prompt went out as text alone, and the agent — with the picture sitting
    /// in the person's own bubble looking delivered — answered that no picture
    /// had been attached (bw-t26l.20).
    #[test]
    fn an_attached_picture_reaches_the_agent() {
        let command = prompt_with_images(json!([{
            "mime": "image/png",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
            "alt": "a screenshot",
        }]));
        let content = prompt_content(&command, true).unwrap();
        assert_eq!(content.len(), 2, "the text and the picture both go out");
        match &content[1] {
            ContentBlock::Image(image) => {
                assert_eq!(image.data, "iVBORw0KGgo=");
                assert_eq!(image.mime_type, "image/png");
            }
            other => panic!("the picture must go as an image block, got {other:?}"),
        }
    }

    /// A caller that already holds the two halves apart does not have to build a
    /// data URL to hand them over, and one that sends neither is not turned into
    /// an empty picture the agent has to make sense of.
    #[test]
    fn a_picture_is_read_from_whichever_half_the_caller_holds() {
        let command = prompt_with_images(json!([
            {"base64": "QUJD", "mimeType": "image/jpeg"},
            {"mime": "image/gif", "dataUrl": "not-a-data-url"},
            {"alt": "nothing at all"},
        ]));
        let content = prompt_content(&command, true).unwrap();
        assert_eq!(content.len(), 2, "only the picture with a payload goes out");
        match &content[1] {
            ContentBlock::Image(image) => {
                assert_eq!(image.data, "QUJD");
                assert_eq!(image.mime_type, "image/jpeg");
            }
            other => panic!("the picture must go as an image block, got {other:?}"),
        }
    }

    /// An agent that says it cannot take pictures still gets the sentence.
    ///
    /// ACP gates an image block on `promptCapabilities.image`, and an agent
    /// that has not advertised it refuses the whole `session/prompt` when one
    /// arrives. We sent it regardless, so attaching a picture in such a chat
    /// lost the words the owner had typed along with it, under an error that
    /// named neither. The picture cannot be delivered either way; his turn can.
    #[test]
    fn a_picture_an_agent_cannot_take_does_not_take_the_message_down_with_it() {
        let command = prompt_with_images(json!([{
            "mime": "image/png",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo=",
            "alt": "a screenshot",
        }]));

        let content = prompt_content(&command, false).unwrap();
        let words = content
            .iter()
            .map(|block| match block {
                ContentBlock::Text(text) => text.text.clone(),
                other => panic!("nothing but words may go to an agent that takes no pictures, got {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(words[0], "what is in this picture?");
        // And he is told, in the turn itself, why the thing he attached is not
        // in it. Silence would have the agent answer about a picture it never
        // received, which is the failure this replaced.
        assert!(words[1].contains("cannot be sent pictures"), "{words:?}");

        // The same command to an agent that can take one is unchanged.
        let taken = prompt_content(&command, true).unwrap();
        assert!(matches!(taken[1], ContentBlock::Image(_)), "{taken:?}");
        assert_eq!(taken.len(), 2);
    }

    #[tokio::test]
    async fn a_provider_that_wants_signing_in_says_so_instead_of_reading_as_broken() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let session = test_session("idle");
        database.create_session(session.clone()).await.unwrap();

        // What the adapter actually answers when nobody is signed in: the ACP
        // code for it, and a message too terse for any phrase-matcher to read.
        let refused = agent_client_protocol::Error::auth_required();
        let (message, signing_in) = transport_failure(&refused);
        assert!(signing_in, "-32000 is the sign-in code, not a crash");
        record_failure(&database, &session, &message, signing_in).await;

        let events = database.events_since(session.id.clone(), 0).await.unwrap();
        // The chat offers a way back in ...
        let signal = events
            .iter()
            .find(|event| event.kind == crate::workbench::protocol::EventKind::ProviderMessage)
            .expect("a signed-out provider raises the sign-in condition");
        assert_eq!(signal.fields["signal"]["kind"], "authentication");
        assert_eq!(signal.fields["signal"]["severity"], "blocking");
        // ... and the row says the same thing, rather than "Provider unavailable".
        let state = events
            .iter()
            .find(|event| event.kind == crate::workbench::protocol::EventKind::SessionState)
            .expect("the session is marked");
        assert_eq!(state.fields["label"], "Sign in to continue");

        // A genuine crash is still a crash: no sign-in is offered for it.
        let broken = agent_client_protocol::Error::internal_error();
        let (_, crashed_signing_in) = transport_failure(&broken);
        assert!(!crashed_signing_in);
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
            takes_pictures: Arc::new(AtomicBool::new(true)),
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

    /// Stopping a turn cancels the cards it left open. It does not refuse them.
    ///
    /// This used to send the agent's own rejection option, which reads to the
    /// agent as the owner saying no to that exact tool. ACP has a word for the
    /// other thing and requires it: a client that sends `session/cancel` MUST
    /// answer every pending `session/request_permission` with `Cancelled`.
    #[tokio::test]
    async fn interrupt_cancels_every_pending_provider_question_rather_than_refusing_it() {
        let permissions = PermissionBroker::default();
        let (permission_answer, permission_result) = oneshot::channel();
        permissions.pending.lock().await.insert(
            "permission-1".into(),
            PendingPermission {
                answer: permission_answer,
            },
        );
        permissions.plan_options.lock().await.insert(
            "permission-1".into(),
            ("provider-allow".into(), "provider-deny".into()),
        );
        permissions.cancel_all().await;
        assert!(matches!(
            permission_result.await.unwrap(),
            PermissionAnswer::Cancelled
        ));
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
    async fn a_sign_in_finished_in_the_browser_closes_its_own_card() {
        let broker = ElicitationBroker::default();
        let (answer, received) = oneshot::channel();
        broker.pending.lock().await.insert(
            "sign-in-1".into(),
            PendingElicitation {
                answer,
                // No schema: a URL elicitation asks for no fields, only that the
                // owner goes and does the thing the link leads to.
                schema: None,
                custom_fields: HashMap::new(),
                native_questions: false,
            },
        );

        // Anything else stays the update handler's business, untouched.
        assert!(
            !elicitation_completed(
                &broker,
                "session/update",
                &json!({"update":{"sessionUpdate":"agent_message_chunk"}}),
            )
            .await
        );
        assert!(broker.is_pending("sign-in-1").await);

        assert!(
            elicitation_completed(
                &broker,
                "elicitation/complete",
                &json!({"elicitationId":"sign-in-1"}),
            )
            .await
        );
        assert_eq!(received.await.unwrap(), json!({"action":"accept"}));
        assert!(!broker.is_pending("sign-in-1").await);

        // Said twice, or said after the owner already pressed Continue: still
        // ours to swallow, never an error thrown back at the agent.
        assert!(
            elicitation_completed(
                &broker,
                "elicitation/complete",
                &json!({"elicitationId":"sign-in-1"}),
            )
            .await
        );
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
            takes_pictures: Arc::new(AtomicBool::new(true)),
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
            takes_pictures: Arc::new(AtomicBool::new(true)),
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
    fn a_mode_is_only_asked_for_when_the_agent_said_it_has_one() {
        let codex = json!({"currentModeId":"read-only","availableModes":[
            {"id":"read-only"},{"id":"agent"},{"id":"agent-full-access"}
        ]});
        assert!(offers_mode(&codex, &mode_to_acp("codex", "on-request")));
        assert!(!offers_mode(&codex, "shopping"));

        // goose answers session/new with no modes at all; there is nothing to
        // ask it for, and asking anyway is what killed the chat.
        let goose = json!({"currentModeId":Value::Null});
        assert!(!offers_mode(&goose, &mode_to_acp("local", "on-request")));
        assert!(!offers_mode(&json!({"availableModes":[]}), "on-request"));
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
            &json!([]),
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

    /// Measured against the pinned claude adapter (0.73.0): a `session/load`
    /// answers with the `Task` call and its result when this promise is
    /// absent, and drops both when it is there — so a replay must not make it.
    #[test]
    fn only_a_driven_chat_offers_to_host_an_agent_it_sends_off() {
        let live = initialize_request(true).expect("live handshake");
        let replay = initialize_request(false).expect("replay handshake");
        let air = "/clientCapabilities/_meta/jetbrains/air/capabilities";

        assert_eq!(
            live.params().pointer(air),
            Some(&json!(["nativeSubagentSessions"]))
        );
        assert!(replay.params().pointer(air).is_none());
        // Everything else a replay needs is unchanged, the transcript of an
        // agent it sent off included.
        for handshake in [&live, &replay] {
            assert_eq!(
                handshake.params().pointer("/clientCapabilities/_meta/subagent-transcript"),
                Some(&json!(true))
            );
            // Beside the real capabilities, where the adapters this app ships
            // read it, AND under `_meta`, where the protocol says an extension
            // lives. `subagents` is not a field of the spec's client
            // capabilities (bw-t26l.20).
            assert_eq!(
                handshake.params().pointer("/clientCapabilities/subagents"),
                Some(&json!({}))
            );
            assert_eq!(
                handshake.params().pointer("/clientCapabilities/_meta/subagents"),
                Some(&json!({}))
            );
            assert_eq!(handshake.params()["protocolVersion"], json!(SPEAKS));
        }
    }

    /// The handshake NEGOTIATES: the agent answers with the version it will
    /// actually use, not necessarily the one it was asked for. Nothing read
    /// that answer, so an agent speaking something else was carried on with and
    /// the failure surfaced later as nonsense mid-turn (bw-t26l.20).
    #[test]
    fn an_agent_speaking_another_acp_is_stopped_at_the_door() {
        // The pre-release version, which this app has never spoken.
        let refused = agreed_version(&json!({"protocolVersion": 0}))
            .expect_err("version 0 is not version 1");
        let said = refused.to_string();
        assert!(said.contains("speaks ACP 0"), "{said}");
        assert!(said.contains("speaks 1"), "{said}");

        agreed_version(&json!({"protocolVersion": 1})).expect("the version this app speaks");
        // Only a STATED mismatch refuses: an adapter that omits the field has
        // not said it is speaking something else.
        agreed_version(&json!({"agentCapabilities": {}})).expect("silence is not a mismatch");
    }
}
