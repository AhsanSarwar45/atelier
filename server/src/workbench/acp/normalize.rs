//! Lossless ACP session updates translated once into Atelier's canonical events.

use super::super::protocol::{record_event_id, Event};
use chrono::Utc;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

pub struct AcpNormalizer {
    serial: u64,
    event_serial: Cell<u64>,
    stream_id: String,
    active_messages: HashMap<String, (String, String)>,
    message_text: HashMap<String, String>,
    root_assistant_messages: HashSet<String>,
    active_thinking: HashMap<String, String>,
    started_messages: HashSet<String>,
    open_tools: HashSet<String>,
    tool_starts: HashMap<String, Value>,
    subagent_tools: HashSet<String>,
    deferred_agents: HashMap<String, String>,
    goose_tasks: HashMap<String, String>,
    agent_tools: HashMap<String, String>,
    agent_names: HashMap<String, String>,
    active_signals: HashMap<String, String>,
    suppress_local_user: bool,
    menu: Value,
    cwd: PathBuf,
}

impl Default for AcpNormalizer {
    fn default() -> Self {
        Self {
            serial: 0,
            event_serial: Cell::new(0),
            stream_id: uuid::Uuid::new_v4().to_string(),
            active_messages: HashMap::new(),
            message_text: HashMap::new(),
            root_assistant_messages: HashSet::new(),
            active_thinking: HashMap::new(),
            started_messages: HashSet::new(),
            open_tools: HashSet::new(),
            tool_starts: HashMap::new(),
            subagent_tools: HashSet::new(),
            deferred_agents: HashMap::new(),
            goose_tasks: HashMap::new(),
            agent_tools: HashMap::new(),
            agent_names: HashMap::new(),
            active_signals: HashMap::new(),
            suppress_local_user: false,
            menu: json!({"commands":[],"skills":[],"models":[],"efforts":[],"permissionModes":[],"collaborationModes":[],"agentDefinitions":[],"agentControls":[],"configOptions":[]}),
            cwd: PathBuf::from("."),
        }
    }
}

impl AcpNormalizer {
    pub fn new(cwd: PathBuf) -> Self {
        Self {
            cwd,
            ..Self::default()
        }
    }

    pub fn set_menu(&mut self, menu: Value) {
        self.menu = menu;
    }

    fn menu_event(&mut self, session_id: &str, provider: &str, raw: &Value) -> Event {
        let mut menu = self.menu.clone();
        menu["type"] = json!("session.menu");
        self.envelope(session_id, provider, raw, menu)
    }

    fn next_id(&mut self, stem: &str) -> String {
        self.serial += 1;
        format!("acp-{stem}-{}", self.serial)
    }

    fn opaque_note(
        &mut self,
        session_id: &str,
        provider: &str,
        raw: &Value,
        kind: &str,
        text: String,
        body: &Value,
    ) -> Event {
        let note_id = self.next_id("note");
        self.envelope(session_id, provider, raw, json!({
            "type":"note","noteId":note_id,"rank":"detail","kind":kind,
            "text":text,"body":serde_json::to_string(body).unwrap_or_default(),"audience":"machine"
        }))
    }

