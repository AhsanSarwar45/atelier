//! The board as a search source (bw-21a2.7).
//!
//! `GET /api/beads/search` finds cards by what they say — title, description,
//! comments, notes, design, labels — and narrows them by what they are:
//! `status:`, `type:`, `priority:`, `under:`, `owner:` and the dates. It reads
//! the board the screen already holds rather than an index of its own: a board
//! is a few thousand cards, found in milliseconds, and never a beat behind.
//!
//! `POST /api/beads/search/ask` hands a question to the agent chosen in
//! Settings, which finds cards with `search_cards` and `read_card` and names
//! them (search/agent.rs).

use super::{shared_board, Bead, BoardAnswer, SharedBoard};
use crate::db::Database;
use crate::dolt::DoltManager;
use crate::routes::search_settings::search_settings;
use crate::search::agent::{self, read_only, tool_error, tool_text, Called, Source, Steps};
use crate::search::named::Named;
use crate::search::text::{self, Segment};
use crate::search::words::{self, Dates, Key, Piece, Term, Words};
use axum::{
    extract::{Extension, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Local, Utc};
use futures::future::BoxFuture;
use futures::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// How to search the board, handed to the agent with the question.
const SKILL: &str = include_str!("../../../../machinery/skills/board-search/SKILL.md");

/// The most snippets drawn under one card.
const SNIPPETS: usize = 3;

/// The parts of a card a word can be aimed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Title,
    Description,
    Comments,
    Notes,
    Design,
    Labels,
}

impl Field {
    fn named(key: &str) -> Option<Field> {
        Some(match key {
            "title" | "name" | "id" => Field::Title,
            "desc" | "description" | "body" => Field::Description,
            "comment" | "comments" => Field::Comments,
            "notes" | "note" => Field::Notes,
            "design" => Field::Design,
            "label" | "labels" | "tag" | "tags" => Field::Labels,
            _ => return None,
        })
    }

    /// How much a word found here says the card is the one.
    fn weight(self) -> u32 {
        match self {
            Field::Title => 5,
            Field::Labels => 3,
            Field::Description => 2,
            _ => 1,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Field::Title => "title",
            Field::Description => "description",
            Field::Comments => "comment",
            Field::Notes => "notes",
            Field::Design => "design",
            Field::Labels => "label",
        }
    }
}

/// A key that narrows the cards rather than aiming a word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trait {
    Status,
    Type,
    Priority,
    Under,
    Owner,
}

#[derive(Debug)]
struct Only {
    which: Trait,
    /// Any one will do.
    values: Vec<String>,
    negated: bool,
}

pub struct CardQuery {
    words: Words<Field>,
    only: Vec<Only>,
    dates: Dates,
}

impl CardQuery {
    fn is_empty(&self) -> bool {
        self.words.all.is_empty()
            && self.words.none.is_empty()
            && self.only.is_empty()
            && self.dates == Dates::default()
    }
}

/// A status as typed, the way the board spells one: lowercase, words joined
/// by `_`. The states themselves are the board's (src/types/index.ts), so none
/// is spelled out here; a typed one matches the card's whole, or a piece of it.
fn status(value: &str) -> String {
    value.to_lowercase().replace(['-', ' '], "_")
}

/// `progress` finds `in_progress`, `review` both reviews; `open` only `open`.
fn status_matches(stored: &str, typed: &str) -> bool {
    let stored = stored.to_lowercase();
    stored == typed || stored.replace('_', "").contains(&typed.replace('_', ""))
}

pub fn parse(input: &str, now: DateTime<Local>) -> CardQuery {
    let mut only = Vec::new();
    let mut dates = Dates::default();
    let words = words::read(input, Field::named, |key, piece: &Piece| {
        if let Some(taken) = dates.take(key, &piece.value, now) {
            return taken;
        }
        let which = match key {
            "status" | "state" | "is" => Trait::Status,
            "type" | "kind" => Trait::Type,
            "priority" | "prio" | "p" => Trait::Priority,
            "under" | "parent" | "epic" => Trait::Under,
            "owner" | "assignee" => Trait::Owner,
            _ => return Key::Words,
        };
        let mut values = Vec::new();
        for value in piece.value.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            values.push(match which {
                Trait::Status => status(value),
                Trait::Priority => {
                    let digits = value.trim_start_matches(['p', 'P']);
                    match digits.parse::<i32>() {
                        Ok(n) => n.to_string(),
                        Err(_) => return Key::Unread,
                    }
                }
                _ => value.to_lowercase(),
            });
        }
        if values.is_empty() {
            return Key::Unread;
        }
        only.push(Only { which, values, negated: piece.negated });
        Key::Taken
    });
    CardQuery { words, only, dates }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sort {
    Relevance,
    Newest,
    Priority,
}

