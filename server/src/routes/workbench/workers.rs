//! Worker chats: an orchestrator chat starts and steers ordinary chats on
//! the provider, account and model the owner chose for it
//! (docs/designs/orchestrator-workers.md). `atelier tool worker` is the
//! agent's way in; the calling chat is named in every request.

use super::tell::{tell_chat, Delivery};
use super::{ApiError, WorkbenchState};
use crate::workbench::protocol::{Command, CommandKind};
use crate::workbench::status::is_mid_turn;
use crate::workbench::store::Session;
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

/// How much of a worker's chat `read` returns without `all`.
const READ_TAIL: usize = 6000;

#[derive(Deserialize)]
pub(super) struct Ask {
    action: String,
    /// The orchestrator chat asking.
    session: String,
    worker: Option<String>,
    title: Option<String>,
    text: Option<String>,
    #[serde(default)]
    all: bool,
    /// Interrupt the worker's turn so the message goes in now.
    #[serde(default)]
    now: bool,
}

pub(super) async fn act(State(state): State<WorkbenchState>, Json(ask): Json<Ask>) -> Result<Json<Value>, ApiError> {
    let orchestrator = chat(&state, &ask.session).await?;
    match ask.action.as_str() {
        "start" => start(&state, &orchestrator, &ask).await,
        "send" => send(&state, &orchestrator, &ask).await,
        "list" => list(&state, &orchestrator).await,
        "read" => read(&state, &orchestrator, &ask).await,
        "stop" => stop(&state, &orchestrator, &ask).await,
        other => Err(format!("{other} is not a worker action; use start, send, list, read or stop").into()),
    }
}

async fn chat(state: &WorkbenchState, id: &str) -> Result<Session, ApiError> {
    state
        .database()
        .get_session(id.to_string())
        .await?
        .ok_or_else(|| ApiError::from(format!("{id} is not a chat Atelier knows")))
}

/// Chat `id` when it is one of `orchestrator`'s workers.
async fn own_worker(state: &WorkbenchState, orchestrator: &Session, id: Option<&str>) -> Result<Session, ApiError> {
    let id = id.ok_or_else(|| ApiError::from("name the worker's chat ID".to_string()))?;
    let worker = chat(state, id).await?;
    if worker.parent_session_id.as_deref() != Some(orchestrator.id.as_str()) {
        return Err(format!("{id} is not your worker").into());
    }
    Ok(worker)
}

/// Every worker of every orchestrator in the project.
async fn all_workers(state: &WorkbenchState, project: &str) -> Result<Vec<Session>, ApiError> {
    let sessions = state.database().list_sessions(Some(project.to_string())).await?;
    Ok(sessions.into_iter().filter(|session| session.parent_session_id.is_some()).collect())
}

/// Workers share their orchestrator's folder, so only one may be working in
/// it at a time: two editing one folder at once overwrite each other.
async fn folder_is_free(state: &WorkbenchState, orchestrator: &Session, except: Option<&str>) -> Result<(), ApiError> {
    for worker in all_workers(state, &orchestrator.project_id).await? {
        if worker.cwd == orchestrator.cwd && Some(worker.id.as_str()) != except && is_mid_turn(&worker.state) {
            let name = crate::workbench::chat_name::name_session(&worker);
            return Err(format!(
                "worker \"{name}\" ({}) is still working in this folder; wait for its report",
                worker.id
            )
            .into());
        }
    }
    Ok(())
}

fn words<'a>(value: &'a Option<String>, what: &str) -> Result<&'a str, ApiError> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| ApiError::from(format!("give the worker a {what}")))
}