    fn envelope(&self, session_id: &str, provider: &str, raw: &Value, mut event: Value) -> Event {
        let ordinal = self.event_serial.get() + 1;
        self.event_serial.set(ordinal);
        let object = event.as_object_mut().expect("canonical event is an object");
        object.insert("sessionId".into(), json!(session_id));
        object.insert("seq".into(), json!(0));
        object.insert(
            "at".into(),
            json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        object.insert(
            "providerEvent".into(),
            json!({
                "provider": provider,
                "threadId": raw.get("sessionId"),
                "eventId": format!("{}:{ordinal}:{}", self.stream_id, record_event_id(raw)),
                "delivery": "live",
                "transport": "acp"
            }),
        );
        serde_json::from_value(event).expect("normalizer only emits typed WBP events")
    }

    fn content_text(content: &Value) -> Option<&str> {
        (content["type"] == "text")
            .then(|| content["text"].as_str())
            .flatten()
    }

    fn display_text(value: &Value) -> String {
        match value {
            Value::Null => String::new(),
            Value::String(text) => text.clone(),
            Value::Array(rows) => rows
                .iter()
                .map(Self::display_text)
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            Value::Object(row) => row
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    row.get("content")
                        .map(Self::display_text)
                        .filter(|text| !text.is_empty())
                })
                .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default()),
            _ => value.to_string(),
        }
    }

    fn complete_message(
        &mut self,
        session_id: &str,
        provider: &str,
        raw: &Value,
        id: String,
        stop_reason: Value,
    ) -> Vec<Event> {
        let mut events = vec![self.envelope(
            session_id,
            provider,
            raw,
            json!({"type":"message.completed","messageId":id,"stopReason":stop_reason}),
        )];
        let text = self.message_text.remove(&id).unwrap_or_default();
        if !self.root_assistant_messages.remove(&id) || text.is_empty() {
            return events;
        }
        if let Some(mut signal) = crate::workbench::provider_messages::from_text(&text) {
            signal["sourceMessageId"] = json!(id);
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"provider.message","signal":signal}),
            ));
        }
        for widget in crate::workbench::media::widget_specs(&text) {
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"widget","messageId":id,"widget":widget}),
            ));
        }
        for comparison in crate::workbench::media::comparison_specs(&text, &self.cwd) {
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"image.compare","messageId":id,"comparison":comparison}),
            ));
        }
        events
    }

    fn plan_items(entries: &Value) -> Vec<Value> {
        entries
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, entry)| {
                let text = entry["content"].as_str()?.to_string();
                let id = entry["id"]
                    .as_str()
                    .or_else(|| entry.pointer("/_meta/id").and_then(Value::as_str))
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("acp-plan-{index}-{}", record_event_id(entry)));
                let status = match entry["status"].as_str() {
                    Some("in_progress") => "in_progress",
                    Some("completed") => "completed",
                    _ => "pending",
                };
                Some(json!({"id":id,"text":text,"status":status}))
            })
            .collect()
    }

    fn plan_update(&mut self, session_id: &str, provider: &str, raw: &Value) -> Vec<Event> {
        let plan = &raw["update"]["plan"];
        match plan["type"].as_str() {
            Some("items") => vec![self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"todo","items":Self::plan_items(&plan["entries"]),"acp":raw["update"]
                }),
            )],
            Some("markdown") => {
                vec![self.envelope(session_id, provider, raw, json!({
                "type":"plan.proposed","proposalId":plan["planId"],"markdown":plan["content"],
                "actions":[],"acp":raw["update"]
            }))]
            }
            Some("file") => {
                let uri = plan["uri"].as_str().unwrap_or_default();
                vec![self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({
                        "type":"plan.proposed","proposalId":plan["planId"],
                        "markdown":format!("[Open plan]({uri})"),"actions":[],"acp":raw["update"]
                    }),
                )]
            }
            _ => vec![self.opaque_note(
                session_id,
                provider,
                raw,
                "acp/plan-update",
                "ACP sent an unsupported plan representation".to_string(),
                plan,
            )],
        }
    }

    fn failure_signal(failure: &Value) -> Option<Value> {
        let id = failure["id"].as_str()?.to_string();
        let title = failure["title"]
            .as_str()
            .unwrap_or("The provider reported a problem");
        let inferred = crate::workbench::provider_messages::from_text(title);
        let kind = inferred
            .as_ref()
            .and_then(|signal| signal["kind"].as_str())
            .unwrap_or_else(|| match failure["category"].as_str() {
                Some("connection") => "network",
                Some("access") => "authorization",
                Some("limit") => "rate_limit",
                Some("request") => "provider_error",
                Some("service") => "service_unavailable",
                _ => "unknown",
            });
        let severity = match failure["severity"].as_str() {
            Some("warning") => "warning",
            Some("info") => "info",
            Some("blocking") => "blocking",
            _ => "error",
        };
        let detail = failure["details"]
            .as_str()
            .filter(|details| !details.is_empty())
            .map(|details| format!("{title}\n{details}"))
            .unwrap_or_else(|| title.to_string());
        Some(json!({
            "id":id,"kind":kind,"phase":"active","severity":severity,
            "scope":if matches!(kind, "authentication" | "usage_limit") {"session"} else {"turn"},
            "detail":detail,"retryAt":Value::Null,"action":Value::Null
        }))
    }

    fn typed_failure(value: &Value) -> Option<Value> {
        value
            .pointer("/_meta/jetbrains/air/sessionFailure")
            .and_then(Self::failure_signal)
    }

    fn record_signal(&mut self, signal: &Value) {
        if let (Some(id), Some(kind)) = (signal["id"].as_str(), signal["kind"].as_str()) {
            self.active_signals.insert(id.to_string(), kind.to_string());
        }
    }

    fn resolve_signals(&mut self, session_id: &str, provider: &str, raw: &Value) -> Vec<Event> {
        std::mem::take(&mut self.active_signals)
            .into_iter()
            .map(|(id, kind)| {
                self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({
                        "type":"provider.message","signal":{
                            "id":id,"kind":kind,"phase":"resolved","severity":"info","scope":"turn"
                        }
                    }),
                )
            })
            .collect()
    }

    fn session_info(&mut self, session_id: &str, provider: &str, raw: &Value) -> Vec<Event> {
        let update = &raw["update"];
        let mut events = Vec::new();
        if let Some(signal) = Self::typed_failure(update) {
            self.record_signal(&signal);
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"provider.message","signal":signal}),
            ));
        }
        if let Some(report) = update.pointer("/_meta/jetbrains/air/agentFileChangeReport") {
            let status = report["status"].as_str().unwrap_or("unavailable");
            let paths = report["paths"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let text = if status == "reported" {
                format!(
                    "Provider reported {} changed file{}",
                    paths.len(),
                    if paths.len() == 1 { "" } else { "s" }
                )
            } else {
                format!("Provider file-change report was {status}")
            };
            events.push(self.opaque_note(
                session_id,
                provider,
                raw,
                "acp/agent-file-change-report",
                text,
                report,
            ));
        }
        if let Some(status) = update.pointer("/_meta/codex/threadStatus") {
            let waiting = status["activeFlags"].as_array().is_some_and(|flags| {
                flags.iter().any(|flag| {
                    matches!(
                        flag.as_str(),
                        Some("waitingOnApproval" | "waitingOnUserInput")
                    )
                })
            });
            let (state, label) = match status["type"].as_str() {
                Some("active") if waiting => ("waiting_permission", "Waiting for you"),
                Some("active") => ("thinking", "Working"),
                Some("systemError") => ("errored", "Failed"),
                Some("notLoaded") => ("dormant", "Asleep"),
                _ => ("idle", "Ready"),
            };
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"session.state","state":state,"label":label,"acp":update
                }),
            ));
        } else if update.pointer("/_meta/codex/closed") == Some(&Value::Bool(true))
            || update.pointer("/_meta/codex/archived") == Some(&Value::Bool(true))
        {
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"session.state","state":"dormant","label":"Asleep","acp":update
                }),
            ));
        } else if update.pointer("/_meta/codex/archived") == Some(&Value::Bool(false)) {
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"session.state","state":"idle","label":"Ready","acp":update
                }),
            ));
        }
        if update["title"].is_string() {
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"session.pinned","permissionMode":Value::Null,"model":Value::Null,
                    "effort":Value::Null,"collaborationMode":Value::Null,"title":update["title"],
                    "updatedAt":update["updatedAt"],"acp":update
                }),
            ));
        }
        if events.is_empty() {
            events.push(self.opaque_note(
                session_id,
                provider,
                raw,
                "acp/session-info",
                "ACP updated provider session metadata".to_string(),
                update,
            ));
        }
        events
    }

    fn tool_name(update: &Value) -> String {
        if let Some(name) = update
            .pointer("/_meta/claudeCode/toolName")
            .and_then(Value::as_str)
        {
            return name.to_string();
        }
        if let Some(name) = update
            .pointer("/_meta/codex/collaboration/tool")
            .and_then(Value::as_str)
        {
            return match name {
                "spawn" => "spawn_agent",
                "wait" => "wait_agent",
                "sendMessage" | "send_message" => "send_message",
                other => other,
            }
            .to_string();
        }
        if let Some(name) = update
            .pointer("/_meta/goose/toolCall/toolName")
            .and_then(Value::as_str)
        {
            return name.to_string();
        }
        update["title"].as_str().unwrap_or("Tool").to_string()
    }

    fn tool_input(&self, update: &Value) -> Value {
        let mut input = update["rawInput"].clone();
        if Self::tool_name(update) == "wait_agent" {
            let missing_target = input
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
                && input
                    .get("receiverThreadIds")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty);
            if missing_target && self.subagent_tools.len() == 1 {
                if let Some(agent) = self.subagent_tools.iter().next() {
                    input["target"] = json!(self.agent_names.get(agent).unwrap_or(agent));
                }
            }
        }
        input
    }

    fn tool_title(update: &Value, name: &str) -> Value {
        if update.pointer("/_meta/codex/collaboration/tool").is_some() {
            json!(name)
        } else {
            update["title"].clone()
        }
    }

    fn goose_background_task_id(summary: &str) -> Option<&str> {
        let id = summary
            .strip_prefix("Task ")?
            .split_once(" started in background:")?
            .0;
        let (day, ordinal) = id.split_once('_')?;
        (day.len() == 8
            && day.chars().all(|ch| ch.is_ascii_digit())
            && !ordinal.is_empty()
            && ordinal.chars().all(|ch| ch.is_ascii_digit()))
        .then_some(id)
    }

    fn parent_tool_call(&self, raw: &Value) -> Option<String> {
        let thread = raw["sessionId"].as_str().unwrap_or("root");
        raw["update"]
            .pointer("/_meta/claudeCode/parentToolUseId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.agent_tools.get(thread).cloned())
    }

    fn message_chunk(
        &mut self,
        session_id: &str,
        provider: &str,
        raw: &Value,
        role: &str,
        content: &Value,
    ) -> Vec<Event> {
        if Self::content_text(content).is_none() && content["type"] != "image" {
            let content_kind = content["type"].as_str().unwrap_or("unknown");
            return vec![self.opaque_note(
                session_id,
                provider,
                raw,
                &format!("acp/content/{content_kind}"),
                format!("ACP sent {content_kind} content"),
                content,
            )];
        }
        let mut events = Vec::new();
        let thread = raw["sessionId"].as_str().unwrap_or("root");
        let parent = self.parent_tool_call(raw);
        if role == "assistant" {
            if let Some(agent) = parent
                .as_ref()
                .filter(|id| self.subagent_tools.contains(*id))
            {
                if let Some(text) = Self::content_text(content) {
                    self.deferred_agents
                        .entry(agent.clone())
                        .or_default()
                        .push_str(text);
                }
            } else {
                let finished = self.deferred_agents.keys().cloned().collect::<Vec<_>>();
                for agent in finished {
                    let result = self.deferred_agents.remove(&agent).unwrap_or_default();
                    if let Some((_, id)) = self.active_messages.remove(&format!("{thread}:{agent}"))
                    {
                        events.extend(self.complete_message(
                            session_id,
                            provider,
                            raw,
                            id,
                            Value::Null,
                        ));
                    }
                    self.subagent_tools.remove(&agent);
                    events.push(self.envelope(session_id, provider, raw, json!({
                        "type":"agent.finished", "agentId":agent, "state":"done", "result":result,
                        "seconds":0, "tokens":0, "calls":0, "model":Value::Null
                    })));
                }
            }
        }
        let lane = format!("{thread}:{}", parent.as_deref().unwrap_or("root"));
        if role == "assistant" {
            if let Some(id) = self.active_thinking.remove(&lane) {
                events.extend(self.complete_message(session_id, provider, raw, id, Value::Null));
            }
        }
        let sent_id = raw["update"]["messageId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|id| format!("acp-{id}"));
        let id = match (sent_id, self.active_messages.get(&lane)) {
            (Some(id), _) => id,
            (None, Some((active_role, id))) if active_role == role => id.clone(),
            _ => {
                if let Some((_, id)) = self.active_messages.remove(&lane) {
                    events.extend(self.complete_message(
                        session_id,
                        provider,
                        raw,
                        id,
                        Value::Null,
                    ));
                }
                self.next_id("message")
            }
        };
        self.active_messages
            .insert(lane.clone(), (role.to_string(), id.clone()));
        if self.started_messages.insert(id.clone()) {
            if role == "assistant" && parent.is_none() {
                self.root_assistant_messages.insert(id.clone());
            }
            events.push(self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({"type":"message.started","messageId":id,"role":role,"parentToolCallId":parent}),
                ));
        }
        if let Some(text) = Self::content_text(content) {
            if role == "assistant" {
                self.message_text
                    .entry(id.clone())
                    .or_default()
                    .push_str(text);
            }
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"text.delta","messageId":id,"text":text}),
            ));
        } else {
            let mime = content["mimeType"].as_str().unwrap_or("image/png");
            let data_url = content["uri"]
                .as_str()
                .filter(|uri| uri.starts_with("data:"))
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!(
                        "data:{mime};base64,{}",
                        content["data"].as_str().unwrap_or_default()
                    )
                });
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"image","messageId":id,"image":{"mime":mime,"dataUrl":data_url,"alt":content["alt"].as_str().unwrap_or("Agent image")}}),
            ));
        }
        events
    }

    fn thinking_chunk(
        &mut self,
        session_id: &str,
        provider: &str,
        raw: &Value,
        text: &str,
    ) -> Vec<Event> {
        let thread = raw["sessionId"].as_str().unwrap_or("root");
        let parent = self.parent_tool_call(raw);
        let lane = format!("{thread}:{}", parent.as_deref().unwrap_or("root"));
        let sent_id = raw["update"]["messageId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|id| format!("acp-{id}"));
        let mut events = Vec::new();
        let id = match (sent_id, self.active_thinking.get(&lane)) {
            (Some(id), Some(active)) if id != *active => {
                events.extend(self.complete_message(
                    session_id,
                    provider,
                    raw,
                    active.clone(),
                    Value::Null,
                ));
                id
            }
            (Some(id), _) => id,
            (None, Some(active)) => active.clone(),
            (None, None) => self.next_id("thinking"),
        };
        self.active_thinking.insert(lane, id.clone());
        events.push(self.envelope(
            session_id,
            provider,
            raw,
            json!({
                "type":"thinking.delta", "messageId":id, "text":text,
                "parentToolCallId":parent
            }),
        ));
        events
    }

    pub fn update(&mut self, session_id: &str, provider: &str, raw: &Value) -> Vec<Event> {
        let update = &raw["update"];
        match update["sessionUpdate"].as_str() {
            Some("user_message_chunk") if self.suppress_local_user => Vec::new(),
            Some("user_message_chunk") => self.message_chunk(session_id, provider, raw, "user", &update["content"]),
            Some("agent_message_chunk") => self.message_chunk(session_id, provider, raw, "assistant", &update["content"]),
            Some("agent_thought_chunk") => Self::content_text(&update["content"])
                .map(|text| self.thinking_chunk(session_id, provider, raw, text))
                .unwrap_or_default(),
            Some("tool_call") => {
                let id = update["toolCallId"].as_str().unwrap_or_default().to_string();
                self.open_tools.insert(id.clone());
                let name = Self::tool_name(update);
                let input = self.tool_input(update);
                let title = Self::tool_title(update, &name);
                let parent = self.parent_tool_call(raw);
                let started = json!({"type":"tool.started","toolCallId":id,"name":name.clone(),"title":title,"parentToolCallId":parent,"input":input.clone(),"acp":update});
                self.tool_starts.insert(id.clone(), started.clone());
                let mut events = vec![self.envelope(session_id, provider, raw, started)];
                let subagent = update
                    .pointer("/_meta/claudeCode/subagent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || update.pointer("/_meta/codex/subagent").is_some()
                    || name == "delegate";
                if subagent {
                    self.subagent_tools.insert(id.clone());
                    events.push(self.envelope(
                        session_id,
                        provider,
                        raw,
                        json!({
                            "type":"agent.started","agentId":id,"toolCallId":id,"kind":"helper",
                            "what":input["instructions"].as_str().or_else(||update["title"].as_str()).unwrap_or("Delegated task"),
                            "agentType":update.pointer("/_meta/codex/subagent/name")
                                .or_else(||update.pointer("/_meta/claudeCode/subagentType"))
                                .or_else(||input.get("source")),
                            "model":update.pointer("/_meta/codex/subagent/model").or_else(||input.get("model"))
                        }),
                    ));
                }
                events
            }
            Some("tool_call_update") => {
                let id = update["toolCallId"].as_str().unwrap_or_default().to_string();
                let status = update["status"].as_str().unwrap_or("in_progress");
                let mut refinements = Vec::new();
                if !update["rawInput"].is_null() {
                    if let Some(mut started) = self.tool_starts.get(&id).cloned() {
                        let refined = self.tool_input(update);
                        if let (Some(current), Some(addition)) = (started["input"].as_object_mut(), refined.as_object()) {
                            current.extend(addition.clone());
                        } else {
                            started["input"] = refined;
                        }
                        let name = Self::tool_name(update);
                        if !update["title"].is_null() { started["title"] = Self::tool_title(update, &name); }
                        started["name"] = json!(name);
                        started["acp"] = update.clone();
                        self.tool_starts.insert(id.clone(), started.clone());
                        refinements.push(self.envelope(session_id, provider, raw, started));
                    }
                }
                if self.subagent_tools.contains(&id) {
                    if let Some(agent_type) = update.pointer("/rawInput/subagent_type").and_then(Value::as_str)
                        .or_else(|| update.pointer("/_meta/claudeCode/subagentType").and_then(Value::as_str)) {
                        refinements.push(self.envelope(session_id, provider, raw, json!({"type":"agent.identified","agentId":id,"agentType":agent_type})));
                    }
                }
                let summary = update["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| row.get("content").and_then(Self::content_text))
                    .collect::<Vec<_>>()
                    .join("\n");
                let started_name = self.tool_starts.get(&id)
                    .and_then(|started| started["name"].as_str())
                    .unwrap_or_default()
                    .to_string();
                let started_input = self.tool_starts.get(&id)
                    .map(|started| started["input"].clone())
                    .unwrap_or(Value::Null);
                let diffs = update["content"].as_array().into_iter().flatten()
                    .filter(|row| row["type"] == "diff")
                    .map(|row| self.envelope(
                        session_id, provider, raw,
                        json!({"type":"diff","toolCallId":id,"path":row["path"].as_str().unwrap_or_default(),"before":row["oldText"].as_str().unwrap_or_default(),"after":row["newText"].as_str().unwrap_or_default()})
                    )).collect::<Vec<_>>();
                if matches!(status, "completed" | "failed") {
                    self.open_tools.remove(&id);
                    self.tool_starts.remove(&id);
                    let output = Self::display_text(&update["rawOutput"]);
                    let output = if output.is_empty() { summary.clone() } else { output };
                    let mut events = refinements;
                    events.extend(diffs);
                    events.push(self.envelope(
                        session_id,
                        provider,
                        raw,
                        json!({"type":"tool.completed","toolCallId":id,"ok":status=="completed","output":output,"summary":summary,"acp":update}),
                    ));
                    let asynchronous = update.pointer("/_meta/claudeCode/toolResponse/isAsync")
                        .and_then(Value::as_bool).unwrap_or(false)
                        || update.pointer("/rawInput/async").and_then(Value::as_bool).unwrap_or(false)
                        || started_input["async"].as_bool().unwrap_or(false);
                    if self.subagent_tools.contains(&id) && asynchronous {
                        self.deferred_agents.entry(id.clone()).or_default();
                        if let Some(task_id) = Self::goose_background_task_id(&summary) {
                            self.goose_tasks.insert(task_id.to_string(), id.clone());
                        }
                    } else if self.subagent_tools.remove(&id) {
                        events.push(self.envelope(
                            session_id,
                            provider,
                            raw,
                            json!({"type":"agent.finished","agentId":id,"state":if status=="completed"{"done"}else{"failed"},"result":summary,"seconds":0,"tokens":0,"calls":0,"model":Value::Null}),
                        ));
                    }
                    if started_name == "load" {
                        let task_id = started_input["source"].as_str().unwrap_or_default();
                        let peek = started_input["peek"].as_bool().unwrap_or(false);
                        if !peek {
                            if let Some(agent) = self.goose_tasks.remove(task_id) {
                                self.deferred_agents.remove(&agent);
                                self.subagent_tools.remove(&agent);
                                let state = if started_input["cancel"].as_bool().unwrap_or(false) {
                                    "stopped"
                                } else if status == "completed" && !summary.contains("**Status:** ✗") {
                                    "done"
                                } else {
                                    "failed"
                                };
                                events.push(self.envelope(
                                    session_id,
                                    provider,
                                    raw,
                                    json!({"type":"agent.finished","agentId":agent,"state":state,"result":summary,"seconds":0,"tokens":0,"calls":0,"model":Value::Null}),
                                ));
                            }
                        }
                    }
                    events
                } else {
                    let mut events = refinements;
                    events.extend(diffs);
                    events.push(self.envelope(
                        session_id,
                        provider,
                        raw,
                        json!({"type":"tool.progress","toolCallId":id,"seconds":0,"summary":summary,"status":status,"acp":update}),
                    ));
                    events
                }
            }
            Some("plan") => vec![self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"todo","items":Self::plan_items(&update["entries"]),"acp":update}),
            )],
            Some("plan_update") => self.plan_update(session_id, provider, raw),
            Some("plan_removed") => vec![self.envelope(
                session_id, provider, raw,
                json!({"type":"plan.resolved","proposalId":update["planId"],"status":"superseded","actionId":"removed","acp":update}),
            )],
            Some("usage_update") => {
                let mut events = vec![self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({"type":"context","used":update["used"],"window":update["size"],"source":"acp"}),
                )];
                if !update["cost"].is_null() {
                    let currency = update["cost"]["currency"].as_str().unwrap_or("USD");
                    let cost = if currency.eq_ignore_ascii_case("USD") {
                        json!({"type":"cost","cost":{"kind":"usd","usd":update["cost"]["amount"]},"source":"acp"})
                    } else {
                        return {
                            events.push(self.opaque_note(
                                session_id, provider, raw, "acp/cost",
                                format!("ACP reported a cost in {currency}"), &update["cost"],
                            ));
                            events
                        };
                    };
                    events.push(self.envelope(session_id, provider, raw, cost));
                }
                events
            }
            Some("current_mode_update") => vec![self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"session.pinned","permissionMode":super::client::mode_from_acp(provider, update["currentModeId"].as_str().unwrap_or_default()),"model":Value::Null,"effort":Value::Null,"collaborationMode":Value::Null}),
            )],
            Some("config_option_update") => {
                let translated = super::client::menu_fields(
                    provider,
                    self.menu["currentModel"].as_str(),
                    &json!({}),
                    &update["configOptions"],
                    &self.menu["agentControls"],
                    &self.menu["agentDefinitions"],
                );
                let model = translated["currentModel"].clone();
                let effort = translated["currentEffort"].clone();
                let collaboration = translated["currentCollaborationMode"].clone();
                for field in ["efforts","collaborationModes","configOptions"] {
                    self.menu[field] = translated[field].clone();
                }
                if provider != super::super::local::BRAND {
                    self.menu["models"] = translated["models"].clone();
                }
                vec![
                    self.menu_event(session_id, provider, raw),
                    self.envelope(session_id, provider, raw, json!({
                        "type":"session.pinned","permissionMode":Value::Null,"model":model,
                        "effort":effort,"collaborationMode":collaboration
                    })),
                ]
            }
            Some("available_commands_update") => {
                self.menu["commands"] = update["availableCommands"].clone();
                vec![self.menu_event(session_id, provider, raw)]
            }
            Some("session_info_update") => self.session_info(session_id, provider, raw),
            Some("subagent_spawned") => {
                let child = update["subagentSessionId"].as_str().unwrap_or_default().to_string();
                self.agent_tools.insert(child.clone(), child.clone());
                self.subagent_tools.insert(child.clone());
                let name = update["name"].as_str().unwrap_or("child").to_string();
                self.agent_names.insert(child.clone(), name.clone());
                vec![self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({"type":"tool.started","toolCallId":child,"name":"spawn_agent","title":"Spawn child agent","parentToolCallId":Value::Null,"input":{"task_name":name,"description":update["task"]},"acp":update}),
                ), self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({"type":"agent.started","agentId":child,"toolCallId":child,"kind":"helper","what":update["task"],"agentType":name,"model":Value::Null,"acp":update}),
                )]
            }
            Some("subagent_state_update") => {
                let child = update["subagentSessionId"].as_str().unwrap_or_default();
                let state = match update["state"].as_str() {
                    Some("completed") => "done",
                    Some("cancelled") => "stopped",
                    Some("failed" | "disconnected") => "failed",
                    _ => "running",
                };
                if state == "running" {
                    vec![self.envelope(session_id, provider, raw, json!({
                        "type":"agent.progress","agentId":child,"seconds":0,"tokens":0,"calls":0,
                        "doing":update["detail"].as_str().unwrap_or("Working"),"state":"running","acp":update
                    }))]
                } else {
                    self.subagent_tools.remove(child);
                    vec![self.envelope(
                        session_id,
                        provider,
                        raw,
                        json!({"type":"agent.finished","agentId":child,"state":state,"result":Value::Null,"seconds":0,"tokens":0,"calls":0,"model":Value::Null,"acp":update}),
                    )]
                }
            }
            _ => {
                let kind = update["sessionUpdate"].as_str().unwrap_or("unknown");
                vec![self.opaque_note(
                    session_id, provider, raw, &format!("acp/update/{kind}"),
                    format!("ACP sent an unrecognized {kind} update"), raw,
                )]
            }
        }
    }

    pub fn finish_turn(&mut self, session_id: &str, provider: &str, raw: &Value) -> Vec<Event> {
        self.suppress_local_user = false;
        let failure = Self::typed_failure(raw);
        let mut events = Vec::new();
        for (agent, result) in std::mem::take(&mut self.deferred_agents) {
            if result.is_empty() {
                continue;
            }
            self.subagent_tools.remove(&agent);
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"agent.finished", "agentId":agent, "state":"done", "result":result,
                    "seconds":0, "tokens":0, "calls":0, "model":Value::Null
                }),
            ));
        }
        for (_, (_, id)) in std::mem::take(&mut self.active_messages) {
            events.extend(self.complete_message(
                session_id,
                provider,
                raw,
                id,
                raw["stopReason"].clone(),
            ));
        }
        for (_, id) in std::mem::take(&mut self.active_thinking) {
            events.extend(self.complete_message(
                session_id,
                provider,
                raw,
                id,
                raw["stopReason"].clone(),
            ));
        }
        self.started_messages.clear();
        if raw["usage"].is_object() {
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"cost","cost":{"kind":"tokens","input":raw["usage"]["inputTokens"],"output":raw["usage"]["outputTokens"],"total":raw["usage"]["totalTokens"],"thinking":raw["usage"]["thoughtTokens"],"cacheRead":raw["usage"]["cachedReadTokens"],"cacheWrite":raw["usage"]["cachedWriteTokens"]},"source":"acp-prompt"}),
            ));
        }
        let failed = failure.as_ref().is_some_and(|signal| {
            matches!(signal["severity"].as_str(), Some("error" | "blocking"))
        });
        if let Some(signal) = failure {
            self.record_signal(&signal);
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"provider.message","signal":signal}),
            ));
        } else {
            events.extend(self.resolve_signals(session_id, provider, raw));
        }
        events.push(self.envelope(
            session_id,
            provider,
            raw,
            json!({"type":"session.state","state":if failed{"errored"}else{"idle"},"label":if failed{"Provider failed"}else{"Ready"}}),
        ));
        events
    }

    pub fn fail_turn(&mut self, session_id: &str, provider: &str, message: &str) -> Vec<Event> {
        let raw = json!({"error":message});
        let mut events = self.finish_turn(session_id, provider, &raw);
        events.pop();
        events.push(self.envelope(
            session_id,
            provider,
            &raw,
            json!({"type":"error","message":message,"fatal":false,"source":"acp"}),
        ));
        events.push(self.envelope(
            session_id,
            provider,
            &raw,
            json!({"type":"session.state","state":"errored","label":"Failed"}),
        ));
        events
    }

    pub fn begin_local_prompt(&mut self) {
        self.suppress_local_user = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(events: &[Event]) -> Vec<Value> {
        events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap()["type"].clone())
            .collect()
    }

    #[test]
    fn every_provider_uses_the_same_message_mapping() {
        let raw = json!({"sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}});
        let mut claude = AcpNormalizer::default();
        let mut codex = AcpNormalizer::default();
        let a = claude.update("local", "claude", &raw);
        let b = codex.update("local", "codex", &raw);
        assert_eq!(kinds(&a), kinds(&b));
        assert_eq!(kinds(&a), vec!["message.started", "text.delta"]);
        assert_eq!(serde_json::to_value(&a[1]).unwrap()["text"], "hello");
    }

    #[test]
    fn finishing_a_turn_closes_the_open_message() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}));
        let events = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        assert_eq!(kinds(&events), vec!["message.completed", "session.state"]);
    }

    #[test]
    fn final_root_text_keeps_atelier_widget_post_processing() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done\n```atelier-widget\n{\"type\":\"metrics\",\"items\":[{\"label\":\"Checks\",\"value\":1}]}\n```"}
        }}));
        let events = normalizer.finish_turn("local", "codex", &json!({"stopReason":"end_turn"}));
        assert_eq!(
            kinds(&events),
            vec!["message.completed", "widget", "session.state"]
        );
        let widget = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(widget["messageId"], "acp-message-1");
        assert_eq!(widget["widget"]["type"], "metrics");
    }

    #[test]
    fn thought_blocks_have_stable_identity_and_finish_before_the_answer() {
        let mut normalizer = AcpNormalizer::default();
        let first = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"agent_thought_chunk","messageId":"thought-1","content":{"type":"text","text":"considering"}
        }}));
        let thought = serde_json::to_value(&first[0]).unwrap();
        assert_eq!(thought["messageId"], "acp-thought-1");
        let answer = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"agent_message_chunk","messageId":"answer-1","content":{"type":"text","text":"done"}
        }}));
        assert_eq!(
            kinds(&answer),
            vec!["message.completed", "message.started", "text.delta"]
        );
        assert_eq!(
            serde_json::to_value(&answer[0]).unwrap()["messageId"],
            "acp-thought-1"
        );
    }

    #[test]
    fn context_occupancy_is_not_mislabeled_as_additive_token_cost() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{"sessionUpdate":"usage_update","used":1200,"size":200000,"cost":{"amount":1.5,"currency":"USD"}}}));
        assert_eq!(kinds(&events), vec!["context", "cost"]);
        let context = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(context["used"], 1200);
        assert_eq!(context["window"], 200000);
        let cost = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(cost["cost"]["kind"], "usd");
        assert_eq!(cost["cost"]["usd"], 1.5);
    }

    #[test]
    fn plan_entries_are_translated_to_the_canonical_todo_contract() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"plan","entries":[
                {"content":"Inspect the adapter","priority":"high","status":"in_progress"},
                {"content":"Verify the UI","priority":"medium","status":"completed","_meta":{"id":"screen-check"}}
            ]
        }}));
        let event = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(event["items"][0]["text"], "Inspect the adapter");
        assert_eq!(event["items"][0]["status"], "in_progress");
        assert!(event["items"][0]["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("acp-plan-0-")));
        assert_eq!(
            event["items"][1],
            json!({"id":"screen-check","text":"Verify the UI","status":"completed"})
        );
    }

    #[test]
    fn newer_codex_markdown_plans_keep_stable_identity_and_visible_content() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"plan_update","plan":{"type":"markdown","planId":"plan-1","content":"# Verify\n\nRun the screen check."}
        }}));
        assert_eq!(kinds(&events), vec!["plan.proposed"]);
        let event = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(event["proposalId"], "plan-1");
        assert_eq!(event["markdown"], "# Verify\n\nRun the screen check.");
        assert_eq!(event["actions"], json!([]));
    }

    #[test]
    fn partial_pinned_updates_explicitly_leave_other_settings_untouched() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update(
            "local",
            "codex",
            &json!({"sessionId":"remote","update":{
                "sessionUpdate":"current_mode_update","currentModeId":"read-only"
            }}),
        );
        let event = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(event["permissionMode"], "untrusted");
        assert!(event["model"].is_null());
        assert!(event["effort"].is_null());
        assert!(event["collaborationMode"].is_null());
    }

    #[test]
    fn config_updates_refresh_the_catalog_and_the_selected_settings() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.set_menu(json!({
            "commands":[],"skills":[],"models":[],"efforts":[],"permissionModes":["on-request"],
            "collaborationModes":[],"agentDefinitions":[],"agentControls":["stop","park","say"]
        }));
        let events = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"config_option_update","configOptions":[
                {"id":"model","category":"model","currentValue":"gpt-5.6-sol","options":[{"value":"gpt-5.6-sol","name":"GPT-5.6-Sol"}]},
                {"id":"reasoning_effort","category":"thought_level","currentValue":"high","options":[{"value":"high","name":"High"}]}
            ]
        }}));
        assert_eq!(kinds(&events), vec!["session.menu", "session.pinned"]);
        let menu = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(menu["models"][0]["value"], "gpt-5.6-sol");
        assert_eq!(menu["permissionModes"], json!(["on-request"]));
        let pinned = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(pinned["model"], "gpt-5.6-sol");
        assert_eq!(pinned["effort"], "high");
        assert!(pinned["permissionMode"].is_null());
    }

    #[test]
    fn unknown_extensions_remain_lossless_notes_without_forging_a_signal() {
        let raw = json!({"sessionId":"remote","update":{"sessionUpdate":"future_extension","answer":42},"_meta":{"vendor":"kept"}});
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update("local", "future", &raw);
        let event = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(event["type"], "note");
        assert_eq!(event["kind"], "acp/update/future_extension");
        assert_eq!(event["rank"], "detail");
        assert_eq!(event["audience"], "machine");
        let body: Value = serde_json::from_str(event["body"].as_str().unwrap()).unwrap();
        assert_eq!(body, raw);
    }

    #[test]
    fn non_usd_costs_stay_lossless_without_violating_the_cost_contract() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update("local", "future", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"usage_update","used":10,"size":100,"cost":{"amount":2.5,"currency":"EUR"}
        }}));
        assert_eq!(kinds(&events), vec!["context", "note"]);
        let note = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(note["kind"], "acp/cost");
        assert!(note["body"].as_str().unwrap().contains("EUR"));
    }

    #[test]
    fn codex_lifecycle_metadata_becomes_the_shared_rich_session_state() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update(
            "local",
            "codex",
            &json!({"sessionId":"remote","update":{
                "sessionUpdate":"session_info_update","_meta":{"codex":{"threadStatus":{
                    "type":"active","activeFlags":["waitingOnApproval"]
                }}}
            }}),
        );
        assert_eq!(kinds(&events), vec!["session.state"]);
        let state = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(state["state"], "waiting_permission");
        assert_eq!(state["label"], "Waiting for you");
    }

    #[test]
    fn typed_provider_failures_are_semantic_and_resolve_after_a_successful_turn() {
        let mut normalizer = AcpNormalizer::default();
        let failed = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"session_info_update","_meta":{"jetbrains":{"air":{"sessionFailure":{
                "id":"turn-1:error","revision":1,"category":"service","severity":"error",
                "title":"Codex is temporarily overloaded.","actions":["retry"]
            }}}}
        }}));
        assert_eq!(kinds(&failed), vec!["provider.message"]);
        let active = serde_json::to_value(&failed[0]).unwrap();
        assert_eq!(active["signal"]["kind"], "service_unavailable");
        assert_eq!(active["signal"]["phase"], "active");
        let recovered = normalizer.finish_turn("local", "codex", &json!({"stopReason":"end_turn"}));
        assert_eq!(kinds(&recovered), vec!["provider.message", "session.state"]);
        let resolved = serde_json::to_value(&recovered[0]).unwrap();
        assert_eq!(resolved["signal"]["id"], "turn-1:error");
        assert_eq!(resolved["signal"]["phase"], "resolved");
    }

    #[test]
    fn prompt_level_typed_failures_do_not_end_with_a_false_ready_state() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.finish_turn(
            "local",
            "codex",
            &json!({
                "stopReason":"end_turn","_meta":{"jetbrains":{"air":{"sessionFailure":{
                    "id":"turn-2:error","category":"connection","severity":"error",
                    "title":"Connection to Codex was lost."
                }}}}
            }),
        );
        assert_eq!(kinds(&events), vec!["provider.message", "session.state"]);
        let signal = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(signal["signal"]["kind"], "network");
        let state = serde_json::to_value(&events[1]).unwrap();
        assert_eq!(state["state"], "errored");
        assert_eq!(state["label"], "Provider failed");
    }

    #[test]
    fn repeated_identical_chunks_keep_distinct_provider_event_ids() {
        let raw = json!({"sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" "}}});
        let mut normalizer = AcpNormalizer::default();
        let first = normalizer.update("local", "claude", &raw);
        let second = normalizer.update("local", "claude", &raw);
        assert_ne!(
            serde_json::to_value(&first[1]).unwrap()["providerEvent"]["eventId"],
            serde_json::to_value(&second[0]).unwrap()["providerEvent"]["eventId"]
        );
    }

    #[test]
    fn locally_recorded_user_prompt_is_not_echoed_twice() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.begin_local_prompt();
        let user = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello"}}}));
        assert!(user.is_empty());
        let agent = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}));
        assert_eq!(kinds(&agent), vec!["message.started", "text.delta"]);
        let delayed = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello"}}}));
        assert!(delayed.is_empty());
        normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        let external = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"from elsewhere"}}}));
        assert_eq!(kinds(&external), vec!["message.started", "text.delta"]);
    }

    #[test]
    fn native_subagent_sessions_map_to_the_shared_agent_lifecycle() {
        let mut normalizer = AcpNormalizer::default();
        let spawned = normalizer.update("local", "codex", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
            "subagentSessionId":"child-1","name":"Researcher","task":"Check the protocol","capabilities":{}}
        }));
        assert_eq!(kinds(&spawned), vec!["tool.started", "agent.started"]);
        assert_eq!(
            serde_json::to_value(&spawned[0]).unwrap()["name"],
            "spawn_agent"
        );
        assert_eq!(serde_json::to_value(&spawned[1]).unwrap()["kind"], "helper");
        let child = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"child-1", "update":{"sessionUpdate":"agent_message_chunk",
                "messageId":"child-message","content":{"type":"text","text":"Done"}}
            }),
        );
        let message = serde_json::to_value(&child[0]).unwrap();
        assert_eq!(message["parentToolCallId"], "child-1");
        let finished = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"subagent_state_update",
                "subagentSessionId":"child-1","state":"completed"}
            }),
        );
        assert_eq!(kinds(&finished), vec!["agent.finished"]);
    }

    #[test]
    fn provider_collaboration_wait_uses_the_shared_tool_name_and_child_name() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
                "subagentSessionId":"child-1","name":"Researcher","task":"Check the protocol"}
            }),
        );
        let waited = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"tool_call",
                "toolCallId":"wait-1","title":"wait","rawInput":{"receiverThreadIds":[]},
                "_meta":{"codex":{"collaboration":{"tool":"wait"}}}}
            }),
        );
        let tool = serde_json::to_value(&waited[0]).unwrap();
        assert_eq!(tool["name"], "wait_agent");
        assert_eq!(tool["title"], "wait_agent");
        assert_eq!(tool["input"]["target"], "Researcher");
    }

    #[test]
    fn claude_subagent_metadata_preserves_parent_attribution() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
                "messageId":"sub-message","content":{"type":"text","text":"Child answer"},
                "_meta":{"claudeCode":{"parentToolUseId":"agent-tool-1"}}}
            }),
        );
        let started = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(started["parentToolCallId"], "agent-tool-1");
    }

    #[test]
    fn prompt_usage_becomes_one_cumulative_token_snapshot() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.finish_turn(
            "local",
            "claude",
            &json!({
                "stopReason":"end_turn", "usage":{"totalTokens":60,"inputTokens":40,
                "outputTokens":20,"thoughtTokens":5,"cachedReadTokens":10,"cachedWriteTokens":2}
            }),
        );
        let cost = events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "cost")
            .unwrap();
        assert_eq!(cost["cost"]["total"], 60);
        assert_eq!(cost["cost"]["cacheRead"], 10);
    }

    #[test]
    fn structured_images_and_diffs_keep_the_frontend_contract() {
        let mut normalizer = AcpNormalizer::default();
        let image = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk",
                "content":{"type":"image","mimeType":"image/png","data":"aGVsbG8="}}
            }),
        );
        let image = serde_json::to_value(&image[1]).unwrap();
        assert_eq!(image["type"], "image");
        assert!(image["image"]["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));

        let diff = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
                "toolCallId":"edit-1","status":"completed","content":[
                    {"type":"diff","path":"/tmp/a","oldText":"before","newText":"after"}
                ],"rawOutput":[{"type":"text","text":"changed"}]}
            }),
        );
        assert_eq!(kinds(&diff), vec!["diff", "tool.completed"]);
        let completed = serde_json::to_value(&diff[1]).unwrap();
        assert_eq!(completed["ok"], true);
        assert_eq!(completed["output"], "changed");
    }

    #[test]
    fn late_tool_input_and_subagent_type_refine_the_existing_rows() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call",
                "toolCallId":"agent-1","title":"Task","rawInput":{},
                "_meta":{"claudeCode":{"toolName":"Agent","subagent":true}}}
            }),
        );
        let refined = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
                "toolCallId":"agent-1","status":"in_progress",
                "rawInput":{"subagent_type":"general-purpose","description":"Check the port"},
                "_meta":{"claudeCode":{"toolName":"Agent","subagent":true}}}
            }),
        );
        assert_eq!(
            kinds(&refined),
            vec!["tool.started", "agent.identified", "tool.progress"]
        );
        let tool = serde_json::to_value(&refined[0]).unwrap();
        assert_eq!(tool["input"]["subagent_type"], "general-purpose");
        let agent = serde_json::to_value(&refined[1]).unwrap();
        assert_eq!(agent["agentType"], "general-purpose");
    }

    #[test]
    fn goose_delegate_uses_the_shared_subagent_lifecycle() {
        let mut normalizer = AcpNormalizer::default();
        let started = normalizer.update(
            "local",
            "local",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call",
                "toolCallId":"delegate-1","title":"Delegate","rawInput":{
                    "source":"reviewer","instructions":"Review the patch","model":"qwen3"
                },"_meta":{"goose":{"toolCall":{"toolName":"delegate"}}}}
            }),
        );
        assert_eq!(kinds(&started), vec!["tool.started", "agent.started"]);
        let agent = serde_json::to_value(&started[1]).unwrap();
        assert_eq!(agent["what"], "Review the patch");
        assert_eq!(agent["agentType"], "reviewer");
        assert_eq!(agent["model"], "qwen3");

        let finished = normalizer.update(
            "local",
            "local",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
                "toolCallId":"delegate-1","status":"completed",
                "rawInput":{"source":"reviewer","instructions":"Review the patch"},
                "content":[{"type":"content","content":{"type":"text","text":"Looks good"}}]}
            }),
        );
        assert_eq!(
            kinds(&finished),
            vec!["tool.started", "tool.completed", "agent.finished"]
        );
        let agent = serde_json::to_value(finished.last().unwrap()).unwrap();
        assert_eq!(agent["state"], "done");
        assert_eq!(agent["result"], "Looks good");
    }

    #[test]
    fn goose_async_delegate_finishes_when_its_load_returns() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update(
            "local",
            "local",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call",
                "toolCallId":"delegate-1","title":"Delegate","rawInput":{
                    "instructions":"Review the patch","async":true
                },"_meta":{"goose":{"toolCall":{"toolName":"delegate"}}}}
            }),
        );
        let deferred = normalizer.update("local", "local", &json!({
            "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
            "toolCallId":"delegate-1","status":"completed",
            "content":[{"type":"content","content":{"type":"text","text":
                "Task 20260901_1 started in background: \"Review the patch\"\nContinue with other work."
            }}]}
        }));
        assert_eq!(kinds(&deferred), vec!["tool.completed"]);

        normalizer.update(
            "local",
            "local",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call",
                "toolCallId":"load-1","title":"Load","rawInput":{"source":"20260901_1"},
                "_meta":{"goose":{"toolCall":{"toolName":"load"}}}}
            }),
        );
        let finished = normalizer.update("local", "local", &json!({
            "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
            "toolCallId":"load-1","status":"completed",
            "content":[{"type":"content","content":{"type":"text","text":
                "# Background Task Result: 20260901_1\n\n**Status:** ✓ Completed\n\n## Output\n\nLooks good"
            }}]}
        }));
        assert_eq!(kinds(&finished), vec!["tool.completed", "agent.finished"]);
        let agent = serde_json::to_value(finished.last().unwrap()).unwrap();
        assert_eq!(agent["agentId"], "delegate-1");
        assert_eq!(agent["state"], "done");
        assert!(agent["result"].as_str().unwrap().contains("Looks good"));
    }

    #[test]
    fn asynchronous_child_finishes_after_its_attributed_answer_not_after_launch() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call",
                "toolCallId":"agent-1","title":"Task","rawInput":{},
                "_meta":{"claudeCode":{"toolName":"Agent","subagent":true}}}
            }),
        );
        let launched = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
                "toolCallId":"agent-1","status":"completed","rawOutput":"launched",
                "_meta":{"claudeCode":{"toolName":"Agent","toolResponse":{"isAsync":true}}}}
            }),
        );
        assert_eq!(kinds(&launched), vec!["tool.completed"]);

        let child = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk",
                "messageId":"child-message","content":{"type":"text","text":"CHILD DONE"},
                "_meta":{"claudeCode":{"parentToolUseId":"agent-1"}}}
            }),
        );
        assert_eq!(kinds(&child), vec!["message.started", "text.delta"]);
        let parent = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk",
                "messageId":"parent-message","content":{"type":"text","text":"PARENT DONE"}}
            }),
        );
        assert_eq!(
            kinds(&parent),
            vec![
                "message.completed",
                "agent.finished",
                "message.started",
                "text.delta"
            ]
        );
        let finished = serde_json::to_value(&parent[1]).unwrap();
        assert_eq!(finished["result"], "CHILD DONE");
    }

    #[test]
    fn running_subagent_state_is_progress_not_a_false_finish() {
        let mut normalizer = AcpNormalizer::default();
        let events = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"root","update":{"sessionUpdate":"subagent_state_update",
                "subagentSessionId":"child","state":"running","detail":"Searching"}
            }),
        );
        assert_eq!(kinds(&events), vec!["agent.progress"]);
        let progress = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(progress["doing"], "Searching");
        assert_eq!(progress["seconds"], 0);
        assert_eq!(progress["tokens"], 0);
        assert_eq!(progress["calls"], 0);
        assert_eq!(progress["state"], "running");
    }

    #[test]
    fn command_updates_preserve_the_negotiated_model_and_mode_catalogs() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.set_menu(json!({
            "commands":[], "skills":[],
            "models":[{"value":"model-a","label":"Model A"}],
            "efforts":[{"value":"high","label":"High"}],
            "permissionModes":["on-request"], "collaborationModes":["default"],
            "agentDefinitions":[], "agentControls":["stop","park","say"]
        }));
        let events = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"remote", "update":{"sessionUpdate":"available_commands_update",
                "availableCommands":[{"name":"review","description":"Review changes"}]}
            }),
        );
        let menu = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(menu["commands"][0]["name"], "review");
        assert_eq!(menu["models"][0]["value"], "model-a");
        assert_eq!(menu["efforts"][0]["value"], "high");
        assert_eq!(menu["permissionModes"], json!(["on-request"]));
    }
}
