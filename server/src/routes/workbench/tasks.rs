//! Tasks over HTTP (docs/tasks.md, "HTTP").
//!
//! The CLI (`atelier task`, actor `agent`) and the Tasks screen (actor
//! `owner`) both post to `/task`. What needs the outside world — git, for the
//! commits a `done` names, and the media store, for its evidence files — is
//! done here before the change is handed to the database writer.

use super::grids::{announce_grids, prints_for};
use super::tell::tell_chat;
use super::{decoded, presentation_directory, ApiError, WorkbenchState};
use crate::workbench::grids;
use crate::workbench::tasks::{self, checks, types, Request, TaskError};
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

#[derive(Deserialize)]
pub(super) struct KindsQuery {
    session: Option<String>,
    project: Option<String>,
}

/// The project a types call is about: the chat's, the one named, or none
/// (the install's types alone).
async fn kinds_project(state: &WorkbenchState, session: Option<&str>, project: Option<&str>) -> Result<Option<String>, ApiError> {
    if let Some(id) = session.filter(|id| !id.is_empty()) {
        let found = state
            .database()
            .get_session(id.to_string())
            .await
            .map_err(failed)?
            .ok_or_else(|| format!("no chat session {id}: ATELIER_CHAT_SESSION_ID must name a chat in this app"))?;
        return Ok(Some(found.project_id));
    }
    Ok(project.filter(|id| !id.is_empty()).map(str::to_string))
}

/// The data folder, and the project's folder for its task types.
fn kinds_folders(state: &WorkbenchState, project: Option<&str>) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>), ApiError> {
    let data = crate::workbench::library::data_dir()?;
    let dir = match project {
        None => None,
        Some(project) => {
            let folder = project_folder(state, project).ok_or_else(|| format!("there is no project {project}"))?;
            Some(
                tasks::catalog::project_dir(&data, std::path::Path::new(&folder))
                    .ok_or_else(|| "Register this project before changing its task types".to_string())?,
            )
        }
    };
    Ok((data, dir))
}

/// GET /api/workbench/task-types: the types a chat's (or a project's) tasks
/// may use, with their default items.
pub(super) async fn kinds(State(state): State<WorkbenchState>, Query(query): Query<KindsQuery>) -> Result<Json<Value>, ApiError> {
    let project = kinds_project(&state, query.session.as_deref(), query.project.as_deref()).await?;
    let folder = project.as_deref().and_then(|project| project_folder(&state, project));
    let catalog = tasks::catalog::for_folder(folder.as_deref().map(std::path::Path::new))?;
    Ok(Json(catalog.listing()))
}

#[derive(Deserialize)]
pub(super) struct KindsChange {
    session: Option<String>,
    project: Option<String>,
    /// `atelier task types create|edit|disable|enable`'s change
    /// (catalog.rs `change`), or `{action: undo, scope}` from the owner.
    change: Value,
}

/// POST /api/workbench/task-types: change a scope's task types, or undo the
/// last change. Every change is told to the app, which shows it to the owner.
pub(super) async fn change_kinds(State(state): State<WorkbenchState>, Json(request): Json<KindsChange>) -> Result<Json<Value>, ApiError> {
    let project = kinds_project(&state, request.session.as_deref(), request.project.as_deref()).await?;
    let (data, dir) = kinds_folders(&state, project.as_deref())?;
    let summary = if request.change["action"] == "undo" {
        let scope = request.change["scope"].as_str().unwrap_or("project");
        tasks::catalog::undo(&data, dir.as_deref(), scope)?
    } else {
        tasks::catalog::change(&data, dir.as_deref(), &request.change)?
    };
    if let Some(project) = &project {
        let _ = state.watch_polls.send(json!({
            "type": "taskTypes.changed", "kind": "taskTypes.changed", "projectId": project, "summary": summary,
        }));
    }
    Ok(Json(json!({"summary": summary})))
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
    /// Evidence files the CLI read for `done` or `check`, by the path the result names,
    /// base64'd — the presenter's upload, reused.
    #[serde(default)]
    files: BTreeMap<String, String>,
    /// Only the app's E2E harness sets this, as for the presenter.
    #[serde(default)]
    ephemeral: bool,
    /// The owner's `create`: the grid cells picked, `{slug, rows, cols,
    /// onlyGaps}` with rows and cols a list of ids or `"*"`.
    #[serde(default)]
    grid: Option<Value>,
    /// The owner's `create`: the chat to hold the task, or `"new"`.
    #[serde(default)]
    chat: Option<String>,
    /// The owner's `create` in a new chat: the provider to start it on;
    /// left off, the project's latest chat's.
    #[serde(default)]
    brand: Option<String>,
}

