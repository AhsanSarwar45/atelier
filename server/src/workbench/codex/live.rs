//! Stateful native Codex chat behavior above the owned transport.

use super::history::{thread_open_request, OpenRequest};
use super::normalize::{CodexNormalizer, DriverEvent};
use super::transport::{CodexInbound, CodexTransport, CodexTransportConfig, CodexTransportError};
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
    messages: HashSet<String>,
    tool_output: HashMap<String, String>,
    agents: HashSet<String>,
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
            CodexInbound::Exited(detail) => vec![event(
                "error",
                [
                    (
                        "message",
                        json!(format!("Codex app-server exited ({detail})")),
                    ),
                    ("fatal", json!(true)),
                ],
            )],
        }
    }

    fn notification(&mut self, method: &str, params: &Value) -> Vec<DriverEvent> {
        let mut events = Vec::new();
        match method {
            "thread/status/changed" => {
                let status = params.get("status").or_else(|| params["thread"].get("status")).cloned().unwrap_or_else(||json!({}));
                let changed = params["threadId"].as_str().or_else(||params["thread"]["id"].as_str());
                if changed.is_some() && changed != self.thread_id.as_deref() {
                    let id=changed.unwrap();
                    if self.agents.contains(id) && matches!(status["type"].as_str(),Some("idle"|"systemError")) {
                        events.push(event("agent.finished",[("agentId",json!(id)),("state",json!(if status["type"]=="idle"{"done"}else{"failed"})),("seconds",json!(0)),("tokens",json!(0)),("calls",json!(0)),("model",Value::Null),("result",Value::Null)]));
                        self.agents.remove(id);
                    }
                } else {
                    let waiting=status["activeFlags"].as_array().is_some_and(|flags|flags.iter().any(|flag|matches!(flag.as_str(),Some("waitingOnApproval"|"waitingOnUserInput"))));
                    let (state,label)=match status["type"].as_str(){Some("active") if waiting=>("waiting_permission","Waiting for you"),Some("active")=>("thinking","Working"),Some("systemError")=>("errored","Failed"),_=>("idle","Ready")};
                    events.push(event("session.state",[("state",json!(state)),("label",json!(label))]));
                }
            }
            "item/agentMessage/delta" => {
                let id=params["itemId"].as_str().unwrap_or_default();
                if self.messages.insert(id.to_string()){events.push(event("message.started",[("messageId",json!(id)),("role",json!("assistant"))]));events.push(event("session.state",[("state",json!("streaming")),("label",json!("Answering"))]));}
                events.push(event("text.delta",[("messageId",json!(id)),("text",params["delta"].clone())]));
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => events.push(event("thinking.delta",[("messageId",params["itemId"].clone()),("text",params["delta"].clone())])),
            "turn/plan/updated" => events.push(event("todo",[("items",Value::Array(params["plan"].as_array().into_iter().flatten().enumerate().map(|(index,row)|json!({"id":index.to_string(),"text":row["step"],"status":row["status"]})).collect()))])),
            "item/started" => {
                if params["item"]["type"]=="subAgentActivity" || params["item"]["type"]=="collabAgentToolCall" {
                    for id in params["item"]["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str){self.agents.insert(id.to_string());}
                    if let Some(id)=params["item"]["agentThreadId"].as_str(){self.agents.insert(id.to_string());}
                }
                self.normalizer.item_started(&params["item"],&mut events);
                if events.iter().any(|row|row["type"]=="tool.started"){events.push(event("session.state",[("state",json!("running_tool")),("label",params["item"]["type"].clone())]));}
            }
            "item/completed" => {
                if params["item"]["type"]=="plan" {
                    let markdown=params["item"]["text"].as_str().unwrap_or_default().trim();
                    if !markdown.is_empty(){let id=format!("{}:plan:0",params["item"]["id"].as_str().unwrap_or_default());self.plans.insert(id.clone());events.push(plan_event(&id,markdown));}
                } else { self.normalizer.item_completed(&params["item"],&mut events); }
            }
            "thread/tokenUsage/updated" => {
                if !params["tokenUsage"]["total"].is_null(){let total=&params["tokenUsage"]["total"];events.push(event("cost",[("cost",json!({"kind":"tokens","input":total["inputTokens"],"output":total["outputTokens"],"total":total["totalTokens"]}))]));}
                if let (Some(used),Some(window))=(params["tokenUsage"]["last"]["totalTokens"].as_i64(),params["tokenUsage"]["modelContextWindow"].as_i64()){events.push(event("context",[("used",json!(used)),("window",json!(window))]));}
            }
            "turn/started" => {self.turn_id=params["turn"]["id"].as_str().map(str::to_string);events.push(event("session.state",[("state",json!("thinking")),("label",json!("Thinking"))]));}
            "turn/completed" => {
                self.turn_id=None;let status=params["turn"]["status"].as_str();let (state,label)=match status{Some("failed")=>("errored","Failed"),Some("interrupted")=>("stopped","Stopped"),_=>("idle","Ready")};
                if status==Some("failed"){events.push(event("error",[("message",params["turn"]["error"]["message"].as_str().map_or_else(||json!("Codex turn failed"),|message|json!(message))),("fatal",json!(false))]));}
                events.push(event("session.state",[("state",json!(state)),("label",json!(label))]));
            }
            "error" => events.push(event("error",[("message",params["error"]["message"].as_str().or_else(||params["message"].as_str()).map_or_else(||json!("Codex error"),|message|json!(message))),("fatal",json!(false))])),
            "item/fileChange/patchUpdated" => for change in params["changes"].as_array().into_iter().flatten(){events.push(event("diff",[("toolCallId",params["itemId"].clone()),("path",change["path"].clone()),("before",json!("")),("after",change["diff"].clone())]));},
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                let id=params["itemId"].as_str().unwrap_or_default();let output=self.tool_output.entry(id.to_string()).or_default();output.push_str(params["delta"].as_str().unwrap_or_default());events.push(event("tool.progress",[("toolCallId",json!(id)),("seconds",json!(0)),("summary",json!(output.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>()))]));
            }
            "thread/compacted" => {events.push(note("compact",params["message"].as_str().unwrap_or("Conversation compacted."),"note"));events.push(event("session.state",[("state",json!("idle")),("label",json!("Ready"))]));}
            "warning" | "model/rerouted" => events.push(note(method,params["message"].as_str().unwrap_or(&params.to_string()),"note")),
            _ if !method.ends_with("/delta") && !method.ends_with("/outputDelta") => events.push(note(method,params["message"].as_str().unwrap_or(&params.to_string()),"detail")),
            _ => {}
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
    collaboration_presets: HashMap<String, Value>,
}

impl NativeCodexDriver {
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
        let inbound = transport
            .take_inbound()
            .ok_or(CodexTransportError::Stopped)?;
        let events = vec![
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
        ];
        Ok((
            Self {
                transport,
                inbound,
                state,
                instructions: options.instructions,
                collaboration_presets: HashMap::new(),
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
        let events = self.state.handle(inbound);
        self.flush_responses().await?;
        Ok(events)
    }
    pub async fn send(&mut self, text: &str) -> Result<Vec<DriverEvent>, CodexTransportError> {
        let thread = self
            .state
            .thread_id
            .clone()
            .ok_or(CodexTransportError::Stopped)?;
        let input = json!([{"type":"text","text":text,"text_elements":[]}]);
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
    pub fn set_model(&mut self, model: &str) -> DriverEvent {
        self.state.model = (model != "default").then(|| model.to_string());
        event(
            "session.pinned",
            [("permissionMode", Value::Null), ("model", json!(model))],
        )
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
        let mut events = self.send(&text).await?;
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
