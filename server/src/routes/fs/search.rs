//! The files as a search source (bw-21a2.8).
//!
//! `GET /api/fs/search` finds the files under a checkout that say something,
//! the way `git grep` would: every file git does not ignore, read whole, every
//! word found where a word starts, each file listed once with the lines it was
//! found on. Words are found in a file's lines and its path; `content:` and
//! `file:` aim them at one, and `path:`, `name:` and `ext:` narrow which files
//! are read at all. The paths come from the listing the `@` completion already
//! keeps (fs.rs), so a keystroke walks nothing; the files are read on every
//! core at once.
//!
//! `POST /api/fs/search/ask` hands a question to the agent chosen in Settings,
//! which searches with `search_files`, reads with `read_file`, and names files
//! and lines (search/agent.rs). It reads only what the listing holds, so a file
//! git ignores — a `.env` — is never handed to it.

use super::{listing, looks_binary, Candidate, TEXT_READ_LIMIT};
use crate::db::Database;
use crate::routes::search_settings::search_settings;
use crate::routes::validate_path_security;
use crate::search::agent::{self, read_only, tool_error, tool_text, Called, Source, Steps};
use crate::search::named::Named;
use crate::search::text::{self, Segment};
use crate::search::words::{self, Key, Piece, Term, Words};
use axum::{
    extract::{Extension, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures::future::BoxFuture;
use futures::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// How to search the files, handed to the agent with the question.
const SKILL: &str = include_str!("../../../../machinery/skills/file-search/SKILL.md");

/// The most lines drawn under one file.
const LINES: usize = 5;

/// The most lines one `read_file` hands back.
const READ_LINES: usize = 400;

/// The parts of a file a word can be aimed at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Content,
    Path,
}

impl Field {
    fn named(key: &str) -> Option<Field> {
        Some(match key {
            "content" | "text" | "code" => Field::Content,
            "file" => Field::Path,
            _ => return None,
        })
    }
}

/// A key that narrows which files are read rather than aiming a word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trait {
    /// Anywhere in the path from the root.
    Path,
    /// In the file's own name.
    Name,
    /// The extension, whole.
    Ext,
}

#[derive(Debug)]
struct Only {
    which: Trait,
    /// Any one will do; lowercase.
    values: Vec<String>,
    negated: bool,
}

pub struct FileQuery {
    words: Words<Field>,
    only: Vec<Only>,
}

impl FileQuery {
    fn is_empty(&self) -> bool {
        self.words.all.is_empty() && self.words.none.is_empty() && self.only.is_empty()
    }
}

