//! Stateful native Codex chat behavior above the owned transport.

use super::history::{thread_open_request, OpenRequest};
use super::normalize::{CodexNormalizer, DriverEvent};
use super::transport::{CodexInbound, CodexTransport, CodexTransportConfig, CodexTransportError};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const MODES: &[&str] = &["untrusted", "on-request", "never"];

fn event(kind: &str, fields: impl IntoIterator<Item = (&'static str, Value)>) -> DriverEvent {
    let mut row = serde_json::Map::new();
    row.insert("type".into(), json!(kind));
    for (field, value) in fields {
        row.insert(field.into(), value);
    }
    Value::Object(row)
}

#[derive(Clone, Debug)]
pub struct StartOptions {
    pub cwd: PathBuf,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub permission_mode: String,
    pub effort: Option<String>,
    pub collaboration_mode: Option<String>,
    pub instructions: String,
}

#[derive(Clone, Debug)]
enum AskKind {
    Legacy,
    Approval,
    Permissions,
    Url,
    ElicitationField {
        original_id: Value,
        field: String,
        field_type: Option<String>,
        group: String,
    },
}

#[derive(Clone, Debug)]
struct PendingAsk {
    message_id: Value,
    kind: AskKind,
    params: Value,
}

#[derive(Clone, Debug)]
struct PendingQuestions {
    message_id: Value,
    questions: Vec<Value>,
}

#[derive(Default)]
pub struct CodexLiveState {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub collaboration_mode: Option<String>,
    pub permission_mode: String,
    normalizer: CodexNormalizer,
    asks: HashMap<String, PendingAsk>,
    questions: HashMap<String, PendingQuestions>,
    plans: HashSet<String>,
    tool_output: HashMap<String, String>,
    agents: HashSet<String>,
    active_agents: HashSet<String>,
    child_results: HashMap<String, String>,
    elicitation: HashMap<String, (Value, usize, serde_json::Map<String, Value>)>,
    responses: Vec<(Value, Result<Value, Value>)>,
    diagnostic_seq: u64,
}

impl CodexLiveState {
    pub fn new(options: &StartOptions) -> Self {
        Self {
            model: options.model.clone().filter(|model| model != "default"),
            effort: options.effort.clone(),
            collaboration_mode: options.collaboration_mode.clone(),
            permission_mode: if MODES.contains(&options.permission_mode.as_str()) {
                options.permission_mode.clone()
            } else {
                "on-request".into()
            },
            ..Self::default()
        }
    }

    fn respond(&mut self, id: Value, result: Result<Value, Value>) {
        self.responses.push((id, result));
    }

    pub fn take_responses(&mut self) -> Vec<(Value, Result<Value, Value>)> {
        std::mem::take(&mut self.responses)
    }

    fn actor_of(&self, params: &Value) -> Option<String> {
        params["threadId"]
            .as_str()
            .filter(|id| Some(*id) != self.thread_id.as_deref())
            .map(str::to_string)
    }

    pub fn handle(&mut self, inbound: CodexInbound) -> Vec<DriverEvent> {
        match inbound {
            CodexInbound::Notification { method, params } => self.notification(&method, &params),
            CodexInbound::Request { id, method, params } => self.request(id, &method, &params),
            CodexInbound::ProtocolLine(line) => {
                self.diagnostic_seq += 1;
                vec![event(
                    "note",
                    [
                        ("noteId", json!(format!("protocol:{}", self.diagnostic_seq))),
                        ("rank", json!("detail")),
                        ("kind", json!("protocol")),
                        ("text", json!(line)),
                        ("body", Value::Null),
                    ],
                )]
            }
            CodexInbound::Stderr(line) => {
                self.diagnostic_seq += 1;
                vec![event(
                    "note",
                    [
                        ("noteId", json!(format!("stderr:{}", self.diagnostic_seq))),
                        ("rank", json!("detail")),
                        ("kind", json!("stderr")),
                        ("text", json!(line)),
                        ("body", Value::Null),
                    ],
                )]
            }
            CodexInbound::Exited(detail) => {
                let mut events = crate::workbench::lifecycle::abandoned_interactions(
                    self.asks.drain().map(|(id, _)| id),
                    self.questions.drain().map(|(id, _)| id),
                    self.plans.drain(),
                );
                events.push(event(
                    "error",
                    [
                        (
                            "message",
                            json!(format!("Codex app-server exited ({detail})")),
                        ),
                        ("fatal", json!(true)),
                    ],
                ));
                events.push(event(
                    "session.state",
                    [("state", json!("errored")), ("label", json!("Failed"))],
                ));
                events
            }
        }
    }

    fn notification(&mut self, method: &str, params: &Value) -> Vec<DriverEvent> {
        let mut events = Vec::new();
        match method {
            "thread/status/changed" => {
                let status = params.get("status").or_else(|| params["thread"].get("status")).cloned().unwrap_or_else(||json!({}));
                let changed = params["threadId"].as_str().or_else(||params["thread"]["id"].as_str());
                if let Some(id) = changed.filter(|id| Some(*id) != self.thread_id.as_deref()) {
                    if self.agents.contains(id) && status["type"] == "active" {
                        self.active_agents.insert(id.to_string());
                        let mut progress=event("agent.progress",[("agentId",json!(id)),("seconds",json!(0)),("tokens",json!(0)),("calls",json!(0)),("state",json!("running"))]);
                        if let Some(execution)=self.normalizer.agent_execution(id){progress["execution"]=execution;}
                        events.push(progress);
                    } else if self.agents.contains(id)
                        && (status["type"] == "systemError"
                            || (status["type"] == "idle" && self.active_agents.remove(id)))
                    {
                        if let Some(finished)=self.normalizer.finish_agent(id,if status["type"]=="idle"{"done"}else{"failed"},self.child_results.remove(id).map_or(Value::Null,Value::String)){events.push(finished);}
                        self.agents.remove(id);
                        self.active_agents.remove(id);
                    }
                } else {
                    let waiting=status["activeFlags"].as_array().is_some_and(|flags|flags.iter().any(|flag|matches!(flag.as_str(),Some("waitingOnApproval"|"waitingOnUserInput"))));
                    let (state,label)=match status["type"].as_str(){Some("active") if waiting=>("waiting_permission","Waiting for you"),Some("active")=>("thinking","Working"),Some("systemError")=>("errored","Failed"),_=>("idle","Ready")};
                    events.push(event("session.state",[("state",json!(state)),("label",json!(label))]));
                }
            }
            "item/agentMessage/delta" => {
                let id=params["itemId"].as_str().unwrap_or_default();
                let actor = self.actor_of(params);
                if self.normalizer.message_delta_for(id,params["delta"].clone(),actor.as_deref(),&mut events){events.push(event("session.state",[("state",json!("streaming")),("label",json!("Answering"))]));}
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let actor=self.actor_of(params);
                self.normalizer.thinking_delta_for(params["itemId"].as_str().unwrap_or_default(),params["delta"].clone(),actor.as_deref(),&mut events);
            }
            "turn/plan/updated" => events.push(event("todo",[("items",Value::Array(params["plan"].as_array().into_iter().flatten().enumerate().map(|(index,row)|json!({"id":index.to_string(),"text":row["step"],"status":row["status"]})).collect()))])),
            "item/started" => {
                let actor=self.actor_of(params);
                if params["item"]["type"]=="subAgentActivity" || params["item"]["type"]=="collabAgentToolCall" {
                    for id in params["item"]["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str){self.agents.insert(id.to_string());}
                    if let Some(id)=params["item"]["agentThreadId"].as_str(){self.agents.insert(id.to_string());}
                }
                self.normalizer.item_started_for(&params["item"],actor.as_deref(),&mut events);
                if let Some(tool) = events.iter().find(|row|row["type"]=="tool.started") {
                    let label = tool["name"].as_str().unwrap_or("Using a tool").to_string();
                    events.push(event("session.state",[("state",json!("running_tool")),("label",json!(label))]));
                }
            }
            "item/completed" => {
                let actor=self.actor_of(params);
                if let Some(actor_id)=actor.as_deref().filter(|_|params["item"]["type"]=="agentMessage") {
                    if let Some(result)=params["item"]["text"].as_str().map(str::trim).filter(|text|!text.is_empty()) {self.child_results.insert(actor_id.to_string(),result.to_string());}
                }
                if params["item"]["type"]=="plan" {
                    let markdown=params["item"]["text"].as_str().unwrap_or_default().trim();
                    if !markdown.is_empty(){let id=format!("{}:plan:0",params["item"]["id"].as_str().unwrap_or_default());self.plans.insert(id.clone());events.push(plan_event(&id,markdown));}
                } else { self.normalizer.item_completed_for(&params["item"],actor.as_deref(),false,&mut events); }
            }
            "thread/tokenUsage/updated" => {
                if !params["tokenUsage"]["total"].is_null(){let total=&params["tokenUsage"]["total"];events.push(event("cost",[("cost",json!({"kind":"tokens","input":total["inputTokens"],"output":total["outputTokens"],"total":total["totalTokens"]}))]));}
                if let (Some(used),Some(window))=(params["tokenUsage"]["last"]["totalTokens"].as_i64(),params["tokenUsage"]["modelContextWindow"].as_i64()){events.push(event("context",[("used",json!(used)),("window",json!(window))]));}
            }
            "turn/started" => {self.turn_id=params["turn"]["id"].as_str().map(str::to_string);events.push(event("session.state",[("state",json!("thinking")),("label",json!("Thinking"))]));}
            "turn/completed" => {
                self.turn_id=None;let status=params["turn"]["status"].as_str();let (state,label)=match status{Some("failed")=>("errored","Failed"),Some("interrupted")=>("stopped","Stopped"),_=>("idle","Ready")};
                if status==Some("failed"){
                    let message=params["turn"]["error"]["message"].as_str().unwrap_or("Codex turn failed");
                    if let Some(signal)=crate::workbench::provider_messages::from_text(message){events.push(event("provider.message",[("signal",signal)]));}
                    else {events.push(event("error",[("message",json!(message)),("fatal",json!(false))]));}
                } else {
                    for kind in ["rate_limit","service_unavailable","network","provider_error"] {events.push(event("provider.message",[("signal",crate::workbench::provider_messages::resolved(kind))]));}
                }
                events.push(event("session.state",[("state",json!(state)),("label",json!(label))]));
            }
            "error" => {
                let message=params["error"]["message"].as_str().or_else(||params["message"].as_str()).unwrap_or("Codex error");
                if let Some(signal)=crate::workbench::provider_messages::from_text(message){events.push(event("provider.message",[("signal",signal)]));}
                else {events.push(event("error",[("message",json!(message)),("fatal",json!(false))]));}
            },
            "item/fileChange/patchUpdated" => for change in params["changes"].as_array().into_iter().flatten(){events.push(event("diff",[("toolCallId",params["itemId"].clone()),("path",change["path"].clone()),("before",json!("")),("after",change["diff"].clone())]));},
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                let id=params["itemId"].as_str().unwrap_or_default();let output=self.tool_output.entry(id.to_string()).or_default();output.push_str(params["delta"].as_str().unwrap_or_default());events.push(event("tool.progress",[("toolCallId",json!(id)),("seconds",json!(0)),("summary",json!(output.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()))]));
            }
            "thread/compacted" => {events.push(note("compact",params["message"].as_str().unwrap_or("Conversation compacted."),"note"));events.push(event("session.state",[("state",json!("idle")),("label",json!("Ready"))]));}
            "skills/changed" => {}
            "warning" | "model/rerouted" => events.push(note(method,params["message"].as_str().unwrap_or(&params.to_string()),"note")),
            _ if !method.ends_with("/delta") && !method.ends_with("/outputDelta") => events.push(note(method,params["message"].as_str().unwrap_or(&params.to_string()),"detail")),
            _ => {}
        }
        let finished: Vec<String> = events
            .iter()
            .filter(|row| row["type"] == "agent.finished")
            .filter_map(|row| row["agentId"].as_str().map(str::to_string))
            .collect();
        for id in finished {
            self.agents.remove(&id);
            self.active_agents.remove(&id);
        }
        events
    }

    fn request(&mut self, id: Value, method: &str, params: &Value) -> Vec<DriverEvent> {
        if method == "currentTime/read" {
            self.respond(id,Ok(json!({"currentTimeAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()})));
            return Vec::new();
        }
        if method == "item/tool/requestUserInput" {
            return self.ask_questions(id, params);
        }
        if method == "mcpServer/elicitation/request" {
            return self.ask_elicitation(id, params);
        }
        let recognized = method == "applyPatchApproval"
            || method == "execCommandApproval"
            || method.ends_with("/requestApproval");
        if !recognized {
            self.respond(
                id,
                Err(json!({"code":-32601,"message":format!("Unsupported request {method}")})),
            );
            return Vec::new();
        }
        let ask_id = params["approvalId"]
            .as_str()
            .or_else(|| params["itemId"].as_str())
            .or_else(|| params["id"].as_str())
            .or_else(|| params["callId"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| id.to_string().trim_matches('"').to_string());
        let kind = if method == "applyPatchApproval" || method == "execCommandApproval" {
            AskKind::Legacy
        } else if method == "item/permissions/requestApproval" {
            AskKind::Permissions
        } else {
            AskKind::Approval
        };
        self.asks.insert(
            ask_id.clone(),
            PendingAsk {
                message_id: id,
                kind,
                params: params.clone(),
            },
        );
        vec![
            permission_event(
                &ask_id,
                if method.contains("fileChange") || method == "applyPatchApproval" {
                    "File change"
                } else {
                    "Shell"
                },
                params,
            ),
            event(
                "session.state",
                [
                    ("state", json!("waiting_permission")),
                    ("label", json!("Waiting for permission")),
                ],
            ),
        ]
    }

    fn ask_questions(&mut self, id: Value, params: &Value) -> Vec<DriverEvent> {
        let questions = params["questions"].as_array().cloned().unwrap_or_default();
        if questions.is_empty() {
            self.respond(id, Ok(json!({"answers":{}})));
            return Vec::new();
        }
        let request_id = id.to_string().trim_matches('"').to_string();
        self.questions.insert(
            request_id.clone(),
            PendingQuestions {
                message_id: id,
                questions: questions.clone(),
            },
        );
        let fields=questions.iter().map(|question|json!({"id":question["id"].as_str().unwrap_or_default(),"header":question["header"].as_str().unwrap_or("Question"),"prompt":question["question"].as_str().unwrap_or_default(),"selection":if question["options"].is_null(){"text"}else{"single"},"options":question["options"].as_array().into_iter().flatten().enumerate().map(|(index,option)|json!({"id":format!("{}:option:{index}",question["id"].as_str().unwrap_or_default()),"label":option["label"]})).collect::<Vec<_>>(),"allowCustom":question["options"].is_null()||question["isOther"]==true,"secret":question["isSecret"]==true})).collect();
        let mut events = vec![event(
            "question.requested",
            [
                ("requestId", json!(request_id)),
                ("blocking", json!(params["isBlocking"] != false)),
                ("questions", Value::Array(fields)),
            ],
        )];
        if params["isBlocking"] != false {
            events.push(event(
                "session.state",
                [
                    ("state", json!("waiting_permission")),
                    ("label", json!("Waiting for your answer")),
                ],
            ));
        }
        events
    }

    fn ask_elicitation(&mut self, id: Value, params: &Value) -> Vec<DriverEvent> {
        if params["mode"] == "url" {
            let ask_id = format!("{}:url", id.to_string().trim_matches('"'));
            self.asks.insert(
                ask_id.clone(),
                PendingAsk {
                    message_id: id,
                    kind: AskKind::Url,
                    params: params.clone(),
                },
            );
            return vec![
                event(
                    "ask.permission",
                    [
                        ("askId", json!(ask_id)),
                        (
                            "toolName",
                            json!(format!(
                                "{} needs you",
                                params["serverName"].as_str().unwrap_or("Service")
                            )),
                        ),
                        ("input", json!({"url":params["url"]})),
                        ("title", params["message"].clone()),
                        (
                            "options",
                            json!([{"id":"continue","label":"Continue","kind":"answer"},{"id":"deny","label":"Decline","kind":"deny"}]),
                        ),
                        ("question", json!(true)),
                        ("href", params["url"].clone()),
                    ],
                ),
                event(
                    "session.state",
                    [
                        ("state", json!("waiting_permission")),
                        ("label", json!("Waiting for your answer")),
                    ],
                ),
            ];
        }
        let properties = params["requestedSchema"]["properties"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if properties.is_empty() {
            self.respond(id, Ok(json!({"action":"decline"})));
            return Vec::new();
        }
        let group = format!("mcp:{}", id.to_string().trim_matches('"'));
        self.elicitation.insert(
            group.clone(),
            (id.clone(), properties.len(), serde_json::Map::new()),
        );
        let mut events = Vec::new();
        for (field, schema) in properties {
            let ask_id = format!("{group}:{field}");
            self.asks.insert(
                ask_id.clone(),
                PendingAsk {
                    message_id: id.clone(),
                    kind: AskKind::ElicitationField {
                        original_id: id.clone(),
                        field: field.clone(),
                        field_type: schema["type"].as_str().map(str::to_string),
                        group: group.clone(),
                    },
                    params: schema.clone(),
                },
            );
            let options=schema["enum"].as_array().into_iter().flatten().map(|label|json!({"id":label.as_str().unwrap_or_default(),"label":label,"kind":"answer"})).chain(std::iter::once(json!({"id":"deny","label":"Decline","kind":"deny"}))).collect::<Vec<_>>();
            events.push(event(
                "ask.permission",
                [
                    ("askId", json!(ask_id)),
                    (
                        "toolName",
                        json!(schema["title"].as_str().unwrap_or(&field)),
                    ),
                    ("input", json!({"question":schema["description"]})),
                    (
                        "title",
                        schema
                            .get("description")
                            .or_else(|| schema.get("title"))
                            .cloned()
                            .unwrap_or_else(|| json!(field)),
                    ),
                    ("options", Value::Array(options)),
                    ("question", json!(true)),
                    ("allowText", json!(schema["enum"].is_null())),
                    ("secret", json!(schema["format"] == "password")),
                ],
            ));
        }
        events.push(event(
            "session.state",
            [
                ("state", json!("waiting_permission")),
                ("label", json!("Waiting for your answer")),
            ],
        ));
        events
    }

    pub fn answer(&mut self, ask_id: &str, choice: &str, value: Option<&str>) -> Vec<DriverEvent> {
        let Some(ask) = self.asks.remove(ask_id) else {
            return Vec::new();
        };
        let allowed = choice != "deny";
        match ask.kind{
            AskKind::Legacy=>self.respond(ask.message_id,Ok(json!({"decision":if choice=="allow_always"{"approved_for_session"}else if allowed{"approved"}else{"denied"}}))),
            AskKind::Approval=>self.respond(ask.message_id,Ok(json!({"decision":if choice=="allow_once"{"accept"}else if choice=="allow_always"{"acceptForSession"}else{"decline"}}))),
            AskKind::Permissions=>self.respond(ask.message_id,Ok(json!({"permissions":if allowed{ask.params["permissions"].clone()}else{json!({})},"scope":if choice=="allow_always"{"session"}else{"turn"}}))),
            AskKind::Url=>self.respond(ask.message_id,Ok(json!({"action":if allowed{"accept"}else{"decline"}}))),
            AskKind::ElicitationField{original_id,field,field_type,group}=>{
                if !allowed{self.respond(original_id,Ok(json!({"action":"decline"})));self.elicitation.remove(&group);self.asks.retain(|_,pending|!matches!(&pending.kind,AskKind::ElicitationField{group:other,..}if other==&group));}
                else if let Some((id,left,answers))=self.elicitation.get_mut(&group){let raw=value.unwrap_or(choice);let converted=match field_type.as_deref(){Some("boolean")=>json!(raw=="true"),Some("number"|"integer")=>raw.parse::<f64>().map_or_else(|_|json!(raw),|number|json!(number)),_=>json!(raw)};answers.insert(field,converted);*left-=1;if *left==0{let id=id.clone();let content=Value::Object(std::mem::take(answers));self.respond(id,Ok(json!({"action":"accept","content":content})));self.elicitation.remove(&group);}}
            }
        }
        vec![
            event(
                "ask.resolved",
                [("askId", json!(ask_id)), ("chosen", json!(choice))],
            ),
            event(
                "session.state",
                [("state", json!("thinking")), ("label", json!("Thinking"))],
            ),
        ]
    }

    pub fn answer_questions(
        &mut self,
        request_id: &str,
        answers: &[Value],
    ) -> Result<Vec<DriverEvent>, String> {
        let pending = self
            .questions
            .remove(request_id)
            .ok_or_else(|| "This Codex question is no longer awaiting an answer".to_string())?;
        let by_id: HashMap<&str, &Value> = answers
            .iter()
            .filter_map(|answer| Some((answer["questionId"].as_str()?, answer)))
            .collect();
        let mut native = serde_json::Map::new();
        for question in &pending.questions {
            let id = question["id"].as_str().unwrap_or_default();
            let answer = by_id
                .get(id)
                .ok_or_else(|| format!("No answer was supplied for Codex question \"{id}\""))?;
            let options: HashMap<String, String> = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, option)| {
                    (
                        format!("{id}:option:{index}"),
                        option["label"].as_str().unwrap_or_default().to_string(),
                    )
                })
                .collect();
            let mut values = answer["optionIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|choice| {
                    options
                        .get(choice)
                        .cloned()
                        .unwrap_or_else(|| choice.to_string())
                })
                .collect::<Vec<_>>();
            if let Some(text) = answer["customText"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                values.push(text.trim().to_string());
            }
            if let Some(note) = answer["note"]
                .as_str()
                .filter(|note| !note.trim().is_empty())
            {
                values.push(format!("Additional note: {}", note.trim()));
            }
            native.insert(id.into(), json!({"answers":values}));
        }
        self.respond(pending.message_id, Ok(json!({"answers":native})));
        Ok(vec![
            event(
                "question.resolved",
                [
                    ("requestId", json!(request_id)),
                    ("answers", Value::Array(answers.to_vec())),
                ],
            ),
            event(
                "session.state",
                [("state", json!("thinking")), ("label", json!("Thinking"))],
            ),
        ])
    }
}

pub struct NativeCodexDriver {
    transport: CodexTransport,
    inbound: mpsc::UnboundedReceiver<CodexInbound>,
    pub state: CodexLiveState,
    instructions: String,
    cwd: PathBuf,
    collaboration_presets: HashMap<String, Value>,
    skill_paths: HashMap<String, String>,
    image_dirs: Vec<PathBuf>,
}

fn public_menu(mut menu: Value) -> Value {
    if let Some(object) = menu.as_object_mut() {
        object.remove("collaborationPresets");
        object.remove("skillPaths");
        object.remove("defaultEffort");
    }
    menu["type"] = json!("session.menu");
    menu
}

impl NativeCodexDriver {
    fn remember_private_menu(&mut self, menu: &Value) {
        self.collaboration_presets = menu["collaborationPresets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|preset| Some((preset["mode"].as_str()?.to_string(), preset.clone())))
            .collect();
        self.skill_paths = menu["skillPaths"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(name, path)| Some((name.clone(), path.as_str()?.to_string())))
            .collect();
    }

    pub async fn start(
        config: CodexTransportConfig,
        options: StartOptions,
    ) -> Result<(Self, Vec<DriverEvent>), CodexTransportError> {
        let transport = CodexTransport::start(config).await?;
        Self::open(transport, options).await
    }
    pub async fn open(
        transport: CodexTransport,
        options: StartOptions,
    ) -> Result<(Self, Vec<DriverEvent>), CodexTransportError> {
        let request: OpenRequest = thread_open_request(
            options.resume.as_deref(),
            &options.cwd,
            options.model.as_deref().filter(|model| *model != "default"),
            &options.permission_mode,
            options.effort.as_deref(),
            &options.instructions,
        );
        let opened = transport
            .call(request.method, request.params, CALL_TIMEOUT)
            .await?;
        let thread_id = opened["thread"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let mut state = CodexLiveState::new(&options);
        state.thread_id = Some(thread_id.clone());
        state.model = opened["model"].as_str().map(str::to_string).or(state.model);
        state.effort = opened["reasoningEffort"]
            .as_str()
            .or_else(|| opened["effort"].as_str())
            .map(str::to_string)
            .or(state.effort);
        let menu_future = super::history::menu(&transport, &options.cwd, state.model.as_deref());
        let terminals_future = transport.call(
            "thread/backgroundTerminals/list",
            json!({"threadId":thread_id,"limit":100}),
            CALL_TIMEOUT,
        );
        let (menu, terminals) = tokio::join!(menu_future, terminals_future);
        let collaboration_presets = menu["collaborationPresets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|preset| Some((preset["mode"].as_str()?.to_string(), preset.clone())))
            .collect();
        let skill_paths = menu["skillPaths"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(name, path)| Some((name.clone(), path.as_str()?.to_string())))
            .collect();
        if state.effort.is_none() {
            state.effort = menu["defaultEffort"].as_str().map(str::to_string);
        }
        let menu_event = public_menu(menu);
        let inbound = transport
            .take_inbound()
            .ok_or(CodexTransportError::Stopped)?;
        let mut events = vec![
            event(
                "session.started",
                [
                    ("brand", json!("codex")),
                    ("externalId", json!(thread_id)),
                    (
                        "model",
                        state.model.clone().map_or(Value::Null, Value::String),
                    ),
                    (
                        "cwd",
                        opened["cwd"]
                            .as_str()
                            .map_or_else(|| json!(options.cwd), |cwd| json!(cwd)),
                    ),
                    ("permissionMode", json!(state.permission_mode)),
                    (
                        "effort",
                        state.effort.clone().map_or(Value::Null, Value::String),
                    ),
                    (
                        "collaborationMode",
                        state
                            .collaboration_mode
                            .clone()
                            .map_or(Value::Null, Value::String),
                    ),
                ],
            ),
            event(
                "session.state",
                [("state", json!("idle")), ("label", json!("Ready"))],
            ),
            menu_event,
        ];
        if let Ok(terminals) = terminals {
            let rows = terminals["data"].as_array().cloned().unwrap_or_default();
            for terminal in &rows {
                events.push(event("tool.started", [
                    ("toolCallId", terminal["itemId"].clone()),
                    ("name", json!("Shell")),
                    ("input", json!({"command":terminal["command"],"cwd":terminal["cwd"],"pid":terminal["osPid"]})),
                    ("title", terminal["command"].clone()),
                    ("parentToolCallId", Value::Null),
                ]));
            }
            if !rows.is_empty() {
                events.push(event(
                    "session.state",
                    [
                        ("state", json!("running_tool")),
                        ("label", json!("Background command")),
                    ],
                ));
            }
        }
        Ok((
            Self {
                transport,
                inbound,
                state,
                instructions: options.instructions,
                cwd: options.cwd,
                collaboration_presets,
                skill_paths,
                image_dirs: Vec::new(),
            },
            events,
        ))
    }
    async fn flush_responses(&mut self) -> Result<(), CodexTransportError> {
        for (id, result) in self.state.take_responses() {
            self.transport.respond(id, result)?;
        }
        Ok(())
    }
    pub async fn next_events(&mut self) -> Result<Vec<DriverEvent>, CodexTransportError> {
        let inbound = self
            .inbound
            .recv()
            .await
            .ok_or(CodexTransportError::Stopped)?;
        let refresh_menu =
            matches!(&inbound,CodexInbound::Notification{method,..} if method=="skills/changed");
        let mut events = self.state.handle(inbound);
        self.flush_responses().await?;
        if refresh_menu {
            let menu =
                super::history::menu(&self.transport, &self.cwd, self.state.model.as_deref()).await;
            self.remember_private_menu(&menu);
            events.push(public_menu(menu));
        }
        if events.iter().any(|event| {
            event["type"] == "session.state"
                && matches!(
                    event["state"].as_str(),
                    Some("idle" | "stopped" | "errored")
                )
        }) {
            self.drop_image_dirs();
        }
        Ok(events)
    }
    pub async fn send(
        &mut self,
        text: &str,
        images: &[Value],
    ) -> Result<Vec<DriverEvent>, CodexTransportError> {
        let thread = self
            .state
            .thread_id
            .clone()
            .ok_or(CodexTransportError::Stopped)?;
        let trimmed = text.trim();
        let invocation = trimmed.strip_prefix('/').and_then(|text| {
            let mut parts = text.splitn(2, char::is_whitespace);
            Some((
                parts.next()?.to_string(),
                parts.next().unwrap_or("").trim().to_string(),
            ))
        });
        if let Some((name, argument)) = invocation.as_ref().filter(|(name, _)| {
            matches!(
                name.as_str(),
                "compact" | "review" | "status" | "usage" | "model" | "permissions"
            )
        }) {
            return self.special(name, argument).await;
        }
        let mut input = if let Some((name, argument)) = invocation
            .as_ref()
            .filter(|(name, _)| self.skill_paths.contains_key(name))
        {
            let mut parts = vec![json!({"type":"skill","name":name,"path":self.skill_paths[name]})];
            if !argument.is_empty() {
                parts.push(json!({"type":"text","text":argument,"text_elements":[]}));
            }
            Value::Array(parts)
        } else {
            json!([{"type":"text","text":text,"text_elements":[]}])
        };
        if !images.is_empty() {
            let directory =
                std::env::temp_dir().join(format!("atelier-codex-images-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory)
                .map_err(|error| CodexTransportError::Request(error.to_string()))?;
            let values = input
                .as_array_mut()
                .expect("Codex turn input is always an array");
            for (at, image) in images.iter().enumerate() {
                let Some(data_url) = image["dataUrl"].as_str() else {
                    continue;
                };
                let Some(encoded) = data_url
                    .strip_prefix("data:")
                    .and_then(|rest| rest.split_once(";base64,"))
                    .map(|(_, bytes)| bytes)
                else {
                    values.push(json!({"type":"image","url":data_url}));
                    continue;
                };
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|error| {
                        CodexTransportError::Request(format!("invalid prompt image: {error}"))
                    })?;
                let extension = match image["mime"].as_str().unwrap_or("image/png") {
                    "image/jpeg" => "jpg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    _ => "png",
                };
                let path = directory.join(format!("image-{at}.{extension}"));
                std::fs::write(&path, bytes)
                    .map_err(|error| CodexTransportError::Request(error.to_string()))?;
                values.push(json!({"type":"localImage","path":path}));
            }
            self.image_dirs.push(directory);
        }
        if let Some(turn) = &self.state.turn_id {
            self.transport
                .call(
                    "turn/steer",
                    json!({"threadId":thread,"expectedTurnId":turn,"input":input}),
                    CALL_TIMEOUT,
                )
                .await?;
        } else {
            let mut params = json!({"threadId":thread,"input":input,"model":self.state.model,"approvalPolicy":self.state.permission_mode,"effort":self.state.effort});
            if let Some(mode) = &self.state.collaboration_mode {
                params["collaborationMode"] = self.collaboration_payload(mode);
            }
            let opened = self
                .transport
                .call("turn/start", params, CALL_TIMEOUT)
                .await?;
            self.state.turn_id = opened["turn"]["id"].as_str().map(str::to_string);
        }
        Ok(vec![event(
            "session.state",
            [("state", json!("thinking")), ("label", json!("Thinking"))],
        )])
    }
    pub fn validate_prompt(&self, text: &str) -> Result<(), String> {
        let trimmed = text.trim();
        if let Some(argument) = trimmed
            .strip_prefix("/permissions")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !MODES.contains(&argument) {
                return Err(format!(
                    "Codex does not support approval policy \"{argument}\""
                ));
            }
        }
        Ok(())
    }
    async fn special(
        &mut self,
        name: &str,
        argument: &str,
    ) -> Result<Vec<DriverEvent>, CodexTransportError> {
        match name {
            "compact" => self.compact().await,
            "review" => {
                self.transport.call("review/start",json!({"threadId":self.state.thread_id,"target":if argument.is_empty(){json!({"type":"uncommittedChanges"})}else{json!({"type":"custom","instructions":argument})},"delivery":"inline"}),CALL_TIMEOUT).await?;
                Ok(vec![event(
                    "session.state",
                    [
                        ("state", json!("thinking")),
                        ("label", json!("Reviewing changes")),
                    ],
                )])
            }
            "model" => {
                let mut events = if argument.is_empty() {
                    Vec::new()
                } else {
                    self.set_model(argument).await
                };
                let text = if argument.is_empty() {
                    "Use the model picker below the composer, or type /model followed by a model name.".into()
                } else {
                    format!("Model changed to {argument}.")
                };
                events.push(note("model", &text, "note"));
                Ok(events)
            }
            "permissions" => {
                let mut events = Vec::new();
                if !argument.is_empty() {
                    events.push(
                        self.set_mode(argument)
                            .map_err(CodexTransportError::Request)?,
                    )
                }
                let text = if argument.is_empty() {
                    "Use the permission picker below the composer, or type /permissions followed by a mode.".into()
                } else {
                    format!("Permission mode changed to {argument}.")
                };
                events.push(note("permissions", &text, "note"));
                Ok(events)
            }
            "usage" => {
                let raw = self
                    .transport
                    .call("account/rateLimits/read", json!({}), CALL_TIMEOUT)
                    .await?;
                let limits = raw.get("rateLimits").cloned().unwrap_or_else(|| json!({}));
                let mut snapshots = vec![limits];
                snapshots.extend(
                    raw["rateLimitsByLimitId"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(_, value)| value.clone()),
                );
                let mut seen = HashSet::new();
                let mut says = Vec::new();
                for snapshot in snapshots {
                    for window in [snapshot.get("primary"), snapshot.get("secondary")]
                        .into_iter()
                        .flatten()
                    {
                        if window.is_null() {
                            continue;
                        }
                        let span = window["windowDurationMins"]
                            .as_i64()
                            .map_or_else(|| "window".into(), |minutes| format!("{minutes}m"));
                        let used = window["usedPercent"]
                            .as_f64()
                            .map_or_else(|| "unknown".into(), |percent| format!("{percent}%"));
                        let reset =
                            window["resetsAt"]
                                .as_i64()
                                .map_or_else(String::new, |seconds| {
                                    format!(
                                        ", resets {}",
                                        chrono::DateTime::from_timestamp(seconds, 0).map_or_else(
                                            || seconds.to_string(),
                                            |at| at.to_rfc3339()
                                        )
                                    )
                                });
                        let key = format!("{span}:{used}:{reset}");
                        if seen.insert(key) {
                            says.push(format!("{span}: {used} used{reset}"));
                        }
                    }
                }
                let text = if says.is_empty() {
                    "Codex did not report account limits.".into()
                } else {
                    says.join(" · ")
                };
                Ok(vec![note("usage", &text, "note")])
            }
            "status" => {
                let thread = self
                    .transport
                    .call(
                        "thread/read",
                        json!({"threadId":self.state.thread_id,"includeTurns":false}),
                        CALL_TIMEOUT,
                    )
                    .await?;
                let terminals = self
                    .transport
                    .call(
                        "thread/backgroundTerminals/list",
                        json!({"threadId":self.state.thread_id,"limit":100}),
                        CALL_TIMEOUT,
                    )
                    .await?;
                let state = thread["thread"]["status"]["type"]
                    .as_str()
                    .unwrap_or("unknown");
                let running = terminals["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|terminal| terminal["command"].as_str())
                    .collect::<Vec<_>>();
                let text = if running.is_empty() {
                    format!("Codex is {state}. No background commands.")
                } else {
                    format!("Codex is {state}. Running: {}", running.join("; "))
                };
                Ok(vec![note("status", &text, "note")])
            }
            _ => unreachable!(),
        }
    }
    pub async fn compact(&self) -> Result<Vec<DriverEvent>, CodexTransportError> {
        self.transport
            .call(
                "thread/compact/start",
                json!({"threadId":self.state.thread_id}),
                CALL_TIMEOUT,
            )
            .await?;
        Ok(vec![
            event(
                "session.state",
                [("state", json!("thinking")), ("label", json!("Compacting"))],
            ),
            note("compact", "Compaction started.", "note"),
        ])
    }
    pub async fn interrupt(&mut self) -> Result<(), CodexTransportError> {
        if let (Some(thread), Some(turn)) = (&self.state.thread_id, &self.state.turn_id) {
            self.transport
                .call(
                    "turn/interrupt",
                    json!({"threadId":thread,"turnId":turn}),
                    CALL_TIMEOUT,
                )
                .await?;
        }
        Ok(())
    }
    pub fn set_mode(&mut self, mode: &str) -> Result<DriverEvent, String> {
        if !MODES.contains(&mode) {
            return Err(format!("Codex does not support approval policy \"{mode}\""));
        }
        self.state.permission_mode = mode.into();
        Ok(event(
            "session.pinned",
            [("permissionMode", json!(mode)), ("model", Value::Null)],
        ))
    }
    pub async fn set_model(&mut self, model: &str) -> Vec<DriverEvent> {
        self.state.model = (model != "default").then(|| model.to_string());
        let pinned = event(
            "session.pinned",
            [("permissionMode", Value::Null), ("model", json!(model))],
        );
        let menu =
            super::history::menu(&self.transport, &self.cwd, self.state.model.as_deref()).await;
        vec![pinned, public_menu(menu)]
    }
    pub fn set_effort(&mut self, effort: &str) -> DriverEvent {
        self.state.effort = Some(effort.into());
        event(
            "session.pinned",
            [
                ("permissionMode", Value::Null),
                ("model", Value::Null),
                ("effort", json!(effort)),
            ],
        )
    }
    pub async fn set_collaboration_mode(
        &mut self,
        mode: &str,
    ) -> Result<DriverEvent, CodexTransportError> {
        if !self.collaboration_presets.contains_key(mode) {
            return Err(CodexTransportError::Request(format!(
                "Codex does not support collaboration mode \"{mode}\""
            )));
        }
        self.state.collaboration_mode = Some(mode.into());
        self.transport.call("thread/settings/update",json!({"threadId":self.state.thread_id,"collaborationMode":self.collaboration_payload(mode)}),CALL_TIMEOUT).await?;
        Ok(event(
            "session.pinned",
            [
                ("permissionMode", Value::Null),
                ("model", Value::Null),
                ("collaborationMode", json!(mode)),
            ],
        ))
    }
    fn collaboration_payload(&self, mode: &str) -> Value {
        let preset = self.collaboration_presets.get(mode);
        json!({"mode":mode,"settings":{"model":preset.and_then(|preset|preset["model"].as_str()).or(self.state.model.as_deref()).unwrap_or("default"),"reasoning_effort":preset.and_then(|preset|preset["reasoning_effort"].as_str()).or(self.state.effort.as_deref()),"developer_instructions":self.instructions}})
    }
    pub async fn stop_agent(&self, agent_id: &str) -> Result<(), CodexTransportError> {
        let result = self
            .transport
            .call(
                "thread/read",
                json!({"threadId":agent_id,"includeTurns":true}),
                CALL_TIMEOUT,
            )
            .await?;
        let active = result["thread"]["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .find(|turn| turn["status"] == "inProgress")
            .and_then(|turn| turn["id"].as_str())
            .ok_or_else(|| {
                CodexTransportError::Request(format!(
                    "Codex agent {agent_id} has no active turn to stop"
                ))
            })?;
        self.transport
            .call(
                "turn/interrupt",
                json!({"threadId":agent_id,"turnId":active}),
                CALL_TIMEOUT,
            )
            .await?;
        Ok(())
    }
    pub async fn answer(
        &mut self,
        ask_id: &str,
        choice: &str,
        value: Option<&str>,
    ) -> Result<Vec<DriverEvent>, CodexTransportError> {
        let events = self.state.answer(ask_id, choice, value);
        self.flush_responses().await?;
        Ok(events)
    }
    pub async fn answer_questions(
        &mut self,
        request_id: &str,
        answers: &[Value],
    ) -> Result<Vec<DriverEvent>, String> {
        let events = self.state.answer_questions(request_id, answers)?;
        self.flush_responses()
            .await
            .map_err(|error| error.to_string())?;
        Ok(events)
    }
    pub async fn respond_plan(
        &mut self,
        proposal_id: &str,
        action: &str,
        feedback: Option<&str>,
    ) -> Result<Vec<DriverEvent>, CodexTransportError> {
        if !self.state.plans.remove(proposal_id) {
            return Err(CodexTransportError::Request(
                "This Codex plan is no longer awaiting a response".into(),
            ));
        }
        let (status, text) = match action {
            "implement" => (
                "approved",
                "Implement the approved proposed plan.".to_string(),
            ),
            "request_changes" => (
                "changes_requested",
                format!(
                    "Revise the proposed plan with this feedback:\n\n{}",
                    feedback.unwrap_or_default()
                ),
            ),
            _ => {
                return Err(CodexTransportError::Request(format!(
                    "Unknown Codex plan action \"{action}\""
                )))
            }
        };
        let mut events = self.send(&text, &[]).await?;
        events.push(event(
            "plan.resolved",
            [
                ("proposalId", json!(proposal_id)),
                ("status", json!(status)),
                ("actionId", json!(action)),
                (
                    "feedback",
                    feedback.map_or(Value::Null, |feedback| json!(feedback)),
                ),
            ],
        ));
        Ok(events)
    }
    pub async fn close(&self) {
        self.transport.close().await;
    }

    fn drop_image_dirs(&mut self) {
        for directory in self.image_dirs.drain(..) {
            let _ = std::fs::remove_dir_all(directory);
        }
    }

    #[cfg(test)]
    pub(crate) fn staged_images(&self) -> Vec<PathBuf> {
        self.image_dirs
            .iter()
            .flat_map(|directory| std::fs::read_dir(directory).into_iter().flatten().flatten())
            .map(|entry| entry.path())
            .collect()
    }
}

impl Drop for NativeCodexDriver {
    fn drop(&mut self) {
        self.drop_image_dirs();
    }
}

fn permission_event(ask_id: &str, tool: &str, params: &Value) -> DriverEvent {
    event(
        "ask.permission",
        [
            ("askId", json!(ask_id)),
            ("toolName", json!(tool)),
            ("input", params.clone()),
            (
                "title",
                params["reason"]
                    .as_str()
                    .or_else(|| params["command"].as_str())
                    .map_or_else(|| json!("Codex requested approval"), |title| json!(title)),
            ),
            (
                "options",
                json!([{"id":"allow_once","label":"Allow once","kind":"allow_once"},{"id":"allow_always","label":"Allow for session","kind":"allow_always"},{"id":"deny","label":"Deny","kind":"deny"}]),
            ),
        ],
    )
}
fn plan_event(id: &str, markdown: &str) -> DriverEvent {
    event(
        "plan.proposed",
        [
            ("proposalId", json!(id)),
            ("markdown", json!(markdown)),
            (
                "actions",
                json!([{"id":"implement","kind":"implement","label":"Implement plan","description":"Leave Plan mode and ask Codex to implement this plan."},{"id":"request_changes","kind":"request_changes","label":"Request changes","acceptsFeedback":true,"description":"Keep planning and tell Codex what should change."}]),
            ),
        ],
    )
}
fn note(kind: &str, text: &str, rank: &str) -> DriverEvent {
    event(
        "note",
        [
            ("noteId", json!(format!("{kind}:{}", text.len()))),
            ("rank", json!(rank)),
            ("kind", json!(kind)),
            ("text", json!(text)),
            ("body", Value::Null),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options() -> StartOptions {
        StartOptions {
            cwd: "/project".into(),
            resume: None,
            model: Some("gpt-5".into()),
            permission_mode: "on-request".into(),
            effort: Some("high".into()),
            collaboration_mode: Some("plan".into()),
            instructions: "rules".into(),
        }
    }
    #[test]
    fn native_codex_live_streams_turns_tools_usage_and_terminal_state() {
        let mut state = CodexLiveState::new(&options());
        state.thread_id = Some("thread-1".into());
        let mut events = Vec::new();
        for (message, params) in [
            ("turn/started", json!({"turn":{"id":"turn-1"}})),
            (
                "item/agentMessage/delta",
                json!({"itemId":"a","delta":"Hello"}),
            ),
            (
                "item/started",
                json!({"item":{"id":"sh","type":"commandExecution","command":"pwd","status":"inProgress"}}),
            ),
            (
                "item/completed",
                json!({"item":{"id":"sh","type":"commandExecution","command":"pwd","status":"completed","exitCode":0,"aggregatedOutput":"/tmp"}}),
            ),
            (
                "thread/tokenUsage/updated",
                json!({"tokenUsage":{"last":{"totalTokens":7},"total":{"inputTokens":10,"outputTokens":20,"totalTokens":30},"modelContextWindow":100}}),
            ),
            (
                "turn/completed",
                json!({"turn":{"id":"turn-1","status":"completed"}}),
            ),
        ] {
            events.extend(state.handle(CodexInbound::Notification {
                method: message.into(),
                params,
            }));
        }
        for kind in [
            "message.started",
            "text.delta",
            "tool.started",
            "tool.completed",
            "cost",
            "context",
        ] {
            assert!(
                events.iter().any(|event| event["type"] == kind),
                "missing {kind}"
            );
        }
        assert_eq!(events.last().unwrap()["state"], "idle");
        assert!(events.iter().any(|event| event["type"] == "session.state"
            && event["state"] == "running_tool"
            && event["label"] == "Bash"));
    }

    #[test]
    fn native_codex_live_opens_an_agent_message_once_when_start_precedes_delta() {
        let mut state = CodexLiveState::new(&options());
        let started = state.handle(CodexInbound::Notification {
            method: "item/started".into(),
            params: json!({"item":{"id":"answer","type":"agentMessage"}}),
        });
        let delta = state.handle(CodexInbound::Notification {
            method: "item/agentMessage/delta".into(),
            params: json!({"itemId":"answer","delta":"Hello"}),
        });
        assert_eq!(
            started
                .iter()
                .chain(&delta)
                .filter(|event| event["type"] == "message.started")
                .count(),
            1
        );
    }

    #[test]
    fn native_codex_live_keeps_nested_work_owned_until_a_real_idle_edge() {
        let mut state = CodexLiveState::new(&options());
        state.thread_id = Some("parent".into());

        let spawn = json!({
            "threadId":"parent",
            "item":{
                "id":"spawn-1","type":"collabAgentToolCall","tool":"spawnAgent",
                "prompt":"Inspect the importer","receiverThreadIds":["child"],
                "agentsStates":{"child":{"status":"running"}}
            }
        });
        let started = state.handle(CodexInbound::Notification {
            method: "item/started".into(),
            params: spawn.clone(),
        });
        assert!(started.iter().any(|row| row["type"] == "agent.started"
            && row["agentId"] == "child"
            && row["execution"]["conversationId"] == "child"));

        let completed = state.handle(CodexInbound::Notification {
            method: "item/completed".into(),
            params: spawn,
        });
        assert!(!completed.iter().any(|row| row["type"] == "agent.finished"));

        let premature_idle = state.handle(CodexInbound::Notification {
            method: "thread/status/changed".into(),
            params: json!({"threadId":"child","status":{"type":"idle"}}),
        });
        assert!(premature_idle.is_empty(), "{premature_idle:#?}");

        let active = state.handle(CodexInbound::Notification {
            method: "thread/status/changed".into(),
            params: json!({"threadId":"child","status":{"type":"active"}}),
        });
        assert_eq!(active[0]["type"], "agent.progress");

        let tool = state.handle(CodexInbound::Notification {
            method: "item/started".into(),
            params: json!({"threadId":"child","item":{"id":"read-1","type":"commandExecution","command":"cat file"}}),
        });
        let opened_tool = tool
            .iter()
            .find(|row| row["type"] == "tool.started")
            .unwrap();
        assert_eq!(opened_tool["parentToolCallId"], "spawn-1");
        assert_eq!(opened_tool["execution"]["actorId"], "child");
        assert_eq!(opened_tool["execution"]["operationId"], "read-1");
        assert_eq!(opened_tool["execution"]["parentOperationId"], "spawn-1");

        let answer = state.handle(CodexInbound::Notification {
            method: "item/agentMessage/delta".into(),
            params: json!({"threadId":"child","itemId":"answer-1","delta":"Found it"}),
        });
        let opened_message = answer
            .iter()
            .find(|row| row["type"] == "message.started")
            .unwrap();
        assert_eq!(opened_message["parentToolCallId"], "spawn-1");
        assert_eq!(opened_message["execution"]["actorId"], "child");
        assert!(!answer.iter().any(|row| row["type"] == "session.state"));

        state.handle(CodexInbound::Notification {
            method: "item/completed".into(),
            params: json!({"threadId":"child","item":{"id":"answer-1","type":"agentMessage","text":"Found it"}}),
        });
        let finished = state.handle(CodexInbound::Notification {
            method: "thread/status/changed".into(),
            params: json!({"threadId":"child","status":{"type":"idle"}}),
        });
        assert!(finished.iter().any(|row| row["type"] == "agent.finished"
            && row["agentId"] == "child"
            && row["result"] == "Found it"));
    }
    #[test]
    fn native_codex_live_answers_approvals_questions_and_clock_once() {
        let mut state = CodexLiveState::new(&options());
        let asks = state.handle(CodexInbound::Request {
            id: json!(8),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"itemId":"sh","command":"cargo test"}),
        });
        assert_eq!(asks[0]["type"], "ask.permission");
        state.answer("sh", "allow_once", None);
        assert_eq!(
            state.take_responses(),
            [(json!(8), Ok(json!({"decision":"accept"})))]
        );
        let questions=state.handle(CodexInbound::Request{id:json!(9),method:"item/tool/requestUserInput".into(),params:json!({"questions":[{"id":"q","header":"Choice","question":"Choose","options":[{"label":"One"}]}]})});
        assert_eq!(questions[0]["type"], "question.requested");
        state
            .answer_questions("9", &[json!({"questionId":"q","optionIds":["q:option:0"]})])
            .unwrap();
        assert_eq!(
            state.take_responses()[0].1,
            Ok(json!({"answers":{"q":{"answers":["One"]}}}))
        );
        state.handle(CodexInbound::Request {
            id: json!(10),
            method: "currentTime/read".into(),
            params: json!({}),
        });
        assert!(state.take_responses()[0].1.as_ref().unwrap()["currentTimeAt"].is_number());
    }
    #[test]
    fn native_codex_live_gives_each_diagnostic_line_a_distinct_transcript_id() {
        let mut state = CodexLiveState::new(&options());
        let first = state.handle(CodexInbound::ProtocolLine("one".into()));
        let second = state.handle(CodexInbound::ProtocolLine("two".into()));
        let third = state.handle(CodexInbound::Stderr("three".into()));
        assert_eq!(first[0]["noteId"], "protocol:1");
        assert_eq!(second[0]["noteId"], "protocol:2");
        assert_eq!(third[0]["noteId"], "stderr:3");
    }
    #[test]
    fn native_codex_live_proposes_and_resolves_provider_plans() {
        let mut state = CodexLiveState::new(&options());
        let events = state.handle(CodexInbound::Notification {
            method: "item/completed".into(),
            params: json!({"item":{"id":"p","type":"plan","text":"# Plan"}}),
        });
        assert_eq!(events[0]["type"], "plan.proposed");
        assert!(state.plans.contains("p:plan:0"));
    }

    #[test]
    fn native_codex_live_turns_service_elicitation_into_answerable_browser_cards() {
        let mut state = CodexLiveState::new(&options());
        let events = state.handle(CodexInbound::Request {
            id: json!(12),
            method: "mcpServer/elicitation/request".into(),
            params: json!({
                "mode":"form",
                "requestedSchema":{"properties":{
                    "region":{"title":"Region","type":"string","enum":["EU","US"]},
                    "count":{"title":"Count","type":"integer"}
                }}
            }),
        });
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "ask.permission")
                .count(),
            2
        );
        state.answer("mcp:12:region", "EU", None);
        assert!(state.take_responses().is_empty());
        state.answer("mcp:12:count", "answer", Some("3"));
        assert_eq!(
            state.take_responses(),
            [(
                json!(12),
                Ok(json!({"action":"accept","content":{"region":"EU","count":3.0}}))
            )]
        );
    }
}
