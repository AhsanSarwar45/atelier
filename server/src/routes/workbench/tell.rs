//! Telling a chat something as the owner's next message: a proposal's
//! answer (tasks), a grid draft's or an N/A request's (grids).

use super::WorkbenchState;
use serde_json::json;

/// Where a line Atelier sends into a chat on its own came from: its `kind`
/// (`workflow`, `task`, `proposal`, `grid`, `worker`, `limit`) and a short
/// `label` the chat shows for it. It travels with the line, while it waits
/// and onto the recorded message, so the chat draws every such line as one
/// automated message instead of guessing from its words.
pub(crate) fn from(kind: &str, label: impl Into<String>) -> serde_json::Value {
    json!({"kind": kind, "label": label.into()})
}

/// The first sentence of an answer, as its label when there is no shorter
/// one to give.
pub(super) fn first_sentence(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    match line.find(". ") {
        Some(end) => line[..=end].trim_end_matches('.').to_string(),
        None => line.trim_end_matches('.').to_string(),
    }
}

/// Send a line into a chat as the owner's next message: now when the chat is
/// between turns (waking it if it sleeps), held for the end of the turn when
/// it is in one — the same queue a message the owner holds waits in. A send
/// the chat refuses is held instead, so the answer is never lost. Says which
/// of the two it was.
pub(super) async fn tell_chat(state: &WorkbenchState, session: &str, text: String, from: serde_json::Value) -> Delivery {
    use crate::workbench::protocol::{Command, CommandKind};
    let command = |kind| Command {
        kind,
        fields: serde_json::Map::from_iter([
            ("sessionId".into(), json!(session)),
            ("text".into(), json!(text)),
            ("images".into(), json!([])),
            ("from".into(), from.clone()),
        ]),
    };
    let busy = state.registry.mid_turn(session).await.unwrap_or(false);
    let first = if busy { CommandKind::PromptHold } else { CommandKind::PromptSend };
    let Err(error) = state.registry.execute(&command(first)).await else {
        return if busy { Delivery::Queued } else { Delivery::Sent };
    };
    tracing::warn!(chat = session, %error, "an owner's answer could not be sent to its chat");
    if first == CommandKind::PromptSend {
        if let Err(error) = state.registry.execute(&command(CommandKind::PromptHold)).await {
            tracing::warn!(chat = session, %error, "an owner's answer could not be held for its chat either");
        }
    }
    Delivery::Queued
}

/// What became of a line told to a chat.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Delivery {
    /// Sent as the chat's next prompt.
    Sent,
    /// Waiting for the chat's turn to end.
    Queued,
}
