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
    let (chats, indexed, sizes) = state
        .cleaner
        .gather(&state.registry)
        .await
        .map_err(|why| failed("Couldn't read chats", why))?;
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
            chats: chats.len(),
            ages: disk_usage::ages(&chats, &indexed, &sizes),
            index: index.progress(),
        }
    })
    .await
    .map_err(|why| failed("Couldn't measure storage", why))?;
    *held = Some((Instant::now(), usage.clone()));
    Ok(Json(usage))
}

fn rules_answer(state: &StorageState) -> Result<Value, Refusal> {
    let rules = cleanup::rules(&state.cleaner.settings).map_err(|why| failed("Couldn't read rules", why))?;
    Ok(json!({"rules": rules, "lastRun": cleanup::last_run(&state.cleaner.settings)}))
}

/// GET /api/storage/rules
async fn read_rules(State(state): State<StorageState>) -> Result<Json<Value>, Refusal> {
    rules_answer(&state).map(Json)
}

#[derive(Deserialize)]
struct Rules {
    rules: Vec<Rule>,
}

/// PUT /api/storage/rules
async fn write_rules(State(state): State<StorageState>, Json(asked): Json<Rules>) -> Result<Json<Value>, Refusal> {
    cleanup::check(&asked.rules).map_err(|why| (StatusCode::UNPROCESSABLE_ENTITY, why))?;
    cleanup::save_rules(&state.cleaner.settings, &asked.rules).map_err(|why| failed("Couldn't save rules", why))?;
    rules_answer(&state).map(Json)
}

/// POST /api/storage/preview — what these rules, saved or not, would do now.
async fn preview(State(state): State<StorageState>, Json(asked): Json<Rules>) -> Result<Json<Value>, Refusal> {
    cleanup::check(&asked.rules).map_err(|why| (StatusCode::UNPROCESSABLE_ENTITY, why))?;
    let effects = state
        .cleaner
        .preview(&state.registry, &asked.rules)
        .await
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

fn failed(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

pub fn storage_routes(state: StorageState) -> Router {
    Router::new()
        .route("/storage", get(usage))
        .route("/storage/rules", get(read_rules).put(write_rules))
        .route("/storage/preview", post(preview))
        .route("/storage/run", post(run))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
        .with_state(state)
}
