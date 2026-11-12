//! A chat, a skill, a diff or a task named in a message, and what the agent is told
//! about it (bw-mi3s.2).
//!
//! The composer writes `@chat:<id>`, `@skill:standup`, `@diff:…` and `@task:12`
//! into the message as plain text, and the person sees each as a badge. The
//! agent gets the same text plus one block Atelier adds after it, which says
//! what each reference is:
//!
//! - a chat: its id, its name and its provider, and the command that prints the
//!   whole conversation. Nothing of the conversation itself: a chat can be
//!   hours long, and the agent reads it only if it needs to;
//! - a skill: its text, as guidance for this request. `/skill:<id>` at the
//!   start of a message is the command form, and its own block says to run it
//!   (`library.rs`, `Snapshot::command_block`);
//! - a diff: the change it points at, as the hunks that cover the lines it
//!   names. `@diff:src/a.ts:+12-14` is the uncommitted change, lines 12 to 14
//!   of the new version; `@diff:abc1234:src/a.ts:-30` is line 30 of the old
//!   version in what commit abc1234 did (bw-v79ny.1);
//! - a task: `@task:12` is task #12 of the chat's project, described by its
//!   number, type, status, title, why, holder and plan. A bare `@task` is the
//!   owner asking for a new task from the message, and its entry says so
//!   (docs/tasks.md). It is found with an empty id.
//! - a merge: a bare `@merge` is the owner asking the agent to merge the
//!   chat's branch into the base branch. Its entry carries what git says about
//!   the chat's folder (`tasks::git::merge_instructions`). Like a bare `@task`
//!   it has an empty id, and `@merge:…` is nothing.
//!
//! - a grid: `@grid:camera` is coverage grid "camera", and
//!   `@grid:camera.glare+sunstar.gpu+perf` cells of it (rows, then columns,
//!   each `*` or ids joined by `+`); its id has its own scanner, like a diff's
//!   (docs/grids.md). A bare `@matrix` asks the agent to draft a grid of the
//!   area the message describes, and a bare `@audit` followed by a slug asks
//!   it to audit that grid. Both carry their own steps and have empty ids.
//!
//! The grammar is the composer's (`src/workbench/references.ts`), and both
//! sides are held to one list of cases (`atelier-references.cases.json`).
//! `@bead:…`, which named a card on the retired board, is no longer a
//! reference: older messages that hold it read as the plain text they are.

use std::collections::HashSet;

use crate::routes::git::DiffFile;

use super::library::Snapshot;
use super::metadata::{added_by_atelier, REFERENCES};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Chat,
    Skill,
    Diff,
    Task,
    Merge,
    Grid,
    Matrix,
    Audit,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Chat => "chat",
            Kind::Skill => "skill",
            Kind::Diff => "diff",
            Kind::Task => "task",
            Kind::Merge => "merge",
            Kind::Grid => "grid",
            Kind::Matrix => "matrix",
            Kind::Audit => "audit",
        }
    }
}

/// Which version of a file a diff reference's lines are counted in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// `+`: the file as it is after the change.
    New,
    /// `-`: the file as it was before it.
    Old,
}

/// What a `@diff:` reference's id says: which change, to which file, and
/// which of its lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffRef {
    /// The commit, or None for what is not committed yet.
    pub commit: Option<String>,
    /// The path from the repository root.
    pub path: String,
    pub side: Side,
    pub line: Option<u32>,
    pub end_line: Option<u32>,
}

