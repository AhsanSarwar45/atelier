//! Canonical event-history projection shared by replay and the live tail.
//!
//! The browser contract is JSON, so transcript rows deliberately remain
//! lossless JSON values at this boundary. Provider input is typed by
//! [`Event`](super::protocol::Event); this module owns the semantics which were
//! previously available only through `src/workbench/fold.ts`.

use super::protocol::{Event, EventKind};
use chrono::DateTime;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub struct Projection {
    pub view: Value,
}

impl Projection {
    pub fn items(&self) -> &[Value] {
        self.view["items"].as_array().expect("projection items")
    }

    pub fn agents(&self) -> &[Value] {
        self.view["agents"].as_array().expect("projection agents")
    }
}

fn empty_menu() -> Value {
    json!({
        "commands": [], "skills": [], "models": [], "efforts": [],
        "permissionModes": [], "collaborationModes": [],
        "agentDefinitions": [], "agentControls": []
    })
}

pub(crate) fn empty_view() -> Map<String, Value> {
    let mut view = Map::new();
    view.insert("brand".into(), Value::Null);
    view.insert("items".into(), json!([]));
    view.insert("state".into(), json!("starting"));
    view.insert("stateLabel".into(), json!("Starting"));
    view.insert("cost".into(), Value::Null);
    view.insert("context".into(), Value::Null);
    view.insert("todos".into(), json!([]));
    view.insert("agents".into(), json!([]));
    view.insert("beads".into(), json!([]));
    view.insert("permissionMode".into(), Value::Null);
    view.insert("model".into(), Value::Null);
    view.insert("effort".into(), Value::Null);
    view.insert("collaborationMode".into(), Value::Null);
    view.insert("menu".into(), empty_menu());
    view.insert("thinkingTokens".into(), json!(0));
    view.insert("error".into(), Value::Null);
    view.insert("lastSeq".into(), json!(0));
    view.insert("historyCursor".into(), Value::Null);
    view.insert("hasOlder".into(), json!(false));
    view
}

fn value(event: &Event, field: &str) -> Value {
    event.fields.get(field).cloned().unwrap_or(Value::Null)
}

/// A call's arguments, always an object.
///
/// The projection replays a durable record, and the record on a machine that
/// has run ACP already holds started calls whose `input` is null: ACP
/// announces a `tool_call` before it knows what the call was given. The wire
/// contract says this field is an object and every reader takes a key off it
/// without asking, so one such row took the whole transcript down as the page
/// opened (bw-t26l.20).
fn arguments(event: &Event, field: &str) -> Value {
    match event.fields.get(field) {
        Some(Value::Object(fields)) => Value::Object(fields.clone()),
        _ => json!({}),
    }
}

fn string(event: &Event, field: &str) -> String {
    event
        .fields
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn integer(event: &Event, field: &str) -> i64 {
    event
        .fields
        .get(field)
        .and_then(Value::as_i64)
        .unwrap_or_default()
}

fn truthy_string(event: &Event, field: &str) -> Value {
    match event.fields.get(field).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => json!(value),
        _ => Value::Null,
    }
}

fn copy_if_present(target: &mut Map<String, Value>, event: &Event, field: &str) {
    if let Some(value) = event.fields.get(field) {
        target.insert(field.to_string(), value.clone());
    }
}

fn item(kind: &str, id: String) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("kind".into(), json!(kind));
    row.insert("id".into(), json!(id));
    row
}

fn find(items: &[Value], kind: &str, id: &str) -> Option<usize> {
    items
        .iter()
        .position(|row| row["kind"] == kind && row["id"] == id)
}

fn brief_of(agents: &[Value], sent_by: &Value) -> Value {
    let Some(sent_by) = sent_by.as_str() else {
        return Value::Null;
    };
    agents
        .iter()
        .find(|agent| {
            agent["toolCallId"]
                .as_str()
                .unwrap_or_else(|| agent["id"].as_str().unwrap_or_default())
                == sent_by
        })
        .and_then(|agent| agent["what"].as_str())
        .filter(|what| !what.is_empty())
        .map_or(Value::Null, |what| json!(what))
}

fn is_over(state: &Value) -> bool {
    matches!(state.as_str(), Some("done" | "failed" | "stopped"))
}