async fn start(state: &WorkbenchState, orchestrator: &Session, ask: &Ask) -> Result<Json<Value>, ApiError> {
    let choice = orchestrator.workers.clone().ok_or_else(|| {
        ApiError::from("this chat has no workers; the owner turns them on with Workers in the chat bar".to_string())
    })?;
    let title = words(&ask.title, "title")?;
    let brief = words(&ask.text, "brief")?;
    folder_is_free(state, orchestrator, None).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut fields = serde_json::Map::from_iter([
        ("sessionId".into(), json!(id)),
        ("projectId".into(), json!(orchestrator.project_id)),
        ("projectPath".into(), json!(orchestrator.project_path)),
        ("brand".into(), json!(choice.brand)),
        ("title".into(), json!(title)),
        ("parentSessionId".into(), json!(orchestrator.id)),
    ]);
    if orchestrator.cwd != orchestrator.project_path {
        fields.insert("cwd".into(), json!(orchestrator.cwd));
    }
    for (key, value) in [("profileId", &choice.profile_id), ("model", &choice.model), ("effort", &choice.effort)] {
        if let Some(value) = value {
            fields.insert(key.into(), json!(value));
        }
    }
    let reply = state
        .registry
        .execute(&Command { kind: CommandKind::SessionStart, fields })
        .await
        .map_err(|error| ApiError::from(format!("the worker could not be started: {error}")))?;
    state.publish_holds().await;
    if reply["id"].as_str() != Some(id.as_str()) {
        return Err(format!("the worker came back without its id: {reply}").into());
    }
    // The title is pinned, so the name the provider makes from the brief
    // does not replace the one the orchestrator reports it by.
    let fields = serde_json::Map::from_iter([("sessionId".into(), json!(id)), ("title".into(), json!(title))]);
    if let Err(error) = state.registry.execute(&Command { kind: CommandKind::SessionRename, fields }).await {
        tracing::warn!(chat = id, %error, "a worker could not be named");
    }
    tell_chat(state, &id, brief.to_string(), super::tell::from("worker", "Brief from the main chat")).await;
    Ok(Json(json!({"workerId": id})))
}

async fn send(state: &WorkbenchState, orchestrator: &Session, ask: &Ask) -> Result<Json<Value>, ApiError> {
    let worker = own_worker(state, orchestrator, ask.worker.as_deref()).await?;
    let text = words(&ask.text, "message")?;
    folder_is_free(state, orchestrator, Some(&worker.id)).await?;
    let busy = state.registry.mid_turn(&worker.id).await.unwrap_or(false);
    if ask.now && busy {
        // A send into a turn is held and pushed through at once, as the
        // owner's Send now is: the turn is interrupted and the message goes next.
        let fields = serde_json::Map::from_iter([
            ("sessionId".into(), json!(worker.id)),
            ("text".into(), json!(text)),
            ("images".into(), json!([])),
            ("from".into(), super::tell::from("worker", "Message from the main chat")),
        ]);
        match state.registry.execute(&Command { kind: CommandKind::PromptSend, fields }).await {
            Ok(_) => {
                state.publish_holds().await;
                return Ok(Json(json!({
                    "ok": true, "workerId": worker.id, "delivery": "interrupted",
                    "note": "The worker's turn was interrupted; it reads your message next.",
                })));
            }
            Err(error) => tracing::warn!(chat = worker.id, %error, "a worker could not be interrupted"),
        }
    }
    let delivery = tell_chat(state, &worker.id, text.to_string(), super::tell::from("worker", "Message from the main chat")).await;
    state.publish_holds().await;
    Ok(Json(match delivery {
        Delivery::Sent => json!({"ok": true, "workerId": worker.id, "delivery": "sent"}),
        Delivery::Queued => json!({
            "ok": true, "workerId": worker.id, "delivery": "queued",
            "note": format!(
                "The worker is mid-turn, so the message waits until its turn ends. To interrupt it instead: atelier tool worker send {} --now",
                worker.id
            ),
        }),
    }))
}

async fn list(state: &WorkbenchState, orchestrator: &Session) -> Result<Json<Value>, ApiError> {
    let workers: Vec<Value> = all_workers(state, &orchestrator.project_id)
        .await?
        .into_iter()
        .filter(|worker| worker.parent_session_id.as_deref() == Some(orchestrator.id.as_str()))
        .map(|worker| {
            json!({
                "id": worker.id,
                "title": crate::workbench::chat_name::name_session(&worker),
                "state": worker.state,
                "brand": worker.brand,
                "lastActiveAt": worker.last_active_at,
            })
        })
        .collect();
    Ok(Json(json!({"workers": workers})))
}

