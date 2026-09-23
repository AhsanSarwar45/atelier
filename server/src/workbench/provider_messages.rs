//! The conditions this app knows how to draw, and nobody's words for them.
//!
//! What belongs here is provider-neutral by construction: the shape of a
//! condition, the standing it puts a chat in, the word the reader sees. What
//! does not is any reading of a particular kit's prose or of the free-form
//! `data` it hangs off an ACP error — that lives in `kit_words.rs`, which
//! takes a brand, and the test at the foot of this file keeps the two apart
//! (bw-d516).

use serde_json::{json, Value};

/// The same signal, raised from the protocol rather than from prose.
///
/// ACP has a code for this — `AuthRequired`, -32000, "Authentication is
/// required before this operation can be performed" (schema `v1/error.rs`).
/// Every path here read the words instead, so a provider that answered with
/// the code and a terse message came out the far end as "Provider
/// unavailable": indistinguishable from a broken install, with no sign-in
/// offered and no way back into the chat (bw-t26l.20).
pub fn needs_signing_in(detail: &str) -> Value {
    json!({
        "id":"condition:authentication", "kind":"authentication", "phase":"active",
        "severity":"blocking", "scope":"session",
        "detail":detail, "retryAt":Value::Null, "action":Value::Null,
    })
}

/// An ACP error as a sentence a reader can act on.
///
/// A JSON-RPC error is written for a caller: a code, a short message, and a
/// free-form `data` that carries whatever structure the far end wanted to
/// hand over. `Display` for the protocol's error type prints the message and
/// then the whole of `data`, pretty-printed, which is how a chat came to draw
/// `Resource not found: a22f34ef-...: { "uri": "a22f34ef-..." }` in red at the
/// foot of the screen — a sentence, an id nobody can use, and a JSON object,
/// none of it telling the reader what happened or what to do (bw-m15v.3).
///
/// So structure stays out. `data` reaches the reader only when it is itself a
/// sentence, which is what a provider puts there when it has more to say than
/// the message held; an object or a list is for whatever reads structure. And
/// the one condition the protocol names in a way the reader cares about gets
/// the app's own words rather than the wire's, because the wire's are the
/// code's name with an id after them.
pub fn in_plain_words(code: i32, message: &str, data: Option<&Value>) -> String {
    if code == RESOURCE_NOT_FOUND {
        return "The provider could not find something this chat pointed it at.".into();
    }
    let said = message.trim();
    match data
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|more| !more.is_empty())
    {
        Some(more) if said.is_empty() => more.into(),
        Some(more) if !more.contains(said) => format!("{said}: {more}"),
        Some(more) => more.into(),
        None => said.into(),
    }
}

/// ACP's own code for a thing that was asked for and is not there.
pub const RESOURCE_NOT_FOUND: i32 = -32002;

/// The one thing a chat cannot go on without, when it is the thing that is
/// gone. Said where the refusal answered an attempt to take up the chat's own
/// conversation again, rather than anything the conversation mentioned.
pub const NO_SUCH_CONVERSATION: &str =
    "The provider could not find this conversation. It was either cleared or \
     never written down.";

/// The same condition, survived rather than suffered: the chat is carrying on
/// somewhere the provider does not remember, and the reader should know its
/// memory starts here even though the screen still holds everything said.
pub const CONVERSATION_IS_GONE: &str =
    "The provider no longer has this conversation, so it carries on in a fresh \
     one. Everything said above is still here, but the provider cannot read it.";

/// What a chat is doing, in the words of the condition standing over it.
///
/// The server publishes this as a canonical `session.state` event. Live
/// subscribers and restored snapshots consume that same event; the browser
/// never reconstructs state from a notice or restores an earlier activity.
pub fn standing(signal: &Value) -> (&'static str, &'static str) {
    let state = match signal["severity"].as_str() {
        Some("blocking") => "stopped",
        Some("info") | Some("warning") => "running_tool",
        _ => "errored",
    };
    let word = match signal["kind"].as_str().unwrap_or_default() {
        "usage_limit" => "Limit reached",
        "rate_limit" => "Rate limited",
        "authentication" => "Sign-in required",
        "authorization" => "Not allowed",
        "service_unavailable" => "Provider unavailable",
        "network" => "Connection lost",
        "provider_error" => "Provider failed",
        "retrying" => "Retrying",
        "interrupted" => "Interrupted",
        "model_unavailable" => "Model unavailable",
        "context_limit" => "Context full",
        "refusal" => "Declined",
        "turn_limit" => "Stopped short",
        "runtime_stopped" => "Runtime stopped",
        _ => "Provider problem",
    };
    (state, word)
}

/// Which of two conditions standing at once the chat wears.
///
/// The same order the screen sorts by: what stops the chat outranks what only
/// spoiled the turn.
pub fn loudness(signal: &Value) -> u8 {
    match signal["severity"].as_str() {
        Some("blocking") => 4,
        Some("error") => 3,
        Some("warning") => 2,
        _ => 1,
    }
}

pub fn resolved(kind: &str) -> Value {
    json!({"id":format!("condition:{kind}"),"kind":kind,"phase":"resolved","severity":"info","scope":"turn"})
}

#[cfg(test)]
mod tests {
    /// Nothing in here is written in a kit's language.
    ///
    /// The manager, on the fix that first put a vendor's phrasing in this
    /// file: "you need to use proper acp integration, don't put any provider
    /// specific stuff". This is that line, drawn where it can be checked. A
    /// reading that needs a kit's habits needs a brand to go with it, and
    /// `kit_words.rs` is where both live.
    #[test]
    fn native_workbench_services_the_neutral_core_speaks_no_kit_s_language() {
        let source = include_str!("provider_messages.rs");
        let body = source.split("#[cfg(test)]").next().unwrap().to_lowercase();
        for word in [
            "claude",
            "codex",
            "anthropic",
            "openai",
            "gemini",
            "goose",
            "copilot",
            "you've hit",
            "try again at",
            "rate_limit_info",
            "resetsat",
        ] {
            assert!(!body.contains(word), "the neutral core says `{word}`");
        }
    }
}
