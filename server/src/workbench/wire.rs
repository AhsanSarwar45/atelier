//! Shared storage and delivery limits for provider-owned payloads.

use super::protocol::{Event, EventKind};
use base64::Engine;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

/// Where pictures are kept once they leave the conversation, set once at start.
///
/// Unset — a test, or a tool that never serves pictures — and pictures stay in
/// the conversation as they came.
static PICTURE_STORE: OnceLock<PathBuf> = OnceLock::new();

/// Below this, a picture costs less inline than the request that would fetch it.
const INLINE_PICTURE_KEPT: usize = 8 * 1024;

/// Name the store pictures are moved into. Called once, by the app at start.
pub fn keep_pictures_in(directory: PathBuf) {
    let _ = PICTURE_STORE.set(directory);
}

/// A picture as bytes becomes a picture as a name.
///
/// A screenshot is most of a conversation's weight, and base64 does not
/// compress, so every snapshot carried every picture in full — to a phone on
/// Wi-Fi, again on every open. Kept in the content-addressed store instead, it
/// is fetched once through `/api/presentation-assets`, cached for good, and
/// only when it is drawn. The shape goes with the name, so the page can hold
/// the picture's place before it arrives.
fn keep_pictures(value: &mut Value, depth: usize, store: &Path) {
    match value {
        Value::Object(fields) => {
            if let Some(kept) = fields
                .get("dataUrl")
                .and_then(Value::as_str)
                .and_then(|url| kept_picture(url, store))
            {
                let (asset, size, shape) = kept;
                fields.insert("dataUrl".into(), Value::String(String::new()));
                fields.insert("asset".into(), Value::String(asset));
                fields.entry("size").or_insert(size.into());
                if let Some(shape) = shape {
                    if !fields.contains_key("width") || !fields.contains_key("height") {
                        fields.insert("width".into(), shape.width.into());
                        fields.insert("height".into(), shape.height.into());
                    }
                }
                return;
            }
            if depth > 0 {
                for value in fields.values_mut() {
                    keep_pictures(value, depth - 1, store)
                }
            }
        }
        Value::Array(values) if depth > 0 => {
            for value in values {
                keep_pictures(value, depth - 1, store)
            }
        }
        _ => {}
    }
}

fn kept_picture(
    url: &str,
    store: &Path,
) -> Option<(String, usize, Option<super::media::Dimensions>)> {
    if url.len() < INLINE_PICTURE_KEPT {
        return None;
    }
    let (head, data) = url.strip_prefix("data:")?.split_once(',')?;
    if !head.ends_with(";base64") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .ok()?;
    // Anything the store will not take — too big, not a picture it knows —
    // stays as it came rather than being lost.
    let asset = super::media::import_image(&bytes, "picture", store).ok()?;
    Some((asset, bytes.len(), super::media::picture_dimensions(&bytes)))
}

/// Cards the task, grid and task types commands answered an agent with, by
/// chat, until that chat's next tool call completes. The chat draws a card
/// from the command's printed output, which an agent can pipe away
/// (`| grep`, `> /dev/null`); the call that ran it still gets its card.
static PRINTED_CARDS: Mutex<Vec<PrintedCard>> = Mutex::new(Vec::new());

struct PrintedCard {
    session: String,
    at: chrono::DateTime<chrono::Utc>,
    card: Value,
}

/// A card kept this long with no call to draw it at is dropped.
const PRINTED_CARD_KEPT: chrono::TimeDelta = chrono::TimeDelta::minutes(10);

/// Keeps the cards in `widget`, the fenced text a command prints, for the
/// chat `session`'s next completed tool call.
pub fn printed_card(session: &str, widget: &str) {
    let cards = super::media::widget_specs(widget);
    if cards.is_empty() {
        return;
    }
    let at = chrono::Utc::now();
    let mut kept = PRINTED_CARDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    kept.retain(|card| at - card.at < PRINTED_CARD_KEPT);
    kept.extend(cards.into_iter().map(|card| PrintedCard { session: session.to_string(), at, card }));
}

/// The cards printed for the chat a completed call belongs to, taken so no
/// later call draws them again. A call that finished before a card was
/// printed (an old one read back from the store) takes nothing.
fn take_printed_cards(event: &Event) -> Vec<Value> {
    let Some(session) = event.fields.get("sessionId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let finished = event
        .fields
        .get("at")
        .and_then(Value::as_str)
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&chrono::Utc));
    let mut kept = PRINTED_CARDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut taken = Vec::new();
    kept.retain(|card| {
        // Event times may be cut to the second; allow for that.
        let before = finished.is_some_and(|finished| finished < card.at - chrono::TimeDelta::seconds(2));
        if card.session != session || before {
            return true;
        }
        taken.push(card.card.clone());
        false
    });
    taken
}

