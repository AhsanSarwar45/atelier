//! The AI search: an agent finds the chats a person describes in their own
//! words, and names each with the reason it matches.
//!
//! The agent is only trusted for its judgement. Every chat it names is looked
//! up before it is shown, so an id it misremembered or made up is dropped
//! rather than drawn as a link to nothing.

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

/// One chat the agent named, as it named it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Named {
    pub id: String,
    #[serde(default)]
    pub reason: String,
    /// The message the thing it describes happens at, when it said.
    #[serde(default)]
    pub message: Option<String>,
}

/// The most chats one answer may name: past this it is a list, not an answer.
pub const MOST: usize = 10;

/// The chats an agent's last words name: the last JSON object in them that
/// carries a `chats` list, however it was wrapped — a code fence, a sentence
/// before it. Nothing when it gave no such object at all, which is a failed
/// search, not a search that found nothing.
pub fn named_chats(said: &str) -> Option<Vec<Named>> {
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
        let Some(list) = value.get("chats").and_then(Value::as_array) else {
            continue;
        };
        let mut seen = HashSet::new();
        return Some(
            list.iter()
                .filter_map(|item| serde_json::from_value::<Named>(item.clone()).ok())
                .map(|mut named| {
                    named.id = named.id.trim().to_string();
                    named.reason = named.reason.trim().to_string();
                    named.message = named.message.filter(|id| !id.trim().is_empty());
                    named
                })
                .filter(|named| !named.id.is_empty() && seen.insert(named.id.clone()))
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
        let named = named_chats(said).unwrap();
        assert_eq!(ids(&named), ["a", "b"]);
        assert_eq!(named[0].reason, "Fixed the loader");
        assert_eq!(named[0].message.as_deref(), Some("m2"));
        assert_eq!(named[1].message, None);
    }

    #[test]
    fn the_last_answer_counts_and_an_example_before_it_does_not() {
        let said = r#"The format is {"chats":[{"id":"example"}]}. Here: {"chats":[{"id":"real"}]}"#;
        assert_eq!(ids(&named_chats(said).unwrap()), ["real"]);
    }

    #[test]
    fn no_answer_is_told_apart_from_an_answer_that_found_nothing() {
        assert_eq!(named_chats("I could not find it."), None);
        assert_eq!(named_chats(r#"{"chats":[]}"#), Some(Vec::new()));
    }

    #[test]
    fn a_chat_named_twice_is_listed_once_and_a_long_answer_is_cut() {
        let list = (0..15)
            .map(|n| format!(r#"{{"id":"c{n}"}},{{"id":"c{n}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let named = named_chats(&format!(r#"{{"chats":[{list},{{"id":"  "}}]}}"#)).unwrap();
        assert_eq!(named.len(), MOST);
        assert_eq!(named[1].id, "c1");
    }
}
