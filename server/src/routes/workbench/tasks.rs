//! Tasks over HTTP (docs/tasks.md, "HTTP").
//!
//! The CLI (`atelier task`, actor `agent`) and the Tasks screen (actor
//! `owner`) both post to `/task`. What needs the outside world — git, for the
//! commits a `done` names, and the media store, for its evidence files — is
//! done here before the change is handed to the database writer.

use super::grids::{announce_grids, prints_for};
use super::tell::tell_chat;
use super::{decoded, presentation_directory, ApiError, WorkbenchState};
use crate::workbench::tasks::{self, types, Request, TaskError};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

fn failed(message: String) -> ApiError {
    ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, message }
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    project: Option<String>,
    session: Option<String>,
    /// With `session` and no `project`: the session's whole project.
    all: Option<String>,
}

/// GET /api/workbench/tasks?project=ID[&session=ID]
///
/// `session` alone lists that session's tasks; `session` with `all=1` lists
/// its project's. The answer names the project, for the CLI.
pub(super) async fn list(
    State(state): State<WorkbenchState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let project = match (&query.project, &query.session) {
        (Some(project), _) => project.clone(),
        (None, Some(session)) => {
            state
                .database()
                .get_session(session.clone())
                .await
                .map_err(failed)?
                .ok_or_else(|| ApiError::not_found(format!("no session {session}")))?
                .project_id
        }
        (None, None) => return Err("project or session is required".to_string().into()),
    };
    let everything = matches!(query.all.as_deref(), Some("1" | "true" | "yes"));
    let session = if everything { None } else { query.session.clone() };
    let listed_project = project.clone();
    let mut tasks = state
        .database()
        .read_tasks(move |store| {
            let rows = tasks::list(store.connection(), Some(&listed_project), session.as_deref())?;
            Ok(rows.iter().map(|row| (tasks::to_json(store, row), folder_of(store, row))).collect::<Vec<_>>())
        })
        .await
        .map_err(failed)?;
    let fallback = project_folder(&state, &project);
    for (task, folder) in &mut tasks {
        with_merged(task, folder.as_deref().or(fallback.as_deref())).await;
    }
    let tasks: Vec<Value> = tasks.into_iter().map(|(task, _)| task).collect();
    Ok(Json(json!({"projectId": project, "tasks": tasks})))
}