async fn read(state: &WorkbenchState, orchestrator: &Session, ask: &Ask) -> Result<Json<Value>, ApiError> {
    let worker = own_worker(state, orchestrator, ask.worker.as_deref()).await?;
    let text = state.database().chat_text(worker.id.clone()).await?;
    let text = if ask.all || text.chars().count() <= READ_TAIL {
        text
    } else {
        let tail: String = text.chars().rev().take(READ_TAIL).collect::<Vec<_>>().into_iter().rev().collect();
        format!("… (earlier messages left out; read with --all for the whole chat)\n{tail}")
    };
    let name = crate::workbench::chat_name::name_session(&worker);
    Ok(Json(json!({
        "text": format!(
            "Worker {} — \"{name}\" ({}), {}\n\n{}\n",
            worker.id,
            worker.brand,
            worker.state,
            if text.is_empty() { "(no messages yet)" } else { &text }
        )
    })))
}

async fn stop(state: &WorkbenchState, orchestrator: &Session, ask: &Ask) -> Result<Json<Value>, ApiError> {
    let worker = own_worker(state, orchestrator, ask.worker.as_deref()).await?;
    let fields = serde_json::Map::from_iter([("sessionId".into(), json!(worker.id))]);
    state
        .registry
        .execute(&Command { kind: CommandKind::SessionStop, fields })
        .await
        .map_err(|error| ApiError::from(format!("the worker could not be stopped: {error}")))?;
    Ok(Json(json!({"ok": true, "workerId": worker.id})))
}

/// How much of a worker's chat its report carries.
const REPORT_TAIL: usize = 4000;

/// Tell each orchestrator when one of its workers' turns ends: a short line
/// the owner sees, with the worker's last words in a block for the agent. It
/// goes through `tell_chat`, so an orchestrator between turns is woken by it
/// and one in a turn gets it when that turn ends.
pub(super) fn watch(state: WorkbenchState) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let mut updates = state.database().subscribe_all();
    handle.spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        let mut last = std::collections::HashMap::<String, String>::new();
        loop {
            let update = match updates.recv().await {
                Ok(update) => update,
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("worker reports fell {missed} events behind");
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            if update.event.kind != crate::workbench::protocol::EventKind::SessionState {
                continue;
            }
            let Some(now) = update.event.fields.get("state").and_then(Value::as_str) else { continue };
            let before = last.insert(update.session_id.clone(), now.to_string());
            let ended = before.as_deref().is_some_and(is_mid_turn)
                && ["idle", "waiting_for_agents", "errored", "stopped"].contains(&now);
            if !ended {
                continue;
            }
            let reporting = state.clone();
            let (worker, now) = (update.session_id.clone(), now.to_string());
            tokio::spawn(async move { report(&reporting, &worker, &now).await });
        }
    });
}

async fn report(state: &WorkbenchState, worker: &str, ended_in: &str) {
    let Ok(Some(session)) = state.database().get_session(worker.to_string()).await else { return };
    let Some(orchestrator) = session.parent_session_id.clone() else { return };
    let name = crate::workbench::chat_name::name_session(&session);
    let line = match ended_in {
        "errored" => format!("Worker \"{name}\" stopped with an error"),
        "stopped" => format!("Worker \"{name}\" was stopped"),
        _ => format!("Worker \"{name}\" finished"),
    };
    let text = state.database().chat_text(worker.to_string()).await.unwrap_or_default();
    let count = text.chars().count();
    let tail: String = text.chars().skip(count.saturating_sub(REPORT_TAIL)).collect();
    let details = format!(
        "Worker chat: {worker}\nEnded in: {ended_in}\n\nIts latest messages:\n{}\n\nRead the whole chat with: atelier tool worker read {worker} --all",
        if tail.is_empty() { "(no messages yet)" } else { &tail }
    );
    let block = crate::workbench::metadata::added_by_atelier(crate::workbench::metadata::WORKER_REPORT, &details);
    tell_chat(state, &orchestrator, format!("{line}\n\n{block}"), super::tell::from("worker", line)).await;
}
