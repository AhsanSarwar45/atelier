//! What a search asks for, read from the words typed into the search box.
//!
//! Plain words must all be found somewhere in a chat. A word can be aimed at
//! one part of a chat with a key — `title:`, `me:`, `agent:`, `tool:` — and
//! the chats themselves narrowed by `project:`, `provider:`, `card:`,
//! `from:`, and the dates `after:`, `before:` and `on:`. Quotes keep words
//! together as a phrase, a leading `-` leaves out chats that say it, and `OR`
//! between two words accepts either.
//!
//! How a box is read is shared with every search (search/words.rs); this
//! says only what a chat's keys are.
//!
//! Nothing typed is ever an error. A key this does not know is read as the
//! plain word it looks like, so a search for `std::fs` or `http://` finds
//! what was written rather than refusing it; a date it cannot read is
//! reported beside the results and otherwise ignored.

use crate::search::words::{self, Dates, Key};
use chrono::{DateTime, Local};
use serde::Serialize;

/// The parts of a chat a word can be aimed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Field {
    Title,
    Me,
    Agent,
    Tool,
}

impl Field {
    pub fn name(self) -> &'static str {
        match self {
            Field::Title => "title",
            Field::Me => "me",
            Field::Agent => "agent",
            Field::Tool => "tool",
        }
    }

    fn from_key(key: &str) -> Option<Self> {
        match key {
            "title" | "name" => Some(Field::Title),
            "me" | "i" | "user" | "you" => Some(Field::Me),
            "agent" | "ai" | "assistant" | "reply" => Some(Field::Agent),
            "tool" | "tools" | "cmd" | "command" | "file" | "path" => Some(Field::Tool),
            _ => None,
        }
    }
}

/// A word or phrase in a chat, and the parts of it it must be found in.
pub type Term = words::Term<Field>;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Every group must be found; within a group, any one term will do.
    pub all: Vec<Vec<Term>>,
    /// A chat that says any of these is left out.
    pub none: Vec<Term>,
    pub projects: Vec<String>,
    pub providers: Vec<String>,
    pub cards: Vec<String>,
    /// `app` or `terminal`: where the chat was begun.
    pub origins: Vec<String>,
    /// Inclusive lower bound, an ISO instant in UTC.
    pub after: Option<String>,
    /// Exclusive upper bound, an ISO instant in UTC.
    pub before: Option<String>,
    /// What could not be read, in the words typed.
    pub ignored: Vec<String>,
}

impl Query {
    /// True when the query names nothing at all to look for or narrow by.
    pub fn is_empty(&self) -> bool {
        self.all.is_empty()
            && self.none.is_empty()
            && self.projects.is_empty()
            && self.providers.is_empty()
            && self.cards.is_empty()
            && self.origins.is_empty()
            && self.after.is_none()
            && self.before.is_none()
    }
}

