//! Refuse a turn that explicitly leaves the work for another session.
//!
//! This is the native form of `machinery/hooks/completion-gate.py`. Joined
//! projects name the gate through `atelier hook completion-gate.py`, so the
//! short-circuit here lets that hook keep working on a machine with no Python.

use serde_json::Value;
use std::io::Read;

pub const GATE: &str = "completion-gate";

const DEFERRALS: &[&str] = &[
    "future agent",
    "future session",
    "follow-up session",
    "left for later",
    "TODO for later",
    "deferred to a later",
    "deferred to a next",
    "deferred to the later",
    "deferred to the next",
    "in a later session",
    "a future pass will",
    "next session will",
    "next session should",
];

pub fn is_ours(name: &str) -> bool {
    name == GATE || name == "completion-gate.py"
}

pub fn run() -> i32 {
    let mut heard = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut heard) {
        eprintln!("{error}");
        return 1;
    }
    match answer(&heard) {
        Ok(said) => {
            print!("{said}");
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn answer(heard: &str) -> Result<String, String> {
    let data: Value = serde_json::from_str(heard).map_err(|error| error.to_string())?;
    if truthy(data.get("stop_hook_active")) {
        return Ok(String::new());
    }
    let Some(message) = data
        .get("last_assistant_message")
        .filter(|value| truthy(Some(*value)))
        .and_then(Value::as_str)
    else {
        return Ok(String::new());
    };
    let Some(found) = deferral(message) else {
        return Ok(String::new());
    };
    let reason = format!(
        "Reply defers work (\"{found}\"). Never flag work for a future agent or session: do it now, or state the concrete blocker and what input is needed."
    );
    let reason = serde_json::to_string(&reason).map_err(|error| error.to_string())?;
    Ok(format!(
        "{{\"decision\": \"block\", \"reason\": {reason}}}\n"
    ))
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64() != Some(0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(value)) => !value.is_empty(),
        Some(Value::Object(value)) => !value.is_empty(),
    }
}

fn deferral(message: &str) -> Option<&str> {
    for (start, _) in message.char_indices() {
        if !boundary_before(message, start) {
            continue;
        }
        for phrase in DEFERRALS {
            let end = start + phrase.len();
            let Some(candidate) = message.get(start..end) else {
                continue;
            };
            if candidate.eq_ignore_ascii_case(phrase) && boundary_after(message, end) {
                return Some(candidate);
            }
        }
    }
    None
}

fn boundary_before(value: &str, at: usize) -> bool {
    value[..at].chars().next_back().is_none_or(|ch| !word(ch))
}

fn boundary_after(value: &str, at: usize) -> bool {
    value[at..].chars().next().is_none_or(|ch| !word(ch))
}

fn word(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_gate_refuses_only_explicit_deferral_language() {
        assert_eq!(
            answer(r#"{"last_assistant_message":"I will leave this for a Future Session."}"#)
                .unwrap(),
            "{\"decision\": \"block\", \"reason\": \"Reply defers work (\\\"Future Session\\\"). Never flag work for a future agent or session: do it now, or state the concrete blocker and what input is needed.\"}\n"
        );
        assert_eq!(
            answer(r#"{"last_assistant_message":"The session model is documented."}"#)
                .unwrap(),
            ""
        );
        assert_eq!(
            answer(r#"{"stop_hook_active":true,"last_assistant_message":"left for later"}"#)
                .unwrap(),
            ""
        );
    }

}