pub fn parse(input: &str) -> FileQuery {
    let mut only = Vec::new();
    let words = words::read(input, Field::named, |key, piece: &Piece| {
        let which = match key {
            "path" | "dir" | "folder" | "under" => Trait::Path,
            "name" | "filename" => Trait::Name,
            "ext" | "extension" => Trait::Ext,
            _ => return Key::Words,
        };
        let values: Vec<String> = piece
            .value
            .split(',')
            .map(|value| {
                if which == Trait::Ext {
                    value.trim().trim_start_matches('.')
                } else {
                    value.trim()
                }
            })
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        if values.is_empty() {
            return Key::Unread;
        }
        only.push(Only {
            which,
            values,
            negated: piece.negated,
        });
        Key::Taken
    });
    FileQuery { words, only }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sort {
    Relevance,
    Path,
}

impl Sort {
    fn from(written: Option<&str>) -> Sort {
        match written {
            Some("path") => Sort::Path,
            _ => Sort::Relevance,
        }
    }
}

/// One line a word was found on, 1-based, cut to the stretch around it.
pub struct Line {
    number: usize,
    segments: Vec<Segment>,
}

pub struct Match {
    path: String,
    score: u32,
    /// Every line anything was found on, not only those drawn.
    lines_found: usize,
    /// The path, marked, when a word was found in it.
    marked_path: Option<Vec<Segment>>,
    lines: Vec<Line>,
}

fn aimed(term: &Term<Field>, field: Field) -> bool {
    term.fields.is_empty() || term.fields.contains(&field)
}

fn has_trait(candidate: &Candidate, only: &Only) -> bool {
    let name = &candidate.lower[candidate.name_at..];
    let any = only.values.iter().any(|value| match only.which {
        Trait::Path => candidate.lower.contains(value.as_str()),
        Trait::Name => name.contains(value.as_str()),
        Trait::Ext => name.rsplit_once('.').is_some_and(|(_, ext)| ext == value),
    });
    any != only.negated
}

/// A file's text, or nothing for one too big to be source or not text at all.
fn contents(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > TEXT_READ_LIMIT {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    Some(
        String::from_utf8(bytes)
            .unwrap_or_else(|not| String::from_utf8_lossy(not.as_bytes()).into_owned()),
    )
}

/// The file, if it is one the query asks for, with where it was found.
fn matched(root: &Path, candidate: &Candidate, query: &FileQuery) -> Option<Match> {
    if candidate.dir || !query.only.iter().all(|only| has_trait(candidate, only)) {
        return None;
    }
    let path = candidate.path.as_str();
    let in_path =
        |term: &Term<Field>| aimed(term, Field::Path) && !text::find(path, term).is_empty();
    let reads = query
        .words
        .all
        .iter()
        .flatten()
        .chain(&query.words.none)
        .any(|term| aimed(term, Field::Content));
    let body = if reads {
        contents(&root.join(path)).unwrap_or_default()
    } else {
        String::new()
    };
    // Most files say none of it; a byte search of the folded text turns them
    // away before a single line is split.
    let folded = body.to_ascii_lowercase();
    let could = |term: &Term<Field>| {
        aimed(term, Field::Content) && folded.contains(&term.text.to_ascii_lowercase())
    };
    if !query
        .words
        .all
        .iter()
        .all(|group| group.iter().any(|term| in_path(term) || could(term)))
    {
        return None;
    }
    if query.words.none.iter().any(in_path) {
        return None;
    }

    let content_terms: Vec<&Term<Field>> = query
        .words
        .all
        .iter()
        .flatten()
        .chain(&query.words.none)
        .filter(|term| could(term))
        .collect();
    // Whether each term was truly found — a whole word, not a piece of one.
    let mut found_in_body = vec![0usize; content_terms.len()];
    let mut lines = Vec::new();
    let mut lines_found = 0;
    if !content_terms.is_empty() {
        let mut start = 0;
        for (index, line) in body.split('\n').enumerate() {
            let end = start + line.len();
            let lowered = &folded[start..end];
            start = end + 1;
            let here: Vec<&Term<Field>> = content_terms
                .iter()
                .copied()
                .filter(|term| lowered.contains(&term.text.to_ascii_lowercase()))
                .collect();
            if here.is_empty() {
                continue;
            }
            let line = line.strip_suffix('\r').unwrap_or(line);
            let mut any = false;
            for term in here {
                let count = text::find(line, term).len();
                if count > 0 {
                    any = true;
                    let at = content_terms
                        .iter()
                        .position(|t| std::ptr::eq(*t, term))
                        .unwrap_or(0);
                    found_in_body[at] += count;
                }
            }
            if !any {
                continue;
            }
            lines_found += 1;
            if lines.len() < LINES {
                let wanted: Vec<&Term<Field>> = query
                    .words
                    .all
                    .iter()
                    .flatten()
                    .filter(|term| aimed(term, Field::Content))
                    .collect();
                let places = text::places(line, &wanted);
                if !places.is_empty() {
                    lines.push(Line {
                        number: index + 1,
                        segments: text::snippet(line, &places),
                    });
                }
            }
        }
    }
    let body_count = |term: &Term<Field>| {
        content_terms
            .iter()
            .position(|t| std::ptr::eq(*t, term))
            .map_or(0, |at| found_in_body[at])
    };
    if query.words.none.iter().any(|term| body_count(term) > 0) {
        return None;
    }

    let name = &path[candidate.name_at..];
    let mut score = 0;
    for group in &query.words.all {
        let mut any = false;
        for term in group {
            if aimed(term, Field::Path) {
                if !text::find(name, term).is_empty() {
                    any = true;
                    score += 8;
                } else if in_path(term) {
                    any = true;
                    score += 3;
                }
            }
            let count = body_count(term);
            if count > 0 {
                any = true;
                score += count.min(20) as u32;
            }
        }
        if !any {
            return None;
        }
    }
    let path_terms: Vec<&Term<Field>> = query
        .words
        .all
        .iter()
        .flatten()
        .filter(|term| aimed(term, Field::Path))
        .collect();
    let places = text::places(path, &path_terms);
    let marked_path = (!places.is_empty()).then(|| text::marked(path, &places));
    Some(Match {
        path: candidate.path.clone(),
        score,
        lines_found,
        marked_path,
        lines,
    })
}

/// A page of the files under `root` the query asks for, and where the next
/// page starts. Blocking: it reads files.
fn search(
    root: &Path,
    paths: &[Candidate],
    query: &FileQuery,
    sort: Sort,
    offset: usize,
    limit: usize,
) -> (Vec<Match>, Option<usize>) {
    if query.is_empty() {
        return (Vec::new(), None);
    }
    let cores = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .min(16);
    let share = paths.len().div_ceil(cores).max(1);
    let mut found: Vec<Match> = std::thread::scope(|scope| {
        let workers: Vec<_> = paths
            .chunks(share)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .filter_map(|candidate| matched(root, candidate, query))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    });
    match sort {
        Sort::Relevance => {
            found.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)))
        }
        Sort::Path => found.sort_by(|a, b| a.path.cmp(&b.path)),
    }
    let next = (found.len() > offset + limit).then_some(offset + limit);
    (found.into_iter().skip(offset).take(limit).collect(), next)
}

