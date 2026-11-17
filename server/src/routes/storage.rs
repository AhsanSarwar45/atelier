//! The storage screen: what the app takes on disk, and the rules that clear
//! old chats (`workbench::cleanup`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// How long a measurement is shown before the folders are walked again, in
/// the background: walking them takes a while on a large data folder, so the
/// screen is answered from the last measurement meanwhile.
const FRESH_FOR: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct StorageState {
    pub cleaner: Arc<Cleaner>,
    pub registry: Arc<WorkbenchRegistry>,
    pub data: PathBuf,
    measured: Arc<tokio::sync::Mutex<Option<(Instant, Usage)>>>,
    /// Counts the times what was measured went out of date, so a background
    /// measurement begun before a cleanup is not kept after it.
    changed: Arc<AtomicU64>,
    /// A background measurement is under way.
    refreshing: Arc<AtomicBool>,
}

impl StorageState {
    pub fn new(cleaner: Arc<Cleaner>, registry: Arc<WorkbenchRegistry>, data: PathBuf) -> Self {
        Self {
            cleaner,
            registry,
            data,
            measured: Arc::default(),
            changed: Arc::default(),
            refreshing: Arc::default(),
        }
    }

    /// Drop the last measurement after a change this screen made itself, so
    /// the next ask measures again rather than show what was there before.
    async fn forget(&self) {
        let mut held = self.measured.lock().await;
        self.changed.fetch_add(1, Ordering::SeqCst);
        *held = None;
    }

    /// Measure again without holding up anyone asking, unless already doing so.
    fn refresh_in_background(&self) {
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let state = self.clone();
        tokio::spawn(async move {
            let changed = state.changed.load(Ordering::SeqCst);
            let started = Instant::now();
            let measured = measure_now(&state).await;
            if let Ok(usage) = measured {
                let mut held = state.measured.lock().await;
                // Kept unless it went out of date while it was measured, or
                // someone asking meanwhile measured afresh.
                let newer = held.as_ref().is_some_and(|(at, _)| *at >= started);
                if state.changed.load(Ordering::SeqCst) == changed && !newer {
                    *held = Some((Instant::now(), usage));
                }
            }
            state.refreshing.store(false, Ordering::SeqCst);
        });
    }
}