/// GET /api/workbench/tasks/:project/:number
pub(super) async fn detail(
    State(state): State<WorkbenchState>,
    Path((project, number)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    let fallback = project_folder(&state, &project);
    let found = state
        .database()
        .read_tasks(move |store| {
            let Some(row) = tasks::get(store.connection(), &project, number)? else {
                return Ok(None);
            };
            let events = tasks::events(store.connection(), &project, number)?;
            Ok(Some((tasks::to_json(store, &row), folder_of(store, &row), events)))
        })
        .await
        .map_err(failed)?;
    let (mut task, folder, events) =
        found.ok_or_else(|| ApiError::not_found(format!("there is no task #{number} in this project")))?;
    with_merged(&mut task, folder.as_deref().or(fallback.as_deref())).await;
    Ok(Json(json!({"task": task, "events": events})))
}

/// GET /api/workbench/task-proposals/:project/:id
pub(super) async fn proposal(
    State(state): State<WorkbenchState>,
    Path((project, id)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    let found = state
        .database()
        .read_tasks(move |store| Ok(tasks::get_proposal(store.connection(), &project, id)?.map(|p| tasks::proposal_json(&p))))
        .await
        .map_err(failed)?;
    found
        .map(|proposal| Json(json!({"proposal": proposal})))
        .ok_or_else(|| ApiError::not_found(format!("there is no proposal {id} in this project")))
}

/// The folder a task's commits are looked for in: its holding session's.
fn folder_of(store: &crate::workbench::store::Store, task: &tasks::TaskRow) -> Option<String> {
    let session = task.session_id.as_ref().or(task.created_by.as_ref())?;
    store.get_session(session).ok().flatten().map(|session| session.cwd)
}

/// The project's own folder, for a task whose session is gone.
pub(super) fn project_folder(state: &WorkbenchState, project: &str) -> Option<String> {
    let found = state.projects.as_ref()?.get_project(project).ok()?;
    Some(found.local_path.filter(|path| !path.is_empty()).unwrap_or(found.path))
}

/// `merged`: for a done task with commits, whether every one is in the base
/// branch (`tasks::git::merged`); null when there is nothing to say.
async fn with_merged(task: &mut Value, folder: Option<&str>) {
    let commits: Vec<String> = task["result"]["commits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let merged = match folder {
        Some(folder) if task["status"] == "done" && !commits.is_empty() && std::path::Path::new(folder).is_dir() => {
            tasks::git::merged(std::path::Path::new(folder), &commits).await
        }
        _ => None,
    };
    task["merged"] = json!(merged);
}

/// GET /api/workbench/task-types
pub(super) async fn kinds() -> Json<Value> {
    Json(types::listing())
}

#[derive(Deserialize)]
pub(super) struct ActionRequest {
    action: String,
    actor: String,
    session: Option<String>,
    project: Option<String>,
    number: Option<i64>,
    #[serde(default)]
    payload: Value,
    /// Evidence files the CLI read for `done`, by the path the result names,
    /// base64'd — the presenter's upload, reused.
    #[serde(default)]
    files: BTreeMap<String, String>,
    /// Only the app's E2E harness sets this, as for the presenter.
    #[serde(default)]
    ephemeral: bool,
}

/// Which of these commits the repository at `cwd` does not have.
async fn missing_commits(cwd: &str, commits: &[String]) -> HashSet<String> {
    let mut missing = HashSet::new();
    for sha in commits {
        let found = tokio::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(["cat-file", "-e", &format!("{sha}^{{commit}}")])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
        if !found {
            missing.insert(sha.clone());
        }
    }
    missing
}

/// Store each uploaded evidence file and put its served address where the
/// result named its path.
pub(super) fn store_evidence(
    result: &mut Value,
    files: BTreeMap<String, String>,
    directory: &std::path::Path,
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let mut named = Vec::new();
    tasks::media_strings(result, &mut named);
    let files = decoded(files)?;
    let mut stored = HashMap::new();
    for path in named {
        let Some(bytes) = files.get(&path) else { continue };
        let lower = path.to_ascii_lowercase();
        let image = types::IMAGE_EXTENSIONS.iter().any(|ext| lower.ends_with(&format!(".{ext}")));
        let asset = if image {
            crate::workbench::media::import_image(bytes, &path, directory)?
        } else {
            crate::workbench::media::import_attachment(bytes, &path, directory)?
        };
        stored.insert(path, format!("{}{asset}", types::SERVED));
    }
    tasks::replace_strings(result, &stored);
    Ok(())
}

/// POST /api/workbench/task
pub(super) async fn act(
    State(state): State<WorkbenchState>,
    Json(request): Json<ActionRequest>,
) -> Result<Json<Value>, ApiError> {
    let (project, session, cwd) = match request.actor.as_str() {
        "agent" => {
            let id = request
                .session
                .clone()
                .ok_or_else(|| "session is required for agent actions".to_string())?;
            let session = state
                .database()
                .get_session(id.clone())
                .await
                .map_err(failed)?
                .ok_or_else(|| format!("no chat session {id}: ATELIER_CHAT_SESSION_ID must name a chat in this app"))?;
            (session.project_id, Some(id), Some(session.cwd))
        }
        "owner" => (
            request
                .project
                .clone()
                .ok_or_else(|| "project is required for owner actions".to_string())?,
            None,
            None,
        ),
        other => return Err(format!("actor must be agent or owner, not \"{other}\"").into()),
    };
    if request.action == "propose" && request.actor == "agent" {
        let session = session.unwrap_or_default();
        let payload = request.payload;
        let now = chrono::Utc::now().timestamp_millis();
        let asked_project = project.clone();
        let prints = prints_for(&state, &project, cell_grids(&payload)).await;
        let outcome = state
            .database()
            .write_tasks(move |store| {
                tasks::propose(store, &asked_project, &session, &payload, &prints, now)
                    .map(|(proposal, summary)| (tasks::proposal_json(&proposal), summary))
            })
            .await
            .map_err(failed)?;
        let (proposal, summary) = refused_or(outcome)?;
        let widget = tasks::proposal_widget(&proposal).map_err(failed)?;
        announce(&state, &proposal["projectId"], &Value::Null);
        return Ok(Json(json!({"proposal": proposal, "widget": widget, "summary": summary})));
    }
    if request.action == "answer_proposal" && request.actor == "owner" {
        let id = request.number.ok_or_else(|| "number is required: the proposal's id".to_string())?;
        let choice = request.payload["choice"]
            .as_str()
            .ok_or_else(|| format!("choice is required: one of {}", tasks::PROPOSAL_CHOICES.join(", ")))?
            .to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let asked = project.clone();
        let named = state
            .database()
            .read_tasks(move |store| {
                Ok(tasks::get_proposal(store.connection(), &asked, id)?.map(|p| p.cells).unwrap_or(Value::Null))
            })
            .await
            .map_err(failed)?;
        let prints = prints_for(&state, &project, cell_grids(&json!({"cells": named}))).await;
        let answered = project.clone();
        let outcome = state
            .database()
            .write_tasks(move |store| {
                tasks::answer_proposal(store, &answered, id, &choice, &prints, now).map(|(proposal, task, grids)| {
                    let prompt = tasks::answer_prompt(&proposal);
                    (tasks::proposal_json(&proposal), task.map(|task| tasks::to_json(store, &task)), prompt, proposal.session_id, grids)
                })
            })
            .await
            .map_err(failed)?;
        let (proposal, task, prompt, session, grids) = refused_or(outcome)?;
        announce(&state, &proposal["projectId"], task.as_ref().map_or(&Value::Null, |task| &task["number"]));
        announce_grids(&state, &project, &grids);
        // The agent stopped to wait for this; it hears the answer as its
        // next message, queued behind a turn still running.
        let telling = state.clone();
        let said = prompt.clone();
        tokio::spawn(async move { tell_chat(&telling, &session, said).await });
        return Ok(Json(json!({"proposal": proposal, "task": task, "summary": prompt})));
    }
    let mut payload = request.payload;
    let mut missing = HashSet::new();
    if request.action == "done" && request.actor == "agent" {
        if let Some(result) = payload.get_mut("result") {
            let directory = presentation_directory(&state, request.ephemeral)?;
            store_evidence(result, request.files, &directory)?;
        }
        let commits: Vec<String> = payload["commits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|sha| sha.trim().to_ascii_lowercase())
            .filter(|sha| (7..=40).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit()))
            .collect();
        if let Some(cwd) = cwd.as_deref() {
            missing = missing_commits(cwd, &commits).await;
        }
    }
    let action = request.action.clone();
    let prints = if request.action == "create" { prints_for(&state, &project, cell_grids(&payload)).await } else { Default::default() };
    let announced = project.clone();
    let asked = Request {
        action: request.action,
        actor: request.actor,
        session,
        project,
        number: request.number,
        payload,
        missing_commits: missing,
        cwd,
        prints,
        now: chrono::Utc::now().timestamp_millis(),
    };
    let outcome = state
        .database()
        .write_tasks(move |store| {
            tasks::apply(store, &asked).map(|outcome| (tasks::to_json(store, &outcome.task), outcome.summary, outcome.grids))
        })
        .await
        .map_err(failed)?;
    let (task, summary, grids) = refused_or(outcome)?;
    let widget = tasks::widget(&action, &task).map_err(failed)?;
    announce(&state, &task["projectId"], &task["number"]);
    announce_grids(&state, &announced, &grids);
    Ok(Json(json!({"task": task, "widget": widget, "summary": summary})))
}

fn refused_or<T>(outcome: Result<T, TaskError>) -> Result<T, ApiError> {
    match outcome {
        Ok(done) => Ok(done),
        Err(TaskError::Refused(message)) => Err(message.into()),
        Err(TaskError::Failed(message)) => Err(failed(message)),
    }
}

/// The grids a payload's `cells` name.
fn cell_grids(payload: &Value) -> Vec<String> {
    let mut grids: Vec<String> = payload["cells"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|cell| cell["grid"].as_str().map(str::to_string))
        .collect();
    grids.sort();
    grids.dedup();
    grids
}

/// Tell every screen the project's tasks changed.
pub(super) fn announce(state: &WorkbenchState, project: &Value, number: &Value) {
    let _ = state.watch_polls.send(json!({
        "type": "tasks.changed", "kind": "tasks.changed",
        "projectId": project, "number": number,
    }));
}
