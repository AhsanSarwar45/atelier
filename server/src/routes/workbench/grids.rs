//! Coverage grids over HTTP (docs/grids.md, "HTTP").
//!
//! The CLI (`atelier grid`, actor `agent`) and the Grids screen (actor
//! `owner`) both post to `/grid`. What needs the outside world — the row
//! search, the checks, git for fingerprints, dirty paths and commits — runs
//! here first, outside the database writer; then the change goes to the
//! writer with what was found. The watcher that reruns row searches when HEAD
//! moves lives here too, since it needs the live feed.

use super::tasks::{project_folder, store_evidence};
use super::tell::tell_chat;
use super::{presentation_directory, ApiError, WorkbenchState};
use crate::workbench::grids::{self, proof, search, watch, Loaded, Prints, Request};
use crate::workbench::tasks::{checks, TaskError};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn failed(message: String) -> ApiError {
    ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, message }
}

fn refused_or<T>(outcome: Result<T, TaskError>) -> Result<T, ApiError> {
    match outcome {
        Ok(done) => Ok(done),
        Err(TaskError::Refused(message)) => Err(message.into()),
        Err(TaskError::Failed(message)) => Err(failed(message)),
    }
}

/// Tell every screen these grids changed.
pub(super) fn announce_grids(state: &WorkbenchState, project: &str, slugs: &[String]) {
    for slug in slugs {
        let _ = state.watch_polls.send(json!({
            "type": "grids.changed", "kind": "grids.changed", "projectId": project, "slug": slug,
        }));
    }
}

fn folder_path(state: &WorkbenchState, project: &str) -> Option<PathBuf> {
    project_folder(state, project).map(PathBuf::from).filter(|path| path.is_dir())
}

/// Fingerprints of every row of these grids in `folder` at its HEAD.
async fn prints_of(folder: Option<&std::path::Path>, loaded: &[Loaded]) -> (Prints, Option<String>) {
    let mut prints = Prints::new();
    let Some(folder) = folder else { return (prints, None) };
    let Some(head) = proof::head(folder).await else { return (prints, None) };
    for grid in loaded {
        if grid.grid.status != "approved" {
            continue;
        }
        for (row, paths) in grid.coverage() {
            if let Some(print) = proof::fingerprint(folder, &head, &paths).await {
                prints.insert((grid.grid.slug.clone(), row), print);
            }
        }
    }
    (prints, Some(head))
}

async fn load_all(state: &WorkbenchState, project: &str, slugs: Option<Vec<String>>) -> Result<Vec<Loaded>, String> {
    let project = project.to_string();
    state
        .database()
        .read_tasks(move |store| {
            let connection = store.connection();
            let slugs = match slugs {
                Some(slugs) => slugs,
                None => grids::list_grids(connection, &project)?.into_iter().map(|g| g.slug).collect(),
            };
            let mut loaded = Vec::new();
            for slug in slugs {
                if let Some(grid) = grids::load(connection, &project, &slug)? {
                    loaded.push(grid);
                }
            }
            Ok(loaded)
        })
        .await
}

/// Fingerprints, in the project's folder, of the rows of these grids: what
/// tells a stale proof from a fresh one. Used by tasks for their `cells`.
pub(super) async fn prints_for(state: &WorkbenchState, project: &str, slugs: Vec<String>) -> Prints {
    if slugs.is_empty() {
        return Prints::new();
    }
    let loaded = load_all(state, project, Some(slugs)).await.unwrap_or_default();
    prints_of(folder_path(state, project).as_deref(), &loaded).await.0
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    project: Option<String>,
    session: Option<String>,
}

async fn project_of(state: &WorkbenchState, project: Option<String>, session: Option<String>) -> Result<String, ApiError> {
    match (project, session) {
        (Some(project), _) => Ok(project),
        (None, Some(session)) => Ok(state
            .database()
            .get_session(session.clone())
            .await
            .map_err(failed)?
            .ok_or_else(|| ApiError::not_found(format!("no session {session}")))?
            .project_id),
        (None, None) => Err("project or session is required".to_string().into()),
    }
}

