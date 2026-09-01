//! Codex snapshots and rollout rows translated to provider-neutral WBP payloads.

use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use uuid::Uuid;

pub type DriverEvent = Value;

fn event(kind: &str, fields: impl IntoIterator<Item = (&'static str, Value)>) -> DriverEvent {
    let mut row = Map::new();
    row.insert("type".into(), json!(kind));
    for (field, value) in fields {
        row.insert(field.into(), value);
    }
    Value::Object(row)
}

fn strings(value: &Value, field: &str) -> Vec<String> {
    value[field]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

fn output_of(item: &Value) -> String {
    for field in ["aggregatedOutput", "result", "results"] {
        if let Some(value) = item.get(field) {
            return value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string());
        }
    }
    for field in ["error", "failure"] {
        if let Some(message) = item[field]["message"].as_str() {
            return message.to_string();
        }
    }
    String::new()
}

fn local_image(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/*",
    };
    Some(json!({
        "dataUrl": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
        "mime": mime,
        "alt": path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
    }))
}

fn patch_sides(diff: &str) -> Value {
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut line_number = None;
    for line in diff.lines() {
        if line.starts_with("@@") {
            line_number = line
                .split_whitespace()
                .find(|part| part.starts_with('+'))
                .and_then(|part| part.trim_start_matches('+').split(',').next())
                .and_then(|line| line.parse::<i64>().ok());
        } else if line.starts_with("---") || line.starts_with("+++") {
        } else if let Some(line) = line.strip_prefix('-') {
            before.push(line);
        } else if let Some(line) = line.strip_prefix('+') {
            after.push(line);
        } else {
            let line = line.strip_prefix(' ').unwrap_or(line);
            before.push(line);
            after.push(line);
        }
    }
    let mut result = json!({"before": before.join("\n"), "after": after.join("\n")});
    if let Some(line) = line_number {
        result["line"] = json!(line);
    }
    result
}

fn proposed_plans(text: &str) -> Vec<String> {
    let mut plans = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("<proposed_plan>") {
        let after = &rest[open + "<proposed_plan>".len()..];
        let after = after.trim_start_matches([' ', '\t']);
        let Some(body) = after
            .strip_prefix("\r\n")
            .or_else(|| after.strip_prefix('\n'))
        else {
            rest = after;
            continue;
        };
        let Some(close) = body
            .find("\r\n</proposed_plan>")
            .map(|at| (at, "\r\n</proposed_plan>".len()))
            .or_else(|| {
                body.find("\n</proposed_plan>")
                    .map(|at| (at, "\n</proposed_plan>".len()))
            })
        else {
            break;
        };
        let markdown = body[..close.0].trim();
        if !markdown.is_empty() {
            plans.push(markdown.to_string());
        }
        rest = &body[close.0 + close.1..];
    }
    plans
}

fn plan_proposal(id: &str, markdown: &str) -> DriverEvent {
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

#[derive(Clone, Debug)]
struct Agent {
    agent_type: Option<String>,
    what: String,
    tool_call_id: Option<String>,
    parent_actor_id: Option<String>,
}

#[derive(Default)]
pub struct CodexNormalizer {
    messages: HashSet<String>,
    completed_messages: HashSet<String>,
    tools: HashMap<String, String>,
    completed_tools: HashSet<String>,
    agents: HashMap<String, Agent>,
    finished_agents: HashSet<String>,
    message_parents: HashMap<String, String>,
    message_actors: HashMap<String, String>,
    rollout_apply: Option<String>,
}

impl CodexNormalizer {
    fn parent_tool_call(&self, actor_agent_id: Option<&str>) -> Option<String> {
        actor_agent_id.and_then(|id| self.agents.get(id)?.tool_call_id.clone())
    }

    pub fn agent_execution(&self, agent_id: &str) -> Option<Value> {
        let agent = self.agents.get(agent_id)?;
        let operation_id = agent.tool_call_id.as_deref()?;
        Some(json!({
            "conversationId": agent_id,
            "actorId": agent_id,
            "actorName": agent.agent_type.as_deref().unwrap_or(&agent.what),
            "parentActorId": agent.parent_actor_id,
            "operationId": operation_id,
            "parentOperationId": self.parent_tool_call(agent.parent_actor_id.as_deref()),
        }))
    }

    pub fn finish_agent(
        &mut self,
        agent_id: &str,
        state: &str,
        result: Value,
    ) -> Option<DriverEvent> {
        if !self.agents.contains_key(agent_id) || !self.finished_agents.insert(agent_id.to_string())
        {
            return None;
        }
        let mut finished = event(
            "agent.finished",
            [
                ("agentId", json!(agent_id)),
                ("state", json!(state)),
                ("seconds", json!(0)),
                ("tokens", json!(0)),
                ("calls", json!(0)),
                ("model", Value::Null),
                ("result", result),
            ],
        );
        if let Some(execution) = self.agent_execution(agent_id) {
            finished["execution"] = execution;
        }
        Some(finished)
    }

    fn execution(
        &self,
        actor_agent_id: Option<&str>,
        operation_id: &str,
        parent_operation_id: Option<&str>,
    ) -> Option<Value> {
        let actor_id = actor_agent_id?;
        let actor = self.agents.get(actor_id);
        Some(json!({
            "conversationId": actor_id,
            "actorId": actor_id,
            "actorName": actor.and_then(|row| row.agent_type.as_deref()).or_else(|| actor.map(|row| row.what.as_str())),
            "parentActorId": actor.and_then(|row| row.parent_actor_id.as_deref()),
            "operationId": operation_id,
            "parentOperationId": parent_operation_id,
        }))
    }

    fn contextual_event(
        &self,
        kind: &str,
        fields: impl IntoIterator<Item = (&'static str, Value)>,
        actor_agent_id: Option<&str>,
        operation_id: &str,
        parent_tool_call_id: Option<&str>,
        include_parent: bool,
    ) -> DriverEvent {
        let mut row = event(kind, fields);
        if include_parent {
            row["parentToolCallId"] = parent_tool_call_id.map_or(Value::Null, |id| json!(id));
        }
        if let Some(execution) = self.execution(actor_agent_id, operation_id, parent_tool_call_id) {
            row["execution"] = execution;
        }
        row
    }

    fn open_message(
        &mut self,
        id: &str,
        role: &str,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) {
        if self.messages.insert(id.to_string()) {
            let parent = self.parent_tool_call(actor_agent_id);
            if let Some(parent) = &parent {
                self.message_parents.insert(id.to_string(), parent.clone());
            }
            if let Some(actor) = actor_agent_id {
                self.message_actors
                    .insert(id.to_string(), actor.to_string());
            }
            events.push(self.contextual_event(
                "message.started",
                [("messageId", json!(id)), ("role", json!(role))],
                actor_agent_id,
                id,
                parent.as_deref(),
                parent.is_some(),
            ));
        }
    }

    fn start_agent(
        &mut self,
        item: &Value,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) {
        let Some(agent_id) = item["agentThreadId"].as_str() else {
            return;
        };
        if self.agents.contains_key(agent_id) || self.finished_agents.contains(agent_id) {
            return;
        }
        let agent_type = item["agentPath"].as_str().and_then(|path| {
            Path::new(path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_string)
        });
        let what = agent_type.clone().unwrap_or_else(|| {
            item["prompt"]
                .as_str()
                .filter(|prompt| !prompt.is_empty())
                .unwrap_or("Subagent")
                .to_string()
        });
        let tool_call_id = item["id"].as_str().map(str::to_string);
        let execution = json!({
            "conversationId": agent_id,
            "actorId": agent_id,
            "actorName": agent_type.as_deref().unwrap_or(&what),
            "parentActorId": actor_agent_id,
            "operationId": item.get("id").cloned().unwrap_or(Value::Null),
            "parentOperationId": self.parent_tool_call(actor_agent_id),
        });
        events.push(event(
            "agent.started",
            [
                ("agentId", json!(agent_id)),
                ("toolCallId", item.get("id").cloned().unwrap_or(Value::Null)),
                ("kind", json!("helper")),
                ("what", json!(what)),
                (
                    "agentType",
                    agent_type.clone().map_or(Value::Null, Value::String),
                ),
                ("model", item.get("model").cloned().unwrap_or(Value::Null)),
                ("execution", execution),
            ],
        ));
        self.agents.insert(
            agent_id.to_string(),
            Agent {
                agent_type,
                what,
                tool_call_id,
                parent_actor_id: actor_agent_id.map(str::to_string),
            },
        );
    }

    pub fn item_started(&mut self, item: &Value, events: &mut Vec<DriverEvent>) {
        self.item_started_for(item, None, events);
    }

    pub fn message_delta_for(
        &mut self,
        id: &str,
        text: Value,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) -> bool {
        let opened = !self.messages.contains(id);
        self.open_message(id, "assistant", actor_agent_id, events);
        let parent = self
            .message_parents
            .get(id)
            .cloned()
            .or_else(|| self.parent_tool_call(actor_agent_id));
        events.push(self.contextual_event(
            "text.delta",
            [("messageId", json!(id)), ("text", text)],
            actor_agent_id,
            id,
            parent.as_deref(),
            false,
        ));
        opened && parent.is_none()
    }

    pub fn thinking_delta_for(
        &self,
        id: &str,
        text: Value,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) {
        let parent = self.parent_tool_call(actor_agent_id);
        events.push(self.contextual_event(
            "thinking.delta",
            [("messageId", json!(id)), ("text", text)],
            actor_agent_id,
            id,
            parent.as_deref(),
            parent.is_some(),
        ));
    }

    pub fn item_started_for(
        &mut self,
        item: &Value,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) {
        let Some(kind) = item["type"].as_str() else {
            return;
        };
        let id = item["id"].as_str().unwrap_or_default();
        match kind {
            "agentMessage" => self.open_message(id, "assistant", actor_agent_id, events),
            "reasoning" => {
                let mut text = strings(item, "summary");
                text.extend(strings(item, "content"));
                if !text.is_empty() {
                    let parent = self.parent_tool_call(actor_agent_id);
                    events.push(self.contextual_event(
                        "thinking.delta",
                        [("messageId", json!(id)), ("text", json!(text.join("\n")))],
                        actor_agent_id,
                        id,
                        parent.as_deref(),
                        parent.is_some(),
                    ));
                }
            }
            "plan" => events.push(event(
                "note",
                [
                    ("noteId", json!(id)),
                    ("rank", json!("note")),
                    ("kind", json!("plan")),
                    ("text", item.get("text").cloned().unwrap_or(Value::Null)),
                    ("body", Value::Null),
                ],
            )),
            "subAgentActivity" => {
                self.start_agent(item, actor_agent_id, events);
                if item["kind"] == "started" {
                    self.start_tool(
                        id,
                        "spawn_agent",
                        json!({"task_name": item["agentThreadId"], "prompt": ""}),
                        actor_agent_id,
                        events,
                    );
                }
            }
            "collabAgentToolCall" => {
                let name = match item["tool"].as_str().unwrap_or_default() {
                    "spawnAgent" => "spawn_agent",
                    "sendInput" => "send_message",
                    "resumeAgent" => "resume_agent",
                    "wait" => "wait_agent",
                    "closeAgent" => "close_agent",
                    other => other,
                };
                let ids = item["receiverThreadIds"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if item["tool"] == "spawnAgent" {
                    for agent_id in &ids {
                        self.start_agent(
                            &json!({"id":id,"agentThreadId":agent_id,"agentPath":Value::Null,"prompt":item["prompt"],"model":item["model"]}),
                            actor_agent_id,
                            events,
                        );
                    }
                }
                self.start_tool(id, name, json!({"target": ids}), actor_agent_id, events);
            }
            "hookPrompt" | "contextCompaction" | "enteredReviewMode" | "exitedReviewMode" => {}
            _ => {
                let action = item["commandActions"]
                    .as_array()
                    .and_then(|rows| rows.first())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let name = match kind {
                    "commandExecution" => match action["type"].as_str() {
                        Some("read") => "Read",
                        Some("listFiles") => "Glob",
                        Some("search") => "Grep",
                        _ => "Bash",
                    },
                    "fileChange" => "Edit",
                    "mcpToolCall" => return self.start_mcp(item, actor_agent_id, events),
                    "dynamicToolCall" => item["tool"].as_str().unwrap_or("Tool"),
                    "webSearch" => "Web search",
                    "imageView" => "View image",
                    "sleep" => "Wait",
                    "imageGeneration" => "Generate image",
                    _ => return,
                };
                let input = item.get("arguments").cloned().unwrap_or_else(|| json!({
                    "command": item["command"], "changes": item["changes"], "query": action.get("query").unwrap_or(&item["query"]),
                    "pattern": action["query"], "path": action.get("path").unwrap_or(&item["path"]), "file_path": action["path"],
                    "durationMs": item["durationMs"]
                }));
                self.start_tool(id, name, input, actor_agent_id, events);
                if kind == "fileChange" {
                    for change in item["changes"].as_array().into_iter().flatten() {
                        let mut fields =
                            vec![("toolCallId", json!(id)), ("path", change["path"].clone())];
                        let sides = patch_sides(change["diff"].as_str().unwrap_or_default());
                        fields.push(("before", sides["before"].clone()));
                        fields.push(("after", sides["after"].clone()));
                        if let Some(line) = sides.get("line") {
                            fields.push(("line", line.clone()));
                        }
                        events.push(event("diff", fields));
                    }
                }
            }
        }
    }

    fn start_mcp(
        &mut self,
        item: &Value,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) {
        let id = item["id"].as_str().unwrap_or_default();
        let name = format!(
            "{}/{}",
            item["server"].as_str().unwrap_or_default(),
            item["tool"].as_str().unwrap_or_default()
        );
        let mut input = item.get("arguments").cloned().unwrap_or_else(|| json!({}));
        input["readOnlyHint"] = item
            .get("readOnlyHint")
            .or_else(|| item.get("read_only_hint"))
            .cloned()
            .unwrap_or(Value::Null);
        input["destructiveHint"] = item
            .get("destructiveHint")
            .or_else(|| item.get("destructive_hint"))
            .cloned()
            .unwrap_or(Value::Null);
        self.start_tool(id, &name, input, actor_agent_id, events);
    }

    fn start_tool(
        &mut self,
        id: &str,
        name: &str,
        input: Value,
        actor_agent_id: Option<&str>,
        events: &mut Vec<DriverEvent>,
    ) {
        if self.tools.contains_key(id) || self.completed_tools.contains(id) {
            return;
        }
        self.tools.insert(id.to_string(), name.to_string());
        let parent = self.parent_tool_call(actor_agent_id);
        events.push(self.contextual_event(
            "tool.started",
            [
                ("toolCallId", json!(id)),
                ("name", json!(name)),
                ("input", input.clone()),
                ("title", json!(tool_title(name, &input))),
            ],
            actor_agent_id,
            id,
            parent.as_deref(),
            true,
        ));
    }

    pub fn item_completed(&mut self, item: &Value, events: &mut Vec<DriverEvent>) {
        self.item_completed_for(item, None, true, events);
    }

    pub fn item_completed_for(
        &mut self,
        item: &Value,
        actor_agent_id: Option<&str>,
        replayed: bool,
        events: &mut Vec<DriverEvent>,
    ) {
        let Some(kind) = item["type"].as_str() else {
            return;
        };
        let id = item["id"].as_str().unwrap_or_default();
        if kind == "agentMessage" {
            if !self.completed_messages.insert(id.to_string()) {
                return;
            }
            let text = item["text"].as_str().unwrap_or_default();
            if !self.messages.contains(id) && text.trim().is_empty() {
                return;
            }
            let opened = self.messages.contains(id);
            let remembered_actor = self.message_actors.get(id).cloned();
            let actor_agent_id = actor_agent_id.or(remembered_actor.as_deref());
            let remembered_parent = self.message_parents.get(id).cloned();
            self.open_message(id, "assistant", actor_agent_id, events);
            if !opened && !text.is_empty() {
                events.push(self.contextual_event(
                    "text.delta",
                    [("messageId", json!(id)), ("text", json!(text))],
                    actor_agent_id,
                    id,
                    remembered_parent.as_deref(),
                    false,
                ));
            }
            events.push(self.contextual_event(
                "message.completed",
                [("messageId", json!(id))],
                actor_agent_id,
                id,
                remembered_parent.as_deref(),
                false,
            ));
            for (index, markdown) in proposed_plans(text).into_iter().enumerate() {
                events.push(plan_proposal(&format!("{id}:plan:{index}"), &markdown));
            }
            return;
        }
        if self.completed_tools.contains(id) {
            return;
        }
        if kind == "collabAgentToolCall" {
            self.item_started_for(item, actor_agent_id, events);
            for (agent_id, state) in item["agentsStates"].as_object().into_iter().flatten() {
                if !replayed && item["tool"] == "spawnAgent" {
                    continue;
                }
                let state_name = match state["status"].as_str().unwrap_or_default() {
                    "completed" => "done",
                    "interrupted" | "shutdown" => "stopped",
                    "errored" | "notFound" => "failed",
                    _ => continue,
                };
                if let Some(finished) = self.finish_agent(
                    agent_id,
                    state_name,
                    state.get("message").cloned().unwrap_or(Value::Null),
                ) {
                    events.push(finished);
                }
            }
        }
        if !self.tools.contains_key(id) {
            return;
        }
        let ok = !matches!(item["status"].as_str(), Some("failed" | "declined"))
            && item["exitCode"].as_i64().is_none_or(|code| code == 0);
        let parent = self.parent_tool_call(actor_agent_id);
        events.push(self.contextual_event(
            "tool.completed",
            [
                ("toolCallId", json!(id)),
                ("ok", json!(ok)),
                ("output", json!(output_of(item))),
            ],
            actor_agent_id,
            id,
            parent.as_deref(),
            false,
        ));
        if ok && matches!(kind, "imageView" | "imageGeneration") {
            let path = if kind == "imageGeneration" {
                item["savedPath"].as_str()
            } else {
                item["path"].as_str()
            };
            if let Some(image) = path.and_then(|path| local_image(Path::new(path))) {
                let message_id = format!("{id}:image");
                self.open_message(&message_id, "assistant", actor_agent_id, events);
                events.push(event(
                    "image",
                    [("messageId", json!(message_id)), ("image", image)],
                ));
                events.push(event(
                    "message.completed",
                    [("messageId", json!(message_id))],
                ));
            }
        }
        self.tools.remove(id);
        self.completed_tools.insert(id.to_string());
    }

    pub fn replay_thread(&mut self, thread: &Value) -> Vec<DriverEvent> {
        let mut events = Vec::new();
        for turn in thread["turns"].as_array().into_iter().flatten() {
            for item in turn["items"].as_array().into_iter().flatten() {
                match item["type"].as_str().unwrap_or_default() {
                    "userMessage" => {
                        let id = item["id"].as_str().unwrap_or_default();
                        self.open_message(id, "user", None, &mut events);
                        let text = item["content"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|part| part["type"] == "text")
                            .filter_map(|part| part["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        if !text.is_empty() {
                            events.push(event(
                                "text.delta",
                                [("messageId", json!(id)), ("text", json!(text))],
                            ));
                        }
                        for part in item["content"].as_array().into_iter().flatten() {
                            let image = if part["type"] == "image" {
                                part["url"].as_str().map(|url| json!({"dataUrl":url,"mime":data_mime(url),"alt":"Attached image"}))
                            } else if part["type"] == "localImage" {
                                part["path"]
                                    .as_str()
                                    .and_then(|path| local_image(Path::new(path)))
                            } else {
                                None
                            };
                            if let Some(image) = image {
                                events.push(event(
                                    "image",
                                    [("messageId", json!(id)), ("image", image)],
                                ));
                            }
                        }
                        events.push(event("message.completed", [("messageId", json!(id))]));
                    }
                    "reasoning" | "plan" => self.item_started(item, &mut events),
                    "agentMessage" => self.item_completed(item, &mut events),
                    _ => {
                        self.item_started(item, &mut events);
                        if item["status"] != "inProgress" {
                            self.item_completed(item, &mut events);
                        }
                    }
                }
            }
        }
        events
    }

    pub fn rollout_line(&mut self, line: &str) -> Vec<DriverEvent> {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let payload = &row["payload"];
        let mut events = Vec::new();
        if row["type"] == "event_msg" && payload["type"] == "sub_agent_activity" {
            self.item_started(&json!({"id":payload["event_id"],"type":"subAgentActivity","kind":payload["kind"],"agentThreadId":payload["agent_thread_id"],"agentPath":payload["agent_path"]}), &mut events);
        } else if row["type"] == "world_state"
            && payload["state"]["environments"].get("subagents").is_some()
        {
            let list = payload["state"]["environments"]["subagents"].as_str();
            let active: HashSet<String> = list
                .unwrap_or_default()
                .lines()
                .filter_map(|line| {
                    line.trim()
                        .strip_prefix('-')
                        .and_then(|line| line.trim().split(':').next())
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                })
                .collect();
            let finished: Vec<String> = self
                .agents
                .iter()
                .filter(|(_, agent)| {
                    list.is_none()
                        || !agent
                            .agent_type
                            .as_ref()
                            .is_some_and(|name| active.contains(name))
                })
                .map(|(id, _)| id.clone())
                .collect();
            for agent_id in finished {
                if let Some(finished) = self.finish_agent(&agent_id, "done", Value::Null) {
                    events.push(finished);
                }
            }
        } else if row["type"] == "event_msg" && payload["type"] == "user_message" {
            let id = payload["id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!(
                        "codex-user:{}",
                        row["timestamp"]
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| Uuid::new_v4().to_string())
                    )
                });
            self.open_message(&id, "user", None, &mut events);
            if payload["message"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
            {
                events.push(event(
                    "text.delta",
                    [
                        ("messageId", json!(id)),
                        ("text", payload["message"].clone()),
                    ],
                ));
            }
            for source in payload["images"].as_array().into_iter().flatten() {
                let url = source.as_str().or_else(|| source["url"].as_str());
                if let Some(url) = url {
                    events.push(event(
                        "image",
                        [
                            ("messageId", json!(id)),
                            (
                                "image",
                                json!({"dataUrl":url,"mime":data_mime(url),"alt":"Attached image"}),
                            ),
                        ],
                    ));
                }
            }
            for source in payload["local_images"].as_array().into_iter().flatten() {
                let path = source.as_str().or_else(|| source["path"].as_str());
                if let Some(image) = path.and_then(|path| local_image(Path::new(path))) {
                    events.push(event("image", [("messageId", json!(id)), ("image", image)]));
                }
            }
            events.push(event("message.completed", [("messageId", json!(id))]));
        } else if row["type"] == "event_msg" && payload["type"] == "task_started" {
            events.push(event(
                "session.state",
                [("state", json!("thinking")), ("label", json!("Thinking"))],
            ));
        } else if row["type"] == "event_msg"
            && matches!(
                payload["type"].as_str(),
                Some("task_complete" | "turn_aborted")
            )
        {
            events.push(event(
                "session.state",
                [("state", json!("dormant")), ("label", json!("Asleep"))],
            ));
        } else if row["type"] == "turn_context" {
            let mode = payload["approval_policy"]
                .as_str()
                .filter(|mode| ["untrusted", "on-request", "never"].contains(mode))
                .unwrap_or("on-request");
            events.push(event(
                "session.pinned",
                [
                    (
                        "model",
                        payload
                            .get("model")
                            .cloned()
                            .unwrap_or_else(|| json!("default")),
                    ),
                    ("permissionMode", json!(mode)),
                    (
                        "collaborationMode",
                        payload["collaboration_mode"]
                            .get("mode")
                            .cloned()
                            .unwrap_or(Value::Null),
                    ),
                ],
            ));
        } else if row["type"] == "event_msg"
            && payload["type"] == "token_count"
            && !payload["info"].is_null()
        {
            let total = &payload["info"]["total_token_usage"];
            events.push(event("cost", [("cost",json!({"kind":"tokens","input":total["input_tokens"].as_i64().unwrap_or_default(),"output":total["output_tokens"].as_i64().unwrap_or_default(),"total":total["total_tokens"].as_i64().unwrap_or_default()}))]));
            if let Some(window) = payload["info"]["model_context_window"].as_i64() {
                events.push(event(
                    "context",
                    [
                        (
                            "used",
                            json!(payload["info"]["last_token_usage"]["total_tokens"]
                                .as_i64()
                                .unwrap_or_default()),
                        ),
                        ("window", json!(window)),
                    ],
                ));
            }
        } else if row["type"] == "event_msg" && payload["type"] == "mcp_tool_call_end" {
            let invocation = &payload["invocation"];
            let id = payload["call_id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!(
                        "mcp:{}/{}",
                        invocation["server"].as_str().unwrap_or("service"),
                        invocation["tool"].as_str().unwrap_or("call")
                    )
                });
            let item = json!({"id":id,"type":"mcpToolCall","server":invocation["server"],"tool":invocation["tool"],"arguments":invocation["arguments"],"readOnlyHint":payload["read_only_hint"],"destructiveHint":payload["destructive_hint"],"status":if payload["result"].get("Err").is_some(){"failed"}else{"completed"},"result":payload["result"]});
            self.item_started(&item, &mut events);
            self.item_completed(&item, &mut events);
        } else if row["type"] == "event_msg" && payload["type"] == "item_completed" {
            let item = &payload["item"];
            match item["type"].as_str().unwrap_or_default() {
                "UserMessage" => {
                    let id = item["id"].as_str().unwrap_or_default();
                    self.open_message(id, "user", None, &mut events);
                    let text = rollout_text(item);
                    if !text.is_empty() {
                        events.push(event(
                            "text.delta",
                            [("messageId", json!(id)), ("text", json!(text))],
                        ));
                    }
                    events.push(event("message.completed", [("messageId", json!(id))]));
                }
                "AgentMessage" => self.item_completed(
                    &json!({"id":item["id"],"type":"agentMessage","text":rollout_text(item)}),
                    &mut events,
                ),
                "Reasoning" => {
                    let text = strings(item, "summary_text")
                        .into_iter()
                        .chain(strings(item, "raw_content"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.is_empty() {
                        events.push(event(
                            "thinking.delta",
                            [("messageId", item["id"].clone()), ("text", json!(text))],
                        ));
                    }
                }
                "FileChange" => {
                    if let Some(id) = self.rollout_apply.clone() {
                        for (path, change) in item["changes"].as_object().into_iter().flatten() {
                            if let Some(diff) = change["unified_diff"].as_str() {
                                let sides = patch_sides(diff);
                                events.push(event(
                                    "diff",
                                    [
                                        ("toolCallId", json!(id)),
                                        ("path", json!(path)),
                                        ("before", sides["before"].clone()),
                                        ("after", sides["after"].clone()),
                                    ],
                                ));
                            }
                        }
                    }
                }
                _ => {}
            }
        } else if row["type"] == "response_item"
            && payload["type"] == "message"
            && payload["role"] == "assistant"
        {
            self.item_completed(
                &json!({"id":payload["id"],"type":"agentMessage","text":rollout_text(payload)}),
                &mut events,
            );
        } else if row["type"] == "response_item"
            && matches!(
                payload["type"].as_str(),
                Some("custom_tool_call" | "function_call")
            )
        {
            let id = payload
                .get("call_id")
                .or_else(|| payload.get("id"))
                .cloned()
                .unwrap_or(Value::Null);
            let tool = rollout_tool(
                payload["name"].as_str().unwrap_or_default(),
                payload.get("input"),
            );
            if tool["name"] == "Edit" {
                self.rollout_apply = id.as_str().map(str::to_string);
            }
            self.item_started(&json!({"id":id,"type":"dynamicToolCall","tool":tool["name"],"arguments":tool["arguments"]}),&mut events);
        } else if row["type"] == "response_item"
            && matches!(
                payload["type"].as_str(),
                Some("custom_tool_call_output" | "function_call_output")
            )
        {
            let id = payload["call_id"].clone();
            self.item_completed(&json!({"id":id,"type":"dynamicToolCall","status":"completed","result":payload["output"]}),&mut events);
            if self.rollout_apply.as_deref() == id.as_str() {
                self.rollout_apply = None;
            }
        }
        events
    }
}

fn data_mime(url: &str) -> &str {
    url.strip_prefix("data:")
        .and_then(|rest| rest.split([';', ',']).next())
        .unwrap_or("image/*")
}

fn rollout_text(item: &Value) -> String {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn rollout_tool(name: &str, input: Option<&Value>) -> Value {
    let input = input.cloned().unwrap_or(Value::Null);
    let text = input
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| input.to_string());
    if name == "apply_patch"
        || text.contains("tools.apply_patch(")
        || text.contains("*** Begin Patch")
    {
        let path = text.lines().find_map(|line| {
            ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix))
        });
        json!({"name":"Edit","arguments":path.map_or_else(||json!({}),|path|json!({"file_path":path,"files":[path]}))})
    } else if name == "exec" || name == "exec_command" {
        json!({"name":"Bash","arguments":{"command":input.as_str().unwrap_or(&text).chars().take(500).collect::<String>()}})
    } else if name == "wait" {
        json!({"name":"Wait","arguments":{}})
    } else {
        json!({"name":name,"arguments":if input.is_object(){input}else{json!({"input":input})}})
    }
}

fn tool_title(name: &str, input: &Value) -> String {
    if name == "linear/get_issue" {
        return format!(
            "Read Linear issue {}",
            input["id"].as_str().unwrap_or_default()
        );
    }
    if name == "gmail/delete_label" {
        return format!(
            "Deleted Gmail label {}",
            input["id"].as_str().unwrap_or_default()
        );
    }
    match name {
        "Bash" => input["command"]
            .as_str()
            .unwrap_or("Ran command")
            .to_string(),
        "Edit" => "Edited files".into(),
        _ => name.to_string(),
    }
}

pub fn replay_rollout(text: &str) -> Vec<DriverEvent> {
    let mut normalizer = CodexNormalizer::default();
    text.lines()
        .flat_map(|line| normalizer.rollout_line(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_codex_history_restores_prompts_answers_reasoning_tools_images_and_agents() {
        let mut normalizer = CodexNormalizer::default();
        let events = normalizer.replay_thread(&json!({"turns":[{"items":[
            {"id":"u","type":"userMessage","content":[{"type":"text","text":"Check it"},{"type":"image","url":"data:image/png;base64,AA=="}]},
            {"id":"r","type":"reasoning","summary":["Looking"]},
            {"id":"sh","type":"commandExecution","command":"pwd","status":"completed","exitCode":0,"aggregatedOutput":"/tmp"},
            {"id":"a","type":"agentMessage","text":"Done"},
            {"id":"c","type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","prompt":"Inspect","receiverThreadIds":["helper"],"agentsStates":{"helper":{"status":"completed","message":"OK"}}},
            {"id":"sa","type":"subAgentActivity","agentThreadId":"typed-helper","agentPath":"/repo/.codex/agents/reviewer.toml","kind":"started"}
        ]}]}));
        let kinds: Vec<&str> = events
            .iter()
            .filter_map(|event| event["type"].as_str())
            .collect();
        for kind in [
            "image",
            "thinking.delta",
            "tool.started",
            "tool.completed",
            "agent.started",
            "agent.finished",
        ] {
            assert!(kinds.contains(&kind), "missing {kind}: {events:#?}");
        }
        assert!(!kinds.contains(&"session.state"));
        assert!(events.iter().any(|event| event["type"] == "agent.started"
            && event["agentId"] == "typed-helper"
            && event["agentType"] == "reviewer"));
    }

    #[test]
    fn native_codex_history_replays_rollout_prompts_beside_answers_and_usage() {
        let text = [
            json!({"timestamp":"2026-08-28T05:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"First prompt","images":[],"local_images":[]}}),
            json!({"type":"response_item","payload":{"type":"message","id":"answer-1","role":"assistant","content":[{"type":"output_text","text":"First answer"}]}}),
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"last_token_usage":{"total_tokens":2},"model_context_window":100}}}),
        ].into_iter().map(|row|row.to_string()).collect::<Vec<_>>().join("\n");
        let events = replay_rollout(&text);
        let messages: Vec<(&str, &str)> = events
            .iter()
            .filter_map(|event| match event["type"].as_str()? {
                "message.started" => Some((event["role"].as_str().unwrap(), "")),
                "text.delta" => Some(("", event["text"].as_str().unwrap())),
                _ => None,
            })
            .collect();
        assert_eq!(
            messages,
            [
                ("user", ""),
                ("", "First prompt"),
                ("assistant", ""),
                ("", "First answer")
            ]
        );
        assert!(events
            .iter()
            .any(|event| event["type"] == "cost" && event["cost"]["total"] == 3));
        assert!(events
            .iter()
            .any(|event| event["type"] == "context" && event["window"] == 100));
    }

    #[test]
    fn native_codex_history_materializes_a_native_service_completion_once() {
        let mut normalizer = CodexNormalizer::default();
        let mut events = Vec::new();
        normalizer.item_started(&json!({"id":"exec-mcp","type":"mcpToolCall","server":"linear","tool":"get_issue","arguments":{"id":"KEY-1309"},"readOnlyHint":true}),&mut events);
        events.extend(normalizer.rollout_line(&json!({"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"exec-mcp","read_only_hint":true,"invocation":{"server":"linear","tool":"get_issue","arguments":{"id":"KEY-1309"}},"result":{"Ok":{"content":[]}}}}).to_string()));
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "tool.started")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "tool.completed")
                .count(),
            1
        );
        assert!(events
            .iter()
            .any(|event| event["title"] == "Read Linear issue KEY-1309"));
    }

    #[test]
    fn native_codex_history_finishes_helpers_omitted_from_the_rollout_active_set() {
        let mut normalizer = CodexNormalizer::default();
        for name in ["reader", "reviewer"] {
            normalizer.rollout_line(
                &json!({"type":"event_msg","payload":{
                    "type":"sub_agent_activity","event_id":format!("spawn-{name}"),
                    "kind":"started","agent_thread_id":format!("{name}-thread"),
                    "agent_path":format!("/root/{name}.toml")
                }})
                .to_string(),
            );
        }
        let events = normalizer.rollout_line(
            &json!({"type":"world_state","payload":{
                "state":{"environments":{"subagents":"- reviewer: Ada"}}
            }})
            .to_string(),
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "agent.finished")
                .map(|event| event["agentId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["reader-thread"]
        );
    }
}
