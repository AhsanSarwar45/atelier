//! What an edit changed, worked out before the wire limit cuts its text.
//!
//! The wire keeps one bound over every provider-owned string, and for a whole
//! file that bound used to fall on the text itself: a 54 KB write reached the
//! app as its first four thousand characters, which is the top of the file and
//! almost never the part that changed. The view could then say nothing truer
//! than how many characters it was not shown (bw-vl3q.1).
//!
//! So the diff is taken here, on the full text, and what is kept is the change
//! rather than a prefix of the file. A one-line edit to a large file now costs
//! a few hundred characters instead of eight thousand, and the few hundred are
//! the ones the reader wanted. The shape written out is the one the app
//! already reads from `/api/git/diff`, so both ends of the app draw a diff
//! through the same table.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

/// Unchanged lines kept either side of a changed run. Wider than git's three,
/// because there is nowhere to ask for more: the full text is gone after this.
const CONTEXT: usize = 6;
/// The most hunks one edit carries. A change spread over more places than this
/// is read as a rewrite, and the rest are counted rather than drawn.
const MAX_HUNKS: usize = 30;
/// The most lines those hunks carry between them.
const MAX_LINES: usize = 400;
/// The largest comparison table we will build in one go. A span past it is
/// cut at its unique shared lines and the pieces compared instead.
const MAX_CELLS: usize = 4_000_000;
/// How many times a span may be cut that way before it is simply reported as
/// replaced. Each pass divides, so this is far deeper than any real file needs.
const ANCHOR_DEPTH: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Context,
    Removed,
    Added,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Context => "context",
            Kind::Removed => "removed",
            Kind::Added => "added",
        }
    }
}

/// One line of the change, carrying where it sits on both sides.
///
/// Both numbers are held whatever the kind, because a hunk that opens on a
/// removed line still has to say which new line it starts at.
struct Op<'a> {
    kind: Kind,
    text: &'a str,
    old_no: usize,
    new_no: usize,
}

/// A body as lines, without the one newline that ends a file.
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n').unwrap_or(text).split('\n').collect()
}

/// How many lines the two sides open with in common.
fn common_prefix(a: &[&str], b: &[&str]) -> usize {
    let mut at = 0;
    while at < a.len() && at < b.len() && a[at] == b[at] {
        at += 1;
    }
    at
}

/// How many lines the two sides end with in common, without running back into
/// the prefix that has already been claimed.
fn common_suffix(a: &[&str], b: &[&str], prefix: usize) -> usize {
    let most = a.len().min(b.len()) - prefix;
    let mut at = 0;
    while at < most && a[a.len() - 1 - at] == b[b.len() - 1 - at] {
        at += 1;
    }
    at
}

/// Lines that appear exactly once on each side and say the same thing.
///
/// A line like that can only line up one way, so it is a place the two sides
/// certainly meet. Used as fixed points they cut a large file into spans small
/// enough to compare exactly, which is what keeps a file with changes all
/// through it from falling back to "everything replaced".
fn anchors<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(usize, usize)> {
    let once_in = |side: &[&'a str]| {
        let mut seen: HashMap<&'a str, (usize, usize)> = HashMap::with_capacity(side.len());
        for (at, text) in side.iter().enumerate() {
            seen.entry(text).and_modify(|e| e.0 += 1).or_insert((1, at));
        }
        seen
    };
    let in_a = once_in(a);
    let in_b = once_in(b);

    let mut pairs: Vec<(usize, usize)> = in_a
        .iter()
        .filter(|(_, (count, _))| *count == 1)
        .filter_map(|(text, (_, i))| match in_b.get(text) {
            Some((1, j)) => Some((*i, *j)),
            _ => None,
        })
        .collect();
    pairs.sort_unstable();
    // Anchors have to be read in the same order on both sides; the ones that
    // cross are lines that moved, and keeping them would tangle the spans.
    rising(&pairs)
}