/// The checkout a search is rooted at, as the listing keys it.
fn root_of(given: &str) -> Result<PathBuf, (StatusCode, String)> {
    let root = PathBuf::from(given);
    validate_path_security(&root).map_err(|e| (StatusCode::FORBIDDEN, e))?;
    if !root.is_dir() {
        return Err((StatusCode::NOT_FOUND, "Path is not a directory".into()));
    }
    Ok(root.canonicalize().unwrap_or(root))
}

fn refusal((status, error): (StatusCode, String)) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

/// Search a root's files off the async runtime's threads.
async fn searched(
    root: PathBuf,
    query: FileQuery,
    sort: Sort,
    offset: usize,
    limit: usize,
) -> Result<(Vec<Match>, Option<usize>, Vec<String>), String> {
    let listing = listing(&root)
        .await
        .map_err(|e| format!("Failed to search directory: {e}"))?;
    tokio::task::spawn_blocking(move || {
        let (found, next) = search(&root, &listing.paths, &query, sort, offset, limit);
        (found, next, query.words.ignored)
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct SearchParams {
    root: String,
    q: Option<String>,
    sort: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
}

pub async fn search_files(Query(params): Query<SearchParams>) -> Response {
    let root = match root_of(&params.root) {
        Ok(root) => root,
        Err(refused) => return refusal(refused),
    };
    let query = parse(params.q.unwrap_or_default().trim_start());
    let limit = params.limit.unwrap_or(30).clamp(1, 100);
    match searched(root.clone(), query, Sort::from(params.sort.as_deref()), params.cursor.unwrap_or(0), limit).await {
        Ok((files, next, ignored)) => Json(json!({
            "root": root.to_string_lossy(),
            "files": files.iter().map(|found| json!({
                "path": found.path,
                "abs": root.join(&found.path).to_string_lossy(),
                "pathSegments": found.marked_path,
                "matches": found.lines_found,
                "lines": found.lines.iter().map(|line| json!({ "line": line.number, "segments": line.segments })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "next": next,
            "ignored": ignored,
        }))
        .into_response(),
        Err(error) => refusal((StatusCode::INTERNAL_SERVER_ERROR, error)),
    }
}

struct Files {
    root: PathBuf,
}

impl Files {
    /// A file the listing holds, by its path from the root — never one git
    /// ignores, never one outside the root however it was spelled.
    async fn listed(&self, id: &str) -> Option<String> {
        let wanted = id.trim().trim_start_matches("./").replace('\\', "/");
        let listing = listing(&self.root).await.ok()?;
        listing
            .paths
            .iter()
            .find(|candidate| !candidate.dir && candidate.path == wanted)
            .map(|candidate| candidate.path.clone())
    }
}

impl Source for Files {
    fn name(&self) -> &'static str {
        "files"
    }

    fn skill(&self) -> &'static str {
        SKILL
    }

    fn tools(&self) -> Value {
        json!([
            {
                "name": "search_files",
                "description": "Search the checkout's files, skipping everything git ignores. Every word must appear somewhere in a file: its lines or its path. Supports \"phrases\", -word, word OR word, content:, file:, path:, name: and ext:. Returns each file's path from the root, the first line it was found on, how many lines matched, and up to five matching lines with their numbers.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type":"string","description":"The words and keys to search for"},
                        "sort": {"type":"string","enum":["relevance","path"]},
                        "offset": {"type":"integer","minimum":0},
                        "limit": {"type":"integer","minimum":1,"maximum":30}
                    },
                    "required": ["query"]
                },
                "annotations": read_only(),
            },
            {
                "name": "read_file",
                "description": "Read one file by its path from search_files, with line numbers. Hands back at most 400 lines at a time; pass from to read further.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type":"string","description":"A path from search_files"},
                        "from": {"type":"integer","minimum":1,"description":"The first line wanted"}
                    },
                    "required": ["path"]
                },
                "annotations": read_only(),
            }
        ])
    }

    fn call(
        self: Arc<Self>,
        tool: String,
        arguments: Value,
        steps: Steps,
    ) -> BoxFuture<'static, Called> {
        async move {
            if tool == "search_files" {
                let Some(query) = arguments["query"].as_str() else {
                    return Ok(tool_error("query is required"));
                };
                let _ = steps.send(format!("Searched {}", query.trim()));
                let number = |name: &str| arguments[name].as_u64().map(|n| n as usize);
                let parsed = parse(query.trim_start());
                let sort = Sort::from(arguments["sort"].as_str());
                let (offset, limit) = (number("offset").unwrap_or(0), number("limit").unwrap_or(10).clamp(1, 30));
                return Ok(match searched(self.root.clone(), parsed, sort, offset, limit).await {
                    Ok((files, next, ignored)) => tool_text(json!({
                        "files": files.iter().map(|found| json!({
                            "id": found.path,
                            "line": found.lines.first().map(|line| line.number),
                            "matches": found.lines_found,
                            "lines": found.lines.iter().map(|line| json!({
                                "line": line.number,
                                "text": line.segments.iter().map(|s| s.text.as_str()).collect::<String>(),
                            })).collect::<Vec<_>>(),
                        })).collect::<Vec<_>>(),
                        "next": next,
                        "ignored": ignored,
                    })),
                    Err(error) => tool_error(&error),
                });
            }
            let Some(asked) = arguments["path"].as_str() else {
                return Ok(tool_error("path is required"));
            };
            let Some(path) = self.listed(asked).await else {
                return Ok(tool_error("No file has that path."));
            };
            let Some(body) = contents(&self.root.join(&path)) else {
                return Ok(tool_error("That file is too big, or not text."));
            };
            let _ = steps.send(format!("Read {path}"));
            let from = arguments["from"].as_u64().map_or(1, |n| n.max(1) as usize);
            let all: Vec<&str> = body.lines().collect();
            let shown: String = all
                .iter()
                .enumerate()
                .skip(from - 1)
                .take(READ_LINES)
                .map(|(index, line)| format!("{}: {line}\n", index + 1))
                .collect();
            Ok(tool_text(json!({
                "path": path,
                "lines": all.len(),
                "from": from,
                "to": (from - 1 + READ_LINES).min(all.len()),
                "text": shown,
            })))
        }
        .boxed()
    }

    fn found(self: Arc<Self>, named: Vec<Named>) -> BoxFuture<'static, Vec<Option<Value>>> {
        async move {
            let mut found = Vec::new();
            for named in named {
                found.push(self.listed(&named.id).await.map(|path| {
                    json!({
                        "id": path,
                        "path": path,
                        "abs": self.root.join(&path).to_string_lossy(),
                    })
                }));
            }
            found
        }
        .boxed()
    }
}