/// The project's `[tasks]` settings, from its manifest.
fn task_settings(state: &WorkbenchState, project: &str, fallback: Option<&str>) -> crate::project_manifest::TaskSettings {
    match project_folder(state, project).or_else(|| fallback.map(str::to_string)) {
        Some(folder) => checks::project_settings(std::path::Path::new(&folder)),
        None => Default::default(),
    }
}

/// The task types the project offers: built-ins, the install's and its own.
fn type_catalog(state: &WorkbenchState, project: &str) -> Result<tasks::catalog::Catalog, ApiError> {
    let folder = project_folder(state, project);
    tasks::catalog::for_folder(folder.as_deref().map(std::path::Path::new)).map_err(|error| ApiError::from(error))
}

/// For a draft with checks, in the folder its checks run in: the locked
/// files' hashes, the check files missing, and the weak-check lint.
async fn draft_gate(state: &WorkbenchState, project: &str, folder: Option<&str>, kind: &Value, plan: &Value) -> Option<checks::Gate> {
    let folder = folder?.to_string();
    let harness = task_settings(state, project, Some(&folder)).harness;
    let (kind, plan) = (kind.as_str().unwrap_or_default().to_string(), plan.clone());
    tokio::task::spawn_blocking(move || checks::draft_gate(std::path::Path::new(&folder), &kind, &plan, &harness)).await.ok()
}

/// For start, check, done, an amend and its approval, of a task with checks: run
/// what the writer judges (checks.rs `measure`), in the task's folder (the
/// agent's chat, or for the owner the holding chat's). `None` for a task
/// made before checks, or another action.
async fn task_gate(
    state: &WorkbenchState,
    project: &str,
    number: Option<i64>,
    action: &str,
    actor: &str,
    cwd: Option<&str>,
    payload: &Value,
) -> Option<checks::Gate> {
    if !matches!((actor, action), ("agent", "start" | "check" | "done" | "amend")) {
        return None;
    }
    let (asked, number) = (project.to_string(), number?);
    let (task, holder) = state
        .database()
        .read_tasks(move |store| {
            Ok(tasks::get(store.connection(), &asked, number)?.map(|task| {
                let folder = folder_of(store, &task);
                (task, folder)
            }))
        })
        .await
        .ok()
        .flatten()?;
    if !tasks::gate::gated(&task) {
        return None;
    }
    let folder = cwd.map(str::to_string).or(holder).or_else(|| project_folder(state, project));
    let Some(folder) = folder else {
        return Some(checks::Gate { error: Some("the task's chat has no folder".into()), ..Default::default() });
    };
    let measure = match action {
        "start" => checks::Measure::Start,
        "check" => checks::Measure::Item(payload["item"].as_str().unwrap_or_default().trim().to_string()),
        "done" => checks::Measure::Done { test_command: task_settings(state, project, Some(&folder)).test_command },
        "amend" => checks::Measure::Amend { plan: payload.get("plan").filter(|plan| !plan.is_null())?.clone() },
        _ => return None,
    };
    let stored = task.gate.clone().unwrap_or(Value::Null);
    let at = chrono::Utc::now().timestamp_millis();
    Some(checks::measure(std::path::Path::new(&folder), &task.kind, &task.plan, &stored, measure, at).await)
}

