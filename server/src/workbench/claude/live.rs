//! Stateful translation between Claude Code stream-json and Atelier's WBP.

use super::transport::{ClaudeInbound, ClaudeTransport, ClaudeTransportError};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use uuid::Uuid;

pub type DriverEvent = Value;
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const WINDOW: i64 = 200_000;
const MODES: &[&str] = &[
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
];

fn event(kind: &str, fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut value = Map::new();
    value.insert("type".into(), json!(kind));
    value.extend(fields.into_iter().map(|(name, value)| (name.into(), value)));
    Value::Object(value)
}

fn note(kind: &str, text: String, body: Value) -> Value {
    event(
        "note",
        [
            ("noteId", json!(Uuid::new_v4().to_string())),
            ("rank", json!("detail")),
            ("kind", json!(kind)),
            ("text", json!(text)),
            ("body", body),
        ],
    )
}

fn one_line(value: &Value) -> String {
    let text = value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string());
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 200 {
        flat
    } else {
        format!("{}…", flat.chars().take(200).collect::<String>())
    }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part["type"].as_str() {
                Some("text") => part["text"].as_str().unwrap_or_default().to_string(),
                Some("image") => format!(
                    "[{}, image]",
                    part["source"]["media_type"].as_str().unwrap_or("image")
                ),
                Some(kind) => format!("[{kind}]"),
                None => "[unknown]".into(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn title(tool: &str, input: &Value) -> String {
    match tool {
        "Bash" => input["command"].as_str().unwrap_or(tool).to_string(),
        "Read" | "Write" | "Edit" => input["file_path"].as_str().unwrap_or(tool).to_string(),
        _ => tool.to_string(),
    }
}

#[derive(Clone, Debug)]
struct Permission {
    request_id: String,
    input: Value,
    suggestions: Value,
}

#[derive(Clone, Debug)]
struct Questions {
    request_id: String,
    input: Value,
    questions: Vec<Value>,
}

#[derive(Clone, Debug)]
struct Plan {
    request_id: String,
    input: Value,
}

pub struct ClaudeLiveState {
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub permission_mode: String,
    pub effort: Option<String>,
    pub awaiting_answer: bool,
    initialization: Value,
    streaming_message: Option<String>,
    streamed: HashSet<String>,
    tools: HashMap<String, String>,
    permissions: HashMap<String, Permission>,
    questions: HashMap<String, Questions>,
    plans: HashMap<String, Plan>,
    agents: HashMap<String, String>,
    calls_to_agents: HashMap<String, String>,
    window: i64,
}

impl ClaudeLiveState {
    pub fn new(
        initialization: Value,
        model: Option<String>,
        mode: String,
        effort: Option<String>,
    ) -> Self {
        Self {
            session_id: None,
            model,
            permission_mode: if MODES.contains(&mode.as_str()) {
                mode
            } else {
                "default".into()
            },
            effort,
            awaiting_answer: false,
            initialization,
            streaming_message: None,
            streamed: HashSet::new(),
            tools: HashMap::new(),
            permissions: HashMap::new(),
            questions: HashMap::new(),
            plans: HashMap::new(),
            agents: HashMap::new(),
            calls_to_agents: HashMap::new(),
            window: WINDOW,
        }
    }

    pub fn menu(&self) -> Value {
        let commands = self.initialization["commands"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let models = self.initialization["models"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let skills = commands
            .iter()
            .filter(|row| row["type"] == "skill" || row["isSkill"] == true)
            .cloned()
            .collect::<Vec<_>>();
        let commands = commands
            .into_iter()
            .filter(|row| row["type"] != "skill" && row["isSkill"] != true)
            .collect::<Vec<_>>();
        let active = self.model.as_deref();
        let selected = models
            .iter()
            .find(|row| row["value"].as_str() == active || row["resolvedModel"].as_str() == active)
            .or_else(|| models.first());
        let efforts = selected
            .and_then(|row| row["supportedEffortLevels"].as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| {
                value
                    .as_str()
                    .map(|value| json!({"value":value,"displayName":capitalize(value)}))
            })
            .collect::<Vec<_>>();
        event(
            "session.menu",
            [
                ("commands", Value::Array(commands)),
                ("skills", Value::Array(skills)),
                ("models", Value::Array(models)),
                ("permissionModes", json!(MODES)),
                ("efforts", Value::Array(efforts)),
                ("agentDefinitions", json!([])),
                ("agentControls", json!(["stop", "park", "say"])),
            ],
        )
    }

    pub fn handle(&mut self, inbound: ClaudeInbound) -> Vec<DriverEvent> {
        match inbound {
            ClaudeInbound::Event(message) => self.draw(&message),
            ClaudeInbound::Request {
                request_id,
                request,
            } => self.request(request_id, request),
            ClaudeInbound::ProtocolLine(line) => vec![note("protocol", line, Value::Null)],
            ClaudeInbound::Stderr(line) => vec![note("stderr", line, Value::Null)],
            ClaudeInbound::Exited(detail) => vec![event(
                "error",
                [
                    ("message", json!(format!("Claude Code exited ({detail})"))),
                    ("fatal", json!(true)),
                ],
            )],
        }
    }

    fn request(&mut self, request_id: String, request: Value) -> Vec<Value> {
        match request["subtype"].as_str() {
            Some("can_use_tool") => self.permission_request(request_id, request),
            Some("request_user_dialog") => self.dialog_request(request_id, request),
            Some(subtype) => vec![note(
                "control_request",
                format!("Claude requested {subtype}"),
                request,
            )],
            None => vec![note(
                "control_request",
                "Claude sent an unnamed request".into(),
                request,
            )],
        }
    }

    fn permission_request(&mut self, request_id: String, request: Value) -> Vec<Value> {
        let tool = request["tool_name"].as_str().unwrap_or("Tool");
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        let parent = request["tool_use_id"]
            .as_str()
            .and_then(|call| self.calls_to_agents.get(call))
            .cloned();
        self.awaiting_answer = true;
        if tool == "AskUserQuestion" {
            let questions = input["questions"].as_array().cloned().unwrap_or_default();
            self.questions.insert(
                request_id.clone(),
                Questions {
                    request_id: request_id.clone(),
                    input,
                    questions: questions.clone(),
                },
            );
            let fields = questions.iter().enumerate().filter_map(|(index, question)| {
                let prompt = question["question"].as_str()?;
                Some(json!({
                    "id":format!("question:{index}"), "header":question["header"].as_str().unwrap_or("Question"),
                    "prompt":prompt, "selection":if question["multiSelect"] == true {"multiple"} else {"single"},
                    "options":question["options"].as_array().into_iter().flatten().enumerate().map(|(option_index, option)|json!({
                        "id":format!("question:{index}:option:{option_index}"), "label":option["label"],
                        "description":option["description"], "preview":option["preview"]
                    })).collect::<Vec<_>>(), "allowCustom":true, "secret":question["isSecret"] == true
                }))
            }).collect::<Vec<_>>();
            let mut asked = event(
                "question.requested",
                [
                    ("requestId", json!(request_id)),
                    ("blocking", json!(true)),
                    ("questions", Value::Array(fields)),
                ],
            );
            if let Some(parent) = parent {
                asked["parentToolCallId"] = json!(parent);
            }
            return vec![
                asked,
                state("waiting_permission", "Waiting for your answer"),
            ];
        }
        if tool == "ExitPlanMode"
            && input["plan"]
                .as_str()
                .is_some_and(|plan| !plan.trim().is_empty())
        {
            self.plans.insert(
                request_id.clone(),
                Plan {
                    request_id: request_id.clone(),
                    input: input.clone(),
                },
            );
            let mut proposed = event(
                "plan.proposed",
                [
                    ("proposalId", json!(request_id)),
                    ("markdown", json!(input["plan"].as_str().unwrap().trim())),
                    (
                        "actions",
                        json!([
                            {"id":"approve","kind":"approve","label":"Approve plan","description":"Approve Claude’s plan and continue."},
                            {"id":"request_changes","kind":"request_changes","label":"Request changes","acceptsFeedback":true,"description":"Keep planning and tell Claude what should change."}
                        ]),
                    ),
                ],
            );
            if let Some(parent) = parent {
                proposed["parentToolCallId"] = json!(parent);
            }
            return vec![
                proposed,
                state("waiting_permission", "Waiting for your plan decision"),
            ];
        }
        let suggestions = request
            .get("permission_suggestions")
            .cloned()
            .unwrap_or(Value::Null);
        self.permissions.insert(
            request_id.clone(),
            Permission {
                request_id: request_id.clone(),
                input: input.clone(),
                suggestions,
            },
        );
        let mut asked = event(
            "ask.permission",
            [
                ("askId", json!(request_id)),
                ("toolName", json!(tool)),
                ("input", input.clone()),
                ("title", json!(title(tool, &input))),
                (
                    "options",
                    json!([
                        {"id":"allow_once","label":"Allow once","kind":"allow_once"},
                        {"id":"allow_always","label":"Allow always","kind":"allow_always"},
                        {"id":"deny","label":"Deny","kind":"deny"}
                    ]),
                ),
            ],
        );
        if let Some(parent) = parent {
            asked["parentToolCallId"] = json!(parent);
        }
        vec![
            asked,
            state("waiting_permission", &format!("Asking about {tool}")),
        ]
    }

    fn dialog_request(&mut self, request_id: String, request: Value) -> Vec<Value> {
        self.awaiting_answer = true;
        self.permissions.insert(
            request_id.clone(),
            Permission {
                request_id: request_id.clone(),
                input: request["payload"].clone(),
                suggestions: Value::Null,
            },
        );
        vec![
            event(
                "ask.permission",
                [
                    ("askId", json!(request_id)),
                    (
                        "toolName",
                        json!(request["dialog_kind"].as_str().unwrap_or("Claude")),
                    ),
                    ("input", request["payload"].clone()),
                    ("title", json!("Claude needs your answer")),
                    (
                        "options",
                        json!([{"id":"allow_once","label":"Continue","kind":"answer"},{"id":"deny","label":"Cancel","kind":"deny"}]),
                    ),
                    ("question", json!(true)),
                ],
            ),
            state("waiting_permission", "Waiting for your answer"),
        ]
    }

    pub fn answer_permission(
        &mut self,
        transport: &ClaudeTransport,
        ask_id: &str,
        choice: &str,
    ) -> Result<Vec<Value>, ClaudeTransportError> {
        let Some(pending) = self.permissions.remove(ask_id) else {
            return Ok(Vec::new());
        };
        let result = match choice {
            "deny" => {
                json!({"behavior":"deny","message":"The owner denied this from Atelier.","decisionClassification":"user_reject"})
            }
            "allow_always" => {
                json!({"behavior":"allow","updatedInput":pending.input,"updatedPermissions":pending.suggestions,"decisionClassification":"user_permanent"})
            }
            _ => {
                json!({"behavior":"allow","updatedInput":pending.input,"decisionClassification":"user_temporary"})
            }
        };
        transport.respond(pending.request_id, Ok(result))?;
        self.awaiting_answer = false;
        Ok(vec![
            event(
                "ask.resolved",
                [("askId", json!(ask_id)), ("chosen", json!(choice))],
            ),
            state("thinking", "Working"),
        ])
    }

    pub fn answer_questions(
        &mut self,
        transport: &ClaudeTransport,
        request_id: &str,
        response: &Value,
    ) -> Result<Vec<Value>, String> {
        let Some(pending) = self.questions.remove(request_id) else {
            return Err("This Claude question is no longer awaiting an answer".into());
        };
        let answers = response["answers"].as_array().cloned().unwrap_or_default();
        let mut supplied = Map::new();
        for (index, question) in pending.questions.iter().enumerate() {
            let id = format!("question:{index}");
            let Some(answer) = answers.iter().find(|answer| answer["questionId"] == id) else {
                let question = question["question"].to_string();
                self.questions.insert(request_id.into(), pending);
                return Err(format!(
                    "No answer was supplied for Claude question {question}"
                ));
            };
            let labels = answer["optionIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|selected| {
                    let option_index = selected.rsplit(':').next()?.parse::<usize>().ok()?;
                    question["options"][option_index]["label"]
                        .as_str()
                        .map(str::to_string)
                })
                .chain(
                    answer["customText"]
                        .as_str()
                        .filter(|text| !text.trim().is_empty())
                        .map(|text| text.trim().to_string()),
                )
                .collect::<Vec<_>>();
            supplied.insert(
                question["question"].as_str().unwrap_or_default().into(),
                json!(labels.join(", ")),
            );
        }
        let mut input = pending.input;
        input["answers"] = Value::Object(supplied);
        transport
            .respond(
                pending.request_id,
                Ok(json!({"behavior":"allow","updatedInput":input})),
            )
            .map_err(|error| error.to_string())?;
        self.awaiting_answer = false;
        Ok(vec![
            event(
                "question.resolved",
                [
                    ("requestId", json!(request_id)),
                    ("answers", Value::Array(answers)),
                ],
            ),
            state("thinking", "Working"),
        ])
    }

    pub fn respond_plan(
        &mut self,
        transport: &ClaudeTransport,
        proposal_id: &str,
        action: &str,
        feedback: Option<&str>,
    ) -> Result<Vec<Value>, String> {
        let Some(pending) = self.plans.remove(proposal_id) else {
            return Err("This Claude plan is no longer awaiting a response".into());
        };
        let (answer, status) = match action {
            "approve" => (
                json!({"behavior":"allow","updatedInput":pending.input}),
                "approved",
            ),
            "request_changes" => {
                let feedback = feedback
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| "Plan feedback is required".to_string())?;
                (
                    json!({"behavior":"deny","message":feedback}),
                    "changes_requested",
                )
            }
            _ => return Err(format!("Unknown Claude plan action {action}")),
        };
        transport
            .respond(pending.request_id, Ok(answer))
            .map_err(|error| error.to_string())?;
        self.awaiting_answer = false;
        let mut resolved = event(
            "plan.resolved",
            [
                ("proposalId", json!(proposal_id)),
                ("status", json!(status)),
                ("actionId", json!(action)),
            ],
        );
        if let Some(feedback) = feedback {
            resolved["feedback"] = json!(feedback);
        }
        Ok(vec![resolved, state("thinking", "Working")])
    }

    pub async fn set_mode(
        &mut self,
        transport: &ClaudeTransport,
        mode: &str,
    ) -> Result<Vec<Value>, ClaudeTransportError> {
        if !MODES.contains(&mode) {
            return Err(ClaudeTransportError::Request(format!(
                "Unknown Claude permission mode {mode}"
            )));
        }
        transport
            .call(
                json!({"subtype":"set_permission_mode","mode":mode}),
                CALL_TIMEOUT,
            )
            .await?;
        self.permission_mode = mode.into();
        Ok(vec![
            event(
                "session.pinned",
                [("permissionMode", json!(mode)), ("model", Value::Null)],
            ),
            note(
                "mode",
                format!("Permission mode is now {mode}."),
                Value::Null,
            ),
        ])
    }

    pub async fn set_model(
        &mut self,
        transport: &ClaudeTransport,
        model: &str,
    ) -> Result<Vec<Value>, ClaudeTransportError> {
        transport
            .call(json!({"subtype":"set_model","model":model}), CALL_TIMEOUT)
            .await?;
        self.model = Some(model.into());
        Ok(vec![
            event(
                "session.pinned",
                [("permissionMode", Value::Null), ("model", json!(model))],
            ),
            note("model", format!("Model is now {model}."), Value::Null),
            self.menu(),
        ])
    }

    pub async fn set_effort(
        &mut self,
        transport: &ClaudeTransport,
        effort: &str,
    ) -> Result<Vec<Value>, ClaudeTransportError> {
        transport
            .call(
                json!({"subtype":"apply_flag_settings","settings":{"effortLevel":effort}}),
                CALL_TIMEOUT,
            )
            .await?;
        self.effort = Some(effort.into());
        Ok(vec![event(
            "session.pinned",
            [
                ("permissionMode", Value::Null),
                ("model", Value::Null),
                ("effort", json!(effort)),
            ],
        )])
    }

    pub async fn interrupt(
        &mut self,
        transport: &ClaudeTransport,
    ) -> Result<Vec<Value>, ClaudeTransportError> {
        for (_, pending) in self.permissions.drain() {
            transport.respond(
                pending.request_id,
                Ok(json!({"behavior":"deny","message":"Stopped by the owner.","interrupt":true})),
            )?;
        }
        for (_, pending) in self.questions.drain() {
            transport.respond(
                pending.request_id,
                Ok(json!({"behavior":"deny","message":"Stopped by the owner.","interrupt":true})),
            )?;
        }
        for (_, pending) in self.plans.drain() {
            transport.respond(
                pending.request_id,
                Ok(json!({"behavior":"deny","message":"Stopped by the owner.","interrupt":true})),
            )?;
        }
        transport
            .call(
                json!({"subtype":"interrupt","cancel_queued":true}),
                CALL_TIMEOUT,
            )
            .await?;
        self.awaiting_answer = false;
        Ok(vec![state("stopped", "Stopped")])
    }

    pub async fn stop_agent(
        &self,
        transport: &ClaudeTransport,
        agent: &str,
    ) -> Result<(), ClaudeTransportError> {
        transport
            .call(json!({"subtype":"stop_task","task_id":agent}), CALL_TIMEOUT)
            .await
            .map(|_| ())
    }

    pub async fn park_agent(
        &self,
        transport: &ClaudeTransport,
        agent: &str,
    ) -> Result<bool, ClaudeTransportError> {
        let Some(call) = self.agents.get(agent) else {
            return Ok(false);
        };
        let answer = transport
            .call(
                json!({"subtype":"background_tasks","tool_use_id":call}),
                CALL_TIMEOUT,
            )
            .await?;
        Ok(answer["backgrounded"]
            .as_bool()
            .or_else(|| answer.as_bool())
            .unwrap_or(false))
    }

    pub fn send_prompt(
        &mut self,
        transport: &ClaudeTransport,
        text: &str,
        images: &[Value],
    ) -> Result<Vec<Value>, ClaudeTransportError> {
        let content = if images.is_empty() {
            Value::String(text.into())
        } else {
            let mut blocks = images.iter().filter_map(|image| {
                let mime=image["mime"].as_str()?; let data=image["dataUrl"].as_str()?.split_once(',')?.1;
                Some(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}))
            }).collect::<Vec<_>>();
            blocks.push(json!({"type":"text","text":text}));
            Value::Array(blocks)
        };
        transport.send(json!({"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":content}}))?;
        self.awaiting_answer = true;
        Ok(vec![state("thinking", "Thinking")])
    }

    pub fn draw(&mut self, message: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        match message["type"].as_str() {
            Some("system") => self.system(message, &mut events),
            Some("stream_event") => self.stream(message, &mut events),
            Some("assistant") => self.assistant(message, &mut events),
            Some("user") => self.user(message, &mut events),
            Some("tool_progress") => events.push(event(
                "tool.progress",
                [
                    ("toolCallId", message["tool_use_id"].clone()),
                    ("seconds", message["elapsed_time_seconds"].clone()),
                ],
            )),
            Some("result") => {
                self.awaiting_answer = false;
                if message["total_cost_usd"].is_number() {
                    events.push(event(
                        "cost",
                        [(
                            "cost",
                            json!({"kind":"usd","usd":message["total_cost_usd"]}),
                        )],
                    ));
                }
                let ok = message["subtype"] == "success";
                events.push(state(
                    if ok { "idle" } else { "errored" },
                    if ok { "Ready" } else { "Failed" },
                ));
                if message["is_error"] == true {
                    events.push(note(
                        "result",
                        one_line(&message["result"]),
                        message["result"].clone(),
                    ));
                }
            }
            Some(kind) => events.push(note(
                kind,
                spoken(message).unwrap_or_else(|| format!("Claude reported {kind}")),
                message.clone(),
            )),
            None => events.push(note(
                "unknown",
                "Claude sent an unnamed event".into(),
                message.clone(),
            )),
        }
        events
    }

    fn system(&mut self, message: &Value, events: &mut Vec<Value>) {
        let subtype = message["subtype"].as_str().unwrap_or("unknown");
        if subtype == "init" {
            self.session_id = message["session_id"].as_str().map(str::to_string);
            self.model = message["model"]
                .as_str()
                .map(str::to_string)
                .or(self.model.clone());
            self.permission_mode = message["permissionMode"]
                .as_str()
                .unwrap_or(&self.permission_mode)
                .to_string();
            events.push(event(
                "session.started",
                [
                    ("brand", json!("claude")),
                    (
                        "externalId",
                        message.get("session_id").cloned().unwrap_or(Value::Null),
                    ),
                    (
                        "model",
                        message.get("model").cloned().unwrap_or(Value::Null),
                    ),
                    ("cwd", message.get("cwd").cloned().unwrap_or(json!(""))),
                    ("permissionMode", json!(self.permission_mode)),
                    (
                        "effort",
                        message
                            .get("effort")
                            .cloned()
                            .unwrap_or_else(|| json!(self.effort)),
                    ),
                ],
            ));
            events.push(state(
                if self.awaiting_answer {
                    "thinking"
                } else {
                    "idle"
                },
                if self.awaiting_answer {
                    "Thinking"
                } else {
                    "Ready"
                },
            ));
            events.push(self.menu());
            return;
        }
        if subtype == "thinking_tokens" {
            events.push(event(
                "thinking.progress",
                [("tokens", message["estimated_tokens"].clone())],
            ));
            return;
        }
        if subtype == "task_progress" && message["tool_use_id"].is_string() {
            events.push(event(
                "tool.progress",
                [
                    ("toolCallId", message["tool_use_id"].clone()),
                    (
                        "seconds",
                        json!(message["usage"]["duration_ms"].as_i64().unwrap_or_default() / 1000),
                    ),
                    (
                        "summary",
                        message.get("summary").cloned().unwrap_or(Value::Null),
                    ),
                ],
            ));
            return;
        }
        if subtype == "task_started" {
            let id = message["task_id"].as_str().unwrap_or_default();
            let call = message["tool_use_id"].as_str().map(str::to_string);
            if let Some(call) = &call {
                self.agents.insert(id.into(), call.clone());
                self.calls_to_agents.insert(call.clone(), id.into());
            }
            events.push(event(
                "agent.started",
                [
                    ("agentId", json!(id)),
                    ("toolCallId", json!(call)),
                    ("kind", json!("helper")),
                    (
                        "what",
                        message.get("description").cloned().unwrap_or(json!("")),
                    ),
                    (
                        "agentType",
                        message.get("agent_type").cloned().unwrap_or(Value::Null),
                    ),
                    ("model", Value::Null),
                ],
            ));
            return;
        }
        if subtype == "task_notification" {
            let id = message["task_id"].as_str().unwrap_or_default();
            let state_name = if message["status"] == "failed" {
                "failed"
            } else {
                "done"
            };
            events.push(event(
                "agent.finished",
                [
                    ("agentId", json!(id)),
                    ("state", json!(state_name)),
                    (
                        "seconds",
                        json!(message["usage"]["duration_ms"].as_i64().unwrap_or_default() / 1000),
                    ),
                    ("tokens", message["usage"]["total_tokens"].clone()),
                    ("calls", message["usage"]["tool_uses"].clone()),
                    (
                        "model",
                        message.get("model").cloned().unwrap_or(Value::Null),
                    ),
                    (
                        "result",
                        message.get("summary").cloned().unwrap_or(Value::Null),
                    ),
                ],
            ));
            return;
        }
        if subtype == "compact_boundary" {
            events.push(note(
                "system/compact_boundary",
                "This chat folded its history up.".into(),
                message.clone(),
            ));
            return;
        }
        if subtype == "status" {
            if let Some(mode) = message["permissionMode"].as_str() {
                if mode != self.permission_mode {
                    self.permission_mode = mode.into();
                    events.push(event(
                        "session.pinned",
                        [("permissionMode", json!(mode)), ("model", Value::Null)],
                    ));
                }
            }
            return;
        }
        events.push(note(
            &format!("system/{subtype}"),
            spoken(message).unwrap_or_else(|| format!("Claude reported {subtype}")),
            message.clone(),
        ));
    }

    fn stream(&mut self, message: &Value, events: &mut Vec<Value>) {
        let wire = &message["event"];
        match wire["type"].as_str() {
            Some("message_start") => {
                let id = wire["message"]["id"]
                    .as_str()
                    .or_else(|| message["uuid"].as_str())
                    .unwrap_or_default();
                self.streaming_message = Some(id.into());
                self.streamed.insert(id.into());
            }
            Some("content_block_start") if wire["content_block"]["type"] == "text" => {
                let id = self.block_id(wire);
                events.push(event(
                    "message.started",
                    [("messageId", json!(id)), ("role", json!("assistant"))],
                ));
                events.push(state("streaming", "Answering"));
            }
            Some("content_block_start") if wire["content_block"]["type"] == "thinking" => {
                events.push(state("thinking", "Thinking"))
            }
            Some("content_block_delta") if wire["delta"]["type"] == "text_delta" => {
                events.push(event(
                    "text.delta",
                    [
                        ("messageId", json!(self.block_id(wire))),
                        ("text", wire["delta"]["text"].clone()),
                    ],
                ))
            }
            Some("content_block_delta")
                if wire["delta"]["type"] == "thinking_delta"
                    && wire["delta"]["thinking"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty()) =>
            {
                events.push(event(
                    "thinking.delta",
                    [
                        ("messageId", json!(self.block_id(wire))),
                        ("text", wire["delta"]["thinking"].clone()),
                    ],
                ))
            }
            Some("content_block_stop") => events.push(event(
                "message.completed",
                [("messageId", json!(self.block_id(wire)))],
            )),
            _ => {}
        }
    }

    fn block_id(&self, wire: &Value) -> String {
        format!(
            "{}:{}",
            self.streaming_message
                .as_deref()
                .unwrap_or("claude-message"),
            wire["index"].as_i64().unwrap_or_default()
        )
    }

    fn assistant(&mut self, message: &Value, events: &mut Vec<Value>) {
        let parent = message["parent_tool_use_id"].as_str();
        let id = message["message"]["id"]
            .as_str()
            .or_else(|| message["uuid"].as_str())
            .unwrap_or_default();
        if !id.is_empty() && self.streamed.insert(id.into()) {
            for (index, block) in message["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let block_id = format!("{id}:{index}");
                if block["type"] == "thinking"
                    && block["thinking"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())
                {
                    let mut thought = event(
                        "thinking.delta",
                        [
                            ("messageId", json!(block_id)),
                            ("text", block["thinking"].clone()),
                        ],
                    );
                    if let Some(parent) = parent {
                        thought["parentToolCallId"] = json!(parent);
                    }
                    events.push(thought);
                    events.push(event("message.completed", [("messageId", json!(block_id))]));
                } else if block["type"] == "text"
                    && block["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty())
                {
                    let mut opened = event(
                        "message.started",
                        [("messageId", json!(block_id)), ("role", json!("assistant"))],
                    );
                    if let Some(parent) = parent {
                        opened["parentToolCallId"] = json!(parent);
                    }
                    events.push(opened);
                    events.push(event(
                        "text.delta",
                        [
                            ("messageId", json!(block_id)),
                            ("text", block["text"].clone()),
                        ],
                    ));
                    events.push(event("message.completed", [("messageId", json!(block_id))]));
                }
            }
        }
        if parent.is_none() {
            if let Some(window) = message["context_usage"]["raw_max_tokens"].as_i64() {
                self.window = window;
            }
            let u = &message["message"]["usage"];
            let used = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "output_tokens",
            ]
            .iter()
            .filter_map(|field| u[*field].as_i64())
            .sum::<i64>();
            if used > 0 {
                events.push(event(
                    "context",
                    [("used", json!(used)), ("window", json!(self.window))],
                ));
            }
        }
        for block in message["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if block["type"] != "tool_use" {
                continue;
            }
            let call = block["id"].as_str().unwrap_or_default();
            let name = block["name"].as_str().unwrap_or("Tool");
            self.tools.insert(call.into(), name.into());
            if let Some(parent) = parent {
                self.calls_to_agents.insert(call.into(), parent.into());
            }
            events.push(event(
                "tool.started",
                [
                    ("toolCallId", json!(call)),
                    ("name", json!(name)),
                    ("input", block["input"].clone()),
                    ("title", json!(title(name, &block["input"]))),
                    ("parentToolCallId", json!(parent)),
                ],
            ));
            events.push(state("running_tool", &format!("Running {name}")));
        }
    }

    fn user(&mut self, message: &Value, events: &mut Vec<Value>) {
        for block in message["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if block["type"] != "tool_result" {
                continue;
            }
            let call = block["tool_use_id"].as_str().unwrap_or_default();
            self.tools.remove(call);
            events.push(event(
                "tool.completed",
                [
                    ("toolCallId", json!(call)),
                    ("ok", json!(block["is_error"] != true)),
                    ("output", json!(result_text(&block["content"]))),
                ],
            ));
            for part in block["content"].as_array().into_iter().flatten() {
                if part["type"] == "image" {
                    let mime = part["source"]["media_type"].as_str().unwrap_or("image/*");
                    if let Some(data) = part["source"]["data"].as_str() {
                        let message_id = format!("{call}:images");
                        events.push(event(
                            "message.started",
                            [
                                ("messageId", json!(message_id)),
                                ("role", json!("assistant")),
                            ],
                        ));
                        events.push(event("image",[("messageId",json!(message_id)),("image",json!({"mime":mime,"dataUrl":format!("data:{mime};base64,{data}"),"alt":"Agent-produced image"}))]));
                        events.push(event(
                            "message.completed",
                            [("messageId", json!(message_id))],
                        ));
                    }
                }
            }
        }
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}
fn state(state_name: &str, label: &str) -> Value {
    event(
        "session.state",
        [("state", json!(state_name)), ("label", json!(label))],
    )
}
fn spoken(message: &Value) -> Option<String> {
    for field in [
        "content",
        "text",
        "message",
        "error",
        "summary",
        "reason",
        "result",
        "description",
    ] {
        if let Some(text) = message[field]
            .as_str()
            .filter(|text| !text.trim().is_empty())
        {
            return Some(one_line(&json!(text)));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> ClaudeLiveState {
        ClaudeLiveState::new(
            json!({"commands":[{"name":"compact"}],"models":[{"value":"sonnet","supportedEffortLevels":["low","high"]}]}),
            Some("sonnet".into()),
            "default".into(),
            None,
        )
    }
    #[test]
    fn native_claude_live_streams_words_tools_context_and_results() {
        let mut live = live();
        assert!(live.draw(&json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}})).is_empty());
        assert_eq!(live.draw(&json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}))[0]["type"],"message.started");
        assert_eq!(live.draw(&json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}))[0]["text"],"hello");
        let events=live.draw(&json!({"type":"assistant","message":{"id":"m1","usage":{"input_tokens":5,"cache_read_input_tokens":3,"output_tokens":2},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test"}}]},"parent_tool_use_id":null}));
        assert!(events.iter().any(|event| event["type"] == "tool.started"));
        assert!(events
            .iter()
            .any(|event| event["type"] == "context" && event["used"] == 10));
        let events=live.draw(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}));
        assert!(events
            .iter()
            .any(|event| event["type"] == "tool.completed" && event["output"] == "ok"));
    }
    #[test]
    fn native_claude_live_turns_permissions_questions_and_plans_into_cards() {
        let mut live = live();
        let events=live.handle(ClaudeInbound::Request{request_id:"p1".into(),request:json!({"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1","input":{"command":"rm x"},"permission_suggestions":[{"type":"addRules"}]})});
        assert_eq!(events[0]["type"], "ask.permission");
        assert_eq!(events[0]["askId"], "p1");
        let events=live.handle(ClaudeInbound::Request{request_id:"q1".into(),request:json!({"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"header":"Pick","question":"Which?","options":[{"label":"A"}]}]}})});
        assert_eq!(events[0]["type"], "question.requested");
        let events=live.handle(ClaudeInbound::Request{request_id:"plan1".into(),request:json!({"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"Do it"}})});
        assert_eq!(events[0]["type"], "plan.proposed");
    }
    #[test]
    fn native_claude_live_preserves_unknown_messages_and_builds_menu() {
        let mut live = live();
        let events=live.draw(&json!({"type":"brand_new_event","description":"A useful sentence","extra":{"kept":true}}));
        assert_eq!(events[0]["type"], "note");
        assert_eq!(events[0]["body"]["extra"]["kept"], true);
        let menu = live.menu();
        assert_eq!(menu["permissionModes"].as_array().unwrap().len(), 6);
        assert_eq!(menu["efforts"][1]["value"], "high");
    }
}
