//! What an agent named, read back from its last words.
//!
//! The agent is only trusted for its judgement. Each source looks up every
//! thing it names before it is shown, so an id it misremembered or made up is
//! dropped rather than drawn as a link to nothing.

use serde_json::Value;
use std::collections::HashSet;

/// One thing the agent named, as it named it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub id: String,
    pub reason: String,
    /// Where in it the described thing is — a message, a line — when it said.
    pub at: Option<String>,
}

/// The most one answer may name: past this it is a list, not an answer.
pub const MOST: usize = 10;

/// A string or a number, as text; an agent writes a line either way.
fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.trim().to_string()).filter(|text| !text.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// What the agent's last words name under `list`: the last JSON object in
/// them that carries that list, however it was wrapped — a code fence, a
/// sentence before it. Nothing when it gave no such object at all, which is a
/// failed search, not a search that found nothing.
pub fn named(said: &str, list: &str) -> Option<Vec<Named>> {
    let starts = said
        .match_indices('{')
        .map(|(at, _)| at)
        .collect::<Vec<_>>();
    for start in starts.into_iter().rev() {
        let Some(Ok(value)) = serde_json::Deserializer::from_str(&said[start..])
            .into_iter::<Value>()
            .next()
        else {
            continue;
        };
        let Some(items) = value.get(list).and_then(Value::as_array) else {
            continue;
        };
        let mut seen = HashSet::new();
        return Some(
            items
                .iter()
                .filter_map(|item| {
                    Some(Named {
                        id: text(item.get("id")?)?,
                        reason: item["reason"].as_str().unwrap_or("").trim().to_string(),
                        at: ["at", "message", "line"]
                            .into_iter()
                            .find_map(|key| item.get(key).and_then(text)),
                    })
                })
                .filter(|named| seen.insert(named.id.clone()))
                .take(MOST)
                .collect(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(named: &[Named]) -> Vec<&str> {
        named.iter().map(|named| named.id.as_str()).collect()
    }

    #[test]
    fn the_answer_is_found_however_it_was_wrapped() {
        let said = "I read both.\n```json\n{\"chats\":[{\"id\":\"a\",\"reason\":\" Fixed the loader \",\"message\":\"m2\"},{\"id\":\"b\",\"reason\":\"Said it again\"}]}\n```";
        let found = named(said, "chats").unwrap();
        assert_eq!(ids(&found), ["a", "b"]);
        assert_eq!(found[0].reason, "Fixed the loader");
        assert_eq!(found[0].at.as_deref(), Some("m2"));
        assert_eq!(found[1].at, None);
    }

    #[test]
    fn a_line_is_a_place_whether_written_as_a_number_or_not() {
        let found = named(
            r#"{"files":[{"id":"src/a.rs","line":42},{"id":"b.rs","line":"7"}]}"#,
            "files",
        )
        .unwrap();
        assert_eq!(found[0].at.as_deref(), Some("42"));
        assert_eq!(found[1].at.as_deref(), Some("7"));
    }

    #[test]
    fn the_last_answer_counts_and_an_example_before_it_does_not() {
        let said = r#"The format is {"chats":[{"id":"example"}]}. Here: {"chats":[{"id":"real"}]}"#;
        assert_eq!(ids(&named(said, "chats").unwrap()), ["real"]);
    }

    #[test]
    fn only_the_list_the_source_asked_for_is_read() {
        assert_eq!(named(r#"{"cards":[{"id":"bw-1"}]}"#, "chats"), None);
    }

    #[test]
    fn no_answer_is_told_apart_from_an_answer_that_found_nothing() {
        assert_eq!(named("I could not find it.", "chats"), None);
        assert_eq!(named(r#"{"chats":[]}"#, "chats"), Some(Vec::new()));
    }

    #[test]
    fn a_thing_named_twice_is_listed_once_and_a_long_answer_is_cut() {
        let list = (0..15)
            .map(|n| format!(r#"{{"id":"c{n}"}},{{"id":"c{n}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let found = named(&format!(r#"{{"chats":[{list},{{"id":"  "}}]}}"#), "chats").unwrap();
        assert_eq!(found.len(), MOST);
        assert_eq!(found[1].id, "c1");
    }
}
