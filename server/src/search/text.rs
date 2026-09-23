//! Words found in text held in memory, the way every search that is not an
//! index finds them: the board's cards, a file's lines.
//!
//! A word matches where a word starts, and ends where a word ends unless it is
//! the word still being typed. Case is ignored. A phrase is found as written,
//! spaces and all. What is found is handed back marked, cut down to the stretch
//! around the first place it was found.

use super::words::Term;
use serde::Serialize;

/// A run of text, and whether it is a word the search found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Segment {
    pub text: String,
    #[serde(skip_serializing_if = "unmarked")]
    pub mark: bool,
}

fn unmarked(mark: &bool) -> bool {
    !*mark
}

/// How much is kept before the first match in a snippet, and in all.
const BEFORE: usize = 60;
const LONGEST: usize = 220;

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Where `term` is found in `text`, as byte ranges, in order.
pub fn find<F>(text: &str, term: &Term<F>) -> Vec<(usize, usize)> {
    let needle = term.text.to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    // Lowercased ASCII keeps every byte where it was, so a place found in the
    // folded text is the same place in the text as written.
    let folded = text.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let starts_word = needle.starts_with(is_word);
    let ends_word = needle.ends_with(is_word);
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = folded[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let clean_start = !starts_word || !before.is_some_and(is_word);
        let clean_end = term.prefix || !ends_word || !after.is_some_and(is_word);
        if clean_start && clean_end {
            found.push((start, end));
        }
        from = start + needle.chars().next().map_or(1, char::len_utf8);
    }
    found
}

/// Every place any of `terms` is found, merged where they overlap.
pub fn places<F>(text: &str, terms: &[&Term<F>]) -> Vec<(usize, usize)> {
    let mut all: Vec<(usize, usize)> = terms.iter().flat_map(|term| find(text, term)).collect();
    all.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in all {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// `text` whole, with `places` marked.
pub fn marked(text: &str, places: &[(usize, usize)]) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut at = 0;
    for &(start, end) in places {
        if start > at {
            segments.push(Segment {
                text: text[at..start].to_string(),
                mark: false,
            });
        }
        segments.push(Segment {
            text: text[start..end].to_string(),
            mark: true,
        });
        at = end;
    }
    if at < text.len() {
        segments.push(Segment {
            text: text[at..].to_string(),
            mark: false,
        });
    }
    segments
}

/// The stretch of `text` around its first place, on one line, marked.
pub fn snippet(text: &str, places: &[(usize, usize)]) -> Vec<Segment> {
    let Some(&(first, _)) = places.first() else {
        return Vec::new();
    };
    let mut start = first.saturating_sub(BEFORE);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    // Begun at a word, not partway into one.
    if start > 0 {
        if let Some(space) = text[start..first].find(char::is_whitespace) {
            start += space + 1;
        }
    }
    let mut end = (start + LONGEST).min(text.len());
    while !text.is_char_boundary(end) {
        end += 1;
    }
    // Line breaks become spaces, byte for byte, so the places still line up.
    let line: String = text[start..end]
        .chars()
        .map(|c| {
            if matches!(c, '\n' | '\r' | '\t') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let inside: Vec<(usize, usize)> = places
        .iter()
        .filter(|(s, _)| *s >= start && *s < end)
        .map(|&(s, e)| (s - start, e.min(end) - start))
        .collect();
    let mut segments = marked(&line, &inside);
    if start > 0 {
        if let Some(first) = segments.first_mut() {
            first.text.insert(0, '…');
        }
    }
    if end < text.len() {
        if let Some(last) = segments.last_mut() {
            last.text.push('…');
        }
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(text: &str, prefix: bool) -> Term<()> {
        Term {
            text: text.into(),
            phrase: false,
            prefix,
            fields: Vec::new(),
        }
    }

    #[test]
    fn a_word_is_found_whole_unless_it_is_still_being_typed() {
        assert_eq!(
            find("The Loader crashed", &term("loader", false)),
            vec![(4, 10)]
        );
        assert!(find("reloader", &term("loader", false)).is_empty());
        assert!(find("loaders", &term("loader", false)).is_empty());
        assert_eq!(find("loaders", &term("loader", true)), vec![(0, 6)]);
        assert_eq!(
            find("see bw-21a2.7 now", &term("bw-21a2", false)),
            vec![(4, 11)]
        );
    }

    #[test]
    fn a_snippet_is_the_stretch_around_the_first_match_with_it_marked() {
        let text = format!("{} the cobalt cache\nwas off", "word ".repeat(40));
        let at = places(&text, &[&term("cobalt", false)]);
        let snippet = snippet(&text, &at);
        assert!(snippet[0].text.starts_with('…'), "{snippet:?}");
        assert_eq!(
            snippet
                .iter()
                .filter(|s| s.mark)
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["cobalt"]
        );
        assert!(
            snippet.last().unwrap().text.ends_with("cache was off"),
            "{snippet:?}"
        );
    }
}