/// Bound the fields whose native provider shapes are intentionally unbounded.
/// This is applied once by the durable actor for every provider and delivery.
pub fn bound_event(event: &mut Event) {
    if let Some(store) = PICTURE_STORE.get() {
        for value in event.fields.values_mut() {
            keep_pictures(value, DEPTH, store);
        }
    }
    match event.kind {
        EventKind::ToolStarted => {
            if let Some(input) = event.fields.get_mut("input") {
                trim(input, DEPTH, "")
            }
        }
        EventKind::ToolCompleted => {
            // What the presenter printed is read before the output is cut, so
            // a large table is not lost to its missing closing fence. The chat
            // draws these at the call itself: an agent that forgot to paste
            // the block into its reply — a quarter of every block presented
            // (bw-yh4nu) — no longer leaves the reader without the widget. As
            // with a diff's hunks, the second bounding finds the field set.
            //
            // Codex hands its output back as JSON (`formatted_output`), which
            // escapes the fence; the terminal's own copy is the plain text.
            if !event.fields.contains_key("presented") {
                let printed = [
                    event.fields.get("output"),
                    event.fields.get("terminal").and_then(|run| run.get("output")),
                ];
                let presented = printed
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|text| text.contains("```atelier-widget"))
                    .map(super::media::widget_specs)
                    .find(|found| !found.is_empty());
                // Taken either way: a card the output kept is the same card.
                let printed = take_printed_cards(event);
                if let Some(presented) = presented.or_else(|| (!printed.is_empty()).then_some(printed)) {
                    event.fields.insert("presented".into(), Value::Array(presented));
                }
            }
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

    /// A widget the presenter printed survives the cut that would take its
    /// closing fence, and a second bounding leaves what was read alone.
    #[test]
    fn a_presented_widget_is_read_before_the_output_is_cut() {
        let rows: Vec<Value> = (0..30).map(|row| json!([format!("row {row} {}", "w".repeat(150)), "ok"])).collect();
        let table = json!({"type":"table","columns":["Name","State"],"rows":rows});
        let output = format!("```atelier-widget\n{table}\n```\n");
        assert!(output.len() > 5_000);
        let mut completed = event(
            json!({"type":"tool.completed","sessionId":"s","seq":0,"at":"now","toolCallId":"t","ok":true,"output":output}),
        );
        bound_event(&mut completed);
        assert!(completed.fields["output"].as_str().unwrap().len() < 5_000);
        assert_eq!(completed.fields["presented"], json!([table]));
        bound_event(&mut completed);
        assert_eq!(completed.fields["presented"], json!([table]));

        let mut plain = event(
            json!({"type":"tool.completed","sessionId":"s","seq":0,"at":"now","toolCallId":"t","ok":true,"output":"```atelier-widget\nnot json\n```\n"}),
        );
        bound_event(&mut plain);
        assert!(!plain.fields.contains_key("presented"));

        // Codex's output is JSON around the text; its terminal holds the text.
        let block = "```atelier-widget\n{\"columns\":[\"A\"],\"rows\":[[\"1\"]],\"type\":\"table\"}\n```\n";
        let mut codex = event(json!({
            "type":"tool.completed","sessionId":"s","seq":0,"at":"now","toolCallId":"t","ok":true,
            "output": json!({"formatted_output": block, "exit_code": 0}).to_string(),
            "terminal": {"type":"terminal","output": block}
        }));
        bound_event(&mut codex);
        assert_eq!(codex.fields["presented"], json!([{"columns":["A"],"rows":[["1"]],"type":"table"}]));
    }

    /// A card printed while a call runs goes to that chat's next completed
    /// call, not to an older call read back from the store, nor another chat's.
    #[test]
    fn a_printed_card_goes_to_its_own_chats_next_call_only() {
        let card = json!({"type":"table","columns":["A"],"rows":[["1"]]});
        printed_card("own-chat", &format!("```atelier-widget\n{card}\n```\n"));
        let completed = |session: &str, at: &str| {
            event(json!({"type":"tool.completed","sessionId":session,"seq":3,"at":at,"toolCallId":"t","ok":true,"output":"done"}))
        };
        let mut other = completed("other-chat", "now");
        bound_event(&mut other);
        assert!(!other.fields.contains_key("presented"));
        let mut old = completed("own-chat", "2020-01-01T00:00:00Z");
        bound_event(&mut old);
        assert!(!old.fields.contains_key("presented"));
        let mut next = completed("own-chat", &chrono::Utc::now().to_rfc3339());
        bound_event(&mut next);
        assert_eq!(next.fields["presented"], json!([card]));
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

    /// A screenshot leaves the conversation as a name the page fetches once,
    /// with its shape, and a small picture stays inline.
    #[test]
    fn a_large_picture_is_sent_as_a_name_and_a_small_one_stays() {
        let store = tempfile::tempdir().unwrap();
        // A 3x2 PNG header, padded past the inline limit.
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x03\0\0\0\x02".to_vec();
        png.extend(std::iter::repeat_n(0u8, 16 * 1024));
        let big = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        let mut value =
            json!({"images":[{"dataUrl":big},{"dataUrl":"data:image/png;base64,AAAA"}]});
        keep_pictures(&mut value, DEPTH, store.path());

        let kept = &value["images"][0];
        assert_eq!(kept["dataUrl"], "");
        assert_eq!(kept["width"], 3);
        assert_eq!(kept["height"], 2);
        assert_eq!(kept["size"], png.len());
        assert!(store.path().join(kept["asset"].as_str().unwrap()).is_file());
        assert_eq!(value["images"][1]["dataUrl"], "data:image/png;base64,AAAA");
    }
}