/// The longest run of pairs rising on both sides, kept whole.
fn rising(pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut ends: Vec<usize> = Vec::new();
    let mut came_from: Vec<usize> = vec![usize::MAX; pairs.len()];
    for (at, pair) in pairs.iter().enumerate() {
        let place = ends.partition_point(|&e| pairs[e].1 < pair.1);
        if place > 0 {
            came_from[at] = ends[place - 1];
        }
        if place == ends.len() {
            ends.push(at);
        } else {
            ends[place] = at;
        }
    }
    let mut run = Vec::new();
    let mut at = ends.last().copied();
    while let Some(k) = at {
        run.push(pairs[k]);
        at = (came_from[k] != usize::MAX).then_some(came_from[k]);
    }
    run.reverse();
    run
}

/// One side replaced wholesale by the other: true, and as coarse as this file
/// ever gets. Only reached when there is nothing on one side to line up
/// against, or nothing the two sides share to line up by.
fn replaced<'a>(a: &[&'a str], b: &[&'a str], old_from: usize, new_from: usize, ops: &mut Vec<Op<'a>>) {
    for (at, text) in a.iter().enumerate() {
        ops.push(Op { kind: Kind::Removed, text, old_no: old_from + at, new_no: new_from });
    }
    for (at, text) in b.iter().enumerate() {
        ops.push(Op { kind: Kind::Added, text, old_no: old_from + a.len(), new_no: new_from + at });
    }
}

/// An exact comparison of two spans small enough to afford one.
///
/// Longest-common-subsequence, so a line that merely moved is not reported as
/// rewritten.
fn exactly<'a>(a: &[&'a str], b: &[&'a str], old_from: usize, new_from: usize, ops: &mut Vec<Op<'a>>) {
    // table[i][j] is the length of the longest common subsequence of a[i..]
    // and b[j..], held as one flat row-major buffer.
    let width = b.len() + 1;
    let mut table = vec![0u32; (a.len() + 1) * width];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            table[i * width + j] = if a[i] == b[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }

    let (mut i, mut j) = (0usize, 0usize);
    let (mut old_no, mut new_no) = (old_from, new_from);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            ops.push(Op { kind: Kind::Context, text: a[i], old_no, new_no });
            old_no += 1;
            new_no += 1;
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            ops.push(Op { kind: Kind::Removed, text: a[i], old_no, new_no });
            old_no += 1;
            i += 1;
        } else {
            ops.push(Op { kind: Kind::Added, text: b[j], old_no, new_no });
            new_no += 1;
            j += 1;
        }
    }
    replaced(&a[i..], &b[j..], old_no, new_no, ops);
}

/// Two spans as operations, absolutely numbered from `old_from` and `new_from`.
///
/// Small spans are compared exactly. A span too large for that is cut at the
/// lines that can only mean one thing and each piece compared on its own; the
/// pieces of a real file are small, so this almost always ends in an exact
/// comparison of every part. Only a span with nothing unique in common — a
/// file rewritten from end to end — is reported as replaced.
fn span<'a>(a: &[&'a str], b: &[&'a str], old_from: usize, new_from: usize, depth: usize, ops: &mut Vec<Op<'a>>) {
    if a.is_empty() || b.is_empty() {
        return replaced(a, b, old_from, new_from, ops);
    }
    if a.len().saturating_mul(b.len()) <= MAX_CELLS {
        return exactly(a, b, old_from, new_from, ops);
    }
    let found = if depth == 0 { Vec::new() } else { anchors(a, b) };
    if found.is_empty() {
        return replaced(a, b, old_from, new_from, ops);
    }
    let (mut i, mut j) = (0usize, 0usize);
    for (ai, bj) in found {
        span(&a[i..ai], &b[j..bj], old_from + i, new_from + j, depth - 1, ops);
        ops.push(Op { kind: Kind::Context, text: a[ai], old_no: old_from + ai, new_no: new_from + bj });
        i = ai + 1;
        j = bj + 1;
    }
    span(&a[i..], &b[j..], old_from + i, new_from + j, depth - 1, ops);
}