impl Sort {
    fn from(written: Option<&str>) -> Sort {
        match written {
            Some("newest") => Sort::Newest,
            Some("priority") => Sort::Priority,
            _ => Sort::Relevance,
        }
    }
}

/// Where in a card a snippet was found.
pub struct Snippet {
    field: Field,
    author: Option<String>,
    segments: Vec<Segment>,
}

pub struct Match<'a> {
    bead: &'a Bead,
    score: u32,
    places: usize,
    title: Option<Vec<Segment>>,
    snippets: Vec<Snippet>,
}

fn instant(written: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(written?).ok().map(|at| at.with_timezone(&Utc))
}

fn when(bead: &Bead) -> Option<&str> {
    bead.updated_at.as_deref().or(bead.created_at.as_deref())
}

/// What a card says, part by part: the one searched and the one drawn.
fn texts(bead: &Bead) -> Vec<(Field, Option<&str>, &str)> {
    let mut texts = vec![(Field::Title, None, bead.title.as_str()), (Field::Title, None, bead.id.as_str())];
    if let Some(description) = &bead.description {
        texts.push((Field::Description, None, description));
    }
    for comment in bead.comments.iter().flatten() {
        texts.push((Field::Comments, Some(comment.author.as_str()), comment.text.as_str()));
    }
    if let Some(notes) = &bead.notes {
        texts.push((Field::Notes, None, notes));
    }
    if let Some(design) = &bead.design {
        texts.push((Field::Design, None, design));
    }
    for label in bead.labels.iter().flatten() {
        texts.push((Field::Labels, None, label));
    }
    texts
}

fn aimed(term: &Term<Field>, field: Field) -> bool {
    term.fields.is_empty() || term.fields.contains(&field)
}

/// Whether `bead` sits anywhere under the card `above`.
fn is_under(bead: &Bead, above: &str, parents: &HashMap<&str, &str>) -> bool {
    let mut at = bead.parent_id.as_deref();
    for _ in 0..64 {
        match at {
            Some(parent) if parent.eq_ignore_ascii_case(above) => return true,
            Some(parent) => at = parents.get(parent).copied(),
            None => return false,
        }
    }
    false
}

fn has_trait(bead: &Bead, only: &Only, parents: &HashMap<&str, &str>) -> bool {
    let any = only.values.iter().any(|value| match only.which {
        Trait::Status => status_matches(&bead.status, value),
        Trait::Type => bead.issue_type.as_deref().is_some_and(|t| t.eq_ignore_ascii_case(value)),
        Trait::Priority => bead.priority.is_some_and(|p| p.to_string() == *value),
        Trait::Under => is_under(bead, value, parents),
        Trait::Owner => bead.owner.as_deref().is_some_and(|o| o.to_lowercase().contains(value.as_str())),
    });
    any != only.negated
}

/// The card, if it is one the query asks for, with where it was found.
fn matched<'a>(bead: &'a Bead, query: &CardQuery, parents: &HashMap<&str, &str>) -> Option<Match<'a>> {
    if !query.only.iter().all(|only| has_trait(bead, only, parents)) {
        return None;
    }
    if query.dates != Dates::default() {
        let at = instant(when(bead))?;
        if query.dates.after.as_deref().and_then(|a| instant(Some(a))).is_some_and(|after| at < after) {
            return None;
        }
        if query.dates.before.as_deref().and_then(|b| instant(Some(b))).is_some_and(|before| at >= before) {
            return None;
        }
    }
    let texts = texts(bead);
    let found_in = |term: &Term<Field>| {
        texts
            .iter()
            .filter(|(field, _, _)| aimed(term, *field))
            .map(|(field, _, said)| (field.weight(), text::find(said, term).len()))
            .filter(|(_, count)| *count > 0)
            .collect::<Vec<_>>()
    };
    if query.words.none.iter().any(|term| !found_in(term).is_empty()) {
        return None;
    }
    let mut score = 0;
    for group in &query.words.all {
        let mut any = false;
        for term in group {
            for (weight, count) in found_in(term) {
                any = true;
                score += weight * count.min(5) as u32;
            }
        }
        if !any {
            return None;
        }
    }

    let terms: Vec<&Term<Field>> = query.words.all.iter().flatten().collect();
    let mut places = 0;
    let mut title = None;
    let mut snippets = Vec::new();
    for (index, (field, author, said)) in texts.iter().enumerate() {
        let aiming: Vec<&Term<Field>> = terms.iter().copied().filter(|term| aimed(term, *field)).collect();
        let at = text::places(said, &aiming);
        if at.is_empty() {
            continue;
        }
        places += at.len();
        match (index, field) {
            (0, _) => title = Some(text::marked(said, &at)),
            (_, Field::Title) => {}
            _ if snippets.len() < SNIPPETS => snippets.push(Snippet {
                field: *field,
                author: author.map(str::to_string),
                segments: text::snippet(said, &at),
            }),
            _ => {}
        }
    }
    Some(Match { bead, score, places, title, snippets })
}

