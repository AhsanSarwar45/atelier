//! A card, a chat or a skill named in a message, and what the agent is told
//! about it (bw-mi3s.2).
//!
//! The composer writes `@bead:bw-zldt.2`, `@chat:<id>` and `@skill:standup`
//! into the message as plain text, and the person sees each as a badge. The
//! agent gets the same text plus one block Atelier adds after it, which says
//! what each reference is:
//!
//! - a card: its title, status, type, priority, parent, acceptance and
//!   description, and the command that shows the rest of it;
//! - a chat: its id, its name and its provider, and the command that prints the
//!   whole conversation. Nothing of the conversation itself: a chat can be
//!   hours long, and the agent reads it only if it needs to;
//! - a skill: its text, as guidance for this request. `/skill:<id>` at the
//!   start of a message is the command form, and its own block says to run it
//!   (`library.rs`, `Snapshot::command_block`).
//!
//! The grammar is the composer's (`src/workbench/references.ts`), and both
//! sides are held to one list of cases (`atelier-references.cases.json`).

use std::collections::HashSet;

use super::library::Snapshot;
use super::metadata::{added_by_atelier, REFERENCES};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Bead,
    Chat,
    Skill,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Bead => "bead",
            Kind::Chat => "chat",
            Kind::Skill => "skill",
        }
    }
}

/// One reference found in a text, with the byte span it occupies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub kind: Kind,
    pub id: String,
    pub start: usize,
    pub end: usize,
    /// Written as a command at the start of the message.
    pub run: bool,
}

/// What may sit right before the `@`: nothing, or something that ends a word.
fn begins_after(c: char) -> bool {
    c.is_whitespace() || "([{<'\"`,;:!?~=".contains(c)
}

fn id_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-')
}

/// The id starting at `from`, ending on a letter or a digit, with nothing
/// word-like after it — the longest that fits, the way the composer's pattern
/// backtracks.
fn id_at(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.get(from).is_some_and(u8::is_ascii_alphanumeric) {
        return None;
    }
    let mut run = from;
    while run < bytes.len() && id_char(bytes[run]) {
        run += 1;
    }
    (from + 1..=run).rev().find(|&end| {
        bytes[end - 1].is_ascii_alphanumeric()
            && !bytes.get(end).is_some_and(|&c| c.is_ascii_alphanumeric() || c == b'_')
    })
}

fn reference_at(text: &str, at: usize) -> Option<Found> {
    let rest = &text[at + 1..];
    for kind in [Kind::Bead, Kind::Chat, Kind::Skill] {
        let prefix = format!("{}:", kind.word());
        if rest.starts_with(&prefix) {
            let from = at + 1 + prefix.len();
            let end = id_at(text, from)?;
            return Some(Found { kind, id: text[from..end].to_string(), start: at, end, run: false });
        }
    }
    None
}

/// The spans of fenced blocks and inline code, which name nothing.
fn code_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    // Fenced blocks: a line opening with ``` or ~~~ runs to a line opening
    // with the same fence, or to the end.
    let mut offset = 0;
    let mut open: Option<(usize, String)> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let fence: String = trimmed.chars().take_while(|&c| c == '`' || c == '~').collect();
        let is_fence = fence.len() >= 3 && fence.chars().all(|c| c == fence.chars().next().unwrap());
        match &open {
            None if is_fence => open = Some((offset, fence)),
            Some((start, opened)) if trimmed.starts_with(opened.as_str()) => {
                let end = offset + line.trim_end_matches('\n').len();
                spans.push((*start, end));
                open = None;
            }
            _ => {}
        }
        offset += line.len();
    }
    if let Some((start, _)) = open {
        spans.push((start, text.len()));
    }
    // Inline code outside them: a run of backticks to the next run as long.
    let fenced = spans.clone();
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'`' || fenced.iter().any(|&(s, e)| at >= s && at < e) {
            at += 1;
            continue;
        }
        let mut n = 0;
        while at + n < bytes.len() && bytes[at + n] == b'`' {
            n += 1;
        }
        let mut close = at + n;
        while close < bytes.len() && bytes[close] != b'`' {
            close += 1;
        }
        let mut m = 0;
        while close + m < bytes.len() && bytes[close + m] == b'`' {
            m += 1;
        }
        if close < bytes.len() && m >= n {
            spans.push((at, close + n));
            at = close + n;
        } else {
            at += n;
        }
    }
    spans
}

