//! What a search asks for, read from the words typed into the search box.
//!
//! Plain words must all be found somewhere in a chat. A word can be aimed at
//! one part of a chat with a key — `title:`, `me:`, `agent:`, `tool:` — and
//! the chats themselves narrowed by `project:`, `provider:`, `card:`,
//! `from:`, and the dates `after:`, `before:` and `on:`. Quotes keep words
//! together as a phrase, a leading `-` leaves out chats that say it, and `OR`
//! between two words accepts either.
//!
//! Nothing typed is ever an error. A key this does not know is read as the
//! plain word it looks like, so a search for `std::fs` or `http://` finds
//! what was written rather than refusing it; a date it cannot read is
//! reported beside the results and otherwise ignored.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
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

/// One word or phrase, and where it must be found. `fields` empty means
/// anywhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    pub text: String,
    pub phrase: bool,
    pub prefix: bool,
    pub fields: Vec<Field>,
}

impl Term {
    /// The term as FTS5 reads it, or `None` when it holds nothing a word
    /// could be made of — a lone `-` or `::`, which FTS5 would refuse.
    pub fn fts(&self) -> Option<String> {
        if !self.text.chars().any(char::is_alphanumeric) {
            return None;
        }
        let quoted = format!("\"{}\"", self.text.replace('"', "\"\""));
        // One letter still being typed would match nearly every word there
        // is, and cost a second doing it; it is read as itself until a second
        // letter makes it worth finishing.
        Some(if self.prefix && self.text.chars().count() > 1 {
            format!("{quoted}*")
        } else {
            quoted
        })
    }
}

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

/// One piece of the box, split on spaces outside quotes.
#[derive(Debug)]
struct Piece {
    negated: bool,
    key: Option<String>,
    value: String,
    quoted: bool,
}

fn pieces(input: &str) -> Vec<Piece> {
    let mut found = Vec::new();
    let mut chars = input.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut raw = String::new();
        let mut quoted = false;
        let mut in_quotes = false;
        while let Some(&c) = chars.peek() {
            if c == '"' {
                in_quotes = !in_quotes;
                quoted = true;
                chars.next();
                continue;
            }
            if c.is_whitespace() && !in_quotes {
                break;
            }
            raw.push(c);
            chars.next();
        }
        let (negated, rest) = match raw.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest.to_string()),
            _ => (false, raw),
        };
        // A key is letters then a colon, with something after it or a quote
        // that was opened for it: `title:"two words"`.
        let (key, value) = match rest.split_once(':') {
            Some((key, value))
                if !key.is_empty()
                    && key.chars().all(|c| c.is_ascii_alphabetic())
                    && (!value.is_empty() || quoted) =>
            {
                (Some(key.to_ascii_lowercase()), value.to_string())
            }
            _ => (None, rest),
        };
        found.push(Piece {
            negated,
            key,
            value,
            quoted,
        });
    }
    found
}

/// A word as typed, before `in:` has aimed it and `OR` has grouped it.
struct Word {
    negated: bool,
    /// Typed right after an `OR`, so it belongs with the word before it.
    joins: bool,
    term: Term,
}

