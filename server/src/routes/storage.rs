//! The storage screen: what the app takes on disk, and the rules that clear
//! old chats (`workbench::cleanup`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::workbench::cleanup::{self, Cleaner, Rule};
use crate::workbench::disk_usage::{self, Usage};
use crate::workbench::registry::WorkbenchRegistry;

type Refusal = (StatusCode, String);

/// How long a measurement is shown before the folders are walked again.
const FRESH_FOR: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct StorageState {
    pub cleaner: Arc<Cleaner>,
    pub registry: Arc<WorkbenchRegistry>,
    pub data: PathBuf,
    measured: Arc<tokio::sync::Mutex<Option<(Instant, Usage)>>>,
}

impl StorageState {
    pub fn new(cleaner: Arc<Cleaner>, registry: Arc<WorkbenchRegistry>, data: PathBuf) -> Self {
        Self {
            cleaner,
            registry,
            data,
            measured: Arc::default(),
        }
    }
}

#[derive(Deserialize)]
struct Measure {
    #[serde(default)]
    fresh: bool,
}

/// GET /api/storage
async fn usage(State(state): State<StorageState>, Query(measure): Query<Measure>) -> Result<Json<Usage>, Refusal> {
    let mut held = state.measured.lock().await;
    if let Some((at, usage)) = held.as_ref() {
        // While the index is still filling, its progress is the news.
        if !measure.fresh && at.elapsed() < FRESH_FOR && usage.index.ready() {
            return Ok(Json(usage.clone()));
        }
    }
    let found = state
        .cleaner
        .gather(&state.registry, false)
        .await
        .map_err(|why| failed("Couldn't read chats", why))?;
    let unused_files = state.cleaner.unused(&found).await;
    let data = state.data.clone();
    let media = state.cleaner.media.clone();
    let index = state.cleaner.index.clone();
    let usage = tokio::task::spawn_blocking(move || {
        let (total, parts) = disk_usage::measure(&data, media.as_deref(), disk_usage::browser_dir().as_deref());
        Usage {
            total,
            parts,
            disk: disk_usage::disk(&data),
            unused_chat_bytes: index.unused_chat_bytes(),
            reclaims: index.reclaims(),
            unused_files,
            archived: found.archived.len(),
            chats: found.chats.len(),
            ages: disk_usage::ages(&found.chats, &found.indexed, &found.sizes),
            // Read before the index was whole: ask again rather than keep it.
            index: {
                let mut progress = index.progress();
                progress.ready &= found.complete;
                progress
            },
        }
    })
    .await
    .map_err(|why| failed("Couldn't measure storage", why))?;
    *held = Some((Instant::now(), usage.clone()));
    Ok(Json(usage))
}

fn rules_answer(state: &StorageState) -> Result<Value, Refusal> {
    let rules = cleanup::rules(&state.cleaner.settings).map_err(|why| failed("Couldn't read rules", why))?;
    Ok(json!({
        "rules": rules,
        "keepLinked": cleanup::keep_linked(&state.cleaner.settings),
        "lastRun": cleanup::last_run(&state.cleaner.settings),
    }))
}