#[cfg(test)]
impl StorageState {
    /// As if `by` had passed since the storage was last measured, so a test
    /// can ask a second time a few minutes after the first.
    async fn pretend_elapsed(&self, by: Duration) {
        if let Some((at, _)) = self.measured.lock().await.as_mut() {
            *at = at.checked_sub(by).expect("a clock that far back");
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
        if !measure.fresh && usage.index.ready() {
            if at.elapsed() >= FRESH_FOR {
                state.refresh_in_background();
            }
            return Ok(Json(usage.clone()));
        }
    }
    let usage = measure_now(&state).await?;
    *held = Some((Instant::now(), usage.clone()));
    Ok(Json(usage))
}

/// Walk the data folder and read the index for the storage screen.
async fn measure_now(state: &StorageState) -> Result<Usage, Refusal> {
    let found = state
        .cleaner
        .gather(&state.registry, false)
        .await
        .map_err(|why| failed("Couldn't read chats", why))?;
    let unused_files = state.cleaner.unused(&found).await;
    let data = state.data.clone();
    let media = state.cleaner.media.clone();
    let index = state.cleaner.index.clone();
    tokio::task::spawn_blocking(move || {
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
    .map_err(|why| failed("Couldn't measure storage", why))
}

fn rules_answer(state: &StorageState) -> Result<Value, Refusal> {
    let rules = cleanup::rules(&state.cleaner.settings).map_err(|why| failed("Couldn't read rules", why))?;
    Ok(json!({
        "rules": rules,
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
}

/// PUT /api/storage/rules
async fn write_rules(State(state): State<StorageState>, Json(asked): Json<Rules>) -> Result<Json<Value>, Refusal> {
    cleanup::check(&asked.rules).map_err(|why| (StatusCode::UNPROCESSABLE_ENTITY, why))?;
    cleanup::save_rules(&state.cleaner.settings, &asked.rules).map_err(|why| failed("Couldn't save rules", why))?;
    state.forget().await;
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
    state.forget().await;
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
    state.forget().await;
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
    state.forget().await;
    Ok(Json(json!({"ok": true})))
}

/// POST /api/storage/archived/delete
async fn delete_archive(State(state): State<StorageState>, Json(asked): Json<OneChat>) -> Result<Json<Value>, Refusal> {
    state
        .cleaner
        .delete_archive(&state.registry, &asked.id)
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    state.forget().await;
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
    state.forget().await;
    Ok(Json(json!({"images": images, "files": files})))
}

/// POST /api/storage/compact — shrink the chat database.
async fn compact(State(state): State<StorageState>) -> Result<Json<Value>, Refusal> {
    let done = state
        .cleaner
        .compact(&state.registry)
        .await
        .map_err(|why| (StatusCode::CONFLICT, why))?;
    state.forget().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::actor::ChatDb;
    use crate::workbench::registry::{RegistryPaths, UnavailableFactory};
    use crate::workbench::storage_index::StorageIndex;
    use crate::workbench::store::Session;

    fn session(dir: &std::path::Path, id: &str) -> Session {
        Session {
            id: id.into(),
            brand: "claude".into(),
            external_id: None,
            project_id: "p".into(),
            project_path: dir.join("p").to_string_lossy().into(),
            cwd: dir.to_string_lossy().into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: Some(id.into()),
            state: "dormant".into(),
            origin: "atelier".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            last_active_at: "2026-01-02T00:00:00.000Z".into(),
            last_spoke_at: None,
            begun_by: None,
            named_by_owner: false,
            auto_approve: false,
            parent_session_id: None,
            workers: None,
        }
    }

    /// A data folder with 22,000 files under the account profiles, 50 chats
    /// naming 1,000 stored pictures, and 500 pictures nothing names.
    async fn data_folder(data: &std::path::Path) -> StorageState {
        for profile in 0..400 {
            let folder = data.join(format!("profiles/claude/{profile}/projects/p"));
            std::fs::create_dir_all(&folder).unwrap();
            for file in 0..55 {
                std::fs::write(folder.join(format!("{file}.jsonl")), b"{\"line\":1}\n").unwrap();
            }
        }
        let media = data.join("presentation-media");
        std::fs::create_dir_all(&media).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(30 * 86_400);
        for n in 0..1_500usize {
            let path = media.join(format!("{n:064x}.png"));
            std::fs::write(&path, b"picture").unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        }
        let chats_db = data.join("workbench.db");
        let database = ChatDb::open(&chats_db).unwrap();
        for chat in 0..50usize {
            database.create_session(session(data, &format!("c{chat}"))).await.unwrap();
        }
        let writer = rusqlite::Connection::open(&chats_db).unwrap();
        for n in 0..1_000usize {
            writer
                .execute(
                    "INSERT INTO event (session_id, seq, at, type, json) VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', 'message', ?3)",
                    rusqlite::params![
                        format!("c{}", n % 50),
                        (n / 50) as i64 + 1,
                        format!(r#"{{"text":"see","asset":"{n:064x}.png"}}"#)
                    ],
                )
                .unwrap();
        }
        drop(writer);
        let paths = RegistryPaths {
            home: data.to_path_buf(),
            claude_config: data.join("claude"),
            codex_home: data.join("codex"),
            profiles: data.join("profiles"),
            media: media.clone(),
        };
        let registry = Arc::new(WorkbenchRegistry::new(database, paths, Arc::new(UnavailableFactory)));
        let settings = Arc::new(crate::db::Database::new_in_memory().unwrap());
        let index = Arc::new(StorageIndex::new(data.join("storage.db"), chats_db.clone()));
        index.refresh().unwrap();
        let cleaner = Arc::new(Cleaner::new(settings, index, Some(media), chats_db, data.join("chat-archive")));
        StorageState::new(cleaner, registry, data.to_path_buf())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_old_measurement_is_shown_while_it_is_measured_again_behind_it() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_STATE_HOME", dir.path().join("state"));
        let data = dir.path().join("data");
        let state = data_folder(&data).await;
        let ask = || usage(State(state.clone()), Query(Measure { fresh: false }));
        assert_eq!(ask().await.unwrap().unused_files.files, 500);

        // A file nothing names turns up; within the window nothing is walked.
        let path = state.cleaner.media.as_ref().unwrap().join(format!("{:064x}.png", 9_999));
        std::fs::write(&path, b"picture").unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(30 * 86_400);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        assert_eq!(ask().await.unwrap().unused_files.files, 500);

        // Past it, the last answer is shown once more and the new one follows.
        state.pretend_elapsed(Duration::from_secs(3 * 60)).await;
        assert_eq!(ask().await.unwrap().unused_files.files, 500);
        let deadline = Instant::now() + Duration::from_secs(60);
        while ask().await.unwrap().unused_files.files != 501 {
            assert!(Instant::now() < deadline, "never measured again");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Asking for a fresh answer measures there and then.
        std::fs::remove_file(&path).unwrap();
        let Json(fresh) = usage(State(state.clone()), Query(Measure { fresh: true })).await.unwrap();
        assert_eq!(fresh.unused_files.files, 500);
    }

    /// Run alone: `cargo test --lib -- --ignored --exact
    /// routes::storage::tests::bench_storage_asked_again_minutes_later`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn bench_storage_asked_again_minutes_later() {
        const BUDGET_MS: f64 = 5.0;
        let dir = tempfile::tempdir().unwrap();
        // The browser profiles are measured too: keep them inside the test.
        std::env::set_var("XDG_STATE_HOME", dir.path().join("state"));
        let data = dir.path().join("data");
        let state = data_folder(&data).await;
        let ask = || usage(State(state.clone()), Query(Measure { fresh: false }));

        let Json(first) = ask().await.unwrap();
        assert!(first.index.ready(), "{:?}", first.index);
        assert_eq!((first.chats, first.unused_files.files), (50, 500));
        let claude = |usage: &Usage| usage.parts.iter().find(|p| p.id == "claude").unwrap().bytes;
        assert_eq!(claude(&first), 400 * 55 * 11);

        state.pretend_elapsed(Duration::from_secs(3 * 60)).await;
        let started = Instant::now();
        let Json(second) = ask().await.unwrap();
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        println!("second_ms={ms:.1}");
        assert_eq!((second.total, claude(&second)), (first.total, claude(&first)));
        assert_eq!((second.chats, second.unused_files.files), (50, 500));
        assert!(ms <= BUDGET_MS, "the second request took {ms:.1} ms, budget {BUDGET_MS} ms");
    }
}