/// A session's folder.
async fn session_folder(state: &WorkbenchState, session: &str) -> Option<String> {
    state.database().get_session(session.to_string()).await.ok().flatten().map(|session| session.cwd)
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
        let gate = draft_gate(&state, &project, cwd.as_deref(), &payload["type"], &payload["plan"]).await;
        let types = type_catalog(&state, &project)?;
        let outcome = state
            .database()
            .write_tasks(move |store| {
                tasks::propose(store, &asked_project, &session, &payload, &prints, gate.as_ref(), now, &types)
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
        let found = state
            .database()
            .read_tasks(move |store| tasks::get_proposal(store.connection(), &asked, id))
            .await
            .map_err(failed)?;
        let named = found.as_ref().map(|p| p.cells.clone()).unwrap_or(Value::Null);
        let prints = prints_for(&state, &project, cell_grids(&json!({"cells": named}))).await;
        // Create task approves the checks: lock their files as they are now.
        let gate = match found.as_ref().filter(|_| choice == "create") {
            Some(proposal) => {
                let folder = session_folder(&state, &proposal.session_id).await;
                draft_gate(&state, &project, folder.as_deref(), &json!(proposal.kind), &proposal.plan).await
            }
            None => None,
        };
        let answered = project.clone();
        let outcome = state
            .database()
            .write_tasks(move |store| {
                tasks::answer_proposal(store, &answered, id, &choice, &prints, gate.as_ref(), now).map(|(proposal, task, grids)| {
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
    if request.action == "create" && request.actor == "owner" {
        return owner_create(&state, project, request.grid, request.chat, request.brand).await;
    }
    let mut payload = request.payload;
    let mut missing = HashSet::new();
    let mut visual = Vec::new();
    if request.action == "check" && request.actor == "agent" {
        // One item's entry carries its evidence the way a done result does.
        if let Some(entry) = payload.get_mut("entry") {
            let directory = presentation_directory(&state, request.ephemeral)?;
            store_evidence(entry, request.files, &directory)?;
        }
    } else if request.action == "done" && request.actor == "agent" {
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
            // The safety net under feature and bug: which of the files the
            // commits change show on screen, by the project's own list.
            let changed = tasks::git::changed_files(std::path::Path::new(cwd), &commits).await;
            if !changed.is_empty() {
                let folder = project_folder(&state, &project).unwrap_or_else(|| cwd.to_string());
                let patterns = tasks::visual::project_patterns(std::path::Path::new(&folder));
                visual = tasks::visual::visual_files(&changed, &patterns);
            }
        }
    }
    let action = request.action.clone();
    let actor = request.actor.clone();
    let note = payload["note"].as_str().unwrap_or_default().to_string();
    let prints = if request.action == "create" { prints_for(&state, &project, cell_grids(&payload)).await } else { Default::default() };
    let gate = if request.action == "create" && request.actor == "agent" {
        draft_gate(&state, &project, cwd.as_deref(), &payload["type"], &payload["plan"]).await
    } else {
        task_gate(&state, &project, request.number, &request.action, &request.actor, cwd.as_deref(), &payload).await
    };
    let announced = project.clone();
    let types = type_catalog(&state, &project)?;
    let asked = Request {
        action: request.action,
        actor: request.actor,
        session,
        project,
        number: request.number,
        payload,
        missing_commits: missing,
        cwd,
        visual_files: visual,
        prints,
        gate,
        types,
        now: chrono::Utc::now().timestamp_millis(),
    };
    let outcome = state
        .database()
        .write_tasks(move |store| {
            tasks::apply(store, &asked).map(|outcome| {
                let folder = folder_of(store, &outcome.task);
                let json = tasks::to_json(store, &outcome.task);
                (json, outcome.summary, outcome.grids, outcome.detail, outcome.task, folder)
            })
        })
        .await
        .map_err(failed)?;
    let (task, summary, grids, detail, row, folder) = refused_or(outcome)?;
    let widget = tasks::widget(&action, &task, &detail).map_err(failed)?;
    announce(&state, &task["projectId"], &task["number"]);
    announce_grids(&state, &announced, &grids);
    // The owner's approve, reopen and plan-change answers are told to the
    // chat holding the task, like a proposal's answer.
    if let Some(session) = tasks::told_chat(&actor, &action, &row).map(str::to_string) {
        let merge = if action == "approve" {
            let commits: Vec<String> = task["result"]["commits"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            let folder = folder.or_else(|| project_folder(&state, &announced));
            tasks::git::merge_state(folder.as_deref().map(std::path::Path::new), &commits).await
        } else {
            tasks::git::MergeState::Unknown
        };
        if let Some(said) = tasks::owner_prompt(&action, &row, &note, &merge) {
            // Queued behind a turn still running, as a proposal's answer is.
            let telling = state.clone();
            tokio::spawn(async move { tell_chat(&telling, &session, said).await });
        }
    }
    // A check that leaves its item unmet is recorded, and the CLI exits non-zero.
    let failed = action == "check" && detail["met"] == false;
    Ok(Json(json!({"task": task, "widget": widget, "summary": summary, "failed": failed})))
}

/// The owner's Create task on the Grids screen: a todo task for the picked
/// cells that need work, claimed at once, held by an existing chat or one
/// started for it, which is told to start it.
async fn owner_create(
    state: &WorkbenchState,
    project: String,
    grid: Option<Value>,
    chat: Option<String>,
    brand: Option<String>,
) -> Result<Json<Value>, ApiError> {
    let pick = grid
        .as_ref()
        .ok_or_else(|| "grid is required: {slug, rows, cols, onlyGaps}".to_string())
        .and_then(grids::Pick::parse)?;
    let chat = chat
        .map(|chat| chat.trim().to_string())
        .filter(|chat| !chat.is_empty())
        .ok_or_else(|| "chat is required: a chat's id, or \"new\" for a new chat".to_string())?;
    let prints = prints_for(state, &project, vec![pick.slug.clone()]).await;
    // Check before a chat is started for it: nothing is left behind by a
    // pick with nothing to do.
    let (asked, checked, checked_prints) = (project.clone(), pick.clone(), prints.clone());
    let (picked, latest) = state
        .database()
        .read_tasks(move |store| {
            let latest = store.list_sessions(Some(&asked))?.into_iter().next();
            Ok((grids::picked_task(store.connection(), &asked, &checked, &checked_prints).map(|(payload, _)| payload), latest))
        })
        .await
        .map_err(failed)?;
    let picked = refused_or(picked)?;
    let title = picked["title"].as_str().unwrap_or_default().to_string();
    // A chat started here is ours to take back: whatever fails from here on
    // removes it, so a failed create leaves nothing behind.
    let made = (chat == "new").then(|| uuid::Uuid::new_v4().to_string());
    let session = if let Some(id) = &made {
        if let Err(error) = start_chat(state, &project, id, &title, latest.as_ref(), brand).await {
            discard_chat(state, id).await;
            return Err(error);
        }
        id.clone()
    } else {
        let found = state
            .database()
            .get_session(chat.clone())
            .await
            .map_err(failed)?
            .ok_or_else(|| format!("there is no chat {chat}"))?;
        if found.project_id != project {
            return Err(format!("chat {chat} belongs to another project").into());
        }
        chat
    };
    let (asked, held) = (project.clone(), session.clone());
    let folder = session_folder(state, &session).await.or_else(|| project_folder(state, &project));
    let gate = draft_gate(state, &project, folder.as_deref(), &picked["type"], &picked["plan"]).await;
    let now = chrono::Utc::now().timestamp_millis();
    let types = type_catalog(state, &project)?;
    let outcome = state
        .database()
        .write_tasks(move |store| {
            tasks::create_from_pick(store, &asked, &held, &pick, &prints, gate.as_ref(), now, &types)
                .map(|(task, grids, prompt)| (tasks::to_json(store, &task), grids, prompt))
        })
        .await
        .map_err(failed)
        .and_then(refused_or);
    let (task, grids, prompt) = match outcome {
        Ok(created) => created,
        Err(error) => {
            if let Some(id) = &made {
                discard_chat(state, id).await;
            }
            return Err(error);
        }
    };
    announce(state, &task["projectId"], &task["number"]);
    announce_grids(state, &project, &grids);
    let telling = state.clone();
    let told = session.clone();
    tokio::spawn(async move { tell_chat(&telling, &told, prompt).await });
    Ok(Json(json!({"task": task, "sessionId": session})))
}

/// Start chat `id` in the project for a task the owner created: on the given
/// provider, else the project's latest chat's, in the project's folder.
async fn start_chat(
    state: &WorkbenchState,
    project: &str,
    id: &str,
    title: &str,
    latest: Option<&crate::workbench::store::Session>,
    brand: Option<String>,
) -> Result<(), ApiError> {
    use crate::workbench::protocol::{Command, CommandKind};
    let path = latest
        .map(|session| session.project_path.clone())
        .or_else(|| project_folder(state, project))
        .ok_or_else(|| format!("the project {project} has no folder to start a chat in"))?;
    let brand = brand.or_else(|| latest.map(|session| session.brand.clone())).unwrap_or_else(|| "claude".into());
    let mut fields = serde_json::Map::from_iter([
        ("sessionId".into(), json!(id)),
        ("projectId".into(), json!(project)),
        ("projectPath".into(), json!(path)),
        ("brand".into(), json!(brand)),
        ("title".into(), json!(title)),
    ]);
    if let Some(profile) = latest.and_then(|session| session.profile.clone()).filter(|_| latest.is_some_and(|s| s.brand == brand)) {
        fields.insert("profileId".into(), json!(profile));
    }
    let reply = state
        .registry
        .execute(&Command { kind: CommandKind::SessionStart, fields })
        .await
        .map_err(|error| format!("a new chat could not be started: {error}"))?;
    state.publish_holds().await;
    if reply["id"].as_str() != Some(id) {
        return Err(failed("the new chat came back without its id".into()));
    }
    // Pin the task's title as the owner's own name for the chat, so the name
    // the provider makes from its first message does not replace it.
    let fields = serde_json::Map::from_iter([("sessionId".into(), json!(id)), ("title".into(), json!(title))]);
    state
        .registry
        .execute(&Command { kind: CommandKind::SessionRename, fields })
        .await
        .map_err(|error| failed(format!("the new chat could not be named: {error}")))?;
    Ok(())
}

/// Take back a chat `owner_create` started for a task it then failed to
/// make: close it if it is running, then delete it as the owner's own delete
/// does, or, where that is refused, the app's copy of it.
async fn discard_chat(state: &WorkbenchState, id: &str) {
    use crate::workbench::protocol::{Command, CommandKind};
    let named = || serde_json::Map::from_iter([("sessionId".into(), json!(id))]);
    if state.registry.has_driver(id).await {
        let _ = state.registry.execute(&Command { kind: CommandKind::SessionClose, fields: named() }).await;
    }
    let deleted = state.registry.execute(&Command { kind: CommandKind::SessionDelete, fields: named() }).await;
    if deleted.is_err() {
        let _ = state.database().delete_session(id.to_string()).await;
    }
    state.publish_holds().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::{
        actor::ChatDb,
        grids::search,
        protocol::Command,
        registry::{LaunchFuture, LaunchedSession, RegistryPaths, SessionFactory, WorkbenchRegistry},
        store::Session,
    };
    use std::sync::Arc;

    /// A provider that writes the chat's row, as a real start does before its
    /// process answers, and then either fails (`fail`) or starts with no
    /// driver; `race` has another task take every cell meanwhile.
    struct RowFirst {
        fail: bool,
        race: bool,
    }

    impl SessionFactory for RowFirst {
        fn launch<'a>(&'a self, database: ChatDb, command: &'a Command) -> LaunchFuture<'a> {
            Box::pin(async move {
                let text = |key: &str| command.fields.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
                let session = Session {
                    id: text("sessionId"),
                    brand: text("brand"),
                    external_id: None,
                    project_id: text("projectId"),
                    project_path: text("projectPath"),
                    cwd: text("projectPath"),
                    model: None,
                    permission_mode: "default".into(),
                    effort: None,
                    collaboration_mode: None,
                    profile: None,
                    title: Some(text("title")),
                    state: if self.fail { "errored" } else { "idle" }.into(),
                    origin: "app".into(),
                    created_at: "2026-11-12T00:00:00.000Z".into(),
                    last_active_at: "2026-11-12T00:00:00.000Z".into(),
                    last_spoke_at: None,
                    begun_by: Some("person".into()),
                    named_by_owner: false,
                    auto_approve: false,
                };
                database.create_session(session.clone()).await?;
                if self.race {
                    database
                        .write_tasks(|store| store.connection().execute("UPDATE grid_cell SET state = 'proved'", []).map(|_| ()))
                        .await?
                        .map_err(|error| error.to_string())?;
                }
                if self.fail {
                    return Err("the provider would not start".into());
                }
                Ok(LaunchedSession {
                    session_id: session.id.clone(),
                    reply: serde_json::to_value(&session).unwrap(),
                    driver: None,
                })
            })
        }
    }

    /// A project with an approved grid `camera` of two rows and two columns.
    async fn fixture(factory: RowFirst) -> (tempfile::TempDir, WorkbenchState, String) {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let paths = RegistryPaths {
            home: directory.path().to_path_buf(),
            claude_config: directory.path().join("claude"),
            codex_home: directory.path().join("codex"),
            profiles: directory.path().join("profiles"),
            media: directory.path().join("media"),
        };
        let registry = WorkbenchRegistry::new(database, paths, Arc::new(factory));
        let projects = Arc::new(crate::db::Database::new_in_memory().unwrap());
        let project = projects
            .create_project(crate::db::CreateProjectInput {
                name: "camera-app".into(),
                path: directory.path().display().to_string(),
                local_path: None,
                is_test: false,
            })
            .unwrap()
            .id;
        let state = WorkbenchState::new(registry).with_projects(projects);
        let request = |action: &str, actor: &str| grids::Request {
            action: action.into(),
            actor: actor.into(),
            session: (actor == "agent").then(|| "drafter".to_string()),
            project: project.clone(),
            now: 1,
            ..Default::default()
        };
        let mut draft = request("draft", "agent");
        draft.payload = json!({
            "slug": "camera", "title": "Camera", "area": "An area.",
            "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
            "columns": [
                {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": [{"name": "gpu", "command": "cargo test {row}_on_gpu", "kind": "test",
                    "given": "the {row} pass", "when": "it renders", "then": "it ran on the GPU", "red": "FAILED|panicked"}]},
                {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark check", "checks": [{"name": "perf", "command": "cargo test {row}_in_budget", "kind": "test",
                    "given": "the {row} pass", "when": "it renders", "then": "it is within budget", "red": "FAILED|panicked"}]},
            ],
        });
        let found = |id: &str| search::Found {
            id: id.into(),
            name: id.to_uppercase(),
            paths: vec![format!("camera/{id}.rs")],
            kind: "feature".into(),
            of: Vec::new(),
        };
        draft.search = Some(Ok(search::Run { rows: vec![found("glare"), found("sunstar")], head: Some("h1".into()) }));
        let mut approve = request("approve", "owner");
        approve.slug = Some("camera".into());
        state
            .database()
            .write_tasks(move |store| {
                grids::apply(store.connection(), &draft).unwrap();
                grids::apply(store.connection(), &approve).unwrap();
            })
            .await
            .unwrap();
        (directory, state, project)
    }

    async fn create_in_a_new_chat(state: &WorkbenchState, project: &str) -> Result<Json<Value>, ApiError> {
        let grid = json!({"slug": "camera", "rows": ["glare"], "cols": "*", "onlyGaps": false});
        owner_create(state, project.to_string(), Some(grid), Some("new".into()), Some("claude".into())).await
    }

    async fn chats(state: &WorkbenchState, project: &str) -> Vec<Session> {
        state.database().list_sessions(Some(project.to_string())).await.unwrap()
    }

    #[tokio::test]
    async fn a_new_chat_that_fails_to_start_is_taken_back() {
        let (_directory, state, project) = fixture(RowFirst { fail: true, race: false }).await;
        assert!(create_in_a_new_chat(&state, &project).await.is_err());
        assert!(chats(&state, &project).await.is_empty());
        let open = state.database().read_tasks(|store| Ok(tasks::list(store.connection(), None, None)?.len())).await.unwrap();
        assert_eq!(open, 0);
    }

    #[tokio::test]
    async fn a_new_chat_whose_task_is_then_refused_is_taken_back() {
        let (_directory, state, project) = fixture(RowFirst { fail: false, race: true }).await;
        assert!(create_in_a_new_chat(&state, &project).await.is_err());
        assert!(chats(&state, &project).await.is_empty());
    }

    #[tokio::test]
    async fn a_new_chat_holds_the_task_it_was_started_for() {
        let (_directory, state, project) = fixture(RowFirst { fail: false, race: false }).await;
        let Json(created) = create_in_a_new_chat(&state, &project).await.map_err(|_| "refused").unwrap();
        let started = chats(&state, &project).await;
        assert_eq!(started.len(), 1);
        assert_eq!(created["sessionId"], json!(started[0].id));
        assert_eq!(created["task"]["title"], "camera: GLARE row");
        assert_eq!(started[0].title.as_deref(), Some("camera: GLARE row"));
        // Pinned as the owner's name, so the provider's own title cannot replace it.
        assert!(started[0].named_by_owner);
    }
}