/// Every reference in a message, in the order written.
pub fn find(text: &str) -> Vec<Found> {
    let mut found = Vec::new();
    if let Some(rest) = text.strip_prefix("/skill:") {
        let from = "/skill:".len();
        if let Some(end) = id_at(text, from) {
            found.push(Found { kind: Kind::Skill, id: rest[..end - from].to_string(), start: 0, end, run: true });
        }
    }
    if !text.contains('@') {
        return found;
    }
    let code = code_spans(text);
    for (at, _) in text.match_indices('@') {
        if let Some(before) = text[..at].chars().next_back() {
            if !begins_after(before) {
                continue;
            }
        }
        if code.iter().any(|&(s, e)| at >= s && at < e) {
            continue;
        }
        if let Some(reference) = reference_at(text, at) {
            found.push(reference);
        }
    }
    found
}

/// Everything the server knows about the things a message names, looked up
/// before the block is written.
#[derive(Debug, Default, Clone)]
pub struct Looked {
    /// Each card as `bd show --json` or the held board has it; None when the
    /// board has no such card.
    pub cards: Vec<(String, Option<serde_json::Value>)>,
    /// Each chat's name and provider; None when there is no such chat.
    pub chats: Vec<(String, Option<(String, String)>)>,
}

/// How much of a card's long text is carried, so a card with an essay in it
/// does not crowd the person's own words out of the turn.
const CARD_TEXT: usize = 2_000;

fn clipped(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}… (cut short)")
}

fn brand_name(brand: &str) -> &str {
    match brand {
        "claude" => "Claude",
        "codex" => "Codex",
        "local" => "a local model",
        other => other,
    }
}

fn card_entry(id: &str, card: Option<&serde_json::Value>) -> String {
    let Some(card) = card else {
        return format!("@bead:{id} is not a card on this project's board.");
    };
    let text = |key: &str| card.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
    let mut lines = vec![format!("@bead:{id} — card \"{}\"", text("title").unwrap_or(""))];
    let mut facts = vec![format!("status {}", text("status").unwrap_or("unknown"))];
    if let Some(kind) = text("issue_type") {
        facts.push(format!("type {kind}"));
    }
    if let Some(priority) = card.get("priority").and_then(|v| v.as_i64()) {
        facts.push(format!("priority P{priority}"));
    }
    if let Some(parent) = text("parent_id").or_else(|| text("parent")) {
        facts.push(format!("parent {parent}"));
    }
    lines.push(facts.join(", "));
    if let Some(acceptance) = text("acceptance_criteria") {
        lines.push(format!("Acceptance: {}", clipped(acceptance, CARD_TEXT)));
    }
    if let Some(description) = text("description") {
        lines.push(format!("Description:\n{}", clipped(description, CARD_TEXT)));
    }
    lines.push(format!("Run `bd show {id}` for the whole card."));
    lines.join("\n")
}

fn chat_entry(id: &str, chat: Option<&(String, String)>) -> String {
    match chat {
        Some((name, brand)) => format!(
            "@chat:{id} — Atelier chat \"{name}\" with {}. Its conversation is not included; print the whole of it with `atelier tool chat read {id}` if you need it.",
            brand_name(brand)
        ),
        None => format!("@chat:{id} is not a chat Atelier knows."),
    }
}

fn skill_entry(id: &str, library: &Snapshot) -> String {
    match library.skill_text(id) {
        Ok((name, text)) => format!(
            "@skill:{id} — Atelier shared skill \"{name}\" (revision {}). Use it as guidance for this request; it is not a command to run on its own:\n\n{text}",
            library.revision
        ),
        Err(why) => format!("@skill:{id} could not be read: {why}"),
    }
}