/// GET /api/storage/rules
async fn read_rules(State(state): State<StorageState>) -> Result<Json<Value>, Refusal> {
    rules_answer(&state).map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rules {
    rules: Vec<Rule>,
    #[serde(default)]
    keep_linked: Option<bool>,
}

/// PUT /api/storage/rules
async fn write_rules(State(state): State<StorageState>, Json(asked): Json<Rules>) -> Result<Json<Value>, Refusal> {
    cleanup::check(&asked.rules).map_err(|why| (StatusCode::UNPROCESSABLE_ENTITY, why))?;
    cleanup::save_rules(&state.cleaner.settings, &asked.rules).map_err(|why| failed("Couldn't save rules", why))?;
    if let Some(keep) = asked.keep_linked {
        cleanup::save_keep_linked(&state.cleaner.settings, keep).map_err(|why| failed("Couldn't save rules", why))?;
    }
    *state.measured.lock().await = None;
    rules_answer(&state).map(Json)
}

/// POST /api/storage/preview — what these rules, saved or not, would do now.
async fn preview(State(state): State<StorageState>, Json(asked): Json<Rules>) -> Result<Json<Value>, Refusal> {
    cleanup::check(&asked.rules).map_err(|why| (StatusCode::UNPROCESSABLE_ENTITY, why))?;
    // The switch is part of what is previewed, saved or not.
    let saved = cleanup::keep_linked(&state.cleaner.settings);
    let asked_keep = asked.keep_linked.unwrap_or(saved);
    let effects = if asked_keep == saved {
        state.cleaner.preview(&state.registry, &asked.rules).await
    } else {
        state.cleaner.preview_keeping(&state.registry, &asked.rules, asked_keep).await
    }
    .map_err(|why| failed("Couldn't preview rules", why))?;
    Ok(Json(json!({"effects": effects})))
}

/// POST /api/storage/run — follow the saved rules now.
async fn run(State(state): State<StorageState>) -> Result<Json<Value>, Refusal> {
    let report = state
        .cleaner
        .run(&state.registry)
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    *state.measured.lock().await = None;
    Ok(Json(json!(report)))
}

#[derive(Deserialize)]
struct Most {
    #[serde(default)]
    limit: Option<usize>,
}

/// GET /api/storage/chats — the largest chats.
async fn largest(State(state): State<StorageState>, Query(most): Query<Most>) -> Result<Json<Value>, Refusal> {
    let found = state
        .cleaner
        .gather(&state.registry, false)
        .await
        .map_err(|why| failed("Couldn't read chats", why))?;
    let chats = Cleaner::largest(&found, most.limit.unwrap_or(20).clamp(1, 100));
    let ready = found.complete && state.cleaner.index.progress().ready;
    Ok(Json(json!({"chats": chats, "ready": ready})))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChatAction {
    Delete,
    Archive,
}

#[derive(Deserialize)]
struct ClearChats {
    ids: Vec<String>,
    action: ChatAction,
}

/// POST /api/storage/chats — delete or archive chats by hand.
async fn clear_chats(State(state): State<StorageState>, Json(asked): Json<ClearChats>) -> Result<Json<Value>, Refusal> {
    if asked.ids.is_empty() || asked.ids.len() > 100 {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, "Choose between 1 and 100 chats.".into()));
    }
    let done = state
        .cleaner
        .clear_chats(&state.registry, &asked.ids, matches!(asked.action, ChatAction::Archive))
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    *state.measured.lock().await = None;
    Ok(Json(done))
}

/// GET /api/storage/archived — archived chats, newest archive first.
async fn archived(State(state): State<StorageState>) -> Json<Value> {
    let dir = state.cleaner.archive.clone();
    let chats = tokio::task::spawn_blocking(move || crate::workbench::store::archived_chats(&dir))
        .await
        .unwrap_or_default();
    Json(json!({"chats": chats}))
}

#[derive(Deserialize)]
struct OneChat {
    id: String,
}

/// POST /api/storage/archived/restore
async fn restore(State(state): State<StorageState>, Json(asked): Json<OneChat>) -> Result<Json<Value>, Refusal> {
    state
        .cleaner
        .restore(&state.registry, &asked.id)
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    *state.measured.lock().await = None;
    Ok(Json(json!({"ok": true})))
}

/// POST /api/storage/archived/delete
async fn delete_archive(State(state): State<StorageState>, Json(asked): Json<OneChat>) -> Result<Json<Value>, Refusal> {
    state
        .cleaner
        .delete_archive(&asked.id)
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    *state.measured.lock().await = None;
    Ok(Json(json!({"ok": true})))
}

/// POST /api/storage/unused — delete stored files no chat shows.
async fn delete_unused(State(state): State<StorageState>) -> Result<Json<Value>, Refusal> {
    if !state.cleaner.may_delete_files() {
        return Err((
            StatusCode::CONFLICT,
            "Files can be deleted once the installed app is updated and running.".into(),
        ));
    }
    let (images, files) = state
        .cleaner
        .delete_unused(&state.registry)
        .await
        .map_err(|why| failed("Couldn't delete files", why))?;
    *state.measured.lock().await = None;
    Ok(Json(json!({"images": images, "files": files})))
}

/// POST /api/storage/compact — shrink the chat database.
async fn compact(State(state): State<StorageState>) -> Result<Json<Value>, Refusal> {
    let done = state
        .cleaner
        .compact(&state.registry)
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    *state.measured.lock().await = None;
    Ok(Json(done))
}

fn failed(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

pub fn storage_routes(state: StorageState) -> Router {
    Router::new()
        .route("/storage", get(usage))
        .route("/storage/rules", get(read_rules).put(write_rules))
        .route("/storage/preview", post(preview))
        .route("/storage/run", post(run))
        .route("/storage/chats", get(largest).post(clear_chats))
        .route("/storage/archived", get(archived))
        .route("/storage/archived/restore", post(restore))
        .route("/storage/archived/delete", post(delete_archive))
        .route("/storage/unused", post(delete_unused))
        .route("/storage/compact", post(compact))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
        .with_state(state)
}
