//! Lossless Rust envelopes for the existing workbench wire protocol.
//!
//! The discriminator is typed so an unknown command, event, or app-wide frame
//! is refused at the Rust boundary. Payload fields stay in a JSON map during
//! the incremental port: this preserves old records byte-for-byte in meaning
//! and lets each vertical slice replace its map with a typed payload without
//! changing the browser contract all at once.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub fn replay_event_id(value: &Value) -> String {
    format!("history-{:x}", Sha256::digest(value.to_string().as_bytes()))
}

/// Stable identity for one complete provider-record normalization recipe.
pub fn record_event_id(value: &Value) -> String {
    record_event_id_at(value, super::store::IMPORT_RECIPE)
}

/// Stable identity for a normalized provider record at both replay and live
/// ingestion boundaries. A provider-specific decoder may advance its recipe,
/// but delivery mode must never mint a second identity for the same event.
pub fn provider_record_event_id(provider: &str, value: &Value) -> String {
    record_event_id_at(value, super::store::import_recipe(provider))
}

pub fn record_event_id_at(value: &Value, recipe: i64) -> String {
    format!("r{}:{}", recipe, replay_event_id(value))
}

macro_rules! wire_kinds {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant),+
        }
    };
}

wire_kinds!(CommandKind {
    AgentFilesList => "agent-files.list",
    AgentFilesRead => "agent-files.read",
    ProviderDefaultsRead => "provider-defaults.read",
    ProviderDefaultsWrite => "provider-defaults.write",
    ProvidersList => "providers.list",
    ProviderAuthenticate => "provider.authenticate",
    ProviderLogout => "provider.logout",
    SessionStart => "session.start",
    PromptSend => "prompt.send",
    AskAnswer => "ask.answer",
    QuestionAnswer => "question.answer",
    PlanRespond => "plan.respond",
    SessionStop => "session.stop",
    SessionClose => "session.close",
    SessionDelete => "session.delete",
    SessionFork => "session.fork",
    AgentStop => "agent.stop",
    AgentPark => "agent.park",
    AgentSay => "agent.say",
    SessionMode => "session.mode",
    SessionModel => "session.model",
    SessionEffort => "session.effort",
    SessionCollaborationMode => "session.collaboration-mode",
    SessionConfigOption => "session.config-option",
    SessionOpen => "session.open",
    SessionResume => "session.resume",
});

wire_kinds!(EventKind {
    SessionStarted => "session.started",
    SessionState => "session.state",
    SessionMenu => "session.menu",
    SessionPinned => "session.pinned",
    SessionEnded => "session.ended",
    MessageStarted => "message.started",
    TextDelta => "text.delta",
    ThinkingDelta => "thinking.delta",
    ThinkingProgress => "thinking.progress",
    MessageCompleted => "message.completed",
    MessageRetracted => "message.retracted",
    ToolStarted => "tool.started",
    ToolCompleted => "tool.completed",
    ToolProgress => "tool.progress",
    AgentStarted => "agent.started",
    AgentProgress => "agent.progress",
    AgentFinished => "agent.finished",
    AgentRelayed => "agent.relayed",
    AgentIdentified => "agent.identified",
    Diff => "diff",
    Todo => "todo",
    Image => "image",
    ImageCompare => "image.compare",
    Widget => "widget",
    AskPermission => "ask.permission",
    AskResolved => "ask.resolved",
    QuestionRequested => "question.requested",
    QuestionResolved => "question.resolved",
    PlanProposed => "plan.proposed",
    PlanResolved => "plan.resolved",
    Cost => "cost",
    Context => "context",
    LinkBead => "link.bead",
    ReportAvailable => "report.available",
    Error => "error",
    ProviderMessage => "provider.message",
    Notice => "notice",
    Note => "note",
    TranscriptReset => "transcript.reset",
});

wire_kinds!(WatchFrameKind {
    Snapshot => "snapshot",
    Opened => "opened",
    Running => "running",
    Outside => "outside",
    Usage => "usage",
    Event => "event",
});

/// A browser command posted to `/api/workbench/command`.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Command {
    #[serde(rename = "type")]
    pub kind: CommandKind,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl Command {
    /// One field of a command, or null when the browser did not send it.
    ///
    /// `fields["takeover"]` reads well and panics: `serde_json::Map` indexing
    /// is defined to panic on a key that is not there, unlike `Value` indexing,
    /// which answers null. Every field here comes off the wire, so an omitted
    /// optional field — an older tab, a command written by hand — killed the
    /// worker thread handling it and hung up the socket mid-request. The
    /// browser saw a dropped connection where the answer should have been
    /// (bw-t26l.22).
    pub fn at(&self, field: &str) -> &Value {
        const NOTHING: &Value = &Value::Null;
        self.fields.get(field).unwrap_or(NOTHING)
    }
}

/// One durable event in a chat's append-only event stream.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: EventKind,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

/// One frame sent on the app-wide live stream.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WatchFrame {
    pub kind: WatchFrameKind,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/workbench-contract.json")).unwrap()
    }

    fn round_trip<T>(rows: &[Value])
    where
        T: for<'de> Deserialize<'de> + Serialize,
    {
        for source in rows {
            let parsed: T = serde_json::from_value(source.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), *source);
        }
    }

    #[test]
    fn workbench_wire_contract_round_trips_every_browser_command() {
        let fixture = fixture();
        round_trip::<Command>(fixture["commands"].as_array().unwrap());
    }

    #[test]
    fn workbench_wire_contract_round_trips_every_server_event() {
        let fixture = fixture();
        round_trip::<Event>(fixture["events"].as_array().unwrap());
    }

    #[test]
    fn workbench_wire_contract_round_trips_every_app_wide_frame() {
        let fixture = fixture();
        round_trip::<WatchFrame>(fixture["watchFrames"].as_array().unwrap());
    }

    #[test]
    fn workbench_wire_contract_refuses_unknown_discriminators() {
        assert!(serde_json::from_value::<Command>(serde_json::json!({
            "type": "session.explodes",
            "sessionId": "session-1"
        }))
        .is_err());
        assert!(serde_json::from_value::<Event>(serde_json::json!({
            "type": "message.vanishes",
            "seq": 1,
            "sessionId": "session-1",
            "at": "2026-08-30T00:00:00.000Z"
        }))
        .is_err());
        assert!(serde_json::from_value::<WatchFrame>(serde_json::json!({
            "kind": "mystery"
        }))
        .is_err());
    }
}
