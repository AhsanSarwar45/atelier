//! Lossless ACP session updates translated once into Atelier's canonical events.

use super::super::protocol::{record_event_id, Event};
use chrono::Utc;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, PartialEq)]
struct TokenTally {
    input: i64,
    output: i64,
    total: i64,
    thinking: i64,
    cache_read: i64,
    cache_write: i64,
    delegated: i64,
}

impl TokenTally {
    fn number(value: &Value, field: &str) -> i64 {
        value[field].as_i64().unwrap_or_default().max(0)
    }

    fn quota(value: &Value) -> Self {
        let input = Self::number(value, "inputTokens");
        let output = Self::number(value, "outputTokens");
        let thinking = Self::number(value, "reasoningOutputTokens");
        let cache_read = Self::number(value, "cachedInputTokens");
        let cache_write = Self::number(value, "cachedWriteTokens");
        let total = value
            .get("totalTokens")
            .and_then(Value::as_i64)
            .unwrap_or(input + output + cache_read + cache_write)
            .max(0);
        Self {
            input,
            output,
            total,
            thinking,
            cache_read,
            cache_write,
            delegated: 0,
        }
    }

    fn prompt(value: &Value) -> Self {
        Self {
            input: Self::number(value, "inputTokens"),
            output: Self::number(value, "outputTokens"),
            total: Self::number(value, "totalTokens"),
            thinking: Self::number(value, "thoughtTokens"),
            cache_read: Self::number(value, "cachedReadTokens"),
            cache_write: Self::number(value, "cachedWriteTokens"),
            delegated: 0,
        }
    }

    fn cost(value: &Value) -> Self {
        Self {
            input: Self::number(value, "input"),
            output: Self::number(value, "output"),
            total: Self::number(value, "total"),
            thinking: Self::number(value, "thinking"),
            cache_read: Self::number(value, "cacheRead"),
            cache_write: Self::number(value, "cacheWrite"),
            delegated: Self::number(value, "delegated"),
        }
    }

    fn add(&mut self, next: &Self) {
        self.input = self.input.saturating_add(next.input);
        self.output = self.output.saturating_add(next.output);
        self.total = self.total.saturating_add(next.total);
        self.thinking = self.thinking.saturating_add(next.thinking);
        self.cache_read = self.cache_read.saturating_add(next.cache_read);
        self.cache_write = self.cache_write.saturating_add(next.cache_write);
        self.delegated = self.delegated.saturating_add(next.delegated);
    }

