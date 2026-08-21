//! Manager reports: the list, and the page for one card.
//!
//! Reports live where this computer keeps this program's data —
//! `<data>/reports/<project>/<slug>.report.json`, with the built page beside
//! it, and the tools that make them in `<data>/tools`. The one place that works
//! out where those are, on every platform, is `crate::identity`; nothing here
//! reads an environment variable of its own.
//!
//! Making a report is part of the product, so the tools travel inside it — see
//! `crate::report_tools`. Nothing has to be installed alongside.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use crate::db::{Database, Project};
use crate::routes::projects::AppState;

const SPEC_SUFFIX: &str = ".report.json";

fn reports_dir() -> Option<PathBuf> {
    crate::identity::reports_dir()
}

/// `/api/reports`, `/api/reports/page` and `/api/reports/spec`, carrying the
/// database so a report can be opened without the caller naming the folder
/// its board lives in.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/reports", get(list_reports))
        .route("/reports/page", get(report_page))
        .route("/reports/spec", get(report_spec))
}

/// One report, as the screen lists it.
#[derive(Debug, Clone, Serialize)]
pub struct ReportEntry {
    pub project: String,
    pub slug: String,
    pub title: String,
    /// The card this report belongs to, when it names one.
    pub card: Option<String>,
    /// How many of its questions are still holding work up — what makes this a
    /// report waiting on the reader rather than one he has finished with
    /// (bw-7ks.21.6).
    pub waiting: usize,
}

#[derive(Debug, Deserialize)]
pub struct PageParams {
    pub project: String,
    pub slug: String,
    /// The project folder the report is about — pictures and the board resolve there.
    pub path: Option<String>,
    /// `1` to wait for a run of the toolchain rather than take the last one.
    /// The screen paints from the last build and then asks again with this,
    /// so the reader sees the report at once and the board's current answer a
    /// few seconds later (bw-7ks.21.9).
    pub fresh: Option<String>,
}

impl PageParams {
    fn wants_fresh(&self) -> bool {
        matches!(self.fresh.as_deref(), Some("1") | Some("true"))
    }
}

/// Both report routes take the same `project`/`slug` pair, and neither may
/// carry a path separator or (for the project) a dot — the names are joined
/// straight onto a filesystem path below, with nothing else standing between
/// a caller and `../../etc/passwd`.
fn bad_name(p: &PageParams) -> bool {
    p.project.contains(['/', '\\', '.']) || p.slug.contains(['/', '\\'])
}

/// A report's own words: its title, the card it is about, and the cards its
/// questions say they are holding up.
fn read_spec(spec: &Path) -> Option<(String, Option<String>, Vec<String>)> {
    let raw = std::fs::read_to_string(spec).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let title = v.get("title")?.as_str()?.to_string();
    let card = v
        .get("status")
        .and_then(|s| s.get("card"))
        .and_then(|c| c.as_str())
        .map(str::to_string);
    Some((title, card, holds_of(&v)))
}