/// The changed middle as operations.
///
/// Trimming the shared head and tail before this is what keeps the common case
/// cheap: a whole-file write whose change is one line leaves a middle one line
/// long, whatever the size of the file around it.
fn middle_ops<'a>(a: &[&'a str], b: &[&'a str], old_from: usize, new_from: usize) -> Vec<Op<'a>> {
    let mut ops = Vec::new();
    span(a, b, old_from, new_from, ANCHOR_DEPTH, &mut ops);
    ops
}

/// The runs of operations one hunk each covers.
///
/// Every changed line claims `CONTEXT` lines either side; runs that then touch
/// or overlap are one hunk, because two hunks printed back to back with no gap
/// between them are one hunk written twice.
fn runs(ops: &[Op]) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for (at, op) in ops.iter().enumerate() {
        if op.kind == Kind::Context {
            continue;
        }
        let from = at.saturating_sub(CONTEXT);
        let to = (at + CONTEXT + 1).min(ops.len());
        match spans.last_mut() {
            Some(last) if from <= last.1 => last.1 = to,
            _ => spans.push((from, to)),
        }
    }
    spans
}

/// One run of operations written as the hunk shape the app already reads.
fn hunk(ops: &[Op]) -> Value {
    let old_lines = ops.iter().filter(|o| o.kind != Kind::Added).count();
    let new_lines = ops.iter().filter(|o| o.kind != Kind::Removed).count();
    json!({
        // A hunk that adds to an empty side starts at the line before it,
        // which is nothing; git writes that as zero and so do we.
        "oldStart": if old_lines == 0 { 0 } else { ops[0].old_no },
        "oldLines": old_lines,
        "newStart": if new_lines == 0 { 0 } else { ops[0].new_no },
        "newLines": new_lines,
        "lines": ops
            .iter()
            .map(|o| json!({ "kind": o.kind.name(), "text": o.text }))
            .collect::<Vec<_>>(),
    })
}

