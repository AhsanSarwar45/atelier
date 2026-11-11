//! Tasks over HTTP (docs/tasks.md, "HTTP").
//!
//! The CLI (`atelier task`, actor `agent`) and the Tasks screen (actor
//! `owner`) both post to `/task`. What needs the outside world — git, for the
//! commits a `done` names, and the media store, for its evidence files — is
//! done here before the change is handed to the database writer.

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
    let tasks = state
        .database()
        .read_tasks(move |store| {
            let rows = tasks::list(store.connection(), Some(&listed_project), session.as_deref())?;
            Ok(rows.iter().map(|row| tasks::to_json(store, row)).collect::<Vec<_>>())
        })
        .await
        .map_err(failed)?;
    Ok(Json(json!({"projectId": project, "tasks": tasks})))
}

/// GET /api/workbench/tasks/:project/:number
pub(super) async fn detail(
    State(state): State<WorkbenchState>,
    Path((project, number)): Path<(String, i64)>,
) -> Result<Json<Value>, ApiError> {
    let found = state
        .database()
        .read_tasks(move |store| {
            let Some(row) = tasks::get(store.connection(), &project, number)? else {
                return Ok(None);
            };
            let events = tasks::events(store.connection(), &project, number)?;
            Ok(Some(json!({"task": tasks::to_json(store, &row), "events": events})))
        })
        .await
        .map_err(failed)?;
    found
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("there is no task #{number} in this project")))
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
fn store_evidence(
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
    let asked = Request {
        action: request.action,
        actor: request.actor,
        session,
        project,
        number: request.number,
        payload,
        missing_commits: missing,
        cwd,
        now: chrono::Utc::now().timestamp_millis(),
    };
    let outcome = state
        .database()
        .write_tasks(move |store| {
            tasks::apply(store, &asked).map(|outcome| (tasks::to_json(store, &outcome.task), outcome.summary))
        })
        .await
        .map_err(failed)?;
    let (task, summary) = match outcome {
        Ok(done) => done,
        Err(TaskError::Refused(message)) => return Err(message.into()),
        Err(TaskError::Failed(message)) => return Err(failed(message)),
    };
    let widget = tasks::widget(&action, &task).map_err(failed)?;
    let _ = state.watch_polls.send(json!({
        "type": "tasks.changed", "kind": "tasks.changed",
        "projectId": task["projectId"], "number": task["number"],
    }));
    Ok(Json(json!({"task": task, "widget": widget, "summary": summary})))
}