/// Read the box. `now` is the reader's own clock, which decides what
/// `yesterday` means.
pub fn parse(input: &str, now: DateTime<Local>) -> Query {
    let mut query = Query::default();
    let mut dates = Dates::default();
    let read = words::read(input, Field::from_key, |key, piece| {
        if let Some(taken) = dates.take(key, &piece.value, now) {
            return taken;
        }
        match key {
            "project" | "proj" | "repo" => query.projects.push(piece.value.clone()),
            "provider" | "brand" | "with" => {
                query
                    .providers
                    .push(match piece.value.to_ascii_lowercase().as_str() {
                        "goose" | "ollama" => "local".to_string(),
                        other => other.to_string(),
                    })
            }
            "card" | "bead" | "ticket" | "issue" => query.cards.push(piece.value.clone()),
            "from" | "origin" | "started" => match piece.value.to_ascii_lowercase().as_str() {
                "app" | "atelier" | "here" => query.origins.push("app".to_string()),
                "terminal" | "cli" | "shell" => query.origins.push("terminal".to_string()),
                _ => return Key::Unread,
            },
            // Not a key this knows, so the words as written.
            _ => return Key::Words,
        }
        Key::Taken
    });
    query.all = read.all;
    query.none = read.none;
    query.ignored = read.ignored;
    query.after = dates.after;
    query.before = dates.before;
    query
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::words::instant;
    use chrono::{Duration, TimeZone};

    #[test]
    fn a_single_letter_still_being_typed_is_not_yet_a_prefix() {
        let term = |text: &str| Term {
            text: text.into(),
            phrase: false,
            prefix: true,
            fields: Vec::new(),
        };
        assert_eq!(term("a").fts().as_deref(), Some("\"a\""));
        assert_eq!(term("lo").fts().as_deref(), Some("\"lo\"*"));
    }

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 15, 12, 0, 0).unwrap()
    }

    fn term(text: &str, fields: &[Field]) -> Term {
        Term {
            text: text.to_string(),
            phrase: false,
            prefix: false,
            fields: fields.to_vec(),
        }
    }

    #[test]
    fn plain_words_are_all_required_and_the_last_is_still_being_typed() {
        let query = parse("loader crash", now());
        assert_eq!(query.all.len(), 2);
        assert!(!query.all[0][0].prefix);
        assert!(
            query.all[1][0].prefix,
            "the word under the cursor is a prefix"
        );
        assert_eq!(query.all[1][0].fts().unwrap(), "\"crash\"*");

        let finished = parse("loader crash ", now());
        assert!(
            !finished.all[1][0].prefix,
            "a space says the word is finished"
        );
    }

    #[test]
    fn a_key_aims_a_word_at_one_part_of_the_chat() {
        let query = parse(
            "title:auth me:\"rate limit\" agent:retry tool:cargo ",
            now(),
        );
        assert_eq!(
            query.all,
            vec![
                vec![term("auth", &[Field::Title])],
                vec![Term {
                    phrase: true,
                    ..term("rate limit", &[Field::Me])
                }],
                vec![term("retry", &[Field::Agent])],
                vec![term("cargo", &[Field::Tool])],
            ]
        );
    }

    #[test]
    fn in_aims_every_word_that_named_no_part_of_its_own() {
        let query = parse("loader title:crash in:me,agent ", now());
        assert_eq!(query.all[0][0].fields, vec![Field::Me, Field::Agent]);
        assert_eq!(query.all[1][0].fields, vec![Field::Title]);
    }

    #[test]
    fn narrowing_keys_are_kept_apart_from_words() {
        let query = parse(
            "project:atelier provider:goose card:bw-7ks from:terminal fix ",
            now(),
        );
        assert_eq!(query.projects, ["atelier"]);
        assert_eq!(query.providers, ["local"]);
        assert_eq!(query.cards, ["bw-7ks"]);
        assert_eq!(query.origins, ["terminal"]);
        assert_eq!(query.all, vec![vec![term("fix", &[])]]);
    }

    #[test]
    fn a_minus_leaves_out_and_or_accepts_either() {
        let query = parse("sqlite OR postgres -mysql migrate ", now());
        assert_eq!(
            query.all,
            vec![
                vec![term("sqlite", &[]), term("postgres", &[])],
                vec![term("migrate", &[])],
            ]
        );
        assert_eq!(query.none, vec![term("mysql", &[])]);
    }

    #[test]
    fn what_is_not_a_known_key_is_the_words_as_written() {
        let query = parse("std::fs http://localhost:3008 ", now());
        assert_eq!(query.all[0][0].text, "std::fs");
        assert_eq!(query.all[1][0].text, "http://localhost:3008");
        // Nothing a word could be made of is dropped rather than sent to FTS5.
        assert!(parse("- :: ", now()).all.is_empty());
    }

    #[test]
    fn dates_are_read_on_the_readers_own_clock() {
        let local = |y, m, d| instant(Local.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap());
        let yesterday = parse("on:yesterday", now());
        assert_eq!(
            yesterday.after.as_deref(),
            Some(local(2026, 9, 14).as_str())
        );
        assert_eq!(
            yesterday.before.as_deref(),
            Some(local(2026, 9, 15).as_str())
        );

        let week = parse("after:7d", now());
        assert_eq!(
            week.after.as_deref(),
            Some(instant(now() - Duration::days(7)).as_str())
        );
        assert!(week.before.is_none());

        let month = parse("on:2026-08", now());
        assert_eq!(month.after.as_deref(), Some(local(2026, 8, 1).as_str()));
        assert_eq!(month.before.as_deref(), Some(local(2026, 9, 1).as_str()));

        let before = parse("before:2026-08-01", now());
        assert_eq!(before.before.as_deref(), Some(local(2026, 8, 1).as_str()));

        let unread = parse("after:someday loader", now());
        assert_eq!(unread.ignored, ["after:someday"]);
        assert!(unread.after.is_none());
        assert_eq!(unread.all.len(), 1);
    }

    #[test]
    fn a_quoted_value_after_a_key_keeps_its_spaces() {
        let query = parse("project:\"my app\" title:\"two words\"", now());
        assert_eq!(query.projects, ["my app"]);
        assert_eq!(query.all[0][0].text, "two words");
        assert!(!query.all[0][0].prefix, "a quoted phrase is never a prefix");
    }
}
