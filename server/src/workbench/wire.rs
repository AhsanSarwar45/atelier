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
            // The change has to be worked out before the text is cut. Cutting
            // first leaves the first four thousand characters of the file,
            // which for anything but a tiny edit is the top of the file and
            // not the part that changed — the app could then say nothing
            // truer than a character count. Hunks taken here survive the cut
            // and are smaller than the prefix they replace (bw-vl3q.1).
            //
            // Bounding runs on read as well as on write, and by the second
            // time the text is already cut; hunks worked out from a cut side
            // would be a worse answer than the ones already stored, so a diff
            // that has been summarised once is left alone.
            if !event.fields.contains_key("hunks") {
                let side = |field: &str| {
                    event
                        .fields
                        .get(field)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                };
                let (before, after) = (side("before"), side("after"));
                // A provider hands over the changed fragment and says where it
                // starts; numbering from one would point at the top of the file.
                let start = event
                    .fields
                    .get("line")
                    .and_then(Value::as_u64)
                    .filter(|line| *line > 0)
                    .unwrap_or(1) as usize;
                if !before.is_empty() || !after.is_empty() {
                    event
                        .fields
                        .extend(super::hunks::summarize(&before, &after, start));
                }
            }
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

    /// The whole point of taking the diff here: a file far past the string
    /// bound still delivers the lines that changed, and says how many.
    #[test]
    fn a_diff_past_the_bound_keeps_its_change_and_not_the_top_of_the_file() {
        let before: String = (1..=2000).map(|n| format!("line {n}\n")).collect();
        let after = before.replace("line 1900\n", "line 1900 changed\n");
        let mut diff = event(json!({
            "type":"diff","sessionId":"s","seq":0,"at":"now","toolCallId":"t",
            "path":"/a/big.tsx","before":before,"after":after
        }));
        bound_event(&mut diff);

        assert_eq!(diff.fields["added"], json!(1));
        assert_eq!(diff.fields["removed"], json!(1));
        assert_eq!(diff.fields["beforeLines"], json!(2000));
        let hunks = diff.fields["hunks"].as_array().unwrap();
        assert_eq!(hunks.len(), 1);
        let drawn = serde_json::to_string(&hunks[0]).unwrap();
        assert!(drawn.contains("line 1900 changed"), "{drawn}");
        // The text itself is still cut, and the change still got through.
        assert!(diff.fields["before"].as_str().unwrap().len() < 5_000);
    }

    /// A provider that sends the changed fragment says where it starts, and
    /// the hunks have to be numbered from there rather than from the top.
    #[test]
    fn a_fragment_is_numbered_from_where_the_provider_says_it_sits() {
        let mut diff = event(json!({
            "type":"diff","sessionId":"s","seq":0,"at":"now","toolCallId":"t",
            "path":"/a/notes.txt","before":"one\ntwo\n","after":"one\nTWO\n","line":400
        }));
        bound_event(&mut diff);

        assert_eq!(diff.fields["hunks"][0]["oldStart"], json!(400));
        assert_eq!(diff.fields["hunks"][0]["newStart"], json!(400));
    }

    /// Bounding runs again every time an event is read back. The second pass
    /// sees a before that was already cut, and must not replace good hunks
    /// with hunks of the top of the file.
    #[test]
    fn bounding_a_diff_twice_keeps_the_hunks_from_the_full_text() {
        let before: String = (1..=2000).map(|n| format!("line {n}\n")).collect();
        let after = before.replace("line 1900\n", "line 1900 changed\n");
        let mut diff = event(json!({
            "type":"diff","sessionId":"s","seq":0,"at":"now","toolCallId":"t",
            "path":"/a/big.tsx","before":before,"after":after
        }));
        bound_event(&mut diff);
        let once = diff.fields["hunks"].clone();
        bound_event(&mut diff);

        assert_eq!(diff.fields["hunks"], once);
        assert_eq!(diff.fields["added"], json!(1));
    }
}