    fn value(&self) -> Value {
        json!({
            "kind":"tokens", "input":self.input, "output":self.output,
            "total":self.total, "thinking":self.thinking,
            "cacheRead":self.cache_read, "cacheWrite":self.cache_write,
            "delegated":self.delegated
        })
    }
}

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
    task_agents: HashMap<String, String>,
    unbound_agents: Vec<String>,
    agent_words: HashMap<String, String>,
    agent_word_message: HashMap<String, String>,
    agent_doing: HashMap<String, String>,
    agent_reports: HashMap<String, (String, String)>,
    active_signals: HashMap<String, String>,
    suppress_local_user: bool,
    menu: Value,
    cwd: PathBuf,
    cumulative_usage: TokenTally,
    agent_usage_tokens: HashMap<String, i64>,
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
            task_agents: HashMap::new(),
            unbound_agents: Vec::new(),
            agent_words: HashMap::new(),
            agent_word_message: HashMap::new(),
            agent_doing: HashMap::new(),
            agent_reports: HashMap::new(),
            active_signals: HashMap::new(),
            suppress_local_user: false,
            menu: json!({"commands":[],"skills":[],"models":[],"efforts":[],"permissionModes":[],"collaborationModes":[],"agentDefinitions":[],"agentControls":[],"configOptions":[]}),
            cwd: PathBuf::from("."),
            cumulative_usage: TokenTally::default(),
            agent_usage_tokens: HashMap::new(),
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

    pub fn seed_usage(&mut self, cost: Option<&Value>) {
        if let Some(cost) = cost.filter(|cost| cost["kind"] == "tokens") {
            self.cumulative_usage = TokenTally::cost(cost);
        }
    }

    fn turn_usage(raw: &Value) -> Option<(TokenTally, &'static str)> {
        let model_usage = raw
            .pointer("/_meta/quota/model_usage")
            .and_then(Value::as_array);
        if let Some(rows) = model_usage.filter(|rows| !rows.is_empty()) {
            let mut total = TokenTally::default();
            for row in rows {
                total.add(&TokenTally::quota(&row["token_count"]));
            }
            return Some((total, "acp-accounting-quota"));
        }
        if let Some(tokens) = raw
            .pointer("/_meta/quota/token_count")
            .filter(|value| value.is_object())
        {
            return Some((TokenTally::quota(tokens), "acp-quota"));
        }
        raw["usage"]
            .is_object()
            .then(|| (TokenTally::prompt(&raw["usage"]), "acp-prompt"))
    }

    fn add_agent_usage(
        &mut self,
        agent_id: &str,
        tokens: i64,
        included_in_prompt_usage: bool,
    ) -> bool {
        let tokens = tokens.max(0);
        let previous = self
            .agent_usage_tokens
            .entry(agent_id.to_string())
            .or_default();
        if tokens <= *previous {
            return false;
        }
        let delta = tokens - *previous;
        *previous = tokens;
        if !included_in_prompt_usage {
            self.cumulative_usage.total = self.cumulative_usage.total.saturating_add(delta);
        }
        self.cumulative_usage.delegated = self.cumulative_usage.delegated.saturating_add(delta);
        !included_in_prompt_usage
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

    /// A content block as words, for the four ACP kinds that are words.
    ///
    /// Text is itself. A link to a resource is the link: the reader can follow
    /// it, and the machine note this used to become — the block's JSON under
    /// "ACP sent resource_link content" — is not something anyone can follow.
    /// A resource carried whole is its text under the name of where it came
    /// from, fenced, because a file quoted into a message is not the speaker's
    /// prose. Pictures and sound are not words; `content_picture` takes the
    /// ones it can draw and the rest stay notes (bw-t26l.20).
    fn content_words(content: &Value) -> Option<String> {
        match content["type"].as_str() {
            Some("text") => content["text"].as_str().map(str::to_string),
            Some("resource_link") => {
                let uri = content["uri"].as_str().filter(|uri| !uri.is_empty())?;
                let name = content["title"]
                    .as_str()
                    .or_else(|| content["name"].as_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or(uri);
                Some(format!("[{name}]({uri})"))
            }
            Some("resource") => {
                let resource = &content["resource"];
                let text = resource["text"].as_str()?;
                match resource["uri"].as_str().filter(|uri| !uri.is_empty()) {
                    Some(uri) => Some(format!("{uri}\n\n```\n{text}\n```")),
                    None => Some(format!("```\n{text}\n```")),
                }
            }
            _ => None,
        }
    }

    /// A content block as a picture, drawn from the block itself or from a
    /// resource carried whole whose bytes are an image. Anything else — sound,
    /// a PDF, a blob of an unnamed kind — has no drawing here and stays a note.
    fn content_picture(content: &Value) -> Option<(String, String)> {
        let (mime, data, uri) = match content["type"].as_str() {
            Some("image") => (
                content["mimeType"].as_str().unwrap_or("image/png"),
                content["data"].as_str().unwrap_or_default(),
                content["uri"].as_str().unwrap_or_default(),
            ),
            Some("resource") => {
                let resource = &content["resource"];
                let mime = resource["mimeType"].as_str().unwrap_or_default();
                if !mime.starts_with("image/") {
                    return None;
                }
                (
                    mime,
                    resource["blob"].as_str().unwrap_or_default(),
                    resource["uri"].as_str().unwrap_or_default(),
                )
            }
            _ => return None,
        };
        if data.is_empty() && !uri.starts_with("data:") {
            return None;
        }
        let data_url = if uri.starts_with("data:") {
            uri.to_string()
        } else {
            format!("data:{mime};base64,{data}")
        };
        Some((mime.to_string(), data_url))
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

    fn agent_usage(update: &Value) -> (i64, i64, i64, Value, bool) {
        let usage = &update["_meta"]["atelier.dev/usage"];
        (
            usage["seconds"].as_i64().unwrap_or_default().max(0),
            usage["tokens"].as_i64().unwrap_or_default().max(0),
            usage["calls"].as_i64().unwrap_or_default().max(0),
            usage.get("model").cloned().unwrap_or(Value::Null),
            usage["includedInPromptUsage"].as_bool().unwrap_or(false),
        )
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

    /// What a turn that did not simply end has to say for itself.
    ///
    /// ACP names five stop reasons and only `end_turn` means the work is
    /// done. Of the rest, `refusal` the spec asks in so many words to be
    /// reflected in the UI — the prompt and everything after it is left out
    /// of the next one, so a reader who is not told will retype it and get
    /// nothing — and the two ceilings stop a turn in the middle of its work.
    /// Read as a condition of the turn rather than as a failure, because
    /// nothing broke: the agent answered, and the answer was that it stopped.
    /// `cancelled` says only that the reader's own stop button worked, so it
    /// passes without a notice (bw-t26l.20).
    fn stop_reason_signal(raw: &Value) -> Option<Value> {
        let (kind, detail) = match raw["stopReason"].as_str()? {
            "refusal" => (
                "refusal",
                "The agent declined to continue. This prompt and everything after it \
                 will not be part of the next one.",
            ),
            "max_tokens" => (
                "turn_limit",
                "The turn stopped at the model's token ceiling before it was finished.",
            ),
            "max_turn_requests" => (
                "turn_limit",
                "The turn stopped at the provider's ceiling on requests in one turn.",
            ),
            _ => return None,
        };
        Some(json!({
            "id":format!("condition:{kind}"), "kind":kind, "phase":"active",
            "severity":"error", "scope":"turn", "detail":detail,
            "retryAt":Value::Null, "action":Value::Null
        }))
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

    /// The arguments a call was made with, always as an object.
    ///
    /// ACP announces a `tool_call` before it knows what the call was given:
    /// `rawInput` is absent on the opening notification for most agents and
    /// arrives later on a `tool_call_update`. The wire contract says a started
    /// call carries `input` as an object, and every reader downstream — the
    /// title rules, the language of a row, the cards a call puts forward —
    /// reads a key off it without asking whether it is there. Handing the
    /// absence straight through wrote `"input": null` into the record and took
    /// the whole transcript down on the first row that had no arguments yet
    /// (bw-t26l.20).
    fn tool_input(&self, update: &Value) -> Value {
        let mut input = match update["rawInput"].clone() {
            Value::Object(fields) => Value::Object(fields),
            _ => json!({}),
        };
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

    fn parent_tool_call(&mut self, raw: &Value) -> Option<String> {
        let thread = raw["sessionId"].as_str().unwrap_or("root");
        match raw["update"]
            .pointer("/_meta/claudeCode/parentToolUseId")
            .and_then(Value::as_str)
        {
            Some(call) => Some(self.agent_for_call(call.to_string())),
            None => self.agent_tools.get(thread).cloned(),
        }
    }

    /**
     * Which sent-away agent a call belongs to, for a native subagent whose call
     * the kit never announced.
     *
     * Claude's own subagents arrive twice over: once as `subagent_spawned`,
     * which names a session of its own, and then as work stamped with the
     * `Task` call that started it — a call for which no `tool_call` is ever
     * sent. The two strings are different and nothing in either update joins
     * them, so read by the agent's id the helper's pane opened on nothing
     * (measured against a real chat, 2026-09-03: agent `a631a0e9…`, rows
     * stamped `toolu_01KzuX…`). The join is only stated at the end, in the
     * finished call's `toolResponse.agentId`, which is far too late for the
     * rows already drawn.
     *
     * So an unannounced call, arriving while exactly one spawned agent is
     * unclaimed, IS that agent's call. Where more than one is out at once the
     * guess would be a coin toss, and it is not made: those rows keep the call
     * they came with, as they did before, until `toolResponse.agentId` says
     * which was which.
     */
    fn agent_for_call(&mut self, call: String) -> String {
        if let Some(agent) = self.task_agents.get(&call) {
            return agent.clone();
        }
        let announced = self.open_tools.contains(&call)
            || self.tool_starts.contains_key(&call)
            || self.subagent_tools.contains(&call);
        if announced || self.unbound_agents.len() != 1 {
            return call;
        }
        let agent = self.unbound_agents.remove(0);
        self.task_agents.insert(call, agent.clone());
        agent
    }

    /**
     * The line on a sent-away row saying what its helper is doing NOW.
     *
     * Nothing in the stream states it. A `tool_call_update` for a `Task` that
     * is still running carries an empty content list, so the summary built
     * from that content is the empty string and the line is never drawn —
     * measured against the pinned claude adapter on 2026-09-03, where every
     * one of a turn's seven in-flight updates summarised to nothing and a
     * helper that ran for four minutes said not a word about itself
     * (bw-t26l.20).
     *
     * What the kit does send is the helper's own work, each piece stamped with
     * the call that sent it: the command it just started, the sentence it just
     * wrote. Those are what this line is built from, so it says only things
     * the helper actually did.
     *
     * One fact, two rows. The same words go to the call in the transcript and
     * to the row in the panel beside it, because two accounts of one helper
     * that disagree are worse than one.
     */
    fn doing_now(
        &mut self,
        session_id: &str,
        provider: &str,
        raw: &Value,
        under: &str,
        said: &str,
    ) -> Vec<Event> {
        // Only while the call is still going: once it is over, what the helper
        // did is in its answer, and a present tense beside a finished row is a
        // stale guess (bw-7ks.22.2).
        if !self.subagent_tools.contains(under) || !self.open_tools.contains(under) {
            return Vec::new();
        }
        // Its last line, not its first: a message arrives a piece at a time and
        // the piece before this one is already behind the reader.
        let Some(line) = said
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .next_back()
        else {
            return Vec::new();
        };
        // Said again is not news. A helper's message is re-read on every delta,
        // and a row that re-announces the same sentence eight times costs the
        // reader a redraw each time to say nothing.
        if self.agent_doing.get(under).is_some_and(|last| last == line) {
            return Vec::new();
        }
        self.agent_doing.insert(under.to_string(), line.to_string());
        // No clock and no totals: this ping knows none, and a reader that took
        // its zeros for a count would wind the row's own clock back to nothing.
        vec![
            self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"tool.progress","toolCallId":under,"seconds":0,"summary":line,"status":"in_progress"}),
            ),
            self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"agent.progress","agentId":under,"seconds":0,"tokens":0,"calls":0,"doing":line}),
            ),
        ]
    }

    fn message_chunk(
        &mut self,
        session_id: &str,
        provider: &str,
        raw: &Value,
        role: &str,
        content: &Value,
    ) -> Vec<Event> {
        if Self::content_words(content).is_none() && Self::content_picture(content).is_none() {
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
        // What an asynchronous helper says is kept, not announced: it is still
        // running, and the chat carrying on around it says nothing about
        // whether it is done. The manager speaking again used to be read as the
        // helper being over, which is a guess, and on a real chat it was wrong
        // about one run in five — the helper answered afterwards and the card
        // was left saying "I'll read both files." The helper's own terminal
        // state ends it when there is one; otherwise the end of the turn does
        // (bw-t26l.20).
        if role == "assistant" {
            if let Some(agent) = parent
                .as_ref()
                .filter(|id| self.subagent_tools.contains(*id))
            {
                if let Some(text) = Self::content_words(content) {
                    self.deferred_agents
                        .entry(agent.clone())
                        .or_default()
                        .push_str(&text);
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
        let active = self.active_messages.get(&lane).cloned();
        let id = match (sent_id, &active) {
            (Some(id), _) => id,
            (None, Some((active_role, id))) if active_role == role => id.clone(),
            _ => self.next_id("message"),
        };
        // Whatever was being said in this place before is over: the provider
        // has moved on to another message. Left unsaid, the reader's
        // transcript keeps it open forever and never settles it — measured on
        // a real chat, where two of the turn's four messages were started and
        // never finished (bw-t26l.20).
        if let Some((_, was)) = active {
            if was != id {
                self.active_messages.remove(&lane);
                events.extend(self.complete_message(
                    session_id,
                    provider,
                    raw,
                    was,
                    Value::Null,
                ));
            }
        }
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
        if let Some(text) = Self::content_words(content) {
            if role == "assistant" {
                self.message_text
                    .entry(id.clone())
                    .or_default()
                    .push_str(&text);
                // Everything said under a helper, kept whether or not the
                // helper is still on the books. A native subagent's ending and
                // its own last words race, and the ending wins about half the
                // time: told only what had been said by then, the card
                // announced "I'll read both files" as the answer to a question
                // about two files (bw-t26l.20). One blank line between the
                // things it said, because they are separate messages and run
                // together they read as one sentence that never was.
                if let Some(under) = parent.as_deref() {
                    let previous = self
                        .agent_word_message
                        .insert(under.to_string(), id.clone());
                    let words = self.agent_words.entry(under.to_string()).or_default();
                    if !words.is_empty() && previous.is_some_and(|was| was != id) {
                        words.push_str("\n\n");
                    }
                    words.push_str(&text);
                }
            }
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"text.delta","messageId":id,"text":text}),
            ));
            if role == "assistant" {
                if let Some(under) = parent.clone() {
                    let said = self.message_text.get(&id).cloned().unwrap_or_default();
                    events.extend(self.doing_now(session_id, provider, raw, &under, &said));
                }
            }
        } else if let Some((mime, data_url)) = Self::content_picture(content) {
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
                let started = json!({"type":"tool.started","toolCallId":id,"name":name.clone(),"title":title.clone(),"parentToolCallId":parent.clone(),"input":input.clone(),"acp":update});
                self.tool_starts.insert(id.clone(), started.clone());
                let mut events = vec![self.envelope(session_id, provider, raw, started)];
                if let Some(under) = parent {
                    let says = title.as_str().unwrap_or_default().to_string();
                    events.extend(self.doing_now(session_id, provider, raw, &under, &says));
                }
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
                // The kit finally says which call sent which native subagent.
                // Late for the rows already drawn — `agent_for_call` guesses so
                // they are not lost — but it settles the question for the rest,
                // and it is the only place the two ids are ever stated together.
                if let Some(agent) = update
                    .pointer("/_meta/claudeCode/toolResponse/agentId")
                    .and_then(Value::as_str)
                    .filter(|agent| !agent.is_empty())
                {
                    self.task_agents.insert(id.clone(), agent.to_string());
                    self.unbound_agents.retain(|out| out != agent);
                }
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
                        // A helper's command arrives twice: once as a bare
                        // `Terminal` and again with the command in it. The row
                        // that sent the helper wants the second one.
                        let under = started["parentToolCallId"].as_str().map(str::to_string);
                        let says = started["title"].as_str().unwrap_or_default().to_string();
                        refinements.push(self.envelope(session_id, provider, raw, started));
                        if let Some(under) = under {
                            let doing = self.doing_now(session_id, provider, raw, &under, &says);
                            refinements.extend(doing);
                        }
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
                    .filter_map(|row| row.get("content").and_then(Self::content_words))
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
                        let (seconds, tokens, calls, model, included) = Self::agent_usage(update);
                        if self.add_agent_usage(&id, tokens, included) {
                            events.push(self.envelope(
                                session_id,
                                provider,
                                raw,
                                json!({"type":"cost","cost":self.cumulative_usage.value(),"source":"acp-subagent"}),
                            ));
                        }
                        let state = if status == "completed" { "done" } else { "failed" };
                        self.agent_reports
                            .insert(id.clone(), (state.to_string(), summary.clone()));
                        events.push(self.envelope(
                            session_id,
                            provider,
                            raw,
                            json!({"type":"agent.finished","agentId":id,"state":state,"result":summary,"seconds":seconds,"tokens":tokens,"calls":calls,"model":model}),
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
                                self.agent_reports
                                    .insert(agent.clone(), (state.to_string(), summary.clone()));
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
            Some("async_task_spawned") => {
                let id = update["asyncTaskId"].as_str().unwrap_or_default();
                let task_type = update["taskType"].as_str().unwrap_or("task");
                let kind = match task_type {
                    "shell" => "command",
                    "monitor" => "watch",
                    "workflow" => "run",
                    _ => "run",
                };
                let what = update["description"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .or_else(|| update["name"].as_str())
                    .unwrap_or("Background task");
                vec![self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({
                        "type":"agent.started", "agentId":id,
                        "toolCallId":update.get("toolCallId").cloned().unwrap_or(Value::Null),
                        "kind":kind, "what":what, "agentType":task_type,
                        "model":Value::Null, "acp":update
                    }),
                )]
            }
            Some("async_task_progress") => {
                let usage = &update["usage"];
                let milliseconds = usage["durationMs"].as_i64().unwrap_or_default().max(0);
                let doing = update["summary"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .or_else(|| update["description"].as_str().filter(|value| !value.is_empty()))
                    .or_else(|| update["lastToolName"].as_str().filter(|value| !value.is_empty()));
                vec![self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({
                        "type":"agent.progress", "agentId":update["asyncTaskId"],
                        "seconds":milliseconds.saturating_add(500) / 1000,
                        "tokens":usage["totalTokens"].as_i64().unwrap_or_default().max(0),
                        "calls":usage["toolUses"].as_i64().unwrap_or_default().max(0),
                        "doing":doing, "state":"running", "acp":update
                    }),
                )]
            }
            Some("async_task_state_update") => {
                let native_state = update["state"].as_str().unwrap_or("running");
                if matches!(native_state, "running" | "paused") {
                    return vec![self.envelope(
                        session_id,
                        provider,
                        raw,
                        json!({
                            "type":"agent.progress", "agentId":update["asyncTaskId"],
                            "seconds":0, "tokens":0, "calls":0,
                            "doing":update.get("summary").cloned().unwrap_or(Value::Null),
                            "state":if native_state == "paused" { "parked" } else { "running" },
                            "acp":update
                        }),
                    )];
                }
                let state = if native_state == "completed" {
                    "done"
                } else if native_state == "stopped" {
                    "stopped"
                } else {
                    "failed"
                };
                let summary = update.get("summary").cloned().unwrap_or(Value::Null);
                if let Some(task) = update["asyncTaskId"].as_str() {
                    self.agent_reports.insert(
                        task.to_string(),
                        (
                            state.to_string(),
                            summary.as_str().unwrap_or_default().to_string(),
                        ),
                    );
                }
                vec![self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({
                        "type":"agent.finished", "agentId":update["asyncTaskId"],
                        "state":state, "result":summary,
                        "seconds":0, "tokens":0, "calls":0, "model":Value::Null,
                        "acp":update
                    }),
                )]
            }
            Some("subagent_spawned") => {
                let child = update["subagentSessionId"].as_str().unwrap_or_default().to_string();
                self.agent_tools.insert(child.clone(), child.clone());
                self.subagent_tools.insert(child.clone());
                // The row drawn just below is a call like any other, and it is
                // open until the helper ends. Left off this list it was never
                // closed: on a real turn the sending row was still spinning
                // long after the helper had answered and the panel beside it
                // had filed the helper under "completed" (measured 2026-09-03,
                // agent `a80d66a3…` — `agent.finished` arrived, no
                // `tool.completed` ever did).
                self.open_tools.insert(child.clone());
                if !self.unbound_agents.contains(&child) {
                    self.unbound_agents.push(child.clone());
                }
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
                let (seconds, tokens, calls, model, included) = Self::agent_usage(update);
                let state = match update["state"].as_str() {
                    Some("completed") => "done",
                    Some("cancelled") => "stopped",
                    Some("failed" | "disconnected") => "failed",
                    _ => "running",
                };
                if state == "running" {
                    let mut events = Vec::new();
                    if self.add_agent_usage(child, tokens, included) {
                        events.push(self.envelope(
                            session_id, provider, raw,
                            json!({"type":"cost","cost":self.cumulative_usage.value(),"source":"acp-subagent"}),
                        ));
                    }
                    events.push(self.envelope(session_id, provider, raw, json!({
                        "type":"agent.progress","agentId":child,"seconds":seconds,"tokens":tokens,"calls":calls,
                        "doing":update["detail"].as_str().unwrap_or("Working"),"state":"running","acp":update
                    })));
                    events
                } else {
                    self.subagent_tools.remove(child);
                    self.unbound_agents.retain(|out| out != child);
                    self.deferred_agents.remove(child);
                    // What it has said so far, as its result: this update
                    // carries no report of its own. What it says AFTER this is
                    // reported at the end of the turn, once there is nothing
                    // left for it to add.
                    let said = self
                        .agent_words
                        .get(child)
                        .filter(|said| !said.is_empty())
                        .cloned();
                    self.agent_reports.insert(
                        child.to_string(),
                        (state.to_string(), said.clone().unwrap_or_default()),
                    );
                    let mut events = Vec::new();
                    if self.add_agent_usage(child, tokens, included) {
                        events.push(self.envelope(
                            session_id, provider, raw,
                            json!({"type":"cost","cost":self.cumulative_usage.value(),"source":"acp-subagent"}),
                        ));
                    }
                    events.push(self.envelope(
                        session_id,
                        provider,
                        raw,
                        json!({"type":"agent.finished","agentId":child,"state":state,"result":said,"seconds":seconds,"tokens":tokens,"calls":calls,"model":model,"acp":update}),
                    ));
                    // The call that stood for it in the conversation ends here
                    // too, carrying what it answered. Only when this stream
                    // opened one: a helper launched as an asynchronous call had
                    // its row closed the moment the kit acknowledged the launch.
                    if self.open_tools.remove(child) {
                        events.push(self.envelope(
                            session_id,
                            provider,
                            raw,
                            json!({"type":"tool.completed","toolCallId":child,"ok":state == "done",
                                   "output":said.clone().unwrap_or_default(),"summary":said,"acp":update}),
                        ));
                    }
                    events
                }
            }
            Some("subagent_usage_update") => {
                let child = update["subagentSessionId"].as_str().unwrap_or_default();
                let usage = &update["usage"];
                let tokens = usage["tokens"].as_i64().unwrap_or_default().max(0);
                let included = usage["includedInPromptUsage"].as_bool().unwrap_or(false);
                let mut events = Vec::new();
                if self.add_agent_usage(child, tokens, included) {
                    events.push(self.envelope(
                        session_id, provider, raw,
                        json!({"type":"cost","cost":self.cumulative_usage.value(),"source":"acp-subagent"}),
                    ));
                }
                events.push(self.envelope(
                    session_id,
                    provider,
                    raw,
                    json!({
                        "type":"agent.progress", "agentId":child,
                        "seconds":usage["seconds"].as_i64().unwrap_or_default().max(0),
                        "tokens":tokens,
                        "calls":usage["calls"].as_i64().unwrap_or_default().max(0),
                        "finalUsage":true, "acp":update
                    }),
                ));
                events
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
        for (agent, chunks) in std::mem::take(&mut self.deferred_agents) {
            // Its words as the reader saw them, message breaks and all, rather
            // than the raw run of chunks; the two say the same thing, and
            // reporting the spaced one keeps the correction below quiet.
            let result = match self.agent_words.get(&agent) {
                Some(said) if !said.is_empty() => said.clone(),
                _ => chunks,
            };
            if result.is_empty() {
                continue;
            }
            self.subagent_tools.remove(&agent);
            self.agent_reports
                .insert(agent.clone(), ("done".to_string(), result.clone()));
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
        // A helper that finished before it had finished speaking. Its ending
        // said what it had said by then; this says the whole of it, now that
        // the turn is over and there is no more to come. Every place that ends
        // a helper records the result it announced, and this compares against
        // that rather than against any one of them, because which one fires is
        // a race: an ending of the helper's own, the chat speaking again, or
        // the dispatching call completing (bw-t26l.20). Kept across turns, not
        // drained: an async helper outlives the turn it was launched in, and a
        // second turn that started from an empty record would report its tail
        // as though it were the whole report.
        let corrections = self
            .agent_reports
            .iter()
            .filter_map(|(agent, (state, reported))| {
                let said = self.agent_words.get(agent)?;
                (!said.is_empty() && said != reported).then(|| {
                    (agent.clone(), state.clone(), said.clone())
                })
            })
            .collect::<Vec<_>>();
        for (agent, state, said) in corrections {
            // Recorded as the thing now standing, so the next turn corrects
            // only what is new rather than saying this again.
            self.agent_reports
                .insert(agent.clone(), (state.clone(), said.clone()));
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({
                    "type":"agent.finished", "agentId":agent, "state":state, "result":said,
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
        if let Some((turn, source)) = Self::turn_usage(raw) {
            self.cumulative_usage.add(&turn);
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"cost","cost":self.cumulative_usage.value(),"source":source}),
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
        // Recorded after the resolving above, so it stands until the turn
        // after this one finishes rather than being cleared by its own turn.
        if let Some(signal) = Self::stop_reason_signal(raw) {
            self.record_signal(&signal);
            events.push(self.envelope(
                session_id,
                provider,
                raw,
                json!({"type":"provider.message","signal":signal}),
            ));
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

    /// A turn can end four ways that are not "done", and the reader was told
    /// none of them: the transcript went quiet and the chip said Ready. The
    /// spec asks for a refusal in particular to be shown, because the prompt
    /// it refused is dropped from the next one — retyping it is the reader's
    /// obvious next move and would silently do nothing (bw-t26l.20).
    #[test]
    fn a_turn_that_stopped_short_says_so() {
        for (reason, kind) in [
            ("refusal", "refusal"),
            ("max_tokens", "turn_limit"),
            ("max_turn_requests", "turn_limit"),
        ] {
            let mut normalizer = AcpNormalizer::default();
            let events = normalizer.finish_turn("local", "claude", &json!({"stopReason":reason}));
            assert_eq!(
                kinds(&events),
                vec!["provider.message", "session.state"],
                "{reason} passed without a word"
            );
            let signal = serde_json::to_value(&events[0]).unwrap();
            assert_eq!(signal["signal"]["kind"], kind);
            assert_eq!(signal["signal"]["phase"], "active");
            assert_eq!(signal["signal"]["scope"], "turn");
            assert!(
                signal["signal"]["detail"]
                    .as_str()
                    .is_some_and(|detail| !detail.is_empty()),
                "a notice with nothing to read is not a notice"
            );
            // Nothing broke — the agent answered, and the answer was that it
            // stopped — so the chat is ready for the next thing, not errored.
            let state = serde_json::to_value(&events[1]).unwrap();
            assert_eq!(state["state"], "idle");
        }
    }

    /// The ordinary ending, and cancelling, stay silent: one is the work being
    /// done, the other is the reader's own stop button reporting success.
    #[test]
    fn an_ordinary_ending_and_a_cancelled_one_raise_no_notice() {
        for reason in ["end_turn", "cancelled"] {
            let mut normalizer = AcpNormalizer::default();
            let events = normalizer.finish_turn("local", "claude", &json!({"stopReason":reason}));
            assert_eq!(kinds(&events), vec!["session.state"], "{reason} said something");
        }
    }

    /// ACP carries five kinds of content block and this read two of them.
    /// A file linked into a message and a file carried whole in one both
    /// arrived as a machine note reading "ACP sent resource content" over a
    /// line of JSON — the reader could not follow the link or read the file,
    /// and on a chat opened for reading, where an attached file is how most
    /// prompts start, that note was the prompt (bw-t26l.20).
    #[test]
    fn a_linked_file_and_a_file_carried_whole_are_both_readable() {
        let mut normalizer = AcpNormalizer::default();
        let linked = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"user_message_chunk",
            "content":{"type":"resource_link","name":"notes.md","uri":"file:///work/notes.md"}
        }}));
        assert_eq!(kinds(&linked), vec!["message.started", "text.delta"]);
        assert_eq!(
            serde_json::to_value(&linked[1]).unwrap()["text"],
            "[notes.md](file:///work/notes.md)"
        );

        let carried = normalizer.update("local", "claude", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"user_message_chunk",
            "content":{"type":"resource","resource":{
                "uri":"file:///work/one.rs","mimeType":"text/x-rust","text":"fn one() {}"
            }}
        }}));
        let text = serde_json::to_value(&carried[0]).unwrap()["text"]
            .as_str()
            .unwrap()
            .to_string();
        // Where it came from, then the file itself, fenced: quoted into a
        // message, a file is not the speaker's own prose.
        assert!(text.starts_with("file:///work/one.rs"), "{text}");
        assert!(text.contains("```\nfn one() {}\n```"), "{text}");
    }

    /// A picture carried as a resource is a picture. Sound is not, and has
    /// nowhere to be drawn, so it stays the lossless note it always was.
    #[test]
    fn an_embedded_picture_is_drawn_and_sound_stays_a_note() {
        let mut normalizer = AcpNormalizer::default();
        let drawn = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"agent_message_chunk",
            "content":{"type":"resource","resource":{
                "uri":"file:///work/shot.png","mimeType":"image/png","blob":"aGVsbG8="
            }}
        }}));
        assert_eq!(kinds(&drawn), vec!["message.started", "image"]);
        let image = serde_json::to_value(&drawn[1]).unwrap();
        assert_eq!(image["image"]["mime"], "image/png");
        assert_eq!(image["image"]["dataUrl"], "data:image/png;base64,aGVsbG8=");

        let heard = normalizer.update("local", "codex", &json!({"sessionId":"remote","update":{
            "sessionUpdate":"agent_message_chunk",
            "content":{"type":"audio","mimeType":"audio/wav","data":"aGVsbG8="}
        }}));
        assert_eq!(kinds(&heard), vec!["note"]);
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
        let usage = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"subagent_usage_update",
                "subagentSessionId":"child-1","usage":{"seconds":0,"tokens":850,"calls":0}}
            }),
        );
        assert_eq!(kinds(&usage), vec!["cost", "agent.progress"]);
        let cost = serde_json::to_value(&usage[0]).unwrap();
        assert_eq!(cost["cost"]["total"], 850);
        assert_eq!(cost["cost"]["delegated"], 850);
        let usage = serde_json::to_value(&usage[1]).unwrap();
        assert_eq!(usage["tokens"], 850);
        assert_eq!(usage["finalUsage"], true);
        let finished = normalizer.update(
            "local",
            "codex",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"subagent_state_update",
                "subagentSessionId":"child-1","state":"completed",
                "_meta":{"atelier.dev/usage":{"seconds":12,"tokens":900,"calls":4,"model":"gpt-5.6-sol"}}}
            }),
        );
        // And the call that stood for it in the conversation ends with it.
        assert_eq!(kinds(&finished), vec!["cost", "agent.finished", "tool.completed"]);
        let cost = serde_json::to_value(&finished[0]).unwrap();
        assert_eq!(cost["cost"]["total"], 900);
        let ended = serde_json::to_value(&finished[2]).unwrap();
        assert_eq!(ended["toolCallId"], "child-1");
        assert_eq!(ended["ok"], true);
        let finished = serde_json::to_value(&finished[1]).unwrap();
        assert_eq!(finished["seconds"], 12);
        assert_eq!(finished["tokens"], 900);
        assert_eq!(finished["calls"], 4);
        assert_eq!(finished["model"], "gpt-5.6-sol");
    }

    /// A `tool_call` notification routinely carries no `rawInput`: ACP
    /// announces the call and sends what it was given on a later
    /// `tool_call_update`. The wire contract says a started call's `input` is
    /// an object, and handing the absence straight through wrote a null into
    /// the durable record that every later reader of the row broke on
    /// (bw-t26l.20).
    #[test]
    fn a_call_announced_before_its_arguments_starts_with_none_rather_than_null() {
        let mut normalizer = AcpNormalizer::default();
        let announced = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"tool_call",
                "toolCallId":"call-1","title":"Read file '/w/a.rs'","kind":"read"}
            }),
        );
        let started = serde_json::to_value(&announced[0]).unwrap();
        assert_eq!(started["input"], json!({}));

        let refined = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"root", "update":{"sessionUpdate":"tool_call_update",
                "toolCallId":"call-1","rawInput":{"file_path":"/w/a.rs"}}
            }),
        );
        let started = serde_json::to_value(&refined[0]).unwrap();
        assert_eq!(started["input"]["file_path"], "/w/a.rs");
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
    fn accounting_quota_extends_saved_usage_without_counting_the_root_twice() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.seed_usage(Some(&json!({
            "kind":"tokens", "input":70, "output":30, "total":100,
            "thinking":5, "cacheRead":20, "cacheWrite":0
        })));
        let events = normalizer.finish_turn(
            "local",
            "claude",
            &json!({
                "stopReason":"end_turn",
                "usage":{"inputTokens":40,"outputTokens":20,"totalTokens":60},
                "_meta":{"quota":{
                    "token_count":{"inputTokens":40,"outputTokens":20,"totalTokens":60},
                    "model_usage":[
                        {"model":"claude-opus","token_count":{"inputTokens":50,"outputTokens":20,"cachedInputTokens":10,"totalTokens":80}},
                        {"model":"claude-haiku","token_count":{"inputTokens":15,"outputTokens":5,"totalTokens":20}}
                    ]
                }}
            }),
        );
        let cost = events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "cost")
            .unwrap();
        assert_eq!(cost["source"], "acp-accounting-quota");
        assert_eq!(cost["cost"]["total"], 200);
        assert_eq!(cost["cost"]["input"], 135);
        assert_eq!(cost["cost"]["output"], 55);
        assert_eq!(cost["cost"]["cacheRead"], 30);
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
    fn claude_structured_child_accounting_reaches_the_shared_terminal_row() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call",
                "toolCallId":"agent-1","title":"Audit","rawInput":{"prompt":"Review it"},
                "_meta":{"claudeCode":{"toolName":"Agent","subagent":true}}}
            }),
        );
        let events = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"tool_call_update",
                "toolCallId":"agent-1","status":"completed","rawOutput":"Complete",
                "_meta":{"claudeCode":{"toolName":"Agent"},
                "atelier.dev/usage":{"seconds":21,"tokens":11735,"calls":2,
                "includedInPromptUsage":true}}}
            }),
        );
        assert_eq!(kinds(&events), vec!["tool.completed", "agent.finished"]);
        let finished = events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.finished")
            .unwrap();
        assert_eq!(finished["seconds"], 21);
        assert_eq!(finished["tokens"], 11735);
        assert_eq!(finished["calls"], 2);

        let settled = normalizer.finish_turn(
            "local",
            "claude",
            &json!({
                "stopReason":"end_turn",
                "usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15},
                "_meta":{"quota":{"model_usage":[{
                    "model":"claude-opus","token_count":{
                        "inputTokens":10000,"outputTokens":1735,"totalTokens":11735
                    }
                }]}}
            }),
        );
        let cost = settled
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "cost")
            .unwrap();
        assert_eq!(cost["cost"]["total"], 11735);
        assert_eq!(cost["cost"]["delegated"], 11735);
    }

    #[test]
    fn native_async_tasks_use_the_same_provider_neutral_agent_rows() {
        let mut normalizer = AcpNormalizer::default();
        let started = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"async_task_spawned",
                "asyncTaskId":"task-1","name":"Build release","taskType":"shell",
                "description":"cargo build --release","showInTranscript":true,"canStop":true}
            }),
        );
        assert_eq!(kinds(&started), vec!["agent.started"]);
        let started = serde_json::to_value(&started[0]).unwrap();
        assert_eq!(started["kind"], "command");
        assert_eq!(started["toolCallId"], Value::Null);

        let progress = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"async_task_progress",
                "asyncTaskId":"task-1","summary":"Linking","lastToolName":"Bash",
                "usage":{"totalTokens":500,"toolUses":3,"durationMs":2499}}
            }),
        );
        let progress = serde_json::to_value(&progress[0]).unwrap();
        assert_eq!(progress["type"], "agent.progress");
        assert_eq!(progress["seconds"], 2);
        assert_eq!(progress["tokens"], 500);
        assert_eq!(progress["calls"], 3);
        assert_eq!(progress["doing"], "Linking");

        let finished = normalizer.update(
            "local",
            "claude",
            &json!({
                "sessionId":"remote","update":{"sessionUpdate":"async_task_state_update",
                "asyncTaskId":"task-1","state":"completed","summary":"Built"}
            }),
        );
        let finished = serde_json::to_value(&finished[0]).unwrap();
        assert_eq!(finished["type"], "agent.finished");
        assert_eq!(finished["state"], "done");
        assert_eq!(finished["result"], "Built");
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
        assert_eq!(kinds(&parent), vec!["message.started", "text.delta"]);
        let settled = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        let finished = settled
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.finished")
            .expect("the end of the turn is what ends a helper with no ending of its own");
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

    /**
     * Claude's own subagent, and the join nothing on the wire states in time.
     *
     * `subagent_spawned` names a session (`a631a0e9…` in the chat this is drawn
     * from), and everything the helper then does arrives on the PARENT session
     * stamped with the `Task` call that sent it (`toolu_01KzuX…`) — a call for
     * which no `tool_call` is ever announced. The pane reads a helper's words
     * by the agent it opened, so with the two ids left apart it opened on an
     * empty conversation every time (bw-t26l.20).
     */
    #[test]
    fn a_native_subagents_work_is_filed_under_the_agent_the_reader_opens() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
            "subagentSessionId":"agent-1","name":"Read the docs","task":"Read wheels.md","capabilities":{}}
        }));

        let read = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"tool_call",
            "toolCallId":"call-read","title":"Read wheels.md","kind":"read",
            "_meta":{"claudeCode":{"toolName":"Read","parentToolUseId":"task-call"}}}
        }));
        let started = serde_json::to_value(&read[0]).unwrap();
        assert_eq!(started["parentToolCallId"], "agent-1", "the helper's call belongs to the helper");

        let said = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":"They are round."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        let message = serde_json::to_value(&said[0]).unwrap();
        assert_eq!(message["parentToolCallId"], "agent-1");

        // Finished, the card carries what it reported: this update says nothing
        // about a result, and those are the only words it ever sent.
        let finished = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_state_update",
            "subagentSessionId":"agent-1","state":"completed"}
        }));
        let ended = finished.iter().map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "tool.completed");
        let finished = finished.iter().map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.finished").expect("nothing ended the helper");
        assert_eq!(finished["agentId"], "agent-1");
        assert_eq!(finished["result"], "They are round.");
        // And the row that stood for it in the conversation stops spinning.
        // Measured on a real turn: the helper answered, the panel beside it
        // filed the helper under "completed", and the row that sent it was
        // still running — nothing had ever closed it (2026-09-03, `a80d66a3…`).
        let ended = ended.expect("the row that sent the helper was left running");
        assert_eq!(ended["toolCallId"], "agent-1");
        assert_eq!(ended["ok"], true);
        assert_eq!(ended["output"], "They are round.");

        // And the root's own words are the root's, still.
        let root = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-2","content":{"type":"text","text":"Done."}}
        }));
        assert_eq!(kinds(&root), vec!["message.started", "text.delta"]);
        assert_eq!(serde_json::to_value(&root[0]).unwrap()["parentToolCallId"], Value::Null);
    }

    /**
     * The line saying what a sent-away helper is doing NOW, built from the only
     * thing the kit actually sends about it.
     *
     * The `Task` call's own updates carry an empty content list for as long as
     * the helper runs, so the row's line was never drawn once — a four-minute
     * helper and not a word about it (measured against the pinned claude
     * adapter, 2026-09-03). The helper's work does arrive, stamped with the
     * call that sent it, and that is what the line is made of.
     */
    #[test]
    fn the_row_that_sent_a_helper_says_what_the_helper_is_doing() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
            "subagentSessionId":"agent-1","name":"Wait twice","task":"Sleep, speak, sleep","capabilities":{}}
        }));

        // The command it just started.
        let ran = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"tool_call",
            "toolCallId":"call-sleep","title":"python3 -c 'time.sleep(5)'","kind":"execute",
            "_meta":{"claudeCode":{"toolName":"Bash","parentToolUseId":"task-call"}}}
        }));
        let doing = serde_json::to_value(
            ran.iter().map(|event| serde_json::to_value(event).unwrap())
                .find(|event| event["type"] == "tool.progress")
                .expect("the sending row was never told what its helper started"),
        ).unwrap();
        assert_eq!(doing["toolCallId"], "agent-1");
        assert_eq!(doing["summary"], "python3 -c 'time.sleep(5)'");
        // No clock of its own, and the reader must not read the zero as one.
        assert_eq!(doing["seconds"], 0);
        let pane = ran.iter().map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.progress")
            .expect("the panel beside it was told nothing");
        assert_eq!(pane["doing"], "python3 -c 'time.sleep(5)'");
        assert_eq!(pane["agentId"], "agent-1");
        // A ping with nothing to report about state must not reopen a row.
        assert_eq!(pane["state"], Value::Null);

        // Then the sentence it just wrote, which replaces it.
        let said = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":"That wait is done.\nStarting the longer one."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        let doing = said.iter().map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "tool.progress")
            .expect("the sending row never heard the helper speak");
        assert_eq!(doing["summary"], "Starting the longer one.", "its last line, not its first");

        // Said again is not news: a message is re-read on every delta, and the
        // row must not be redrawn to say what it already says.
        let again = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":""},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        assert!(
            !kinds(&again).iter().any(|kind| kind == "tool.progress"),
            "the row was told the same thing twice: {:?}", kinds(&again),
        );

        // And a call of the chat's own says nothing about any helper.
        let mine = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"tool_call",
            "toolCallId":"call-mine","title":"Read notes.md","kind":"read",
            "_meta":{"claudeCode":{"toolName":"Read"}}}
        }));
        assert_eq!(kinds(&mine), vec!["tool.started"]);
    }

    /**
     * A helper's ending and its last words arrive in either order, and when the
     * ending comes first the card announced whatever it had said by then — "I'll
     * read both files" as its answer about two files (measured 2026-09-03). The
     * rest is reported at the end of the turn, once there is no more to come.
     */
    #[test]
    fn a_helper_that_finished_before_it_stopped_speaking_still_reports_what_it_said() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
            "subagentSessionId":"agent-1","name":"Read the docs","task":"Read wheels.md","capabilities":{}}
        }));
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":"I'll read both files."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        let early = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_state_update",
            "subagentSessionId":"agent-1","state":"completed"}
        }));
        let early = early.iter().map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.finished").expect("nothing ended the helper");
        assert_eq!(early["result"], "I'll read both files.");

        // The chat's own answer, in between: measured on a real chat, the
        // manager answers first and the helper's report lands after it.
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-root","content":{"type":"text","text":"All four steps are done."}}
        }));
        // Its actual report, after its own ending.
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-2","content":{"type":"text","text":"They are round and hot."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        let settled = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        let corrected = settled
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.finished")
            .expect("the turn ends by saying what the helper reported");
        assert_eq!(corrected["agentId"], "agent-1");
        assert_eq!(corrected["state"], "done");
        assert_eq!(corrected["result"], "I'll read both files.\n\nThey are round and hot.");

        // And once said, it is not said again on the next turn.
        let quiet = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        assert!(!kinds(&quiet).iter().any(|kind| *kind == "agent.finished"));
    }

    /**
     * The provider starting a second message where the first one was is the
     * only ending the first one gets — claude sends no completion of its own
     * for it. Measured on a real chat: two of the turn's four messages were
     * started and never finished, so the reader's transcript kept them open
     * (bw-t26l.20).
     */
    #[test]
    fn a_message_replaced_in_its_own_place_is_finished_rather_than_left_open() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":"First."}}
        }));
        let replaced = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-2","content":{"type":"text","text":"Second."}}
        }));
        let replaced = replaced
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .collect::<Vec<_>>();
        let done = replaced
            .iter()
            .find(|event| event["type"] == "message.completed")
            .expect("the message that was replaced is finished");
        assert_eq!(done["messageId"], "acp-m-1");
        // And it is finished before the one replacing it is announced.
        let started = replaced
            .iter()
            .position(|event| event["type"] == "message.started")
            .expect("the new message is announced");
        let finished = replaced
            .iter()
            .position(|event| event["type"] == "message.completed")
            .unwrap();
        assert!(finished < started);

        // The end of the turn finishes the survivor and nothing twice over.
        let settled = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        let endings = settled
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .filter(|event| event["type"] == "message.completed")
            .map(|event| event["messageId"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        assert_eq!(endings, vec!["acp-m-2".to_string()]);
    }

    /**
     * The shape a real chat actually had (measured 2026-09-03, and reproduced
     * on 2 of 10 live runs): the helper said "I'll read both files.", the chat
     * spoke while it was still reading, and only afterwards did the helper file
     * its report. Read as an ending, the chat speaking put that first sentence
     * on the card as the answer to a question about two files. It is not read
     * as an ending: a helper still out is still running, and what ends it is an
     * ending of its own or the end of the turn.
     */
    #[test]
    fn a_helper_still_out_is_not_declared_over_because_the_chat_spoke() {
        let mut normalizer = AcpNormalizer::default();
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
            "subagentSessionId":"agent-1","name":"Read the docs","task":"Read wheels.md","capabilities":{}}
        }));
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":"I'll read both files."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        // The chat answering says nothing about the helper, which is still out.
        let spoke = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-root","content":{"type":"text","text":"The helper is still going."}}
        }));
        assert!(
            !kinds(&spoke).iter().any(|kind| *kind == "agent.finished"),
            "the chat speaking is not an ending: {:?}",
            kinds(&spoke)
        );

        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-2","content":{"type":"text","text":"They are round and hot."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        let settled = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        let endings = settled
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .filter(|event| event["type"] == "agent.finished")
            .collect::<Vec<_>>();
        assert_eq!(endings.len(), 1, "ended once, not once per guess");
        let corrected = &endings[0];
        assert_eq!(corrected["agentId"], "agent-1");
        assert_eq!(corrected["result"], "I'll read both files.\n\nThey are round and hot.");

        let quiet = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        assert!(!kinds(&quiet).iter().any(|kind| *kind == "agent.finished"));

        // An async helper outlives the turn that launched it. What it says in
        // the next one is added to what it already said, not put in place of
        // it: reported as the tail alone, the card would lose the report it
        // was already showing.
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-3","content":{"type":"text","text":"And both are two lines long."},
            "_meta":{"claudeCode":{"parentToolUseId":"task-call"}}}
        }));
        let later = normalizer.finish_turn("local", "claude", &json!({"stopReason":"end_turn"}));
        let later = later
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["type"] == "agent.finished")
            .expect("what it said in the second turn is reported too");
        assert_eq!(
            later["result"],
            "I'll read both files.\n\nThey are round and hot.\n\nAnd both are two lines long."
        );
    }

    /**
     * Two helpers out at once, and no honest way to tell whose call is whose
     * until the kit says so. The guess is not made: the rows keep the call they
     * came with rather than being filed under whichever agent was spawned first
     * (bw-t26l.20).
     */
    #[test]
    fn two_helpers_at_once_are_not_guessed_between() {
        let mut normalizer = AcpNormalizer::default();
        for agent in ["agent-1", "agent-2"] {
            normalizer.update("local", "claude", &json!({
                "sessionId":"root", "update":{"sessionUpdate":"subagent_spawned",
                "subagentSessionId":agent,"name":"Helper","task":"Work","capabilities":{}}
            }));
        }
        let said = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-1","content":{"type":"text","text":"Working"},
            "_meta":{"claudeCode":{"parentToolUseId":"call-b"}}}
        }));
        assert_eq!(serde_json::to_value(&said[0]).unwrap()["parentToolCallId"], "call-b");

        // Said outright, the join is taken and kept.
        normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"tool_call_update",
            "toolCallId":"call-b","status":"in_progress",
            "_meta":{"claudeCode":{"toolName":"Agent","toolResponse":{"agentId":"agent-2"}}}}
        }));
        let after = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-2","content":{"type":"text","text":"Still working"},
            "_meta":{"claudeCode":{"parentToolUseId":"call-b"}}}
        }));
        assert_eq!(serde_json::to_value(&after[0]).unwrap()["parentToolCallId"], "agent-2");

        // And with one of the two now claimed, the other's call is no longer
        // ambiguous.
        let other = normalizer.update("local", "claude", &json!({
            "sessionId":"root", "update":{"sessionUpdate":"agent_message_chunk",
            "messageId":"m-3","content":{"type":"text","text":"Me too"},
            "_meta":{"claudeCode":{"parentToolUseId":"call-a"}}}
        }));
        assert_eq!(serde_json::to_value(&other[0]).unwrap()["parentToolCallId"], "agent-1");
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
