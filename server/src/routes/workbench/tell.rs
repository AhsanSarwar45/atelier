//! Telling a chat something as the owner's next message: a proposal's
//! answer (tasks), a grid draft's or an N/A request's (grids).

use super::WorkbenchState;
use serde_json::json;

/// Send a line into a chat as the owner's next message: now when the chat is
/// between turns (waking it if it sleeps), held for the end of the turn when
/// it is in one — the same queue a message the owner holds waits in. A send
/// the chat refuses is held instead, so the answer is never lost.
pub(super) async fn tell_chat(state: &WorkbenchState, session: &str, text: String) {
    use crate::workbench::protocol::{Command, CommandKind};
    let command = |kind| Command {
        kind,
        fields: serde_json::Map::from_iter([
            ("sessionId".into(), json!(session)),
            ("text".into(), json!(text)),
            ("images".into(), json!([])),
        ]),
    };
    let busy = state.registry.mid_turn(session).await.unwrap_or(false);
    let first = if busy { CommandKind::PromptHold } else { CommandKind::PromptSend };
    let Err(error) = state.registry.execute(&command(first)).await else { return };
    tracing::warn!(chat = session, %error, "an owner's answer could not be sent to its chat");
    if first == CommandKind::PromptSend {
        if let Err(error) = state.registry.execute(&command(CommandKind::PromptHold)).await {
            tracing::warn!(chat = session, %error, "an owner's answer could not be held for its chat either");
        }
    }
}
