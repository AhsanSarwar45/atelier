//! The words typed into a search box, read the way every search reads them.
//!
//! Plain words must all be found. Quotes keep words together as a phrase, a
//! leading `-` leaves out what says it, and `OR` between two words accepts
//! either. The last word is still being typed, and so matches as a prefix,
//! until a space follows it. A word can be aimed at one part of a thing with a
//! key, and `in:` aims every word that named no part of its own.
//!
//! What the keys are is the source's to say: which ones aim a word, and what
//! the others narrow. Nothing typed is ever an error. A key the source does not
//! know is read as the plain word it looks like, so `std::fs` or `http://` is
//! found as written; a value it cannot read is reported beside the results.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
use serde::Serialize;

/// One word or phrase, and the parts it must be found in. `fields` empty means
/// anywhere.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Term<F> {
    pub text: String,
    pub phrase: bool,
    pub prefix: bool,
    pub fields: Vec<F>,
}

impl<F> Term<F> {
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

/// The words of a box, grouped: every group must be found, and within a group
/// any one term will do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Words<F> {
    pub all: Vec<Vec<Term<F>>>,
    /// What says any of these is left out.
    pub none: Vec<Term<F>>,
    /// What could not be read, in the words typed.
    pub ignored: Vec<String>,
}

/// One piece of the box, split on spaces outside quotes.
#[derive(Debug)]
pub struct Piece {
    pub negated: bool,
    /// Lowercase, when the piece is a key.
    pub key: Option<String>,
    pub value: String,
    pub quoted: bool,
}

/// What a source made of a key that aims no word.
pub enum Key {
    /// It narrows the search; the source has kept it.
    Taken,
    /// It is the source's key, but its value means nothing.
    Unread,
    /// Not a key of the source's: the words as written.
    Words,
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
struct Word<F> {
    negated: bool,
    /// Typed right after an `OR`, so it belongs with the word before it.
    joins: bool,
    term: Term<F>,
}

/// Read the box. `field` names the part a key aims a word at; `key` is handed
/// every other key, and says what it made of it.
pub fn read<F: Copy + PartialEq>(
    input: &str,
    field: impl Fn(&str) -> Option<F>,
    mut key: impl FnMut(&str, &Piece) -> Key,
) -> Words<F> {
    let mut ignored = Vec::new();
    let finished = input.ends_with(char::is_whitespace);
    let pieces = pieces(input);
    let last = pieces.len().saturating_sub(1);
    let mut scope: Vec<F> = Vec::new();
    let mut joining = false;
    let mut words: Vec<Word<F>> = Vec::new();

    for (index, piece) in pieces.into_iter().enumerate() {
        if piece.key.is_none() && !piece.quoted && !piece.negated && piece.value == "OR" {
            joining = !words.is_empty();
            continue;
        }
        let prefix = index == last && !finished && !piece.quoted;
        let aimed = piece.key.as_deref().and_then(&field);
        let term = match (piece.key.as_deref(), aimed) {
            (Some(_), Some(aimed)) => Some(Term {
                text: piece.value,
                phrase: piece.quoted,
                prefix,
                fields: vec![aimed],
            }),
            (Some("in"), _) => {
                for name in piece.value.split(',') {
                    match field(&name.to_ascii_lowercase()) {
                        Some(aimed) if !scope.contains(&aimed) => scope.push(aimed),
                        Some(_) => {}
                        None => ignored.push(format!("in:{name}")),
                    }
                }
                None
            }
            (Some(written), _) => match key(written, &piece) {
                Key::Taken => None,
                Key::Unread => {
                    ignored.push(format!("{written}:{}", piece.value));
                    None
                }
                Key::Words => Some(Term {
                    text: format!("{written}:{}", piece.value),
                    phrase: piece.quoted,
                    prefix,
                    fields: Vec::new(),
                }),
            },
            (None, _) => Some(Term {
                text: piece.value,
                phrase: piece.quoted,
                prefix,
                fields: Vec::new(),
            }),
        };
        if let Some(term) = term {
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
    let (mut all, mut none): (Vec<Vec<Term<F>>>, Vec<Term<F>>) = (Vec::new(), Vec::new());
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
        match (negated, joins, all.last_mut()) {
            (true, _, _) => none.push(term),
            (false, true, Some(group)) => group.push(term),
            (false, _, _) => all.push(vec![term]),
        }
    }
    Words { all, none, ignored }
}

/// The dates a search is narrowed to: `after:`, `before:` and `on:`, read on
/// the reader's own clock.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dates {
    /// Inclusive lower bound, an ISO instant in UTC.
    pub after: Option<String>,
    /// Exclusive upper bound, an ISO instant in UTC.
    pub before: Option<String>,
}

impl Dates {
    /// Take a date key, or `None` for a key that is not one.
    pub fn take(&mut self, key: &str, value: &str, now: DateTime<Local>) -> Option<Key> {
        let span = match key {
            "after" | "since" | "before" | "until" | "on" | "during" => day_span(value, now),
            _ => return None,
        };
        let Some((start, end)) = span else {
            return Some(Key::Unread);
        };
        match key {
            "after" | "since" => self.after = Some(latest(self.after.take(), start)),
            "before" | "until" => self.before = Some(earliest(self.before.take(), start)),
            _ => {
                self.after = Some(latest(self.after.take(), start));
                self.before = Some(earliest(self.before.take(), end));
            }
        }
        Some(Key::Taken)
    }
}

fn latest(held: Option<String>, new: String) -> String {
    held.filter(|held| *held > new).unwrap_or(new)
}

fn earliest(held: Option<String>, new: String) -> String {
    held.filter(|held| *held < new).unwrap_or(new)
}

pub fn instant(at: DateTime<Local>) -> String {
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

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Part {
        Name,
        Body,
    }

    fn part(key: &str) -> Option<Part> {
        match key {
            "name" => Some(Part::Name),
            "body" => Some(Part::Body),
            _ => None,
        }
    }

    #[test]
    fn a_source_decides_its_own_keys_and_the_rest_are_words() {
        let mut kinds = Vec::new();
        let words = read("kind:bug kind:nonsense name:loader std::fs in:body crash ", part, |key, piece| {
            match (key, piece.value.as_str()) {
                ("kind", "bug") => {
                    kinds.push(piece.value.clone());
                    Key::Taken
                }
                ("kind", _) => Key::Unread,
                _ => Key::Words,
            }
        });
        assert_eq!(kinds, ["bug"]);
        assert_eq!(words.ignored, ["kind:nonsense"]);
        assert_eq!(words.all[0][0].fields, [Part::Name]);
        assert_eq!(words.all[1][0].text, "std::fs");
        assert_eq!(words.all[1][0].fields, [Part::Body]);
        assert_eq!(words.all[2][0].fields, [Part::Body]);
    }
}