#[derive(Deserialize)]
pub struct Asking {
    root: String,
    question: String,
}

pub async fn ask(Extension(db): Extension<Arc<Database>>, Json(asking): Json<Asking>) -> Response {
    if asking.question.trim().is_empty() {
        return refusal((
            StatusCode::UNPROCESSABLE_ENTITY,
            "Say what the file was about.".into(),
        ));
    }
    let root = match root_of(&asking.root) {
        Ok(root) => root,
        Err(refused) => return refusal(refused),
    };
    let settings = match search_settings(&db) {
        Ok(settings) => settings,
        Err(error) => return refusal((StatusCode::INTERNAL_SERVER_ERROR, error)),
    };
    agent::start(
        Arc::new(Files { root }),
        &asking.question,
        settings,
        |brand| crate::workbench::profiles::system_dir(brand).unwrap_or_default(),
    )
    .unwrap_or_else(|refusal| refusal.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (tempfile::TempDir, Vec<Candidate>) {
        let home = directories::UserDirs::new()
            .unwrap()
            .home_dir()
            .to_path_buf();
        let root = tempfile::Builder::new()
            .prefix(".atelier-file-search-")
            .tempdir_in(home)
            .unwrap();
        let write = |path: &str, text: &str| {
            let at = root.path().join(path);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, text).unwrap();
        };
        write(".gitignore", "ignored/\n");
        write(
            "src/importer.rs",
            "fn main() {\n    // the cobalt cache\n    let cobalt = 1;\n}\n",
        );
        write("src/cobalt.ts", "export const nothing = 0;\n");
        write("docs/notes.md", "The cobalts are not the word.\nloader\n");
        write("ignored/secret.rs", "cobalt\n");
        write("image.bin", "cobalt\0\0");
        let paths = super::super::walk_all(root.path());
        (root, paths)
    }

    fn paths(root: &Path, candidates: &[Candidate], typed: &str) -> Vec<String> {
        search(root, candidates, &parse(typed), Sort::Relevance, 0, 30)
            .0
            .into_iter()
            .map(|found| found.path)
            .collect()
    }

    #[test]
    fn a_word_is_found_on_its_lines_and_in_names_and_never_in_ignored_or_binary_files() {
        let (root, candidates) = tree();
        let (found, _) = search(
            root.path(),
            &candidates,
            &parse("cobalt "),
            Sort::Relevance,
            0,
            30,
        );
        let names: Vec<&str> = found.iter().map(|found| found.path.as_str()).collect();
        assert_eq!(names, ["src/cobalt.ts", "src/importer.rs"]);
        let importer = &found[1];
        assert_eq!(
            importer
                .lines
                .iter()
                .map(|line| line.number)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert!(importer.lines[0]
            .segments
            .iter()
            .any(|s| s.mark && s.text == "cobalt"));
        assert!(found[0].lines.is_empty());
        assert!(found[0]
            .marked_path
            .as_ref()
            .unwrap()
            .iter()
            .any(|s| s.mark && s.text == "cobalt"));
    }

    #[test]
    fn keys_aim_words_and_narrow_the_files_read() {
        let (root, candidates) = tree();
        let root = root.path();
        assert_eq!(
            paths(root, &candidates, "content:cobalt "),
            ["src/importer.rs"]
        );
        assert_eq!(paths(root, &candidates, "file:cobalt "), ["src/cobalt.ts"]);
        assert_eq!(
            paths(root, &candidates, "cobalt ext:rs"),
            ["src/importer.rs"]
        );
        assert_eq!(
            paths(root, &candidates, "cobalt -ext:rs"),
            ["src/cobalt.ts"]
        );
        assert_eq!(paths(root, &candidates, "name:notes"), ["docs/notes.md"]);
        assert_eq!(
            paths(root, &candidates, "path:docs cobalt"),
            ["docs/notes.md"]
        );
        assert_eq!(
            paths(root, &candidates, "cobalt -cache "),
            ["src/cobalt.ts"]
        );
        assert_eq!(
            paths(root, &candidates, "loader OR cache "),
            ["docs/notes.md", "src/importer.rs"]
        );
        assert!(paths(root, &candidates, "").is_empty());
    }

    #[tokio::test]
    async fn the_agent_reads_only_what_the_listing_holds() {
        let (root, _) = tree();
        let files = Files {
            root: root.path().canonicalize().unwrap(),
        };
        assert_eq!(
            files.listed("./src/importer.rs").await.as_deref(),
            Some("src/importer.rs")
        );
        assert_eq!(files.listed("ignored/secret.rs").await, None);
        assert_eq!(files.listed("../etc/passwd").await, None);
        assert_eq!(files.listed("src").await, None);
        assert!(agent::prompt(SKILL, "the file with the cobalt cache")
            .starts_with("# Finding the file someone describes"));
    }
}