/// The cards a spec's questions are holding up, in the order it asks them.
fn holds_of(spec: &serde_json::Value) -> Vec<String> {
    spec.get("actions")
        .and_then(|a| a.get("questions"))
        .and_then(|q| q.as_array())
        .map(|questions| {
            questions
                .iter()
                .filter_map(|q| q.get("holds").and_then(|h| h.as_str()))
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// A dropped card, however a board drops one — the same three words
/// `reporting/tools/board.py` reads, by status or by label.
const DROPPED: [&str; 3] = ["cancelled", "dropped", "wontfix"];

/// The states that mean nobody has started, which is the only work a question
/// can still be holding up — `WAITING` in `reporting/tools/build.py`.
const WAITING: [&str; 4] = ["open", "pinned", "blocked", "deferred"];

/// The board's word on one card, as far as a question cares.
#[derive(Debug, Clone)]
struct Card {
    state: String,
    /// Whether other work sits underneath it.
    carries: bool,
}

impl Card {
    /// Whether a question naming this card is still waiting on an answer.
    fn waiting(&self) -> bool {
        !self.carries && WAITING.contains(&self.state.as_str())
    }
}

/// The board's own word for one card, a dropped one read as `cancelled`
/// whichever way it was dropped.
///
/// A card the board gave no word for keeps none: only the two words that end a
/// question are read from here, so anything else — nothing included — leaves
/// the question standing.
fn card_status(card: &serde_json::Value) -> String {
    let status = card.get("status").and_then(|s| s.as_str()).unwrap_or_default();
    let dropped_by_label = card
        .get("labels")
        .and_then(|l| l.as_array())
        .is_some_and(|labels| {
            labels.iter().filter_map(|l| l.as_str()).any(|l| DROPPED.contains(&l))
        });
    if dropped_by_label || DROPPED.contains(&status) {
        "cancelled".to_string()
    } else {
        status.to_string()
    }
}

/// How many of these questions are still waiting on an answer.
///
/// Exactly the rule the report builder refuses a page by (`live_questions` in
/// `reporting/tools/build.py`): the card a question names has to be one piece
/// of work that nobody has started. Finished, dropped or never heard of holds
/// nothing; work already under way was not waiting on this answer; and a card
/// carrying other work underneath it never finishes at all, so a question hung
/// on one would sit there through every answer it was ever given.
///
/// The two have to agree or the mark lies: a report the builder would refuse
/// is a report whose page comes up as an error, and sending the reader to one
/// of those is worse than saying nothing.
fn waiting_of(holds: &[String], cards: &HashMap<String, Card>) -> usize {
    holds.iter().filter(|held| cards.get(*held).is_some_and(Card::waiting)).count()
}

/// The first thing in the board's answer that reads as JSON.
///
/// `bd show` names the cards it could not find on the way past, so its own
/// words can sit in front of the document it wrote.
fn first_json(out: &[u8]) -> Option<serde_json::Value> {
    let text = String::from_utf8_lossy(out);
    let start = text.find(['[', '{'])?;
    serde_json::Deserializer::from_str(&text[start..])
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()
}

/// The board's word on every card it holds, in one question.
///
/// The whole board rather than the handful of cards a report names, because
/// what makes a card unanswerable is what sits UNDER it, and the only cheap
/// way to know that is to read every card's parent once. One start of `bd` for
/// a project either way, and the answer keeps for as long as the list does.
///
/// A card missing from the answer is a card the board has never heard of, and
/// a board that cannot answer at all leaves the map empty: either way nothing
/// counts as waiting, so a machine with no board is quiet rather than wrong.
fn board_cards(dir: &str) -> HashMap<String, Card> {
    let mut cards = HashMap::new();
    let Ok(out) = Command::new("bd")
        .args(["list", "--all", "--json"])
        .current_dir(dir)
        .output()
    else {
        return cards;
    };
    let Some(serde_json::Value::Array(rows)) = first_json(&out.stdout) else {
        return cards;
    };
    let carriers: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|row| row.get("parent").and_then(|p| p.as_str()))
        .map(str::to_string)
        .collect();
    for row in &rows {
        if let Some(id) = row.get("id").and_then(|i| i.as_str()) {
            let carries = carriers.contains(id);
            cards.insert(id.to_string(), Card { state: card_status(row), carries });
        }
    }
    cards
}

/// The folder that holds `project`'s board — `local_path` when it names
/// one, `path` otherwise. Mirrors `projectDir()` in `src/lib/utils.ts`: a
/// project's own `path` can be a `dolt://` address rather than a real
/// directory, and `local_path` is what the rest of the app then runs
/// filesystem commands in.
fn project_dir(project: &Project) -> String {
    match project.local_path.as_deref() {
        Some(lp) if !lp.trim().is_empty() => lp.to_string(),
        _ => project.path.clone(),
    }
}

/// Where the project a report is filed under keeps its board, found from
/// the app's own project list.
///
/// The match is exact, never fuzzy, and never against a project's display
/// `name`: `reporting/tools/project.py` files a report under the last path
/// segment of the project's main checkout, which is `basename` of the
/// folder `project_dir` resolves to.
fn resolve_project_path(db: &Database, project: &str) -> Option<String> {
    let projects = db.get_projects_filtered(true, true).ok()?;
    projects.into_iter().find_map(|p| {
        let dir = project_dir(&p);
        let matches = Path::new(&dir).file_name().is_some_and(|n| n.to_string_lossy() == project);
        matches.then_some(dir)
    })
}

/// The folder the build runs in. An explicit `path` wins while it still
/// exists — the screen may pass one — then the project name the report is
/// filed under is looked up in the app's own list, and failing both, the
/// report's own folder beside its spec.
///
/// A link handed over months ago may name a worktree, a second checkout
/// named after a branch and deleted the day that job lands. That link is
/// still about the same report, so a path that has since gone falls through
/// to the lookup rather than failing.
///
/// Not every report is about a project this app was ever told about: reports
/// filed by hand sit in the data folder under a name no row matches. Those
/// name no card, so no board is wanted, and their pictures live beside the
/// spec — which is why their own folder is a working answer and a refusal is
/// not (bw-pqt.23). A spec that does name a card and cannot reach a board
/// still fails, and the builder says so in its own words.
///
/// A named folder that belongs to some OTHER project is worse than none at
/// all: the screen lists every report on the machine and hands whichever one
/// is opened the board the reader happens to be looking at, so one project's
/// report was built against another's board and came back as an error about
/// its card (bw-pqt.18). A name that does not match is therefore only a last
/// resort, behind the lookup — it is still what opens a report of a project
/// the app has never been told about.
fn resolve_cwd(explicit: Option<&str>, db: &Database, project: &str, spec: &Path) -> String {
    let named = explicit.filter(|dir| Path::new(dir).is_dir()).map(str::to_string);
    let is_this_projects = named
        .as_deref()
        .and_then(|dir| Path::new(dir).file_name().map(|n| n.to_string_lossy() == project))
        .unwrap_or(false);
    if is_this_projects {
        return named.expect("a folder that matched the project name");
    }
    resolve_project_path(db, project)
        .or(named)
        .unwrap_or_else(|| spec_home(spec))
}

/// The report's own folder — where its spec and its pictures sit.
fn spec_home(spec: &Path) -> String {
    spec.parent().unwrap_or(spec).to_string_lossy().to_string()
}

/// How long the list is kept before the board is asked about it again.
///
/// Every card on a board asks whether it has a report, so this route is hit in
/// bursts, and each answer now costs one board read per project. Short enough
/// that closing the card a question holds up shows on the next screen the
/// reader opens, long enough that a hundred cards cost one read between them.
const MEMO: std::time::Duration = std::time::Duration::from_secs(3);

/// The list as it was last read, and when: named, because the whole of it
/// spelled out inline is a type nobody can read at a glance.
type Memo = Mutex<Option<(SystemTime, Vec<ReportEntry>)>>;

fn memo() -> &'static Memo {
    static MEMO_CELL: OnceLock<Memo> = OnceLock::new();
    MEMO_CELL.get_or_init(|| Mutex::new(None))
}

/// Every report on this machine, newest first, each saying how much of it is
/// still waiting on an answer.
pub async fn list_reports(State(db): State<AppState>) -> impl IntoResponse {
    if let Some((when, ref cached)) = *memo().lock().unwrap_or_else(|e| e.into_inner()) {
        if when.elapsed().map(|since| since < MEMO).unwrap_or(false) {
            return Json(cached.clone());
        }
    }

    // Reading every spec and asking the board about each question's card is
    // filesystem and subprocess work, and this is an async handler.
    let entries = tokio::task::spawn_blocking(move || collect_reports(&db)).await.unwrap_or_default();
    *memo().lock().unwrap_or_else(|e| e.into_inner()) = Some((SystemTime::now(), entries.clone()));
    Json(entries)
}

/// One report, before the board has been asked about the cards it names.
struct Filed {
    when: SystemTime,
    slug: String,
    title: String,
    card: Option<String>,
    holds: Vec<String>,
}

/// Walks the reports folder, then asks each project's board once about every
/// card its reports are holding up.
///
/// One question to the board per project, not per question: a machine holding
/// twenty reports for one project would otherwise pay twenty starts of `bd` to
/// draw one badge.
fn collect_reports(db: &Database) -> Vec<ReportEntry> {
    let Some(root) = reports_dir() else { return Vec::new() };
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };

    let mut out: Vec<(SystemTime, ReportEntry)> = Vec::new();
    for project in projects.flatten() {
        if !project.path().is_dir() {
            continue;
        }
        let project_name = project.file_name().to_string_lossy().to_string();
        let Ok(specs) = std::fs::read_dir(project.path()) else { continue };

        let mut filed: Vec<Filed> = Vec::new();
        for spec in specs.flatten() {
            let name = spec.file_name().to_string_lossy().to_string();
            let Some(slug) = name.strip_suffix(SPEC_SUFFIX) else { continue };
            let Some((title, card, holds)) = read_spec(&spec.path()) else { continue };
            let when = spec.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            filed.push(Filed { when, slug: slug.to_string(), title, card, holds });
        }

        // Nothing held up is nothing to ask the board about.
        let asked = filed.iter().any(|f| !f.holds.is_empty());
        // A project the app's own list does not know has no folder to run the
        // board in — the same reports still list, with nothing waiting on them.
        let cards = match resolve_project_path(db, &project_name) {
            Some(dir) if asked => board_cards(&dir),
            _ => HashMap::new(),
        };

        for f in filed {
            out.push((
                f.when,
                ReportEntry {
                    project: project_name.clone(),
                    slug: f.slug,
                    title: f.title,
                    card: f.card,
                    waiting: waiting_of(&f.holds, &cards),
                },
            ));
        }
    }

    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, e)| e).collect()
}