/// The block Atelier adds after a message that names cards, chats or skills,
/// or nothing when it names none. A command at the start is left to its own
/// block, and a thing named twice is described once.
pub fn block(found: &[Found], looked: &Looked, library: &Snapshot) -> Option<String> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for reference in found.iter().filter(|r| !r.run) {
        if !seen.insert((reference.kind, reference.id.clone())) {
            continue;
        }
        entries.push(match reference.kind {
            Kind::Bead => card_entry(
                &reference.id,
                looked.cards.iter().find(|(id, _)| *id == reference.id).and_then(|(_, c)| c.as_ref()),
            ),
            Kind::Chat => chat_entry(
                &reference.id,
                looked.chats.iter().find(|(id, _)| *id == reference.id).and_then(|(_, c)| c.as_ref()),
            ),
            Kind::Skill => skill_entry(&reference.id, library),
        });
    }
    if entries.is_empty() {
        return None;
    }
    Some(added_by_atelier(
        REFERENCES,
        &format!(
            "The user's message names these Atelier items with @kind:id references. Atelier added this description of each; the user did not type it.\n\n{}",
            entries.join("\n\n")
        ),
    ))
}

/// The ids a message's cards and chats are to be looked up by.
pub fn wanted(found: &[Found], kind: Kind) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for reference in found.iter().filter(|r| r.kind == kind && !r.run) {
        if !ids.contains(&reference.id) {
            ids.push(reference.id.clone());
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        text: String,
        found: Vec<CaseFound>,
    }

    #[derive(serde::Deserialize)]
    struct CaseFound {
        kind: String,
        id: String,
        start: usize,
        end: usize,
        run: bool,
    }

    #[test]
    fn reads_what_the_composer_reads() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../src/workbench/atelier-references.cases.json")).unwrap();
        for case in cases {
            let got: Vec<_> = find(&case.text)
                .into_iter()
                .map(|f| (f.kind.word().to_string(), f.id, f.start, f.end, f.run))
                .collect();
            let want: Vec<_> = case.found.into_iter().map(|f| (f.kind, f.id, f.start, f.end, f.run)).collect();
            assert_eq!(got, want, "{:?}", case.text);
        }
    }

    #[test]
    fn a_chat_is_its_id_name_and_provider_and_how_to_read_it() {
        let found = find("see @chat:abc-1");
        let looked = Looked { chats: vec![("abc-1".into(), Some(("Standup".into(), "claude".into())))], ..Default::default() };
        let block = block(&found, &looked, &Snapshot::default()).unwrap();
        assert!(block.contains("@chat:abc-1 — Atelier chat \"Standup\" with Claude"));
        assert!(block.contains("atelier tool chat read abc-1"));
        assert!(block.starts_with(&format!("<{REFERENCES}>")));
    }

    #[test]
    fn a_card_carries_what_it_is_and_is_described_once() {
        let found = find("@bead:bw-1 and again @bead:bw-1");
        let card = serde_json::json!({"title":"Fix it","status":"open","issue_type":"bug","priority":1,"parent_id":"bw","acceptance_criteria":"It works","description":"Long story"});
        let looked = Looked { cards: vec![("bw-1".into(), Some(card))], ..Default::default() };
        let block = block(&found, &looked, &Snapshot::default()).unwrap();
        assert_eq!(block.matches("@bead:bw-1 —").count(), 1);
        for want in ["card \"Fix it\"", "status open, type bug, priority P1, parent bw", "Acceptance: It works", "Long story", "bd show bw-1"] {
            assert!(block.contains(want), "{want} missing from {block}");
        }
    }

    #[test]
    fn a_missing_card_or_chat_is_said_so_rather_than_failing_the_message() {
        let found = find("@bead:bw-9 @chat:gone");
        let block = block(&found, &Looked::default(), &Snapshot::default()).unwrap();
        assert!(block.contains("@bead:bw-9 is not a card"));
        assert!(block.contains("@chat:gone is not a chat"));
    }

    #[test]
    fn a_leading_skill_command_is_not_described_twice() {
        assert!(block(&find("/skill:standup today"), &Looked::default(), &Snapshot::default()).is_none());
    }
}
