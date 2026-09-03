//! Provider prose and structured allowance packets translated into WBP facts.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

fn has_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

/// Where an ASCII needle starts, whatever case it was written in.
///
/// Over bytes rather than over a lowercased copy: lowercasing can change a
/// string's length, and an index taken from the copy can land inside a
/// character of the original.
fn found(haystack: &str, needle: &str) -> Option<usize> {
    let (bytes, needle) = (haystack.as_bytes(), needle.as_bytes());
    (0..=bytes.len().checked_sub(needle.len())?)
        .find(|&at| haystack.is_char_boundary(at) && bytes[at..at + needle.len()].eq_ignore_ascii_case(needle))
}

/// The provider's own words for when the condition lifts, quoted as it wrote
/// them.
///
/// Its literal, over every one of these in the owner's own record: `You've hit
/// your session limit · resets 9pm (Asia/Karachi)`, with a date in front of the
/// time when the wait needs one and ` · progress saved` after it when the turn
/// was kept. Codex writes the other opening: `… or try again at Sep 3rd, 2036
/// 9:25 PM.`
///
/// Quoted rather than parsed into an instant. Recovering one would mean
/// inventing a date and resolving a zone named in brackets, and a notice that
/// names the wrong hour is worse than one that names none — the same reading
/// `chat-state.ts` already takes for the status chip. `retryAt` stays for the
/// providers that send a real instant; this is what the rest have to offer, and
/// without it the notice said only that a limit was hit and never when it lifts
/// (bw-gao7).
fn resets_at(flat: &str) -> Option<String> {
    let at = ["resets", "try again at"]
        .iter()
        .filter_map(|opening| found(flat, opening))
        .min()?;
    // To the next `·` and no further: what follows one is a separate clause the
    // kit adds, not part of the time.
    let clause = flat[at..]
        .split('·')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .trim();
    (!clause.is_empty()).then(|| clause.to_string())
}

pub fn from_text(text: &str) -> Option<Value> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = flat.to_lowercase();
    let kind = if has_any(&lower, &["usage limit", "out of credits"])
        || ((lower.contains("hit") || lower.contains("reached"))
            && has_any(&lower, &["usage", "session", "weekly"])
            && lower.contains("limit"))
    {
        "usage_limit"
    } else if has_any(
        &lower,
        &[
            "sign in",
            "sign-in",
            "signin",
            "log in",
            "login",
            "authentication",
            "unauthenticated",
            "invalid api key",
        ],
    ) {
        "authentication"
    } else if has_any(
        &lower,
        &[
            "service unavailable",
            "temporarily unavailable",
            "overloaded",
        ],
    ) {
        "service_unavailable"
    } else if has_any(
        &lower,
        &[
            "network",
            "connection failed",
            "connection lost",
            "connection refused",
            "timed out",
            "timeout",
            "dns",
        ],
    ) {
        "network"
    } else if lower.contains("model ")
        && has_any(&lower, &["unavailable", "not found", "not supported"])
    {
        "model_unavailable"
    } else if has_any(
        &lower,
        &[
            "context window",
            "context length",
            "context limit",
            "too many tokens",
        ],
    ) {
        "context_limit"
    } else if has_any(&lower, &["rate limit", "too many requests", "http 429"]) {
        "rate_limit"
    } else {
        return None;
    };
    let blocking = matches!(kind, "usage_limit" | "authentication");
    Some(json!({
        "id": if kind == "usage_limit" { "usage:session".into() } else { format!("condition:{kind}") },
        "kind": kind, "phase":"active",
        "severity": if blocking { "blocking" } else { "error" },
        "scope": if blocking { "session" } else { "turn" },
        "detail": flat, "retryAt": Value::Null, "action": Value::Null,
        "resets": resets_at(&flat),
    }))
}

pub fn allowance(message: &Value) -> Value {
    let info = &message["rate_limit_info"];
    let state = if info["errorCode"] == "credits_required" {
        "credits_required"
    } else {
        info["status"].as_str().unwrap_or("allowed")
    };
    let blocked = state != "allowed" || info["overageStatus"] == "rejected";
    let window = info["rateLimitType"].as_str().unwrap_or("session");
    let retry = info["resetsAt"]
        .as_i64()
        .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0).map(|at| at.to_rfc3339()));
    json!({
        "id":format!("usage:{window}"), "kind":"usage_limit",
        "phase":if blocked{"active"}else{"resolved"},
        "severity":if blocked{"blocking"}else{"info"}, "scope":"session",
        "retryAt":retry, "detail":if blocked{message.clone()}else{Value::Null}
    })
}

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

pub fn resolved(kind: &str) -> Value {
    json!({"id":format!("condition:{kind}"),"kind":kind,"phase":"resolved","severity":"info","scope":"turn"})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_workbench_services_provider_prose_becomes_a_semantic_condition() {
        let signal = from_text("HTTP 429: too many requests").unwrap();
        assert_eq!(signal["kind"], "rate_limit");
        assert_eq!(signal["id"], "condition:rate_limit");
    }

    /// Every usage limit in the owner's own record arrived as prose naming a
    /// wall clock and none of them carried an instant, so prose is the only
    /// place the time is written down (bw-gao7).
    #[test]
    fn native_workbench_services_a_limit_carries_the_time_it_lifts() {
        let signal = from_text("You've hit your session limit · resets 9pm (Asia/Karachi)").unwrap();
        assert_eq!(signal["kind"], "usage_limit");
        assert_eq!(signal["resets"], "resets 9pm (Asia/Karachi)");

        // What the kit adds after the time is a separate clause, not part of it.
        assert_eq!(
            from_text("You've hit your weekly limit · resets Aug 23, 1pm · progress saved").unwrap()
                ["resets"],
            "resets Aug 23, 1pm"
        );

        // Codex writes the other opening, and ends the sentence with a stop.
        assert_eq!(
            from_text(
                "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to \
                 purchase more credits or try again at Sep 3rd, 2036 9:25 PM."
            )
            .unwrap()["resets"],
            "try again at Sep 3rd, 2036 9:25 PM"
        );

        // A condition that names no time says so, rather than inventing one.
        assert_eq!(from_text("HTTP 429: too many requests").unwrap()["resets"], Value::Null);
    }

    #[test]
    fn native_workbench_services_open_allowance_resolves_the_stable_condition() {
        let signal =
            allowance(&json!({"rate_limit_info":{"status":"allowed","rateLimitType":"weekly"}}));
        assert_eq!(signal["id"], "usage:weekly");
        assert_eq!(signal["phase"], "resolved");
    }
}