/// A page of the cards the query asks for, and where the next page starts.
pub fn search<'a>(board: &'a [Bead], query: &CardQuery, sort: Sort, offset: usize, limit: usize) -> (Vec<Match<'a>>, Option<usize>) {
    if query.is_empty() {
        return (Vec::new(), None);
    }
    let parents: HashMap<&str, &str> = board
        .iter()
        .filter_map(|bead| Some((bead.id.as_str(), bead.parent_id.as_deref()?)))
        .collect();
    let mut found: Vec<Match> = board.iter().filter_map(|bead| matched(bead, query, &parents)).collect();
    let newest = |a: &Match, b: &Match| when(b.bead).cmp(&when(a.bead));
    match sort {
        Sort::Relevance => found.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| newest(a, b))),
        Sort::Newest => found.sort_by(newest),
        Sort::Priority => found.sort_by(|a, b| {
            a.bead.priority.unwrap_or(9).cmp(&b.bead.priority.unwrap_or(9)).then_with(|| newest(a, b))
        }),
    }
    let next = (found.len() > offset + limit).then_some(offset + limit);
    (found.into_iter().skip(offset).take(limit).collect(), next)
}

fn card_json(found: &Match) -> Value {
    let bead = found.bead;
    json!({
        "id": bead.id,
        "title": bead.title,
        "titleSegments": found.title,
        "status": bead.status,
        "issueType": bead.issue_type,
        "priority": bead.priority,
        "parentId": bead.parent_id,
        "updatedAt": when(bead),
        "matches": found.places,
        "snippets": found.snippets.iter().map(|snippet| json!({
            "field": snippet.field.name(),
            "author": snippet.author,
            "segments": snippet.segments,
        })).collect::<Vec<_>>(),
    })
}

fn board_failure(failed: (StatusCode, Json<BoardAnswer>)) -> String {
    match failed.1 .0 {
        BoardAnswer::Error { error } => error,
        _ => "The board could not be read.".into(),
    }
}

#[derive(Deserialize)]
pub struct SearchParams {
    path: String,
    q: Option<String>,
    sort: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
}

pub async fn search_cards(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<SearchParams>,
) -> Response {
    let board = match shared_board(&dolt_manager, &db, &params.path).await {
        Ok((board, _)) => board,
        Err(failed) => return failed.into_response(),
    };
    let query = parse(params.q.unwrap_or_default().trim_start(), Local::now());
    let limit = params.limit.unwrap_or(30).clamp(1, 100);
    let (cards, next) = search(&board, &query, Sort::from(params.sort.as_deref()), params.cursor.unwrap_or(0), limit);
    Json(json!({
        "cards": cards.iter().map(card_json).collect::<Vec<_>>(),
        "next": next,
        "ignored": query.words.ignored,
    }))
    .into_response()
}

struct Cards {
    dolt_manager: Arc<DoltManager>,
    db: Arc<Database>,
    path: String,
}

impl Cards {
    async fn board(&self) -> Result<SharedBoard, String> {
        shared_board(&self.dolt_manager, &self.db, &self.path)
            .await
            .map(|(board, _)| board)
            .map_err(board_failure)
    }
}