fn menu(event: &Event) -> Value {
    let mut menu = Map::new();
    for field in [
        "commands",
        "skills",
        "models",
        "efforts",
        "permissionModes",
        "collaborationModes",
        "agentDefinitions",
        "agentControls",
        "configOptions",
    ] {
        let sent = event.fields.get(field).filter(|value| value.is_array());
        menu.insert(field.into(), sent.cloned().unwrap_or_else(|| json!([])));
    }
    Value::Object(menu)
}

/// Fold a complete, sequence-ordered canonical history in one pass.
pub fn fold_all(events: &[Event]) -> Projection {
    let mut view = empty_view();
    fold_from(&mut view, events)
}

/// Continue a fold from an already materialised view. This is the native
/// equivalent of the former helper's incremental canonical projection: a new
/// event must never force every event since the conversation began through
/// the reducer again.
pub fn fold_from(view: &mut Map<String, Value>, events: &[Event]) -> Projection {
    let mut items = view
        .remove("items")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let mut agents = view
        .remove("agents")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let mut beads = view
        .remove("beads")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let mut bead_seen = beads
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut agent_at = agents
        .iter()
        .enumerate()
        .filter_map(|(at, agent)| agent["id"].as_str().map(|id| (id.to_string(), at)))
        .collect::<HashMap<_, _>>();

    for event in events {
        let seq = integer(event, "seq");
        if seq > view["lastSeq"].as_i64().unwrap_or_default() {
            view.insert("lastSeq".into(), json!(seq));
        }

        match event.kind {
            EventKind::SessionStarted => {
                view.insert("brand".into(), value(event, "brand"));
                view.insert(
                    "permissionMode".into(),
                    truthy_string(event, "permissionMode"),
                );
                view.insert("model".into(), value(event, "model"));
                view.insert("effort".into(), value(event, "effort"));
                view.insert(
                    "collaborationMode".into(),
                    value(event, "collaborationMode"),
                );
            }
            EventKind::SessionState => {
                let state = value(event, "state");
                view.insert("state".into(), state.clone());
                view.insert("stateLabel".into(), value(event, "label"));
                if state != "errored" {
                    view.insert("error".into(), Value::Null);
                }
                if matches!(state.as_str(), Some("idle" | "errored" | "stopped")) {
                    view.insert("thinkingTokens".into(), json!(0));
                }
            }
            EventKind::MessageStarted => {
                if find(&items, "message", &string(event, "messageId")).is_some() {
                    continue;
                }
                let mut row = item("message", string(event, "messageId"));
                row.insert("role".into(), value(event, "role"));
                row.insert("text".into(), json!(""));
                row.insert("images".into(), json!([]));
                row.insert("comparisons".into(), json!([]));
                row.insert("widgets".into(), json!([]));
                row.insert("done".into(), json!(false));
                row.insert("parentId".into(), value(event, "parentToolCallId"));
                copy_if_present(&mut row, event, "execution");
                items.push(Value::Object(row));
            }
            EventKind::Image | EventKind::ImageCompare | EventKind::Widget => {
                if let Some(at) = find(&items, "message", &string(event, "messageId")) {
                    let (list, field) = match event.kind {
                        EventKind::Image => ("images", "image"),
                        EventKind::ImageCompare => ("comparisons", "comparison"),
                        _ => ("widgets", "widget"),
                    };
                    items[at][list]
                        .as_array_mut()
                        .unwrap()
                        .push(value(event, field));
                }
            }
            EventKind::TextDelta => {
                if let Some(at) = find(&items, "message", &string(event, "messageId")) {
                    let addition = string(event, "text");
                    let current = items[at]["text"].as_str().unwrap_or_default().to_string();
                    items[at]["text"] = json!(format!("{current}{addition}"));
                }
            }
            EventKind::ThinkingDelta => {
                let id = string(event, "messageId");
                if let Some(at) = find(&items, "thinking", &id) {
                    let current = items[at]["text"].as_str().unwrap_or_default();
                    items[at]["text"] = json!(format!("{current}{}", string(event, "text")));
                } else {
                    let mut row = item("thinking", id);
                    row.insert("text".into(), value(event, "text"));
                    row.insert("done".into(), json!(false));
                    row.insert("parentId".into(), value(event, "parentToolCallId"));
                    copy_if_present(&mut row, event, "execution");
                    items.push(Value::Object(row));
                }
            }
            EventKind::MessageCompleted => {
                let id = string(event, "messageId");
                for kind in ["message", "thinking"] {
                    if let Some(at) = find(&items, kind, &id) {
                        items[at]["done"] = json!(true);
                    }
                }
            }
            EventKind::MessageRetracted => {
                if let Some(at) = find(&items, "message", &string(event, "messageId")) {
                    items.remove(at);
                }
            }
            EventKind::ToolStarted => {
                let id = string(event, "toolCallId");
                let mut row = item("tool", id.clone());
                row.insert("name".into(), value(event, "name"));
                row.insert("title".into(), value(event, "title"));
                row.insert("status".into(), json!("running"));
                row.insert("seconds".into(), json!(0));
                row.insert("summary".into(), Value::Null);
                row.insert("parentId".into(), value(event, "parentToolCallId"));
                copy_if_present(&mut row, event, "execution");
                row.insert("diff".into(), Value::Null);
                row.insert("input".into(), arguments(event, "input"));
                row.insert("output".into(), Value::Null);
                let row = Value::Object(row);
                match find(&items, "tool", &id) {
                    Some(at) => items[at] = row,
                    None => items.push(row),
                }
            }
            EventKind::ToolCompleted => {
                if let Some(at) = find(&items, "tool", &string(event, "toolCallId")) {
                    items[at]["status"] = if event
                        .fields
                        .get("ok")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        json!("ok")
                    } else {
                        json!("failed")
                    };
                    items[at]["output"] = value(event, "output");
                    if event
                        .fields
                        .get("title")
                        .and_then(Value::as_str)
                        .is_some_and(|title| !title.is_empty())
                    {
                        items[at]["title"] = value(event, "title");
                    }
                }
            }
            EventKind::ToolProgress => {
                if let Some(at) = find(&items, "tool", &string(event, "toolCallId")) {
                    items[at]["seconds"] = value(event, "seconds");
                    if event
                        .fields
                        .get("summary")
                        .and_then(Value::as_str)
                        .is_some_and(|summary| !summary.is_empty())
                    {
                        items[at]["summary"] = value(event, "summary");
                    }
                }
            }
            EventKind::AgentStarted => {
                let id = string(event, "agentId");
                if let Some(&at) = agent_at.get(&id) {
                    if agents[at]["toolCallId"].is_null() {
                        agents[at]["toolCallId"] = value(event, "toolCallId");
                    }
                    if agents[at]["what"].as_str().unwrap_or_default().is_empty() {
                        agents[at]["what"] = value(event, "what");
                    }
                    if agents[at]["model"].is_null() {
                        agents[at]["model"] = value(event, "model");
                    }
                } else {
                    let mut row = Map::new();
                    for field in [
                        "agentId",
                        "toolCallId",
                        "kind",
                        "what",
                        "agentType",
                        "model",
                    ] {
                        let target = if field == "agentId" { "id" } else { field };
                        row.insert(target.into(), value(event, field));
                    }
                    row.insert("state".into(), json!("running"));
                    let started = event
                        .fields
                        .get("at")
                        .and_then(Value::as_str)
                        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                        .map_or(0, |at| at.timestamp_millis());
                    row.insert("startedAt".into(), json!(started));
                    row.insert("seconds".into(), json!(0));
                    row.insert("tokens".into(), json!(0));
                    row.insert("calls".into(), json!(0));
                    row.insert("doing".into(), Value::Null);
                    row.insert("result".into(), Value::Null);
                    row.insert("relayed".into(), json!([]));
                    copy_if_present(&mut row, event, "execution");
                    agent_at.insert(id, agents.len());
                    agents.push(Value::Object(row));
                }
            }
            EventKind::AgentProgress => {
                if let Some(&at) = agent_at.get(&string(event, "agentId")) {
                    let final_usage = event
                        .fields
                        .get("finalUsage")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if is_over(&agents[at]["state"]) {
                        if final_usage {
                            for field in ["seconds", "tokens", "calls"] {
                                let old = agents[at][field].as_i64().unwrap_or_default();
                                agents[at][field] = json!(old.max(integer(event, field)));
                            }
                        }
                        if agents[at]["model"].as_str().unwrap_or_default().is_empty() {
                            agents[at]["model"] = truthy_string(event, "model");
                        }
                    } else {
                        for field in ["seconds", "tokens", "calls"] {
                            let old = agents[at][field].as_i64().unwrap_or_default();
                            agents[at][field] = json!(old.max(integer(event, field)));
                        }
                        for field in ["doing", "model", "state"] {
                            if event
                                .fields
                                .get(field)
                                .and_then(Value::as_str)
                                .is_some_and(|sent| !sent.is_empty())
                            {
                                agents[at][field] = value(event, field);
                            }
                        }
                    }
                }
            }
            EventKind::AgentRelayed => {
                if let Some(&at) = agent_at.get(&string(event, "agentId")) {
                    agents[at]["relayed"]
                        .as_array_mut()
                        .unwrap()
                        .push(value(event, "text"));
                }
            }
            EventKind::AgentIdentified => {
                if let Some(&at) = agent_at.get(&string(event, "agentId")) {
                    agents[at]["agentType"] = value(event, "agentType");
                }
            }
            EventKind::AgentFinished => {
                if let Some(&at) = agent_at.get(&string(event, "agentId")) {
                    let stopped = agents[at]["state"] == "stopped";
                    if !stopped {
                        agents[at]["state"] = value(event, "state");
                        agents[at]["result"] = value(event, "result");
                    }
                    for field in ["seconds", "tokens", "calls"] {
                        if integer(event, field) != 0 {
                            agents[at][field] = value(event, field);
                        }
                    }
                    if event.fields.contains_key("model") {
                        agents[at]["model"] = value(event, "model");
                    }
                    if let Some(tool_id) = agents[at]["toolCallId"].as_str() {
                        if let Some(tool_at) = find(&items, "tool", tool_id) {
                            let actor = agents[at]["agentType"]
                                .as_str()
                                .filter(|v| !v.is_empty())
                                .or_else(|| agents[at]["execution"]["actorName"].as_str())
                                .map(str::to_string)
                                .unwrap_or_else(|| {
                                    format!(
                                        "helper {}",
                                        string(event, "agentId")
                                            .chars()
                                            .take(8)
                                            .collect::<String>()
                                    )
                                });
                            let state = string(event, "state");
                            items[tool_at]["title"] = json!(format!(
                                "{actor} {}",
                                match state.as_str() {
                                    "done" => "finished",
                                    "failed" => "failed",
                                    _ => "stopped",
                                }
                            ));
                            items[tool_at]["status"] = if state == "done" {
                                json!("ok")
                            } else {
                                json!("failed")
                            };
                        }
                    }
                }
            }
            EventKind::Diff => {
                if let Some(at) = find(&items, "tool", &string(event, "toolCallId")) {
                    let mut diff = Map::new();
                    for field in ["path", "before", "after"] {
                        diff.insert(field.into(), value(event, field));
                    }
                    if integer(event, "line") != 0 {
                        diff.insert("line".into(), value(event, "line"));
                    }
                    items[at]["diff"] = Value::Object(diff);
                }
            }
            EventKind::Note => {
                let mut row = item("note", string(event, "noteId"));
                row.insert("rank".into(), value(event, "rank"));
                row.insert("noteKind".into(), value(event, "kind"));
                row.insert("text".into(), value(event, "text"));
                row.insert("body".into(), value(event, "body"));
                copy_if_present(&mut row, event, "audience");
                items.push(Value::Object(row));
            }
            EventKind::Todo => {
                view.insert("todos".into(), value(event, "items"));
            }
            EventKind::LinkBead => {
                let id = string(event, "beadId");
                if bead_seen.insert(id.clone()) {
                    beads.push(json!(id));
                }
            }
            // Reports are project-level links rather than transcript rows. The
            // app consumes this durable event from the live stream; replaying
            // an older chat must still accept it and advance lastSeq.
            EventKind::ReportAvailable => {}
            EventKind::AskPermission => {
                let mut row = item("ask", string(event, "askId"));
                for field in [
                    "toolName",
                    "title",
                    "options",
                    "question",
                    "allowText",
                    "secret",
                    "href",
                ] {
                    copy_if_present(&mut row, event, field);
                }
                row.insert("chosen".into(), Value::Null);
                let parent = value(event, "parentToolCallId");
                row.insert("parentId".into(), parent.clone());
                copy_if_present(&mut row, event, "execution");
                row.insert("askedBy".into(), brief_of(&agents, &parent));
                items.push(Value::Object(row));
            }
            EventKind::AskResolved => {
                if let Some(at) = find(&items, "ask", &string(event, "askId")) {
                    items[at]["chosen"] = value(event, "chosen");
                }
            }
            EventKind::QuestionRequested => {
                let mut row = item("question", string(event, "requestId"));
                row.insert("blocking".into(), value(event, "blocking"));
                row.insert("questions".into(), value(event, "questions"));
                row.insert("answers".into(), Value::Null);
                let parent = value(event, "parentToolCallId");
                row.insert("parentId".into(), parent.clone());
                row.insert("askedBy".into(), brief_of(&agents, &parent));
                copy_if_present(&mut row, event, "execution");
                items.push(Value::Object(row));
            }
            EventKind::QuestionResolved => {
                if let Some(at) = find(&items, "question", &string(event, "requestId")) {
                    items[at]["answers"] = value(event, "answers");
                }
            }
            EventKind::PlanProposed => {
                let id = string(event, "proposalId");
                if let Some(at) = find(&items, "plan", &id) {
                    items[at]["markdown"] = value(event, "markdown");
                    items[at]["actions"] = value(event, "actions");
                } else {
                    for row in &mut items {
                        if row["kind"] == "plan" && row["status"] == "proposed" {
                            row["status"] = json!("superseded");
                        }
                    }
                    let mut row = item("plan", id);
                    row.insert("markdown".into(), value(event, "markdown"));
                    row.insert("actions".into(), value(event, "actions"));
                    row.insert("status".into(), json!("proposed"));
                    row.insert("actionId".into(), Value::Null);
                    row.insert("feedback".into(), Value::Null);
                    let parent = value(event, "parentToolCallId");
                    row.insert("parentId".into(), parent.clone());
                    row.insert("askedBy".into(), brief_of(&agents, &parent));
                    copy_if_present(&mut row, event, "execution");
                    items.push(Value::Object(row));
                }
            }
            EventKind::PlanResolved => {
                if let Some(at) = find(&items, "plan", &string(event, "proposalId")) {
                    items[at]["status"] = value(event, "status");
                    items[at]["actionId"] = value(event, "actionId");
                    items[at]["feedback"] = value(event, "feedback");
                }
            }
            EventKind::ThinkingProgress => {
                view.insert("thinkingTokens".into(), value(event, "tokens"));
            }
            EventKind::SessionMenu => {
                view.insert("menu".into(), menu(event));
            }
            EventKind::SessionPinned => {
                for field in ["permissionMode", "model", "effort", "collaborationMode"] {
                    if event.fields.get(field).is_some_and(|sent| !sent.is_null()) {
                        view.insert(field.into(), value(event, field));
                    }
                }
                if event.fields.get("clearModel").and_then(Value::as_bool) == Some(true) {
                    view.insert("model".into(), Value::Null);
                }
                if let Some(selected) = event.fields.get("configOptions").and_then(Value::as_array)
                {
                    if let Some(options) = view
                        .get_mut("menu")
                        .and_then(Value::as_object_mut)
                        .and_then(|menu| menu.get_mut("configOptions"))
                        .and_then(Value::as_array_mut)
                    {
                        for patch in selected {
                            if let Some(option) = options
                                .iter_mut()
                                .find(|option| option["id"] == patch["id"])
                            {
                                option["currentValue"] = patch["currentValue"].clone();
                            }
                        }
                    }
                }
            }
            EventKind::Cost => {
                view.insert("cost".into(), value(event, "cost"));
            }
            EventKind::Context => {
                view.insert(
                    "context".into(),
                    json!({"used": value(event, "used"), "window": value(event, "window")}),
                );
            }
            EventKind::Error => {
                view.insert("error".into(), value(event, "message"));
            }
            EventKind::ProviderMessage => {
                let signal = value(event, "signal");
                let id = signal["id"].as_str().unwrap_or_default();
                let source = signal["sourceMessageId"].as_str();
                items.retain(|row| {
                    !(row["kind"] == "provider_message" && row["id"] == id
                        || source
                            .is_some_and(|source| row["kind"] == "message" && row["id"] == source))
                });
                view.insert("error".into(), Value::Null);
                if signal["phase"] == "active" {
                    let mut row = item("provider_message", id.to_string());
                    row.insert("signal".into(), signal);
                    items.push(Value::Object(row));
                }
            }
            EventKind::Notice => {
                let mut row = item("notice", format!("notice-{seq}"));
                row.insert("text".into(), value(event, "text"));
                copy_if_present(&mut row, event, "family");
                copy_if_present(&mut row, event, "audience");
                items.push(Value::Object(row));
            }
            EventKind::TranscriptReset => {
                items.clear();
                agents.clear();
                beads.clear();
                bead_seen.clear();
                agent_at.clear();
            }
            EventKind::SessionEnded => {}
        }
    }

    view.insert("items".into(), Value::Array(items));
    view.insert("agents".into(), Value::Array(agents));
    view.insert("beads".into(), Value::Array(beads));
    Projection {
        view: Value::Object(view.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract_events() -> Vec<Event> {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/workbench-contract.json"))
                .unwrap();
        fixture["events"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(|event| serde_json::from_value(event).unwrap())
            .collect()
    }

    #[test]
    fn workbench_core_projection_folds_every_canonical_event_kind() {
        let events = contract_events();
        let before_reset = fold_all(&events[..events.len() - 1]);
        assert_eq!(before_reset.items().len(), 9);
        assert_eq!(before_reset.agents().len(), 1);
        assert_eq!(before_reset.view["lastSeq"], 37);
        assert_eq!(before_reset.view["beads"], json!(["bw-1"]));
        assert_eq!(before_reset.view["items"][0]["text"], "Hello");
        assert_eq!(before_reset.view["items"][2]["status"], "ok");

        let after_reset = fold_all(&events);
        assert!(after_reset.items().is_empty());
        assert!(after_reset.agents().is_empty());
        assert_eq!(after_reset.view["lastSeq"], 38);
        assert_eq!(after_reset.view["cost"]["total"], 30);
    }

    #[test]
    fn projection_treats_repeated_message_start_as_the_same_message() {
        let events = [1, 2].map(|seq| {
            serde_json::from_value(json!({
                "type":"message.started", "sessionId":"chat", "seq":seq,
                "at":"2026-08-31T00:00:00Z", "messageId":"answer", "role":"assistant"
            }))
            .unwrap()
        });
        let view = fold_all(&events);
        assert_eq!(view.items().len(), 1);
        assert_eq!(view.items()[0]["id"], "answer");
    }

    #[test]
    fn agent_accounting_is_monotone_and_late_final_usage_only_enriches() {
        let values = vec![
            json!({"type":"agent.started","sessionId":"chat","seq":1,"at":"2026-09-02T00:00:00Z","agentId":"child","toolCallId":"spawn","kind":"helper","what":"Audit","agentType":"reviewer","model":null}),
            json!({"type":"agent.progress","sessionId":"chat","seq":2,"at":"2026-09-02T00:00:12Z","agentId":"child","seconds":12,"tokens":900,"calls":4}),
            json!({"type":"agent.progress","sessionId":"chat","seq":3,"at":"2026-09-02T00:00:13Z","agentId":"child","seconds":2,"tokens":100,"calls":1}),
            json!({"type":"agent.finished","sessionId":"chat","seq":4,"at":"2026-09-02T00:00:14Z","agentId":"child","state":"done","seconds":0,"tokens":0,"calls":0,"model":null,"result":"Done"}),
            json!({"type":"agent.progress","sessionId":"chat","seq":5,"at":"2026-09-02T00:00:15Z","agentId":"child","seconds":10,"tokens":1000,"calls":3,"finalUsage":true}),
        ];
        let events = values
            .into_iter()
            .map(|value| serde_json::from_value(value).unwrap())
            .collect::<Vec<Event>>();
        let view = fold_all(&events);
        assert_eq!(view.agents()[0]["state"], "done");
        assert_eq!(view.agents()[0]["seconds"], 12);
        assert_eq!(view.agents()[0]["tokens"], 1000);
        assert_eq!(view.agents()[0]["calls"], 4);
        assert_eq!(view.agents()[0]["result"], "Done");
    }

    /// ACP announces a call before it knows what the call was given, so the
    /// durable record holds started calls whose `input` is null. The window
    /// the browser opens on must still say the field is an object: every
    /// reader of a row takes a key off it without asking (bw-t26l.20).
    #[test]
    fn a_call_announced_without_arguments_is_projected_with_none_rather_than_null() {
        let events = [
            json!({"type":"tool.started","sessionId":"chat","seq":1,"at":"2026-09-03T00:00:00Z",
                   "toolCallId":"call","name":"Read","title":"Read a file","parentToolCallId":null,
                   "input":Value::Null}),
            json!({"type":"tool.started","sessionId":"chat","seq":2,"at":"2026-09-03T00:00:01Z",
                   "toolCallId":"kept","name":"Read","title":"Read a file","parentToolCallId":null,
                   "input":{"file_path":"/w/a.rs"}}),
        ]
        .map(|value| serde_json::from_value::<Event>(value).unwrap());

        let view = fold_all(&events);

        assert_eq!(view.items()[0]["input"], json!({}));
        assert_eq!(view.items()[1]["input"], json!({"file_path":"/w/a.rs"}));
    }
}
