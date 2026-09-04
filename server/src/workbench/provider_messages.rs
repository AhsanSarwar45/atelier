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

/// What a chat is doing, in the words of the condition standing over it.
///
/// Twin of `providerMessageStatus` (`src/workbench/provider-messages.ts`), and
/// it has to be a twin: the live screen reads the condition and says this for
/// itself, but a chat opened fresh is read off the state the driver wrote down,
/// and the two must not disagree about the same chat.
///
/// They did. Every failed turn published `errored` / `Failed` whatever had gone
/// wrong, so a chat stopped by its own session limit — with the limit notice on
/// the page saying so, and the time it lifts beside it — sat in the list as
/// `Failed`, which reads as a chat that broke rather than one that is waiting
/// (bw-d516). A failure nothing can name still says `Failed`, because there
/// that is the truth.
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
            "claude", "codex", "anthropic", "openai", "gemini", "goose", "copilot",
            "you've hit", "try again at", "rate_limit_info", "resetsat",
        ] {
            assert!(!body.contains(word), "the neutral core says `{word}`");
        }
    }
}
