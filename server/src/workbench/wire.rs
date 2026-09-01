//! Shared storage and delivery limits for provider-owned payloads.

use super::protocol::{Event, EventKind};
use serde_json::Value;

const KEPT: usize = 4_000;
const COMMAND_KEPT: usize = 20_000;
const DEPTH: usize = 4;

fn cut(text: &str, kept: usize) -> String {
    let Some((at, _)) = text.char_indices().nth(kept) else {
        return text.to_string();
    };
    let omitted = text[at..].chars().count();
    format!("{}\n… and {omitted} more characters", &text[..at])
}

fn trim(value: &mut Value, depth: usize, key: &str) {
    match value {
        Value::String(text) => {
            *text = cut(text, if key == "command" { COMMAND_KEPT } else { KEPT })
        }
        Value::Array(values) if depth > 0 => {
            for value in values {
                trim(value, depth - 1, key)
            }
        }
        Value::Object(values) if depth > 0 => {
            for (key, value) in values {
                trim(value, depth - 1, key)
            }
        }
        _ => {}
    }
}

/// Bound the fields whose native provider shapes are intentionally unbounded.
/// This is applied once by the durable actor for every provider and delivery.
pub fn bound_event(event: &mut Event) {
    match event.kind {
        EventKind::ToolStarted => {
            if let Some(input) = event.fields.get_mut("input") {
                trim(input, DEPTH, "")
            }
        }
        EventKind::ToolCompleted => {
            if let Some(output) = event.fields.get_mut("output") {
                trim(output, 0, "")
            }
        }
        EventKind::Diff => {
            for field in ["before", "after"] {
                if let Some(value) = event.fields.get_mut(field) {
                    trim(value, 0, field)
                }
            }
        }
        EventKind::AgentFinished => {
            if let Some(result) = event.fields.get_mut("result") {
                trim(result, 0, "")
            }
        }
        EventKind::Note => {
            // Unknown provider notifications are intentionally retained for
            // forward compatibility, but they must not turn one cumulative
            // diagnostic payload into an unbounded durable event.
            for field in ["text", "body"] {
                if let Some(value) = event.fields.get_mut(field) {
                    trim(value, DEPTH, "")
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(value: Value) -> Event {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn shared_wire_bounds_nested_inputs_outputs_diffs_and_agent_results() {
        let huge = "x".repeat(100_000);
        let mut started = event(
            json!({"type":"tool.started","sessionId":"s","seq":0,"at":"now","toolCallId":"t","name":"Write","input":{"nested":{"body":huge},"command":"c".repeat(30_000)}}),
        );
        bound_event(&mut started);
        assert!(
            started.fields["input"]["nested"]["body"]
                .as_str()
                .unwrap()
                .len()
                < 5_000
        );
        assert!(started.fields["input"]["command"].as_str().unwrap().len() < 21_000);
        for (kind, field) in [("tool.completed", "output"), ("agent.finished", "result")] {
            let mut value = event(
                json!({"type":kind,"sessionId":"s","seq":0,"at":"now","toolCallId":"t","agentId":"a",field:huge}),
            );
            bound_event(&mut value);
            assert!(value.fields[field].as_str().unwrap().len() < 5_000);
        }
    }

    #[test]
    fn shared_wire_bounds_unknown_provider_notes() {
        let huge = "x".repeat(100_000);
        let mut note = event(json!({
            "type":"note","sessionId":"s","seq":0,"at":"now",
            "noteId":"n","rank":"detail","kind":"future/event",
            "text":huge,"body":{"nested":"y".repeat(100_000)}
        }));
        bound_event(&mut note);
        assert!(note.fields["text"].as_str().unwrap().len() < 5_000);
        assert!(note.fields["body"]["nested"].as_str().unwrap().len() < 5_000);
    }
}