/// GET /api/workbench/grids?project=ID (or ?session=ID)
pub(super) async fn list(
    State(state): State<WorkbenchState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let project = project_of(&state, query.project, query.session).await?;
    let loaded = load_all(&state, &project, None).await.map_err(failed)?;
    let (prints, _) = prints_of(folder_path(&state, &project).as_deref(), &loaded).await;
    let asked = project.clone();
    let templates = state
        .database()
        .read_tasks(move |store| grids::templates(store.connection(), &asked))
        .await
        .map_err(failed)?;
    let summaries: Vec<Value> = loaded.iter().map(|grid| grids::summary(grid, &prints)).collect();
    let templates: Vec<Value> = templates.iter().map(grids::template_json).collect();
    Ok(Json(json!({"projectId": project, "grids": summaries, "templates": templates})))
}

/// The detail of one grid: summary, columns, rows and cells.
async fn grid_detail(state: &WorkbenchState, project: &str, slug: &str) -> Result<Value, ApiError> {
    let loaded = load_all(state, project, Some(vec![slug.to_string()])).await.map_err(failed)?;
    let grid = loaded.into_iter().next().ok_or_else(|| ApiError::not_found(format!("there is no grid \"{slug}\" in this project")))?;
    // The grids a reference row reads its cells from.
    let mut owners: Vec<String> = grid
        .rows
        .iter()
        .filter(|row| row.kind == "reference" && row.removed_at.is_none())
        .filter_map(|row| row.reference.as_ref().and_then(|r| r["grid"].as_str()).map(str::to_string))
        .collect();
    owners.sort();
    owners.dedup();
    let owners = load_all(state, project, Some(owners)).await.map_err(failed)?;
    let mut all = vec![grid.clone()];
    all.extend(owners.iter().cloned());
    let (prints, head) = prints_of(folder_path(state, project).as_deref(), &all).await;
    let mut cells: Vec<Value> = grid
        .cells
        .iter()
        .map(|cell| grids::with_checks(&grid, &cell.row, &cell.col, grids::cell_json(cell, grids::is_stale(&grid.grid.slug, cell, &prints), false)))
        .collect();
    for row in grid.rows.iter().filter(|row| row.kind == "reference" && row.removed_at.is_none()) {
        let Some(target) = &row.reference else { continue };
        let (Some(owner), Some(target_row)) = (target["grid"].as_str(), target["row"].as_str()) else { continue };
        let Some(owner) = owners.iter().find(|o| o.grid.slug == owner) else { continue };
        for column in grid.columns.iter().filter(|c| c.retired_at.is_none()) {
            if let Some(cell) = owner.cell(target_row, &column.id) {
                let mut value = grids::with_checks(owner, target_row, &column.id, grids::cell_json(cell, grids::is_stale(&owner.grid.slug, cell, &prints), false));
                value["row"] = json!(row.id);
                value["ref"] = json!(true);
                cells.push(value);
            }
        }
    }
    let asked = project.to_string();
    let cells = state
        .database()
        .read_tasks(move |store| {
            let mut cells = cells;
            grids::with_claim_chats(store.connection(), &asked, &mut cells)?;
            Ok(cells)
        })
        .await
        .map_err(failed)?;
    Ok(json!({
        "grid": grids::summary(&grid, &prints), "head": head,
        "columns": grid.columns.iter().map(grids::column_json).collect::<Vec<_>>(),
        "rows": grid.rows.iter().map(grids::row_json).collect::<Vec<_>>(),
        "cells": cells,
    }))
}

/// GET /api/workbench/grids/:project/:slug
pub(super) async fn detail(
    State(state): State<WorkbenchState>,
    Path((project, slug)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(grid_detail(&state, &project, &slug).await?))
}