/// Runs the report builder and hands back what it wrote — the built page, or
/// the same report's resolved facts when `emit_json` asks for those instead —
/// or the response that explains why it could not.
///
/// `report_page` and `report_spec` are the same report read two ways, so this
/// is the one place either of them runs the builder: a failure reads the same
/// (422, with the builder's own stderr) whichever route hit it.
fn run_builder(
    tools: &Path,
    spec: &Path,
    cwd: &str,
    emit_json: bool,
    built: &Path,
) -> Result<String, (StatusCode, String)> {
    let mut cmd = Command::new("python3");
    cmd.arg(tools.join("build.py")).arg(spec).arg("--project").arg(cwd).current_dir(cwd);
    if emit_json {
        cmd.arg("--emit").arg("json");
    }

    match cmd.output() {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            // The builder's own first line already says what went wrong, and
            // says it in the reader's words — "this report does not build:",
            // or "the spec is not valid JSON:". Putting a sentence in front of
            // it showed the manager the same words twice (bw-pqt.21). Only a
            // builder that said nothing at all needs one supplied.
            let why = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let said = if why.is_empty() {
                "this report does not build, and the builder gave no reason".to_string()
            } else {
                why
            };
            return Err((StatusCode::UNPROCESSABLE_ENTITY, said));
        }
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("the report builder did not run: {e}"))),
    }

    std::fs::read_to_string(built).map_err(|e| {
        let what = if emit_json { "facts" } else { "page" };
        (StatusCode::INTERNAL_SERVER_ERROR, format!("built {what} unreadable: {e}"))
    })
}