impl Source for Cards {
    fn name(&self) -> &'static str {
        "cards"
    }

    fn skill(&self) -> &'static str {
        SKILL
    }

    fn tools(&self) -> Value {
        json!([
            {
                "name": "search_cards",
                "description": "Search the board's cards. Every word must appear somewhere in a card: its title or id, description, comments, notes, design or labels. Supports \"phrases\", -word, word OR word, title:, desc:, comment:, notes:, design:, label:, status:, type:, priority:, under:, owner:, after: and before:. Returns each card with its id, title, status, type, priority, parent, last update, match count and up to three snippets.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type":"string","description":"The words and keys to search for"},
                        "sort": {"type":"string","enum":["relevance","newest","priority"]},
                        "offset": {"type":"integer","minimum":0},
                        "limit": {"type":"integer","minimum":1,"maximum":30}
                    },
                    "required": ["query"]
                },
                "annotations": read_only(),
            },
            {
                "name": "read_card",
                "description": "Read one card by id, whole: title, status, type, priority, labels, description, design, notes, every comment, its parent and the cards under it.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {"type":"string","description":"A card id from search_cards"}
                    },
                    "required": ["id"]
                },
                "annotations": read_only(),
            }
        ])
    }

    fn call(self: Arc<Self>, tool: String, arguments: Value, steps: Steps) -> BoxFuture<'static, Called> {
        async move {
            let board = match self.board().await {
                Ok(board) => board,
                Err(error) => return Ok(tool_error(&error)),
            };
            if tool == "search_cards" {
                let Some(query) = arguments["query"].as_str() else {
                    return Ok(tool_error("query is required"));
                };
                let _ = steps.send(format!("Searched {}", query.trim()));
                let number = |name: &str| arguments[name].as_u64().map(|n| n as usize);
                let parsed = parse(query.trim_start(), Local::now());
                let (cards, next) = search(
                    &board,
                    &parsed,
                    Sort::from(arguments["sort"].as_str()),
                    number("offset").unwrap_or(0),
                    number("limit").unwrap_or(10).clamp(1, 30),
                );
                return Ok(tool_text(json!({
                    "cards": cards.iter().map(|found| json!({
                        "id": found.bead.id,
                        "title": found.bead.title,
                        "status": found.bead.status,
                        "type": found.bead.issue_type,
                        "priority": found.bead.priority,
                        "parent": found.bead.parent_id,
                        "updatedAt": when(found.bead),
                        "matches": found.places,
                        "snippets": found.snippets.iter().map(|snippet| json!({
                            "field": snippet.field.name(),
                            "text": snippet.segments.iter().map(|s| s.text.as_str()).collect::<String>(),
                        })).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                    "next": next,
                    "ignored": parsed.words.ignored,
                })));
            }
            let Some(id) = arguments["id"].as_str() else {
                return Ok(tool_error("id is required"));
            };
            let Some(bead) = board.iter().find(|bead| bead.id.eq_ignore_ascii_case(id)) else {
                return Ok(tool_error("No card has that id."));
            };
            let _ = steps.send(format!("Read {}", bead.title));
            Ok(tool_text(json!({
                "id": bead.id,
                "title": bead.title,
                "status": bead.status,
                "type": bead.issue_type,
                "priority": bead.priority,
                "labels": bead.labels,
                "owner": bead.owner,
                "createdAt": bead.created_at,
                "updatedAt": bead.updated_at,
                "closedAt": bead.closed_at,
                "closeReason": bead.close_reason,
                "description": bead.description,
                "design": bead.design,
                "notes": bead.notes,
                "comments": bead.comments.iter().flatten().map(|comment| json!({
                    "author": comment.author,
                    "at": comment.created_at,
                    "text": comment.text,
                })).collect::<Vec<_>>(),
                "parent": bead.parent_id.as_deref().and_then(|parent| board.iter().find(|b| b.id == parent)).map(|parent| json!({
                    "id": parent.id, "title": parent.title,
                })),
                "children": board.iter().filter(|child| child.parent_id.as_deref() == Some(bead.id.as_str())).map(|child| json!({
                    "id": child.id, "title": child.title, "status": child.status,
                })).collect::<Vec<_>>(),
            })))
        }
        .boxed()
    }

    fn found(self: Arc<Self>, named: Vec<Named>) -> BoxFuture<'static, Vec<Option<Value>>> {
        async move {
            let Ok(board) = self.board().await else {
                return named.iter().map(|_| None).collect();
            };
            named
                .iter()
                .map(|named| {
                    let bead = board.iter().find(|bead| bead.id.eq_ignore_ascii_case(&named.id))?;
                    Some(json!({
                        "id": bead.id,
                        "title": bead.title,
                        "status": bead.status,
                        "issueType": bead.issue_type,
                        "priority": bead.priority,
                        "parentId": bead.parent_id,
                        "updatedAt": when(bead),
                    }))
                })
                .collect()
        }
        .boxed()
    }
}