/// Read the box. `now` is the reader's own clock, which decides what
/// `yesterday` means.
pub fn parse(input: &str, now: DateTime<Local>) -> Query {
    let mut query = Query::default();
    let finished = input.ends_with(char::is_whitespace);
    let pieces = pieces(input);
    let last = pieces.len().saturating_sub(1);
    let mut scope: Vec<Field> = Vec::new();
    let mut joining = false;
    let mut words: Vec<Word> = Vec::new();

    for (index, piece) in pieces.into_iter().enumerate() {
        if piece.key.is_none() && !piece.quoted && !piece.negated && piece.value == "OR" {
            joining = !words.is_empty();
            continue;
        }
        let prefix = index == last && !finished && !piece.quoted;
        let aimed = piece.key.as_deref().and_then(Field::from_key);
        let word = match (piece.key.as_deref(), aimed) {
            (Some(_), Some(field)) => Some(Term {
                text: piece.value,
                phrase: piece.quoted,
                prefix,
                fields: vec![field],
            }),
            (Some("in"), _) => {
                for name in piece.value.split(',') {
                    match Field::from_key(&name.to_ascii_lowercase()) {
                        Some(field) if !scope.contains(&field) => scope.push(field),
                        Some(_) => {}
                        None => query.ignored.push(format!("in:{name}")),
                    }
                }
                None
            }
            (Some("project" | "proj" | "repo"), _) => {
                query.projects.push(piece.value);
                None
            }
            (Some("provider" | "brand" | "with"), _) => {
                query
                    .providers
                    .push(match piece.value.to_ascii_lowercase().as_str() {
                        "goose" | "ollama" => "local".to_string(),
                        other => other.to_string(),
                    });
                None
            }
            (Some("card" | "bead" | "ticket" | "issue"), _) => {
                query.cards.push(piece.value);
                None
            }
            (Some("from" | "origin" | "started"), _) => {
                match piece.value.to_ascii_lowercase().as_str() {
                    "app" | "atelier" | "here" => query.origins.push("app".to_string()),
                    "terminal" | "cli" | "shell" => query.origins.push("terminal".to_string()),
                    _ => query.ignored.push(format!("from:{}", piece.value)),
                }
                None
            }
            (Some(key @ ("after" | "since" | "before" | "until" | "on" | "during")), _) => {
                match day_span(&piece.value, now) {
                    Some((start, end)) => match key {
                        "after" | "since" => query.after = Some(latest(query.after.take(), start)),
                        "before" | "until" => {
                            query.before = Some(earliest(query.before.take(), start))
                        }
                        _ => {
                            query.after = Some(latest(query.after.take(), start));
                            query.before = Some(earliest(query.before.take(), end));
                        }
                    },
                    None => query.ignored.push(format!("{key}:{}", piece.value)),
                }
                None
            }
            // Not a key this knows, so the words as written.
            (key, _) => Some(Term {
                text: match key {
                    Some(key) => format!("{key}:{}", piece.value),
                    None => piece.value,
                },
                phrase: piece.quoted,
                prefix,
                fields: Vec::new(),
            }),
        };
        if let Some(term) = word {
            words.push(Word {
                negated: piece.negated,
                joins: joining && !piece.negated,
                term,
            });
            joining = false;
        }
    }
    // Aimed and grouped only now, because `in:` may come after the words it
    // aims.
    for Word {
        negated,
        joins,
        mut term,
    } in words
    {
        if term.fields.is_empty() {
            term.fields = scope.clone();
        }
        if term.fts().is_none() {
            continue;
        }
        match (negated, joins, query.all.last_mut()) {
            (true, _, _) => query.none.push(term),
            (false, true, Some(group)) => group.push(term),
            (false, _, _) => query.all.push(vec![term]),
        }
    }
    query
}

fn latest(held: Option<String>, new: String) -> String {
    held.filter(|held| *held > new).unwrap_or(new)
}

fn earliest(held: Option<String>, new: String) -> String {
    held.filter(|held| *held < new).unwrap_or(new)
}

fn instant(at: DateTime<Local>) -> String {
    at.with_timezone(&Utc)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn midnight(day: NaiveDate) -> Option<DateTime<Local>> {
    Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0)?)
        .earliest()
}

/// The span a date names, as `[start, end)` in UTC: a day, a month, a year,
/// or — for `3d`, `2w`, `6m`, `1y` — from that long ago until now.
fn day_span(value: &str, now: DateTime<Local>) -> Option<(String, String)> {
    let value = value.trim().to_ascii_lowercase();
    let today = now.date_naive();
    let day = |date: NaiveDate| {
        Some((
            instant(midnight(date)?),
            instant(midnight(date.succ_opt()?)?),
        ))
    };
    match value.as_str() {
        "today" => return day(today),
        "yesterday" => return day(today.pred_opt()?),
        _ => {}
    }
    if let Some(amount) = value
        .char_indices()
        .last()
        .and_then(|(at, unit)| Some((value[..at].parse::<i64>().ok()?, unit)))
    {
        let (count, unit) = amount;
        let ago = match unit {
            'h' => Duration::hours(count),
            'd' => Duration::days(count),
            'w' => Duration::weeks(count),
            'm' => Duration::days(30 * count),
            'y' => Duration::days(365 * count),
            _ => return None,
        };
        return Some((instant(now - ago), instant(now)));
    }
    if let Ok(date) = NaiveDate::parse_from_str(&value, "%Y-%m-%d") {
        return day(date);
    }
    if let Ok(month) = NaiveDate::parse_from_str(&format!("{value}-01"), "%Y-%m-%d") {
        let next = if month.month() == 12 {
            NaiveDate::from_ymd_opt(month.year() + 1, 1, 1)?
        } else {
            NaiveDate::from_ymd_opt(month.year(), month.month() + 1, 1)?
        };
        return Some((instant(midnight(month)?), instant(midnight(next)?)));
    }
    if value.len() == 4 {
        if let Ok(year) = value.parse::<i32>() {
            let start = NaiveDate::from_ymd_opt(year, 1, 1)?;
            let end = NaiveDate::from_ymd_opt(year + 1, 1, 1)?;
            return Some((instant(midnight(start)?), instant(midnight(end)?)));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