/// One gate per built file. Two readers asking for the same report at the same
/// moment run the toolchain once between them rather than once each — and two
/// runs at once would be two writers of one file.
fn gate(built: &Path) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = gates.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(built.to_path_buf()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// What was built last time, when there is anything there.
fn last_build(built: &Path) -> Option<String> {
    let text = std::fs::read_to_string(built).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// The report, from the last build unless the caller asked to wait for a new one.
///
/// A run of the toolchain takes about ten seconds — it reads the board, looks
/// up every card and redraws every picture — and running it on every visit made
/// opening a report a ten-second wait. The file beside the spec is what it said
/// last time, so that goes back at once, and the screen asks again with
/// `fresh=1` behind the reader (bw-7ks.21.9).
fn report_output(
    tools: &Path,
    spec: &Path,
    cwd: &str,
    emit_json: bool,
    built: &Path,
    fresh: bool,
) -> Result<String, (StatusCode, String)> {
    if !fresh {
        if let Some(text) = last_build(built) {
            return Ok(text);
        }
    }

    let asked = SystemTime::now();
    let gate = gate(built);
    let _held = gate.lock().unwrap_or_else(|e| e.into_inner());

    // Someone else's run finished while this request waited its turn, so it is
    // as current as one of our own would be.
    let built_since = std::fs::metadata(built)
        .and_then(|m| m.modified())
        .map(|when| when > asked)
        .unwrap_or(false);
    if built_since {
        if let Some(text) = last_build(built) {
            return Ok(text);
        }
    }

    run_builder(tools, spec, cwd, emit_json, built)
}

/// Where the build runs, worked out the one way both report routes share.
fn build_cwd(p: &PageParams, db: &Database, spec: &Path) -> String {
    resolve_cwd(p.path.as_deref(), db, &p.project, spec)
}

/// One report, rebuilt from its spec so the board it shows is current.
pub async fn report_page(State(db): State<AppState>, Query(p): Query<PageParams>) -> impl IntoResponse {
    if bad_name(&p) {
        return (StatusCode::BAD_REQUEST, "bad name".to_string()).into_response();
    }
    let Some(root) = reports_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this computer names no folder for a program's data, so there is nowhere to keep reports"
                .to_string(),
        )
            .into_response();
    };
    let spec = root.join(&p.project).join(format!("{}{}", p.slug, SPEC_SUFFIX));
    if !spec.is_file() {
        return (StatusCode::NOT_FOUND, format!("no report called {}", p.slug)).into_response();
    }

    let Some(tools) = crate::identity::tools_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this computer names no folder for a program's data, so the report tools have nowhere to live"
                .to_string(),
        )
            .into_response();
    };

    let cwd = build_cwd(&p, &db, &spec);
    let built = spec.with_file_name(format!("{}.html", p.slug));
    match report_output(&tools, &spec, &cwd, false, &built, p.wants_fresh()) {
        // Without the charset the browser reads the page as windows-1252.
        Ok(html) => (
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            html,
        )
            .into_response(),
        Err(resp) => resp.into_response(),
    }
}