/// One cell, with its whole proof and its history, and the grid's prints.
async fn cell_detail(state: &WorkbenchState, project: &str, slug: &str, row: &str, col: &str) -> Result<Value, ApiError> {
    let loaded = load_all(state, project, Some(vec![slug.to_string()])).await.map_err(failed)?;
    let grid = loaded.first().ok_or_else(|| ApiError::not_found(format!("there is no grid \"{slug}\" in this project")))?;
    let cell = grid
        .cell(row, col)
        .ok_or_else(|| ApiError::not_found(format!("there is no cell {slug}.{row}.{col}")))?;
    let (prints, _) = prints_of(folder_path(state, project).as_deref(), &loaded).await;
    let (asked, slug_owned, row_owned, col_owned) = (project.to_string(), slug.to_string(), row.to_string(), col.to_string());
    let events = state
        .database()
        .read_tasks(move |store| grids::events(store.connection(), &asked, &slug_owned, Some((&row_owned, &col_owned))))
        .await
        .map_err(failed)?;
    // Whether the proof's commits are in the base branch, as a task's Merged badge reads.
    let commits: Vec<String> = cell
        .proof
        .as_ref()
        .and_then(|proof| proof["commits"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let merged = match folder_path(state, project) {
        Some(folder) if !commits.is_empty() => crate::workbench::tasks::git::merged(&folder, &commits).await,
        _ => None,
    };
    let mut full = grids::with_checks(grid, row, col, grids::cell_json(cell, grids::is_stale(slug, cell, &prints), true));
    full["merged"] = json!(merged);
    let asked = project.to_string();
    let full = state
        .database()
        .read_tasks(move |store| {
            let mut cells = [full];
            grids::with_claim_chats(store.connection(), &asked, &mut cells)?;
            let [full] = cells;
            Ok(full)
        })
        .await
        .map_err(failed)?;
    Ok(json!({
        "cell": full,
        "row": grid.row(row).map(grids::row_json),
        "column": grid.column(col).map(grids::column_json),
        "events": events,
    }))
}

/// GET /api/workbench/grids/:project/:slug/cells/:row/:col
pub(super) async fn cell(
    State(state): State<WorkbenchState>,
    Path((project, slug, row, col)): Path<(String, String, String, String)>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(cell_detail(&state, &project, &slug, &row, &col).await?))
}

#[derive(Deserialize)]
pub(super) struct NextQuery {
    row: Option<String>,
    col: Option<String>,
}

/// GET /api/workbench/grids/:project/:slug/next[?row=ROW|?col=COL]
///
/// The free cells of the first row that has any (or of the row or column
/// named), the cells there other tasks hold, how many free cells the grid
/// has left, and a ready `task create` payload for the free ones.
pub(super) async fn next(
    State(state): State<WorkbenchState>,
    Path((project, slug)): Path<(String, String)>,
    Query(query): Query<NextQuery>,
) -> Result<Json<Value>, ApiError> {
    let scope = match (query.row, query.col) {
        (Some(_), Some(_)) => return Err("give row or col, not both".to_string().into()),
        (Some(row), None) => grids::Scope::Row(row),
        (None, Some(col)) => grids::Scope::Col(col),
        (None, None) => grids::Scope::First,
    };
    let prints = prints_for(&state, &project, vec![slug.clone()]).await;
    let found = state
        .database()
        .read_tasks(move |store| Ok(grids::next_cells(store.connection(), &project, &slug, &prints, &scope)))
        .await
        .map_err(failed)?;
    Ok(Json(refused_or(found)?))
}

#[derive(Deserialize)]
pub(super) struct ActionRequest {
    action: String,
    actor: String,
    session: Option<String>,
    project: Option<String>,
    slug: Option<String>,
    row: Option<String>,
    col: Option<String>,
    #[serde(default)]
    payload: Value,
    /// Evidence files the CLI read for `prove`, base64'd by path.
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    ephemeral: bool,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn apply(state: &WorkbenchState, request: Request) -> Result<grids::Outcome, ApiError> {
    let outcome = state.database().write_tasks(move |store| grids::apply(store.connection(), &request)).await.map_err(failed)?;
    refused_or(outcome)
}

/// POST /api/workbench/grid
pub(super) async fn act(
    State(state): State<WorkbenchState>,
    Json(asked): Json<ActionRequest>,
) -> Result<Json<Value>, ApiError> {
    let (project, session, cwd) = match asked.actor.as_str() {
        "agent" => {
            let id = asked.session.clone().ok_or_else(|| "session is required for agent actions".to_string())?;
            let session = state
                .database()
                .get_session(id.clone())
                .await
                .map_err(failed)?
                .ok_or_else(|| format!("no chat session {id}: ATELIER_CHAT_SESSION_ID must name a chat in this app"))?;
            (session.project_id, Some(id), Some(session.cwd))
        }
        "owner" => (
            asked.project.clone().ok_or_else(|| "project is required for owner actions".to_string())?,
            None,
            None,
        ),
        other => return Err(format!("actor must be agent or owner, not \"{other}\"").into()),
    };
    let mut request = Request {
        action: asked.action.clone(),
        actor: asked.actor.clone(),
        session: session.clone(),
        project: project.clone(),
        slug: asked.slug.clone(),
        row: asked.row.clone(),
        col: asked.col.clone(),
        payload: asked.payload,
        cwd: cwd.clone(),
        now: now(),
        ..Default::default()
    };
    let slugs = |request: &Request| request.slug.iter().cloned().collect::<Vec<_>>();
    match asked.action.as_str() {
        "draft" => {
            // Gate before running anything: another chat's draft is not
            // this chat's to replace, so no search runs for it.
            let slug = request.payload["slug"].as_str().unwrap_or("").to_string();
            if let Some(session) = session.clone() {
                if grids::valid_id(&slug) {
                    let asked_project = project.clone();
                    let allowed = state
                        .database()
                        .read_tasks(move |store| Ok(grids::may_draft(store.connection(), &asked_project, &session, &slug)))
                        .await
                        .map_err(failed)?;
                    refused_or(allowed)?;
                }
            }
            let row_search = search::check_row_search(&request.payload["row_search"]).map_err(ApiError::from)?;
            let folder = PathBuf::from(cwd.clone().unwrap_or_default());
            request.search = Some(search::run(&folder, &row_search).await);
        }
        "discover" => {
            let slug = request.slug.clone().ok_or_else(|| "slug is required for discover".to_string())?;
            let Some(_running) = watch::start(format!("discover:{project}:{slug}")) else {
                return Err(format!("discovery for \"{slug}\" is already running").into());
            };
            let outcome = discover(&state, &project, &slug, session.clone(), &asked.actor).await?;
            return respond(&state, &project, outcome).await;
        }
        "prove" => return prove(&state, request, asked.files, asked.ephemeral).await,
        "verify" => return verify(&state, request).await,
        "pass" => {
            request.prints = prints_for(&state, &project, slugs(&request)).await;
        }
        "approve" => {
            // Approval locks every cell's check files as they are now in the project.
            let (asked, slug) = (project.clone(), request.slug.clone().unwrap_or_default());
            let pending = state
                .database()
                .read_tasks(move |store| Ok(grids::get_grid(store.connection(), &asked, &slug)?.and_then(|grid| grid.pending)))
                .await
                .map_err(failed)?;
            if let (Some(pending), Some(folder)) = (pending, folder_path(&state, &project)) {
                let files = grids::pending_check_files(&pending);
                request.hashes = Some(json!({"files": checks::hash_files(&folder, &checks::widened(&folder, &files))}));
            }
        }
        _ => {}
    }
    let outcome = apply(&state, request).await?;
    respond(&state, &project, outcome).await
}

/// The folder a grid's row search runs in: the project's for an approved
/// grid; for a draft, the drafting chat's, while it has one.
async fn search_folder(state: &WorkbenchState, project: &str, grid: &grids::Grid) -> Option<PathBuf> {
    if grid.status == "draft" {
        if let Some(session) = grid.drafted_by.clone().or_else(|| grid.created_by.clone()) {
            if let Ok(Some(found)) = state.database().get_session(session).await {
                let folder = PathBuf::from(found.cwd);
                if folder.is_dir() {
                    return Some(folder);
                }
            }
        }
    }
    folder_path(state, project)
}

/// Run a grid's row search and apply it.
async fn discover(
    state: &WorkbenchState,
    project: &str,
    slug: &str,
    session: Option<String>,
    actor: &str,
) -> Result<grids::Outcome, ApiError> {
    let loaded = load_all(state, project, Some(vec![slug.to_string()])).await.map_err(failed)?;
    let grid = loaded
        .into_iter()
        .next()
        .filter(|g| g.grid.status != "discarded")
        .ok_or_else(|| format!("there is no grid \"{slug}\" in this project"))?
        .grid;
    let row_search = match &grid.status[..] {
        "draft" => grid.pending.as_ref().map(|p| p["rowSearch"].clone()).unwrap_or(grid.row_search.clone()),
        _ => grid.row_search.clone(),
    };
    let (found, head) = match search_folder(state, project, &grid).await {
        Some(folder) => {
            let head = proof::head(&folder).await;
            (search::run(&folder, &row_search).await, head)
        }
        None => (Err("the project's folder does not exist".to_string()), None),
    };
    apply(state, Request {
        action: "discover".into(),
        actor: actor.into(),
        session,
        project: project.into(),
        slug: Some(slug.into()),
        search: Some(found),
        head,
        now: now(),
        ..Default::default()
    })
    .await
}

/// The answer to a change: the grid, the cell, the card and the summary.
/// Tells the chats waiting on it and announces it.
async fn respond(state: &WorkbenchState, project: &str, outcome: grids::Outcome) -> Result<Json<Value>, ApiError> {
    let mut touched = outcome.grids.clone();
    if let Some(slug) = &outcome.slug {
        if !touched.contains(slug) {
            touched.push(slug.clone());
        }
    }
    announce_grids(state, project, &touched);
    for (session, text) in outcome.tell.clone() {
        let telling = state.clone();
        tokio::spawn(async move { tell_chat(&telling, &session, text).await });
    }
    let grid = match &outcome.slug {
        Some(slug) => Some(grid_detail(state, project, slug).await?),
        None => None,
    };
    let summary = grid.as_ref().map(|g| g["grid"].clone());
    let cell = match (&outcome.slug, &outcome.cell) {
        (Some(slug), Some((row, col))) => Some(cell_detail(state, project, slug, row, col).await?["cell"].clone()),
        _ => None,
    };
    let widget = match outcome.widget {
        Some(event) => {
            let mut card = json!({"type": "grid", "event": event});
            if let Some(summary) = &summary {
                card["grid"] = summary.clone();
            }
            if let Some(cell) = &cell {
                card["cell"] = cell.clone();
            }
            if let Some(template) = &outcome.template {
                card["template"] = template.clone();
            }
            if let Some(audit) = &outcome.audit {
                card["audit"] = audit.clone();
            }
            Some(crate::workbench::media::widget_block(&card).map_err(failed)?)
        }
        None => None,
    };
    if outcome.widget == Some("discover") {
        if outcome.failed.is_some() {
            return Err(ApiError::from(outcome.summary.clone()));
        }
    }
    Ok(Json(json!({
        "grid": summary, "cell": cell, "widget": widget, "summary": outcome.summary,
        "failed": outcome.failed, "template": outcome.template, "audit": outcome.audit,
    })))
}

/// Run a cell's approved checks in `folder` as test-first checks are run (a
/// benchmark repeated and judged on its budget), as proof results.
async fn run_approved(folder: &std::path::Path, approved: &[Value]) -> Vec<proof::CheckResult> {
    let mut results = Vec::new();
    for value in approved {
        let name = value["name"].as_str().unwrap_or("?").to_string();
        let check = match checks::parse_check(value, &name) {
            Ok(check) => check,
            Err(error) => {
                results.push(proof::CheckResult { name, exit: -1, ms: 0, tail: error });
                continue;
            }
        };
        let run = checks::run_check(folder, &check, None, now()).await;
        let (exit, tail) = match checks::judge_green(&check, &run, None) {
            Ok(()) => (0, run.output_tail),
            Err(why) => (if run.exit == 0 { 1 } else { run.exit }, format!("{}\n{why}", run.output_tail)),
        };
        results.push(proof::CheckResult { name, exit, ms: run.ms, tail });
    }
    results
}

/// The sha256 of each file the approved checks name, and of every file in
/// the test folders they live in, in `folder`.
fn approved_hashes(folder: &std::path::Path, approved: &[Value]) -> Value {
    let paths: Vec<String> = approved
        .iter()
        .flat_map(|check| check["files"].as_array().cloned().unwrap_or_default())
        .filter_map(|path| path.as_str().map(str::to_string))
        .collect();
    json!({"files": checks::hash_files(folder, &checks::widened(folder, &paths))})
}

/// `prove`: check the shape and the claim, then the covered code (committed,
/// commits present), then run the checks in the chat's folder and take the
/// fingerprint there. Then the writer.
async fn prove(
    state: &WorkbenchState,
    mut request: Request,
    files: BTreeMap<String, String>,
    ephemeral: bool,
) -> Result<Json<Value>, ApiError> {
    if let Some(evidence) = request.payload.get_mut("evidence") {
        let directory = presentation_directory(state, ephemeral)?;
        store_evidence(evidence, files, &directory)?;
    }
    let precheck = Request {
        action: request.action.clone(),
        actor: request.actor.clone(),
        session: request.session.clone(),
        project: request.project.clone(),
        slug: request.slug.clone(),
        row: request.row.clone(),
        col: request.col.clone(),
        payload: request.payload.clone(),
        ..Default::default()
    };
    let checked = state
        .database()
        .read_tasks(move |store| Ok(grids::prove_precheck(store.connection(), &precheck)))
        .await
        .map_err(failed)?;
    let (checked, paths) = refused_or(checked)?;
    let asked = Request {
        action: request.action.clone(),
        project: request.project.clone(),
        slug: request.slug.clone(),
        row: request.row.clone(),
        col: request.col.clone(),
        ..Default::default()
    };
    let approved = state
        .database()
        .read_tasks(move |store| Ok(grids::approved_for(store.connection(), &asked)))
        .await
        .map_err(failed)?;
    let (approved, _) = refused_or(approved)?;
    let folder = PathBuf::from(request.cwd.clone().unwrap_or_default());
    request.dirty = proof::dirty(&folder, &paths).await.map_err(ApiError::from)?;
    request.missing_commits = proof::missing_commits(&folder, &checked.commits).await;
    if !approved.is_empty() {
        request.hashes = Some(approved_hashes(&folder, &approved));
    }
    if request.dirty.is_empty() && request.missing_commits.is_empty() {
        request.checks = if approved.is_empty() {
            proof::run_checks(&folder, &checked.checks).await
        } else {
            run_approved(&folder, &approved).await
        };
        if request.checks.iter().all(proof::CheckResult::passed) {
            request.head = proof::head(&folder).await;
            if let Some(head) = &request.head {
                request.fingerprint = proof::fingerprint(&folder, head, &paths).await;
            }
        }
    }
    let project = request.project.clone();
    let outcome = apply(state, request).await?;
    respond(state, &project, outcome).await
}

/// Re-run one proved cell's checks in the project's folder, and apply.
async fn verify_one(state: &WorkbenchState, base: &Request, row: &str, col: &str) -> Result<grids::Outcome, ApiError> {
    let project = base.project.clone();
    let slug = base.slug.clone().unwrap_or_default();
    let Some(_running) = watch::start(format!("verify:{project}:{slug}:{row}:{col}")) else {
        return Err(format!("{slug}.{row}.{col} is already being re-checked").into());
    };
    let loaded = load_all(state, &project, Some(vec![slug.clone()])).await.map_err(failed)?;
    let grid = loaded.first().ok_or_else(|| format!("there is no grid \"{slug}\" in this project"))?;
    let cell = grid.cell(row, col).ok_or_else(|| format!("there is no cell {slug}.{row}.{col}"))?;
    let folder = folder_path(state, &project).ok_or_else(|| "the project's folder does not exist".to_string())?;
    let (prints, head) = prints_of(Some(&folder), &loaded).await;
    // The cell's approved checks; a cell proved before checks re-runs its proof's own.
    let approved = grid.cell_checks(row, col);
    let checks = cell.proof.as_ref().map(proof::stored_checks).unwrap_or_default();
    let results = match (cell.state == "proved", approved.is_empty()) {
        (true, false) => run_approved(&folder, &approved).await,
        (true, true) if !checks.is_empty() => proof::run_checks(&folder, &checks).await,
        _ => Vec::new(),
    };
    let fingerprint = prints.get(&(slug.clone(), row.to_string())).cloned();
    apply(state, Request {
        action: "verify".into(),
        actor: base.actor.clone(),
        session: base.session.clone(),
        project: project.clone(),
        slug: Some(slug),
        row: Some(row.into()),
        col: Some(col.into()),
        checks: results,
        fingerprint,
        head,
        prints,
        now: now(),
        ..Default::default()
    })
    .await
}

/// `verify`: one cell, or every proved cell of the grid one at a time
/// (`staleOnly`: the stale ones), each announced as it lands.
async fn verify(state: &WorkbenchState, request: Request) -> Result<Json<Value>, ApiError> {
    let project = request.project.clone();
    let slug = request.slug.clone().ok_or_else(|| "slug is required for verify".to_string())?;
    if let (Some(row), Some(col)) = (request.row.clone(), request.col.clone()) {
        let outcome = verify_one(state, &request, &row, &col).await?;
        return respond(state, &project, outcome).await;
    }
    let stale_only = request.payload["staleOnly"].as_bool().unwrap_or(false);
    let loaded = load_all(state, &project, Some(vec![slug.clone()])).await.map_err(failed)?;
    let grid = loaded
        .first()
        .filter(|g| g.grid.status == "approved")
        .ok_or_else(|| format!("there is no approved grid \"{slug}\" in this project"))?;
    let (prints, _) = prints_of(folder_path(state, &project).as_deref(), &loaded).await;
    let targets = grids::verify_targets(grid, &prints, stale_only);
    let (mut passed, mut failures) = (0, Vec::new());
    for (row, col) in &targets {
        match verify_one(state, &request, row, col).await {
            Ok(outcome) => {
                announce_grids(state, &project, &[slug.clone()]);
                match outcome.failed {
                    Some(reason) => failures.push(format!("{slug}.{row}.{col}: {reason}")),
                    None => passed += 1,
                }
            }
            Err(error) => failures.push(format!("{slug}.{row}.{col}: {}", error.message)),
        }
    }
    let mut summary = format!(
        "Re-checked {} {}cell{} of \"{slug}\": {passed} passed, {} failed.",
        targets.len(),
        if stale_only { "stale " } else { "" },
        if targets.len() == 1 { "" } else { "s" },
        failures.len()
    );
    for failure in &failures {
        summary.push_str(&format!("\n- {failure}"));
    }
    let grid = grid_detail(state, &project, &slug).await?;
    Ok(Json(json!({"grid": grid["grid"], "cell": null, "widget": null, "summary": summary,
        "failed": if failures.is_empty() { Value::Null } else { json!(failures.join("; ")) }})))
}

/// The watcher's tick: for each project with approved grids, HEAD in the
/// project's folder; each grid due (never discovered, or HEAD moved across a
/// path it watches) gets its search run, one at a time.
async fn watch_tick(state: &WorkbenchState) {
    let projects = state
        .database()
        .read_tasks(|store| grids::projects_with_grids(store.connection()))
        .await
        .unwrap_or_default();
    for project in projects {
        let Some(folder) = folder_path(state, &project) else { continue };
        let Some(head) = proof::head(&folder).await else { continue };
        let Ok(loaded) = load_all(state, &project, None).await else { continue };
        for grid in loaded.iter().filter(|g| g.grid.status == "approved") {
            let slug = grid.grid.slug.clone();
            let run = match watch::due(grid.grid.discovery.as_ref(), &head) {
                watch::Due::Current => false,
                watch::Due::Never => true,
                watch::Due::Moved(old) => {
                    let watched: Vec<String> = grid.grid.row_search["watch"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                    match proof::changed_between(&folder, &old, &head).await {
                        Some(changed) => watch::touches(&watched, &changed),
                        // The old commit is gone (a rewrite): run it.
                        None => true,
                    }
                }
            };
            if !run {
                // Nothing it watches changed: remember this HEAD, quietly.
                if let watch::Due::Moved(_) = watch::due(grid.grid.discovery.as_ref(), &head) {
                    let (asked, slug, head) = (project.clone(), slug.clone(), head.clone());
                    let _ = state
                        .database()
                        .write_tasks(move |store| {
                            store.connection().execute(
                                "UPDATE grid SET discovery = json_set(discovery, '$.head', ?3) WHERE project_id = ?1 AND slug = ?2",
                                rusqlite::params![asked, slug, head],
                            )
                        })
                        .await;
                }
                continue;
            }
            let Some(_running) = watch::start(format!("discover:{project}:{slug}")) else { continue };
            match discover(state, &project, &slug, None, "app").await {
                Ok(outcome) => {
                    tracing::info!(project = %project, grid = %slug, "{}", outcome.summary);
                    announce_grids(state, &project, &[slug.clone()]);
                }
                Err(error) => tracing::warn!(project = %project, grid = %slug, "grid discovery failed: {}", error.message),
            }
        }
    }
}

/// Start the grid watcher (docs/grids.md, "Row search": when it runs).
pub fn watch(state: WorkbenchState) {
    watch::spawn(move || {
        let state = state.clone();
        async move { watch_tick(&state).await }
    });
}