/// What an edit changed: the counts, and the changed lines with context.
///
/// The counts are exact whatever else had to be left out, so a card can always
/// say how large the change was even when it cannot draw all of it. When the
/// hunks themselves had to be cut, `omittedHunks` says how many were dropped
/// and the card can say so rather than imply it showed everything.
/// `start` is the line both sides begin at in the file they were cut from — a
/// provider hands over the changed fragment and says where it sits, and a hunk
/// numbered from one would point the reader at the top of the file instead.
pub fn summarize(before: &str, after: &str, start: usize) -> Map<String, Value> {
    let a = split_lines(before);
    let b = split_lines(after);
    let prefix = common_prefix(&a, &b);
    let suffix = common_suffix(&a, &b, prefix);

    let mut ops: Vec<Op> = Vec::new();
    // Only the last few shared lines of the head can be context for the first
    // hunk; the rest of a large file need never be carried at all.
    let head = prefix.saturating_sub(CONTEXT);
    for (at, text) in a[head..prefix].iter().enumerate() {
        let no = head + at + start;
        ops.push(Op { kind: Kind::Context, text, old_no: no, new_no: no });
    }
    ops.extend(middle_ops(
        &a[prefix..a.len() - suffix],
        &b[prefix..b.len() - suffix],
        prefix + start,
        prefix + start,
    ));
    for (at, text) in a[a.len() - suffix..].iter().take(CONTEXT).enumerate() {
        ops.push(Op {
            kind: Kind::Context,
            text,
            old_no: a.len() - suffix + at + start,
            new_no: b.len() - suffix + at + start,
        });
    }

    let added = ops.iter().filter(|o| o.kind == Kind::Added).count();
    let removed = ops.iter().filter(|o| o.kind == Kind::Removed).count();

    // Hunks are kept until the budget runs out, and the one that runs it out
    // is kept as far as it goes. Taking whole hunks only would mean a brand
    // new file arrived as one hunk of every line it has, which is the bound
    // this module was written to respect.
    let mut hunks: Vec<Value> = Vec::new();
    let mut budget = MAX_LINES;
    let mut omitted_hunks = 0usize;
    let mut omitted_lines = 0usize;
    for (from, to) in runs(&ops) {
        let size = to - from;
        if hunks.len() >= MAX_HUNKS || budget == 0 {
            omitted_hunks += 1;
            omitted_lines += size;
        } else if size <= budget {
            budget -= size;
            hunks.push(hunk(&ops[from..to]));
        } else {
            hunks.push(hunk(&ops[from..from + budget]));
            omitted_lines += size - budget;
            budget = 0;
        }
    }

    let mut change = Map::new();
    change.insert("added".into(), json!(added));
    change.insert("removed".into(), json!(removed));
    change.insert("beforeLines".into(), json!(a.len()));
    change.insert("afterLines".into(), json!(b.len()));
    // Said only when there is something to say, so a card can tell a whole
    // diff from a cut one by whether these are there at all.
    if omitted_hunks > 0 {
        change.insert("omittedHunks".into(), json!(omitted_hunks));
    }
    if omitted_lines > 0 {
        change.insert("omittedLines".into(), json!(omitted_lines));
    }
    change.insert("hunks".into(), Value::Array(hunks));
    change
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(change: &Map<String, Value>, hunk: usize) -> Vec<(String, String)> {
        change["hunks"][hunk]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| (l["kind"].as_str().unwrap().into(), l["text"].as_str().unwrap().into()))
            .collect()
    }

    /// The case the whole module exists for: a large file whose change is one
    /// line near the bottom. What comes out is the change, not the top of the
    /// file, and it is small.
    #[test]
    fn a_one_line_change_in_a_large_file_carries_only_the_change() {
        let before: String = (1..=1500).map(|n| format!("line {n}\n")).collect();
        let after = before.replace("line 1400\n", "line 1400 changed\n");
        assert!(before.len() > 10_000);

        let change = summarize(&before, &after, 1);
        assert_eq!(change["added"], json!(1));
        assert_eq!(change["removed"], json!(1));
        assert_eq!(change["beforeLines"], json!(1500));
        assert_eq!(change["hunks"].as_array().unwrap().len(), 1);
        assert_eq!(change["hunks"][0]["oldStart"], json!(1394));

        let drawn = lines_of(&change, 0);
        assert!(drawn.contains(&("removed".into(), "line 1400".into())));
        assert!(drawn.contains(&("added".into(), "line 1400 changed".into())));
        assert!(drawn.contains(&("context".into(), "line 1394".into())));
        // Six lines of context each side of the one changed line.
        assert_eq!(drawn.len(), 14);
        assert!(serde_json::to_string(&change).unwrap().len() < 1_000);
    }

    /// Two changes far apart are two hunks, each numbered from its own place,
    /// and the unchanged thousand lines between them are in neither.
    #[test]
    fn changes_far_apart_are_separate_hunks() {
        let before: String = (1..=1200).map(|n| format!("line {n}\n")).collect();
        let after = before
            .replace("line 100\n", "one\n")
            .replace("line 1100\n", "two\n");

        let change = summarize(&before, &after, 1);
        let hunks = change["hunks"].as_array().unwrap();
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0]["oldStart"], json!(94));
        assert_eq!(hunks[1]["oldStart"], json!(1094));
        assert_eq!(change["added"], json!(2));
        assert_eq!(change["removed"], json!(2));
    }

    /// Changed lines close together share one hunk rather than printing the
    /// same context twice.
    #[test]
    fn changes_close_together_share_one_hunk() {
        let before: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        let after = before.replace("line 50\n", "a\n").replace("line 53\n", "b\n");

        let change = summarize(&before, &after, 1);
        assert_eq!(change["hunks"].as_array().unwrap().len(), 1);
    }

    /// A new file is all additions, and an emptied one all removals. Neither
    /// has an old or a new side to number from, and the missing side reads
    /// zero the way git writes it.
    #[test]
    fn a_new_file_is_all_additions_and_an_emptied_one_all_removals() {
        let born = summarize("", "a\nb\n", 1);
        assert_eq!(born["added"], json!(2));
        assert_eq!(born["removed"], json!(0));
        assert_eq!(born["hunks"][0]["oldStart"], json!(0));
        assert_eq!(born["hunks"][0]["oldLines"], json!(0));
        assert_eq!(born["hunks"][0]["newLines"], json!(2));

        let gone = summarize("a\nb\n", "", 1);
        assert_eq!(gone["removed"], json!(2));
        assert_eq!(gone["hunks"][0]["newStart"], json!(0));
    }

    /// Nothing changed is no hunks and no counts, not an empty-looking change
    /// the card would have to guess about.
    #[test]
    fn an_unchanged_file_has_no_hunks() {
        let change = summarize("a\nb\n", "a\nb\n", 1);
        assert_eq!(change["added"], json!(0));
        assert_eq!(change["removed"], json!(0));
        assert!(change["hunks"].as_array().unwrap().is_empty());
    }

    /// A change in more places than a card will draw keeps every hunk it can,
    /// counts the rest, and still reports the true totals.
    #[test]
    fn a_change_everywhere_is_cut_to_a_bound_and_says_so() {
        let before: String = (1..=4000).map(|n| format!("line {n}\n")).collect();
        let after: String = (1..=4000)
            .map(|n| if n % 40 == 0 { format!("changed {n}\n") } else { format!("line {n}\n") })
            .collect();

        let change = summarize(&before, &after, 1);
        assert_eq!(change["added"], json!(100));
        assert_eq!(change["removed"], json!(100));
        let hunks = change["hunks"].as_array().unwrap().len();
        assert!(hunks <= MAX_HUNKS, "kept {hunks} hunks");
        assert_eq!(change["omittedHunks"], json!(100 - hunks));
    }

    /// A whole new file is one run of additions with nothing to break it up,
    /// so the bound has to hold inside a hunk and not only between hunks.
    #[test]
    fn a_whole_new_file_is_cut_inside_its_one_hunk() {
        let after: String = (1..=3000).map(|n| format!("line {n}\n")).collect();

        let change = summarize("", &after, 1);
        assert_eq!(change["added"], json!(3000));
        assert_eq!(change["hunks"].as_array().unwrap().len(), 1);
        assert_eq!(change["hunks"][0]["lines"].as_array().unwrap().len(), MAX_LINES);
        assert_eq!(change["omittedLines"], json!(3000 - MAX_LINES));
        assert!(change.get("omittedHunks").is_none());
        // Which is the whole point: it fits on the wire.
        assert!(serde_json::to_string(&change).unwrap().len() < 20_000);
    }

    /// A file rewritten from end to end shares no line with what it replaced,
    /// so there is nothing to line up by. It is reported as one run replaced
    /// by another — coarse, but true, and still counted exactly.
    #[test]
    fn a_wholly_rewritten_large_file_is_one_replaced_run() {
        let before: String = (1..=3000).map(|n| format!("old {n}\n")).collect();
        let after: String = (1..=3000).map(|n| format!("new {n}\n")).collect();

        let change = summarize(&before, &after, 1);
        assert_eq!(change["added"], json!(3000));
        assert_eq!(change["removed"], json!(3000));
        assert_eq!(change["hunks"].as_array().unwrap().len(), 1);
        // Clipped to the bound, with the counts above still exact.
        assert_eq!(change["hunks"][0]["lines"].as_array().unwrap().len(), MAX_LINES);
        assert_eq!(change["omittedLines"], json!(6000 - MAX_LINES));
    }

    /// A large file changed all through it is past the comparison bound, and
    /// is cut at its unique shared lines rather than given up on: what comes
    /// back is every real change in its own place, not one enormous replace.
    #[test]
    fn a_large_file_changed_all_through_is_cut_at_its_unique_lines() {
        let before: String = (1..=4000).map(|n| format!("line {n}\n")).collect();
        let after: String = (1..=4000)
            .map(|n| if n % 500 == 0 { format!("changed {n}\n") } else { format!("line {n}\n") })
            .collect();

        let change = summarize(&before, &after, 1);
        assert_eq!(change["added"], json!(8));
        assert_eq!(change["removed"], json!(8));
        assert_eq!(change["hunks"].as_array().unwrap().len(), 8);
        assert_eq!(change["hunks"][0]["oldStart"], json!(494));
    }

    /// A file with no trailing newline is not one line shorter than it looks,
    /// and neither is one with a trailing newline one line longer.
    #[test]
    fn the_last_newline_is_not_a_line_of_its_own() {
        assert_eq!(summarize("a\nb", "a\nb", 1)["beforeLines"], json!(2));
        assert_eq!(summarize("a\nb\n", "a\nb\n", 1)["beforeLines"], json!(2));
    }
}