/// The same report as `report_page`, but handed over as the facts a page is
/// drawn from, not the drawn page — the React screen reads this so it can
/// draw a report out of its own components instead of an iframe.
///
/// Every gate `report_page` runs, runs here too: `--emit json` walks the same
/// spec through the same validation and the same board reads, so a spec
/// refused for the page is refused here as well, with the same builder stderr
/// in the 422.
pub async fn report_spec(State(db): State<AppState>, Query(p): Query<PageParams>) -> impl IntoResponse {
    if bad_name(&p) {
        return (StatusCode::BAD_REQUEST, "bad name".to_string()).into_response();
    }
    let Some(root) = reports_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this computer names no folder for a program's data, so there is nowhere to keep reports"
                .to_string(),
        )
            .into_response();
    };
    let spec = root.join(&p.project).join(format!("{}{}", p.slug, SPEC_SUFFIX));
    if !spec.is_file() {
        return (StatusCode::NOT_FOUND, format!("no report called {}", p.slug)).into_response();
    }

    let Some(tools) = crate::identity::tools_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this computer names no folder for a program's data, so the report tools have nowhere to live"
                .to_string(),
        )
            .into_response();
    };

    let cwd = build_cwd(&p, &db, &spec);
    let built = spec.with_file_name(format!("{}.json", p.slug));
    match report_output(&tools, &spec, &cwd, true, &built, p.wants_fresh()) {
        Ok(json) => ([(axum::http::header::CONTENT_TYPE, "application/json")], json).into_response(),
        Err(resp) => resp.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateProjectInput;

    fn db_with_projects(rows: &[(&str, &str, Option<&str>)]) -> Database {
        let db = Database::new_in_memory().expect("an in-memory database");
        for (name, path, local_path) in rows {
            db.create_project(CreateProjectInput {
                name: name.to_string(),
                path: path.to_string(),
                local_path: local_path.map(str::to_string),
                is_test: false,
            })
            .expect("create project");
        }
        db
    }

    /// A board of single pieces of work, each in the state named.
    fn states(rows: &[(&str, &str)]) -> HashMap<String, Card> {
        rows.iter()
            .map(|(id, st)| (id.to_string(), Card { state: st.to_string(), carries: false }))
            .collect()
    }

    #[test]
    fn a_question_holding_work_nobody_has_started_is_waiting() {
        let holds = vec!["a-1".to_string(), "a-2".to_string()];
        let seen = states(&[("a-1", "open"), ("a-2", "blocked")]);
        assert_eq!(waiting_of(&holds, &seen), 2);
    }

    #[test]
    fn closing_the_card_a_question_holds_takes_it_off_the_count() {
        let holds = vec!["a-1".to_string()];
        assert_eq!(waiting_of(&holds, &states(&[("a-1", "open")])), 1);
        assert_eq!(waiting_of(&holds, &states(&[("a-1", "closed")])), 0);
    }

    #[test]
    fn work_already_under_way_was_never_waiting_on_the_answer() {
        let holds = vec!["a-1".to_string()];
        assert_eq!(waiting_of(&holds, &states(&[("a-1", "in_progress")])), 0);
    }

    #[test]
    fn a_card_carrying_other_work_holds_nothing_up() {
        // It cannot finish until everything under it does, so the builder
        // refuses the page rather than ask again — and a mark on a report that
        // will not build sends the reader to an error (bw-7ks.21.13).
        let holds = vec!["a-1".to_string()];
        let goal = HashMap::from([(
            "a-1".to_string(),
            Card { state: "open".to_string(), carries: true },
        )]);
        assert_eq!(waiting_of(&holds, &goal), 0);
    }

    #[test]
    fn a_dropped_card_takes_its_question_with_it() {
        let holds = vec!["a-1".to_string()];
        assert_eq!(waiting_of(&holds, &states(&[("a-1", "cancelled")])), 0);
    }

    #[test]
    fn a_card_the_board_has_never_heard_of_holds_nothing() {
        let holds = vec!["gone-1".to_string()];
        assert_eq!(waiting_of(&holds, &HashMap::new()), 0);
    }

    #[test]
    fn a_card_dropped_by_its_label_reads_as_dropped_like_one_dropped_by_status() {
        let by_status = serde_json::json!({"id": "a-1", "status": "wontfix"});
        let by_label = serde_json::json!({"id": "a-2", "status": "open", "labels": ["dropped"]});
        assert_eq!(card_status(&by_status), "cancelled");
        assert_eq!(card_status(&by_label), "cancelled");
        assert_eq!(card_status(&serde_json::json!({"id": "a-3", "status": "open"})), "open");
    }

    #[test]
    fn the_cards_a_spec_holds_up_are_read_off_its_questions() {
        let spec = serde_json::json!({
            "actions": {"questions": [{"ask": "?", "holds": " a-1 "}, {"ask": "?", "holds": "a-2"}]}
        });
        assert_eq!(holds_of(&spec), vec!["a-1".to_string(), "a-2".to_string()]);
    }

    #[test]
    fn a_report_asking_nothing_holds_nothing_up() {
        let fyi = serde_json::json!({"actions": {"none": true, "fyi": "For your information."}});
        assert!(holds_of(&fyi).is_empty());
    }

    #[test]
    fn the_board_naming_a_card_it_could_not_find_still_leaves_readable_json() {
        let said = b"Error fetching nope-1: no issue found\n[{\"id\": \"a-1\", \"status\": \"open\"}]";
        let found = first_json(said).expect("the document after the board's own words");
        assert_eq!(found[0]["id"], "a-1");
    }

    #[test]
    fn the_project_whose_path_ends_in_the_name_is_picked_out_of_several() {
        let db = db_with_projects(&[
            ("Widgets", "/home/dev/widgets", None),
            ("Beads Web", "/home/dev/code/beads-web", None),
            ("Gadgets", "/home/dev/gadgets", None),
        ]);
        assert_eq!(resolve_project_path(&db, "beads-web"), Some("/home/dev/code/beads-web".to_string()));
    }

    #[test]
    fn local_path_is_preferred_over_path_when_it_names_a_folder() {
        // Mirrors `projectDir()` in src/lib/utils.ts: a Dolt project's own
        // `path` is a database address, not a directory, so `local_path` is
        // what the rest of the app runs filesystem commands in — and what
        // `reporting/tools/project.py` would have run in, to file the
        // report under this name in the first place.
        let db = db_with_projects(&[("Corsetta", "dolt://corsetta", Some("/home/dev/corsetta-checkout"))]);
        assert_eq!(
            resolve_project_path(&db, "corsetta-checkout"),
            Some("/home/dev/corsetta-checkout".to_string())
        );
    }

    #[test]
    fn nothing_resolves_a_project_name_no_row_matches() {
        let db = db_with_projects(&[("Widgets", "/home/dev/widgets", None)]);
        assert_eq!(resolve_project_path(&db, "keystone"), None);
    }

    /// Where a report filed under `project` would sit in the data folder.
    fn a_spec(project: &str) -> PathBuf {
        PathBuf::from("/data/reports").join(project).join("some-report.report.json")
    }

    #[test]
    fn an_explicit_path_wins_over_the_lookup_when_it_names_this_projects_own_folder() {
        let here = std::env::temp_dir().join("beads-web");
        std::fs::create_dir_all(&here).expect("a folder to name");
        let db = db_with_projects(&[("Beads Web", "/home/dev/code/beads-web", None)]);
        let named = here.to_string_lossy().to_string();
        assert_eq!(resolve_cwd(Some(&named), &db, "beads-web", &a_spec("beads-web")), named);
    }

    /// What the reports drawer used to do: it lists every report on the
    /// machine and handed each one the board the reader was looking at, so a
    /// report of another project was built against the wrong board and came
    /// back as an error about its card (bw-pqt.18).
    #[test]
    fn a_folder_belonging_to_another_project_loses_to_the_lookup() {
        let open_board = std::env::temp_dir().to_string_lossy().to_string();
        let db = db_with_projects(&[
            ("Beads Web", "/home/dev/code/beads-web", None),
            ("Machinery", "/home/dev/code/machinery", None),
        ]);
        assert_eq!(
            resolve_cwd(Some(&open_board), &db, "machinery", &a_spec("machinery")),
            "/home/dev/code/machinery".to_string()
        );
    }

    /// The one thing a named folder is still for: a project the app has never
    /// been told about, where there is nothing to look up.
    #[test]
    fn a_named_folder_still_opens_a_report_of_a_project_no_row_matches() {
        let db = db_with_projects(&[("Beads Web", "/home/dev/code/beads-web", None)]);
        let anywhere = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(resolve_cwd(Some(&anywhere), &db, "keystone", &a_spec("keystone")), anywhere);
    }

    /// The shape of a link handed over before the worktree it was built in
    /// was deleted. It is still about the same report, so it still opens.
    #[test]
    fn an_explicit_path_that_is_gone_falls_through_to_the_lookup() {
        let db = db_with_projects(&[("Beads Web", "/home/dev/code/beads-web", None)]);
        assert_eq!(
            resolve_cwd(
                Some("/home/dev/code/beads-web/worktrees/landed"),
                &db,
                "beads-web",
                &a_spec("beads-web"),
            ),
            "/home/dev/code/beads-web".to_string()
        );
    }

    /// Two of the reports on this machine are filed under a project the app
    /// was never told about. They name no card and their pictures sit beside
    /// the spec, so their own folder builds them — a refusal only meant the
    /// page would not open at all (bw-pqt.23).
    #[test]
    fn a_report_of_a_project_the_app_never_heard_of_builds_in_its_own_folder() {
        let db = db_with_projects(&[("Beads Web", "/home/dev/code/beads-web", None)]);
        assert_eq!(
            resolve_cwd(None, &db, "keystone", &a_spec("keystone")),
            "/data/reports/keystone".to_string()
        );
    }

    /// A dead `path` on such a link falls all the way through rather than
    /// stopping at the folder that is no longer there.
    #[test]
    fn a_dead_path_on_an_unknown_project_still_reaches_the_reports_own_folder() {
        let db = db_with_projects(&[("Beads Web", "/home/dev/code/beads-web", None)]);
        assert_eq!(
            resolve_cwd(Some("/gone/for/good"), &db, "keystone", &a_spec("keystone")),
            "/data/reports/keystone".to_string()
        );
    }

    fn params(project: &str, slug: &str) -> PageParams {
        PageParams { project: project.to_string(), slug: slug.to_string(), path: None, fresh: None }
    }

    #[test]
    fn a_name_carrying_a_path_separator_or_a_dot_is_refused() {
        assert!(bad_name(&params("../etc", "x")));
        assert!(bad_name(&params("beads-web", "../x")));
        assert!(bad_name(&params("be.ads", "x")));
        assert!(bad_name(&params("beads-web", "x\\y")));
        assert!(!bad_name(&params("beads-web", "some-report")));
    }

    /// The real report toolchain, exactly as `crate::report_tools` embeds it —
    /// so a test that runs the builder is exercising the same `build.py` a
    /// live server would have laid down, not a stand-in.
    fn real_tools_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../reporting/tools")
    }

    /// A spec with no card, no questions and one of every content shape the
    /// builder needs to see at least once — clean enough that `validate`
    /// never has to ask the board about anything.
    const CLEAN_SPEC: &str = r#"{
        "title": "Route Check",
        "actions": {"none": true, "fyi": "Nothing needs your input right now."},
        "status": {"now": "Building the new address.", "next_up": "Ship it."},
        "content": [{
            "label": "What changed",
            "blocks": [{"kind": "note", "tone": "good", "label": "Result", "text": "The new address hands back the same facts, not a page."}]
        }],
        "decisions": [{"id": "D1", "title": "Add the new address", "why": "The app needs facts, not a page."}],
        "next": {"if_nothing": "Nothing changes."}
    }"#;

    /// A builder that does nothing but take its time and leave a mark, for
    /// the test that counts how many runs four readers cause.
    const STAND_IN_BUILDER: &str = r#"import os, pathlib, sys, time