#[derive(Deserialize)]
pub struct Asking {
    path: String,
    question: String,
}

pub async fn ask(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Json(asking): Json<Asking>,
) -> Response {
    if asking.question.trim().is_empty() {
        return (StatusCode::UNPROCESSABLE_ENTITY, "Say what the card was about.").into_response();
    }
    if let Err(failed) = shared_board(&dolt_manager, &db, &asking.path).await {
        return failed.into_response();
    }
    let settings = match search_settings(&db) {
        Ok(settings) => settings,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    };
    let source = Arc::new(Cards { dolt_manager, db, path: asking.path });
    agent::start(source, &asking.question, settings, |brand| {
        crate::workbench::profiles::system_dir(brand).unwrap_or_default()
    })
    .unwrap_or_else(|refusal| refusal.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, title: &str) -> Bead {
        serde_json::from_value(json!({"id": id, "title": title, "status": "open"})).unwrap()
    }

    fn ids(board: &[Bead], typed: &str) -> Vec<String> {
        let query = parse(typed, Local::now());
        search(board, &query, Sort::Relevance, 0, 30).0.iter().map(|m| m.bead.id.clone()).collect()
    }

    fn board() -> Vec<Bead> {
        let mut loader = card("bw-1", "Fix the loader");
        loader.description = Some("It stalls on large boards.".into());
        loader.priority = Some(1);
        loader.labels = Some(vec!["area:board".into()]);
        let mut cache: Bead = card("bw-2", "Cache the counts");
        cache.comments = Some(vec![serde_json::from_value(json!({
            "id": 7, "issue_id": "bw-2", "author": "sam", "text": "The cobalt setting made the loader quiet.", "created_at": "2026-09-01T10:00:00Z"
        })).unwrap()]);
        cache.parent_id = Some("bw-1".into());
        cache.status = "closed".into();
        let mut grandchild = card("bw-3", "Measure it");
        grandchild.parent_id = Some("bw-2".into());
        vec![loader, cache, grandchild]
    }

    #[test]
    fn a_word_only_in_a_comment_finds_its_card_with_the_comment_as_the_snippet() {
        let board = board();
        let query = parse("cobalt ", Local::now());
        let (found, _) = search(&board, &query, Sort::Relevance, 0, 30);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].bead.id, "bw-2");
        let snippet = &found[0].snippets[0];
        assert_eq!(snippet.field, Field::Comments);
        assert_eq!(snippet.author.as_deref(), Some("sam"));
        assert!(snippet.segments.iter().any(|s| s.mark && s.text == "cobalt"));
    }

    #[test]
    fn a_title_word_ranks_first_and_keys_aim_and_narrow() {
        let board = board();
        assert_eq!(ids(&board, "loader "), ["bw-1", "bw-2"]);
        assert_eq!(ids(&board, "title:loader "), ["bw-1"]);
        assert_eq!(ids(&board, "comment:loader "), ["bw-2"]);
        assert_eq!(ids(&board, "loader -cobalt "), ["bw-1"]);
        assert_eq!(ids(&board, "loader status:closed "), ["bw-2"]);
        assert_eq!(ids(&board, "loader status:clos "), ["bw-2"]);
        assert_eq!(ids(&board, "loader -status:closed "), ["bw-1"]);
        assert_eq!(ids(&board, "label:area:board "), ["bw-1"]);
        assert_eq!(ids(&board, "priority:p1 "), ["bw-1"]);
        assert_eq!(ids(&board, "under:bw-1 "), ["bw-2", "bw-3"]);
        assert_eq!(ids(&board, "bw-3 "), ["bw-3"]);
        assert_eq!(ids(&board, "loa"), ["bw-1", "bw-2"]);
        assert!(ids(&board, "").is_empty());
    }

    #[test]
    fn a_board_search_gives_its_agent_two_read_only_tools_and_the_board_skill() {
        let skill = agent::prompt(SKILL, "the card about the stalling loader");
        assert!(skill.starts_with("# Finding the card someone describes"), "{skill}");
    }
}
