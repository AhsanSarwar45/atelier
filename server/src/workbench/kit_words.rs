//! What a kit says for itself, where ACP gives it nothing to say it with.
//!
//! ACP's whole vocabulary for a turn that went wrong is a JSON-RPC code and
//! five stop reasons (schema v2, `error.rs` and `agent.rs`). There is no usage
//! limit in it, no rate limit and no retry — so a kit with one of those to
//! report has nowhere to put it but `data` on the error, which the spec leaves
//! implementation-defined, and its own prose.
//!
//! Reading either is a guess about one vendor's habits, and it has no business
//! in the provider-neutral core: `provider_messages.rs` describes the
//! conditions this app knows how to draw, and it must stay clear of anybody's
//! phrasing (bw-d516). This is the other side of that line, and everything
//! here takes a brand so it is never unclear whose words are being read.
//!
//! One thing worth saying plainly, because it cuts against the obvious rule.
//! Structure should beat prose, and here it does not always: the Claude kit
//! sends `data: {"errorKind": "rate_limit"}` beside the sentence "You've hit
//! your session limit", and the sentence is the more exact of the two. So the
//! kit's own words are read first and `data` is a floor under them, rather
//! than the other way about.

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
/// The openings each kit writes in front of that time.
///
/// A kit nobody has read yet gets both, because neither turns up in ordinary
/// prose and a missing clause costs the reader more than a stray one.
fn openings(brand: &str) -> &'static [&'static str] {
    match brand {
        "claude" => &["resets"],
        "codex" => &["try again at", "resets"],
        _ => &["resets", "try again at"],
    }
}

fn resets_at(brand: &str, flat: &str) -> Option<String> {
    let at = openings(brand)
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

/// The condition a kit's own sentence names, where ACP named nothing.
pub fn condition(brand: &str, text: &str) -> Option<Value> {
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
        "resets": resets_at(brand, &flat),
    }))
}


/// A Claude allowance packet, read as the condition it reports.
///
/// The one path that could ever set a real `retryAt`: this kit sends the reset
/// as an epoch second, where the sentence beside it names a wall clock. It is
/// unreached — nothing calls it but its own test — and it is kept rather than
/// deleted because the packet is still what the kit sends and this is still
/// the right reading of it (bw-d516).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_workbench_services_provider_prose_becomes_a_semantic_condition() {
        let signal = condition("claude", "HTTP 429: too many requests").unwrap();
        assert_eq!(signal["kind"], "rate_limit");
        assert_eq!(signal["id"], "condition:rate_limit");
    }

    /// Every usage limit in the owner's own record arrived as prose naming a
    /// wall clock and none of them carried an instant, so prose is the only
    /// place the time is written down (bw-gao7).
    #[test]
    fn native_workbench_services_a_limit_carries_the_time_it_lifts() {
        let signal = condition("claude", "You've hit your session limit · resets 9pm (Asia/Karachi)").unwrap();
        assert_eq!(signal["kind"], "usage_limit");
        assert_eq!(signal["resets"], "resets 9pm (Asia/Karachi)");

        // What the kit adds after the time is a separate clause, not part of it.
        assert_eq!(
            condition("claude", "You've hit your weekly limit · resets Aug 23, 1pm · progress saved").unwrap()
                ["resets"],
            "resets Aug 23, 1pm"
        );

        // Codex writes the other opening, and ends the sentence with a stop.
        assert_eq!(
            condition(
                "codex",
                "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to \
                 purchase more credits or try again at Sep 3rd, 2036 9:25 PM."
            )
            .unwrap()["resets"],
            "try again at Sep 3rd, 2036 9:25 PM"
        );

        // A condition that names no time says so, rather than inventing one.
        assert_eq!(condition("claude", "HTTP 429: too many requests").unwrap()["resets"], Value::Null);
    }

    /// A kit is read in its own words, not in another kit's.
    ///
    /// Codex ends its sentence with `try again at …`; Claude never writes that
    /// opening, and a reading that accepts it from anybody is a reading that
    /// can pick the clause out of an answer merely discussing one (bw-d516).
    #[test]
    fn native_workbench_services_each_kit_is_read_in_its_own_words() {
        let said = "You've hit your session limit · try again at 9pm";
        assert_eq!(condition("codex", said).unwrap()["resets"], "try again at 9pm");
        assert_eq!(condition("claude", said).unwrap()["resets"], Value::Null);
        // And a kit nobody has read yet is given both, rather than neither.
        assert_eq!(condition("goose", said).unwrap()["resets"], "try again at 9pm");
    }

    #[test]
    fn native_workbench_services_open_allowance_resolves_the_stable_condition() {
        let signal =
            allowance(&json!({"rate_limit_info":{"status":"allowed","rateLimitType":"weekly"}}));
        assert_eq!(signal["id"], "usage:weekly");
        assert_eq!(signal["phase"], "resolved");
    }
}