spec = pathlib.Path(sys.argv[1])
with open(spec.parent / "runs", "a") as tally:
    tally.write("x")
time.sleep(0.4)
out = spec.with_name(spec.name.replace(".report.json", ".json"))
part = out.with_name(out.name + ".part")
part.write_text('{"title": "built once"}')
os.replace(part, out)
"#;

    #[test]
    fn a_clean_spec_builds_into_the_same_facts_the_json_contract_names() {
        let project = tempfile::tempdir().expect("a project directory");
        let spec = project.path().join("route-check.report.json");
        std::fs::write(&spec, CLEAN_SPEC).expect("write the spec");
        let built = project.path().join("route-check.json");

        let json = run_builder(&real_tools_dir(), &spec, &project.path().to_string_lossy(), true, &built)
            .expect("a clean spec builds");
        let doc: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");

        assert_eq!(doc["title"], "Route Check");
        assert_eq!(doc["actions"]["questions"].as_array().unwrap().len(), 0);
        assert_eq!(doc["content"][0]["blocks"][0]["kind"], "note");
        assert_eq!(doc["decisions"][0]["id"], "D1");
        assert_eq!(doc["board"]["reachable"], true);
    }

    #[test]
    fn a_spec_the_builder_refuses_surfaces_as_a_422_with_its_own_reason() {
        let project = tempfile::tempdir().expect("a project directory");
        let spec = project.path().join("no-next.report.json");
        // Drops the required `next` slot, which `validate` refuses before it
        // ever asks the board about anything.
        let mut broken: serde_json::Value = serde_json::from_str(CLEAN_SPEC).expect("valid fixture JSON");
        broken.as_object_mut().expect("an object").remove("next");
        std::fs::write(&spec, serde_json::to_string(&broken).expect("serialize")).expect("write the spec");
        let built = project.path().join("no-next.json");

        let err = run_builder(&real_tools_dir(), &spec, &project.path().to_string_lossy(), true, &built)
            .expect_err("a spec missing a required slot must not build");
        assert_eq!(err.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(err.1.contains("this report does not build"), "{}", err.1);
        assert!(err.1.contains("next"), "{}", err.1);
        // The builder writes that sentence itself. Saying it again in front of
        // its own words showed the manager the same line twice (bw-pqt.21).
        assert_eq!(
            err.1.matches("this report does not build").count(),
            1,
            "the reason is the builder's own words, said once: {}",
            err.1
        );
        assert!(
            err.1.starts_with("this report does not build:"),
            "the message opens with the builder's own first line, with nothing in front of it: {}",
            err.1
        );
    }
    #[test]
    fn only_an_explicit_fresh_asks_for_a_new_run() {
        let mut p = params("beads-web", "some-report");
        assert!(!p.wants_fresh());
        p.fresh = Some("1".to_string());
        assert!(p.wants_fresh());
        p.fresh = Some("true".to_string());
        assert!(p.wants_fresh());
        p.fresh = Some("0".to_string());
        assert!(!p.wants_fresh());
    }

    /// The ten-second wait, gone: a report already built goes back untouched
    /// and nothing runs. Proved by pointing at a folder holding no tools at
    /// all — a build would fail here rather than answer.
    #[test]
    fn a_report_already_built_goes_back_without_running_anything() {
        let project = tempfile::tempdir().expect("a project directory");
        let spec = project.path().join("route-check.report.json");
        std::fs::write(&spec, CLEAN_SPEC).expect("write the spec");
        let built = project.path().join("route-check.json");
        std::fs::write(&built, "{\"title\":\"from the last build\"}").expect("write the last build");

        let out = report_output(
            Path::new("/nowhere/there/are/no/tools"),
            &spec,
            &project.path().to_string_lossy(),
            true,
            &built,
            false,
        )
        .expect("the last build answers on its own");
        assert!(out.contains("from the last build"), "{out}");
    }

    /// And the reader is not left holding it: the screen asks again for a real
    /// run, which replaces whatever the last one said.
    #[test]
    fn asking_for_fresh_facts_runs_the_toolchain_over_what_was_there() {
        let project = tempfile::tempdir().expect("a project directory");
        let spec = project.path().join("route-check.report.json");
        std::fs::write(&spec, CLEAN_SPEC).expect("write the spec");
        let built = project.path().join("route-check.json");
        std::fs::write(&built, "{\"title\":\"from the last build\"}").expect("write the last build");

        let out =
            report_output(&real_tools_dir(), &spec, &project.path().to_string_lossy(), true, &built, true)
                .expect("a clean spec builds");
        assert!(!out.contains("from the last build"), "{out}");
        let doc: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        assert_eq!(doc["title"], "Route Check");
    }

    #[test]
    fn a_report_never_built_before_is_built_on_the_spot() {
        let project = tempfile::tempdir().expect("a project directory");
        let spec = project.path().join("route-check.report.json");
        std::fs::write(&spec, CLEAN_SPEC).expect("write the spec");
        let built = project.path().join("route-check.json");

        let out =
            report_output(&real_tools_dir(), &spec, &project.path().to_string_lossy(), true, &built, false)
                .expect("nothing built yet, so it builds");
        let doc: serde_json::Value = serde_json::from_str(&out).expect("valid JSON");
        assert_eq!(doc["title"], "Route Check");
    }

    /// Four readers opening one report at the same moment run the toolchain
    /// once between them. Two runs at once are also two writers of one file,
    /// which is how a reader used to be handed a half-written report.
    #[test]
    fn readers_arriving_together_share_one_run() {
        let project = tempfile::tempdir().expect("a project directory");
        let tools = tempfile::tempdir().expect("a tools directory");
        // Stands in for build.py: slow enough that the others are all waiting
        // on it, and it records that it ran.
        std::fs::write(tools.path().join("build.py"), STAND_IN_BUILDER).expect("write the stand-in");
        let spec = project.path().join("route-check.report.json");
        std::fs::write(&spec, CLEAN_SPEC).expect("write the spec");
        let built = project.path().join("route-check.json");
        let tally = project.path().join("runs");

        let cwd = project.path().to_string_lossy().to_string();
        let hands: Vec<_> = (0..4)
            .map(|_| {
                let (tools, spec, built, cwd) =
                    (tools.path().to_path_buf(), spec.clone(), built.clone(), cwd.clone());
                std::thread::spawn(move || report_output(&tools, &spec, &cwd, true, &built, true))
            })
            .collect();
        for hand in hands {
            let out = hand.join().expect("the thread lived").expect("every reader is answered");
            assert!(out.contains("built once"), "{out}");
        }

        let ran = std::fs::read_to_string(&tally).expect("the tally");
        assert_eq!(ran.len(), 1, "the toolchain ran {} times for one report", ran.len());
    }
}