fn is_lines(segment: &str) -> Option<(Side, u32, Option<u32>)> {
    let (side, rest) = match segment.as_bytes().first()? {
        b'+' => (Side::New, &segment[1..]),
        b'-' => (Side::Old, &segment[1..]),
        _ => (Side::New, segment),
    };
    let (first, last) = match rest.split_once('-') {
        Some((first, last)) => (first, Some(last)),
        None => (rest, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(first) || last.is_some_and(|l| !digits(l)) {
        return None;
    }
    let line: u32 = first.parse().ok()?;
    let end = match last {
        Some(l) => Some(l.parse::<u32>().ok()?).filter(|&e| e != line),
        None => None,
    };
    Some((side, line, end))
}

fn is_commit(segment: &str) -> bool {
    (7..=40).contains(&segment.len()) && segment.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

impl DiffRef {
    /// The id after `@diff:` read back, or None when it names no file.
    pub fn parse(id: &str) -> Option<DiffRef> {
        let mut segments: Vec<&str> = id.split(':').collect();
        let mut lines = None;
        if segments.len() > 1 {
            if let Some(found) = is_lines(segments[segments.len() - 1]) {
                lines = Some(found);
                segments.pop();
            }
        }
        let mut commit = None;
        if segments.len() > 1 && is_commit(segments[0]) {
            commit = Some(segments.remove(0).to_string());
        }
        let path = segments.join(":");
        if path.is_empty() {
            return None;
        }
        let (side, line, end_line) = match lines {
            Some((side, line, end)) => (side, Some(line), end),
            None => (Side::New, None, None),
        };
        Some(DiffRef { commit, path, side, line, end_line })
    }

    /// The lines it names, in words.
    fn lines_in_words(&self) -> Option<String> {
        let line = self.line?;
        let version = match self.side {
            Side::New => "new",
            Side::Old => "old",
        };
        Some(match self.end_line {
            Some(end) => format!("lines {line}-{end} of the {version} version"),
            None => format!("line {line} of the {version} version"),
        })
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

/// What a diff reference's id may hold: a path, a commit, and lines.
fn diff_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'/' | b'~' | b'@' | b'+' | b':')
}

/// A diff reference's id starting at `from`: the run of what an id may hold,
/// ending on a letter or a digit so the sentence keeps its full stop, and
/// naming a file.
fn diff_id_at(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.get(from).is_some_and(|&c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'/' | b'~')) {
        return None;
    }
    let mut end = from;
    while end < bytes.len() && diff_char(bytes[end]) {
        end += 1;
    }
    while end > from && !bytes[end - 1].is_ascii_alphanumeric() {
        end -= 1;
    }
    (end > from && DiffRef::parse(&text[from..end]).is_some()).then_some(end)
}

/// Whether a change to `path` can be written as `@diff:path` and read back as
/// the same path. A space, a letter outside ASCII or a `:` would end or split
/// the reference, so such a path is never offered as one.
pub fn diff_path_writable(path: &str) -> bool {
    diff_id_at(path, 0) == Some(path.len())
        && DiffRef::parse(path).is_some_and(|diff| diff.commit.is_none() && diff.line.is_none() && diff.path == path)
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

/// A grid reference's id starting at `from`: the longest run that reads as a
/// grid or a selection of its cells, with nothing id-like after it, so a
/// sentence keeps its full stop.
fn grid_id_at(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut run = from;
    while run < bytes.len() && (bytes[run].is_ascii_lowercase() || bytes[run].is_ascii_digit() || b"_-.*+".contains(&bytes[run])) {
        run += 1;
    }
    (from + 1..=run).rev().find(|&end| {
        !bytes.get(end).is_some_and(|&c| c.is_ascii_alphanumeric() || b"_*+-".contains(&c))
            && super::grids::Selection::parse(&text[from..end]).is_some()
    })
}

/// The grid slugs named after each bare `@audit` in a message.
pub fn audit_slugs(text: &str) -> Vec<String> {
    let mut slugs = Vec::new();
    for found in find(text).into_iter().filter(|f| f.kind == Kind::Audit) {
        let rest = text[found.end..].trim_start();
        let word: String =
            rest.chars().take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-').collect();
        if super::grids::valid_id(&word) && !slugs.contains(&word) {
            slugs.push(word);
        }
    }
    slugs
}

/// A task's number: digits, not starting with 0.
pub fn task_number(id: &str) -> Option<i64> {
    (!id.starts_with('0') && !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
        .then(|| id.parse().ok())
        .flatten()
}

fn reference_at(text: &str, at: usize) -> Option<Found> {
    let rest = &text[at + 1..];
    if rest.starts_with("grid:") {
        let from = at + 1 + "grid:".len();
        let end = grid_id_at(text, from)?;
        return Some(Found { kind: Kind::Grid, id: text[from..end].to_string(), start: at, end, run: false });
    }
    for kind in [Kind::Chat, Kind::Skill, Kind::Diff, Kind::Task] {
        let prefix = format!("{}:", kind.word());
        if rest.starts_with(&prefix) {
            let from = at + 1 + prefix.len();
            let end = if kind == Kind::Diff { diff_id_at(text, from)? } else { id_at(text, from)? };
            let id = &text[from..end];
            if kind == Kind::Task && task_number(id).is_none() {
                return None;
            }
            return Some(Found { kind, id: id.to_string(), start: at, end, run: false });
        }
    }
    // A bare `@task`, as a word of its own: the owner asking for a new task.
    if rest.starts_with("task") && rest[4..].chars().next().is_none_or(char::is_whitespace) {
        return Some(Found { kind: Kind::Task, id: String::new(), start: at, end: at + 5, run: false });
    }
    // A bare `@merge`: the owner asking the agent to merge this branch.
    if rest.starts_with("merge") && rest[5..].chars().next().is_none_or(char::is_whitespace) {
        return Some(Found { kind: Kind::Merge, id: String::new(), start: at, end: at + 6, run: false });
    }
    // A bare `@matrix`: the owner asking for a grid of the area; a bare
    // `@audit`, for an audit of the grid named after it.
    for (word, kind) in [("matrix", Kind::Matrix), ("audit", Kind::Audit)] {
        if rest.starts_with(word) && rest[word.len()..].chars().next().is_none_or(char::is_whitespace) {
            return Some(Found { kind, id: String::new(), start: at, end: at + 1 + word.len(), run: false });
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
    /// Each chat's name and provider; None when there is no such chat.
    pub chats: Vec<(String, Option<(String, String)>)>,
    /// Each diff's patch for its file; None when there is no such change.
    pub diffs: Vec<(String, Option<DiffFile>)>,
    /// Each task as the HTTP API has it (`tasks::to_json`); None when the
    /// project has no such task.
    pub tasks: Vec<(String, Option<serde_json::Value>)>,
    /// What a bare `@merge` tells the agent, worked out from git in the
    /// chat's folder (`tasks::git::merge_instructions`).
    pub merge: Option<String>,
    /// What each `@grid:` reference says (`grids::describe`), by id.
    pub grids: Vec<(String, String)>,
    /// The slugs named after a bare `@audit` (`audit_slugs`).
    pub audit_slugs: Vec<String>,
}

/// How much of a task's long text is carried, so a task with an essay in it
/// does not crowd the person's own words out of the turn.
const LONG_TEXT: usize = 2_000;

fn clipped(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{cut}… (cut short)")
}

pub(super) fn brand_name(brand: &str) -> &str {
    match brand {
        "claude" => "Claude",
        "codex" => "Codex",
        "local" => "a local model",
        other => other,
    }
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

/// How much of a patch is carried, so a reference to a rewritten file does
/// not become the whole turn.
const DIFF_LINES: usize = 400;

fn diff_entry(id: &str, file: Option<&DiffFile>) -> String {
    let Some(reference) = DiffRef::parse(id) else {
        return format!("@diff:{id} does not name a file.");
    };
    let which = match &reference.commit {
        Some(sha) => format!("commit {sha}'s change to {}", reference.path),
        None => format!("the uncommitted change to {}", reference.path),
    };
    let Some(file) = file else {
        return format!("@diff:{id} — there is no {which} in this chat's checkout.");
    };
    let mut head = format!("@diff:{id} — {which}");
    if let Some(lines) = reference.lines_in_words() {
        head.push_str(&format!(", {lines}"));
    }
    head.push_str(&format!(" ({}, +{} -{})", file.status, file.additions, file.deletions));
    if file.binary {
        return format!("{head}. It is a binary file, so there are no lines to show.");
    }
    // The hunks that touch the lines named, or every hunk when none are.
    let wanted = reference.line.map(|line| (line, reference.end_line.unwrap_or(line)));
    let hunks: Vec<_> = file
        .hunks
        .iter()
        .filter(|hunk| {
            let Some((from, to)) = wanted else { return true };
            let (start, count) = match reference.side {
                Side::New => (hunk.new_start, hunk.new_lines),
                Side::Old => (hunk.old_start, hunk.old_lines),
            };
            start <= to && from < start + count.max(1)
        })
        .collect();
    if hunks.is_empty() {
        return format!("{head}. Those lines are unchanged; the change is elsewhere in the file.");
    }
    let mut patch = Vec::new();
    for hunk in hunks {
        patch.push(format!("@@ -{},{} +{},{} @@", hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines));
        for line in &hunk.lines {
            let mark = match line.kind.as_str() {
                "added" => '+',
                "removed" => '-',
                _ => ' ',
            };
            patch.push(format!("{mark}{}", line.text));
        }
    }
    let cut = patch.len() > DIFF_LINES;
    patch.truncate(DIFF_LINES);
    let mut entry = format!("{head}:\n```diff\n{}\n```", patch.join("\n"));
    if cut {
        entry.push_str("\n(cut short; read the rest with git diff)");
    }
    entry
}

/// What a bare `@matrix` asks of the agent (docs/grids.md, "Drafting").
pub const NEW_GRID: &str = "@matrix — The owner asks you to draft a coverage grid for the area this message describes: \
one row per user-visible feature, one column per requirement, a cell for each pair. Steps:
1. Read the area's code. Write and commit a row-search script that prints one JSON line per feature, \
`{\"id\", \"name\", \"paths\": [...]}`, plus a combination line `{\"id\", \"name\", \"kind\": \"combination\", \"of\": [ids]}` \
for features that interact (share energy, a buffer or a pass). Ids are lower-case letters, digits, _ and -. Run it and check the output.
2. Run `atelier grid template list`, pick the template that fits, and add the grid's own columns \
(`{id, name, proof_rule}`) only for requirements the template lacks.
3. Run `atelier grid list --rows` to see which features other grids already own; add those as reference rows \
(`{\"id\", \"name\", \"kind\": \"reference\", \"ref\": {\"grid\", \"row\"}}`), not new rows.
4. Run `atelier grid draft` with `{slug, title, area, template?, row_search: {command, watch: [path prefixes]}, columns, rows}` \
on stdin, then stop and end your turn. The owner approves or discards the draft on its card; their answer, or \
the changes they want (draft again with the same slug), arrives as your next message.
5. Once it is approved, work through it: `atelier grid next SLUG` prints the next free cells and a ready \
`atelier task create` payload (no @task needed for cells of an approved grid). Create it, start it, prove each cell and tick its item \
at once (`atelier task check N ROW.COL`), finish with `atelier task done N`, and repeat until no gaps are left.";

/// What a bare `@audit SLUG` asks of the agent.
fn audit_entry(slugs: &[String]) -> String {
    let Some(slug) = slugs.first() else {
        return "@audit — The owner asks for an audit, but no grid slug follows @audit. Ask which grid (`atelier grid list`).".into();
    };
    format!(
        "@audit {slug} — The owner asks you to audit coverage grid \"{slug}\" adversarially. Run `atelier grid audit {slug}` \
for its proved cells, each with its column's proof_rule, proof and last check. For each, decide whether the checks \
really test the proof_rule, whether the ground truth is independent of the code under test, whether benchmarks are \
measured rather than asserted, and whether combinations are really exercised. Read the tests themselves. Then give a \
verdict on every cell: `atelier grid pass {slug} ROW COL [--note TEXT]`, or `atelier grid reopen {slug} ROW COL --reason TEXT` \
with what is missing. Finish with `atelier grid audit {slug} --done`. You may not judge cells this chat proved."
    )
}

/// What a bare `@task` asks of the agent.
const NEW_TASK: &str = "@task — The owner asks you to create a task from this message. Pick the type, draft the plan and run `atelier task create` (`atelier task types TYPE` prints the payload); do not ask for confirmation first. A task for cells of an approved grid needs no @task: `atelier grid next SLUG` prints its payload.";

fn task_entry(id: &str, task: Option<&serde_json::Value>) -> String {
    if id.is_empty() {
        return NEW_TASK.to_string();
    }
    let Some(task) = task else {
        return format!("@task:{id} is not a task in this project.");
    };
    let text = |key: &str| task.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
    let holder = match (text("sessionId"), text("sessionTitle")) {
        (Some(session), Some(title)) => format!("held by chat \"{title}\" ({session})"),
        (Some(session), None) => format!("held by chat {session}"),
        _ => "unassigned".to_string(),
    };
    let mut lines = vec![
        format!("@task:{id} — task #{id} \"{}\"", text("title").unwrap_or("")),
        format!(
            "type {}, status {}, {holder}",
            text("type").unwrap_or("unknown"),
            text("status").unwrap_or("unknown")
        ),
    ];
    if let Some(why) = text("why") {
        lines.push(format!("Why: {why}"));
    }
    let plan = task.get("plan").map(|plan| plan.to_string()).unwrap_or_else(|| "{}".into());
    lines.push(format!("Plan: {}", clipped(&plan, LONG_TEXT)));
    lines.push(format!("Run `atelier task show {id}` for its result and history."));
    lines.join("\n")
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

/// The block Atelier adds after a message that names chats, skills, diffs or tasks,
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
            Kind::Chat => chat_entry(
                &reference.id,
                looked.chats.iter().find(|(id, _)| *id == reference.id).and_then(|(_, c)| c.as_ref()),
            ),
            Kind::Skill => skill_entry(&reference.id, library),
            Kind::Diff => diff_entry(
                &reference.id,
                looked.diffs.iter().find(|(id, _)| *id == reference.id).and_then(|(_, d)| d.as_ref()),
            ),
            Kind::Task => task_entry(
                &reference.id,
                looked.tasks.iter().find(|(id, _)| *id == reference.id).and_then(|(_, t)| t.as_ref()),
            ),
            Kind::Merge => looked.merge.clone().unwrap_or_else(|| {
                "@merge — The owner asks you to merge this chat's branch into the base branch, but Atelier could not read git here. Tell the owner so.".to_string()
            }),
            Kind::Matrix => NEW_GRID.to_string(),
            Kind::Audit => audit_entry(&looked.audit_slugs),
            Kind::Grid => looked
                .grids
                .iter()
                .find(|(id, _)| *id == reference.id)
                .map(|(_, entry)| entry.clone())
                .unwrap_or_else(|| format!("@grid:{} could not be read.", reference.id)),
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

/// The ids a message's chats, diffs and tasks are to be looked up by. A bare
/// `@task` names nothing to look up.
pub fn wanted(found: &[Found], kind: Kind) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for reference in found.iter().filter(|r| r.kind == kind && !r.run && !r.id.is_empty()) {
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
    fn a_missing_chat_is_said_so_rather_than_failing_the_message() {
        let found = find("@bead:bw-9 @chat:gone");
        let block = block(&found, &Looked::default(), &Snapshot::default()).unwrap();
        // A card on the retired board is plain text now, and is not described.
        assert!(!block.contains("bw-9"));
        assert!(block.contains("@chat:gone is not a chat"));
    }

    #[test]
    fn a_diff_id_names_its_commit_its_file_and_its_lines() {
        let working = DiffRef::parse("src/a.ts:+12-14").unwrap();
        assert_eq!(working, DiffRef { commit: None, path: "src/a.ts".into(), side: Side::New, line: Some(12), end_line: Some(14) });
        let old = DiffRef::parse("abc1234:src/a.ts:-30").unwrap();
        assert_eq!((old.commit.as_deref(), old.side, old.line, old.end_line), (Some("abc1234"), Side::Old, Some(30), None));
        // A file whose name looks like a commit is still a file.
        assert_eq!(DiffRef::parse("abcdef1:+3").unwrap().path, "abcdef1");
        assert_eq!(DiffRef::parse("README.md").unwrap().line, None);
    }

    fn patched() -> DiffFile {
        use crate::routes::git::{DiffHunk, DiffLine};
        let line = |kind: &str, text: &str| DiffLine { kind: kind.into(), text: text.into() };
        DiffFile {
            path: "src/a.ts".into(),
            old_path: None,
            status: "modified".into(),
            additions: 2,
            deletions: 1,
            binary: false,
            hunks: vec![
                DiffHunk { old_start: 1, old_lines: 2, new_start: 1, new_lines: 2, lines: vec![line("removed", "one"), line("added", "uno"), line("context", "two")] },
                DiffHunk { old_start: 40, old_lines: 1, new_start: 40, new_lines: 2, lines: vec![line("context", "forty"), line("added", "more")] },
            ],
        }
    }

    #[test]
    fn a_diff_carries_the_hunks_that_cover_its_lines() {
        let found = find("look @diff:src/a.ts:+41");
        let looked = Looked { diffs: vec![("src/a.ts:+41".into(), Some(patched()))], ..Default::default() };
        let block = block(&found, &looked, &Snapshot::default()).unwrap();
        assert!(block.contains("the uncommitted change to src/a.ts, line 41 of the new version"), "{block}");
        assert!(block.contains("@@ -40,1 +40,2 @@\n forty\n+more"), "{block}");
        assert!(!block.contains("uno"), "{block}");
    }

    #[test]
    fn a_diff_with_no_lines_carries_every_hunk_and_a_missing_one_says_so() {
        let found = find("@diff:src/a.ts and @diff:abc1234:gone.ts");
        let looked = Looked { diffs: vec![("src/a.ts".into(), Some(patched())), ("abc1234:gone.ts".into(), None)], ..Default::default() };
        let block = block(&found, &looked, &Snapshot::default()).unwrap();
        assert!(block.contains("-one\n+uno") && block.contains("+more"), "{block}");
        assert!(block.contains("there is no commit abc1234's change to gone.ts"), "{block}");
    }

    #[test]
    fn a_bare_merge_carries_what_git_said_about_the_chats_folder() {
        let found = find("done, @merge please");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].kind, found[0].id.as_str(), found[0].start, found[0].end), (Kind::Merge, "", 6, 12));
        let looked = Looked { merge: Some("@merge — base branch: main".into()), ..Default::default() };
        let block = block(&found, &looked, &Snapshot::default()).unwrap();
        assert!(block.contains("@merge — base branch: main"), "{block}");
        let unknown = super::block(&found, &Looked::default(), &Snapshot::default()).unwrap();
        assert!(unknown.contains("could not read git"), "{unknown}");
        assert!(find("@merged @merge:main").is_empty());
    }

    #[test]
    fn a_bare_task_asks_the_agent_to_create_one_without_asking_again() {
        let found = find("@task fix the login redirect");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].kind, found[0].id.as_str(), found[0].end), (Kind::Task, "", 5));
        assert!(wanted(&found, Kind::Task).is_empty());
        let block = block(&found, &Looked::default(), &Snapshot::default()).unwrap();
        for want in ["create a task from this message", "atelier task create", "atelier task types TYPE", "do not ask for confirmation"] {
            assert!(block.contains(want), "{want} missing from {block}");
        }
        assert!(find("@tasks are fun").is_empty());
        assert!(find("@task.").is_empty());
    }

    #[test]
    fn a_task_carries_its_number_type_status_title_why_holder_and_plan() {
        let found = find("look at @task:12 and @task:12.");
        assert_eq!(wanted(&found, Kind::Task), ["12"]);
        let task = serde_json::json!({
            "number": 12, "type": "bug", "status": "in_progress", "title": "Login loops",
            "why": "Nobody can sign in", "sessionId": "s-1", "sessionTitle": "Auth chat",
            "plan": {"symptom": "loops", "repro_steps": ["open /login"]},
        });
        let looked = Looked { tasks: vec![("12".into(), Some(task))], ..Default::default() };
        let block = block(&found, &looked, &Snapshot::default()).unwrap();
        assert_eq!(block.matches("@task:12 —").count(), 1, "{block}");
        for want in [
            "task #12 \"Login loops\"",
            "type bug, status in_progress, held by chat \"Auth chat\" (s-1)",
            "Why: Nobody can sign in",
            r#"Plan: {"symptom":"loops","repro_steps":["open /login"]}"#,
            "atelier task show 12",
        ] {
            assert!(block.contains(want), "{want} missing from {block}");
        }
        let missing = super::block(&find("@task:9"), &Looked::default(), &Snapshot::default()).unwrap();
        assert!(missing.contains("@task:9 is not a task in this project"), "{missing}");
        assert!(find("@task:0 @task:x1").is_empty());
    }

    #[test]
    fn matrix_audit_and_grid_references_are_read() {
        let found = find("@matrix the camera, then @audit camera and see @grid:camera.glare+sunstar.*.");
        let kinds: Vec<_> = found.iter().map(|f| (f.kind, f.id.as_str())).collect();
        assert_eq!(kinds, [(Kind::Matrix, ""), (Kind::Audit, ""), (Kind::Grid, "camera.glare+sunstar.*")]);
        assert_eq!(audit_slugs("please @audit camera now"), ["camera"]);
        assert!(audit_slugs("@audit").is_empty());
        assert!(audit_slugs("@audited camera").is_empty());
        assert_eq!(find("@grid:camera.glare.").iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["camera"]);
        assert!(find("@grid:camera+x @grid:Camera").is_empty());
        let block = block(&find("@matrix camera"), &Looked::default(), &Snapshot::default()).unwrap();
        for want in ["atelier grid template list", "atelier grid list --rows", "atelier grid draft", "stop and end your turn"] {
            assert!(block.contains(want), "{want} missing from {block}");
        }
        let looked = Looked { audit_slugs: vec!["camera".into()], ..Default::default() };
        let block = super::block(&find("@audit camera"), &looked, &Snapshot::default()).unwrap();
        for want in ["atelier grid audit camera", "atelier grid pass camera", "--done", "proof_rule"] {
            assert!(block.contains(want), "{want} missing from {block}");
        }
    }

    #[test]
    fn a_leading_skill_command_is_not_described_twice() {
        assert!(block(&find("/skill:standup today"), &Looked::default(), &Snapshot::default()).is_none());
    }
}
