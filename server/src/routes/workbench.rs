//! Native browser routes for the agent workbench.
//!
//! These routes deliberately open the existing SQLite chat database, so the
//! native implementation preserves every saved conversation across the
//! runtime cutover.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{Response, StatusCode},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures::{stream, Stream, StreamExt};
use base64::Engine;
use serde::Deserialize;
use std::collections::BTreeMap;
use serde_json::{json, Value};
use std::{convert::Infallible, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::broadcast;

use crate::workbench::{
    actor::{ChatDb, StoreUpdate},
    projection::fold_all,
    protocol::{Command, Event},
    registry::WorkbenchRegistry,
    store::Session,
};

pub type EventStream = Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>>;

#[derive(Clone)]
pub struct WorkbenchState {
    registry: Arc<WorkbenchRegistry>,
}

impl WorkbenchState {
    pub fn new(registry: WorkbenchRegistry) -> Self {
        Self {
            registry: Arc::new(registry),
        }
    }
    pub fn database(&self) -> &ChatDb {
        self.registry.database()
    }
}

pub fn router(state: WorkbenchState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/sessions", get(sessions))
        .route("/restore", get(restore))
        .route("/session/:id", get(session))
        .route("/history", get(history))
        .route("/events", get(events))
        .route("/watch", get(watch))
        .route("/present", post(present))
        .route("/screen-check", post(screen_check))
        .route("/command", post(command))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({"status":"ok","workbench":"native"}))
}

#[derive(Deserialize)]
struct SessionsQuery {
    project: Option<String>,
}

async fn sessions(
    State(state): State<WorkbenchState>,
    Query(query): Query<SessionsQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    Ok(Json(session_summaries(state.database(), query.project).await?))
}

pub(crate) async fn session_summaries(database: &ChatDb, project: Option<String>) -> Result<Vec<Value>, String> {
    let sessions = database.list_sessions(project).await?;
    let ids = sessions.iter().map(|session| session.id.clone()).collect();
    let mut beads = database.beads_for_sessions(ids).await?;
    sessions.into_iter().map(|session| {
        let linked = beads.remove(&session.id).unwrap_or_default();
        let mut value = serde_json::to_value(session).map_err(|error| error.to_string())?;
        let object = value.as_object_mut().ok_or_else(|| "session was not an object".to_string())?;
        object.insert("activity".into(), json!(""));
        object.insert("busySince".into(), Value::Null);
        object.insert("beads".into(), json!(linked));
        Ok(value)
    }).collect()
}

#[derive(Deserialize)]
struct RestoreQuery {
    project: Option<String>,
    #[allow(dead_code)]
    path: Option<String>,
    #[allow(dead_code)]
    all: Option<String>,
}

fn folder_of(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

fn restore_row(session: Session, beads: Vec<String>) -> Value {
    let folder = folder_of(&session.cwd);
    json!({
        "sessionId": session.id, "externalId": session.external_id, "brand": session.brand,
        "title": session.title, "lastActiveAt": session.last_active_at,
        "lastSpokeAt": session.last_spoke_at, "state": session.state, "origin": session.origin,
        "projectId": session.project_id, "cwdHint": session.cwd, "folder": folder,
        "branch": Value::Null, "beads": beads, "runningElsewhere": false, "held": Value::Null,
    })
}

async fn restore(
    State(state): State<WorkbenchState>,
    Query(query): Query<RestoreQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let sessions = state.database().list_sessions(query.project).await?;
    let ids = sessions.iter().map(|session| session.id.clone()).collect();
    let mut beads = state.database().beads_for_sessions(ids).await?;
    let rows = sessions.into_iter().map(|session| {
        let linked = beads.remove(&session.id).unwrap_or_default();
        restore_row(session, linked)
    }).collect();
    Ok(Json(rows))
}

async fn session(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let found = state
        .database()
        .list_sessions(None)
        .await?
        .into_iter()
        .find(|session| session.id == id)
        .ok_or_else(|| ApiError::not_found(format!("no session {id}")))?;
    let folder = folder_of(&found.cwd);
    let mut linked = state.database().beads_for_sessions(vec![found.id.clone()]).await?;
    let beads = linked.remove(&found.id).unwrap_or_default();
    Ok(Json(json!({
        "sessionId": found.id, "origin": found.origin, "brand": found.brand,
        "externalId": found.external_id, "runningElsewhere": false, "held": Value::Null,
        "title": found.title, "cwd": found.cwd, "folder": folder, "branch": Value::Null, "beads": beads,
    })))
}

#[derive(Deserialize)]
struct HistoryQuery {
    session: String,
    before: i64,
}

async fn history(
    State(state): State<WorkbenchState>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let page = state
        .database()
        .transcript_items(query.session, Some(query.before), 40)
        .await?;
    Ok(Json(
        json!({"items":page.items,"cursor":page.cursor,"hasOlder":page.has_older}),
    ))
}

#[derive(Deserialize)]
struct EventsQuery {
    session: String,
    since: Option<i64>,
}

fn event_frame(event: &Event) -> SseEvent {
    let seq = event
        .fields
        .get("seq")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    SseEvent::default()
        .id(seq.to_string())
        .json_data(event)
        .expect("canonical event serializes")
}

fn snapshot_frame(view: &Value) -> SseEvent {
    SseEvent::default()
        .id(view["lastSeq"].as_i64().unwrap_or_default().to_string())
        .event("snapshot")
        .json_data(view)
        .expect("projection serializes")
}

fn session_tail(receiver: broadcast::Receiver<Event>) -> EventStream {
    Box::pin(stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(event) => return Some((Ok(event_frame(&event)), receiver)),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }))
}

async fn events(
    State(state): State<WorkbenchState>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<EventStream>, ApiError> {
    // Subscribe before replay so an append racing the snapshot cannot fall in the gap.
    let receiver = state.database().subscribe_session(&query.session);
    let since = query.since.unwrap_or(0).max(0);
    let initial = if since == 0 {
        let view = snapshot(state.database(), &query.session).await?;
        vec![Ok(snapshot_frame(&view))]
    } else {
        state
            .database()
            .events_since(query.session.clone(), since)
            .await?
            .iter()
            .map(|event| Ok(event_frame(event)))
            .collect()
    };
    let output: EventStream = Box::pin(stream::iter(initial).chain(session_tail(receiver)));
    Ok(Sse::new(output).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("keep-alive"),
    ))
}

pub(crate) async fn snapshot(database: &ChatDb, session_id: &str) -> Result<Value, String> {
    let history = database.events_since(session_id.to_string(), 0).await?;
    let page = database
        .transcript_items(session_id.to_string(), None, 40)
        .await?;
    let mut view = fold_all(&history).view;
    view["items"] = json!(page.items);
    view["lastSeq"] = json!(page.newest_seq);
    view["historyCursor"] = json!(page.cursor);
    view["hasOlder"] = json!(page.has_older);
    Ok(view)
}

fn watch_frame(value: Value) -> SseEvent {
    SseEvent::default()
        .json_data(value)
        .expect("watch frame serializes")
}

fn all_tail(receiver: broadcast::Receiver<StoreUpdate>) -> EventStream {
    Box::pin(stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(update) => {
                    return Some((
                        Ok(watch_frame(json!({"kind":"event","event":update.event}))),
                        receiver,
                    ))
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }))
}

async fn watch(State(state): State<WorkbenchState>) -> Result<Sse<EventStream>, ApiError> {
    let receiver = state.database().subscribe_all();
    let sessions = session_summaries(state.database(), None).await?;
    let initial = stream::iter(vec![
        Ok(watch_frame(json!({"kind":"snapshot","sessions":sessions}))),
        Ok(watch_frame(json!({"kind":"running","holds":[]}))),
    ]);
    let output: EventStream = Box::pin(initial.chain(all_tail(receiver)));
    Ok(Sse::new(output).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("keep-alive"),
    ))
}

async fn command(
    State(state): State<WorkbenchState>,
    Json(command): Json<Command>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.registry.execute(&command).await?))
}

#[derive(Deserialize)]
struct UploadedRequest {
    args: Vec<String>,
    #[serde(default)]
    stdin: String,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

fn decoded(files: BTreeMap<String, String>) -> Result<BTreeMap<String, Vec<u8>>, String> {
    files.into_iter().map(|(path, encoded)| {
        let label = path.clone();
        base64::engine::general_purpose::STANDARD.decode(encoded)
            .map(|bytes| (path, bytes)).map_err(|error| format!("{label}: {error}"))
    }).collect()
}

async fn present(State(state): State<WorkbenchState>, Json(request): Json<UploadedRequest>) -> Result<Json<Value>, ApiError> {
    let files = decoded(request.files)?;
    Ok(Json(json!({"output":state.registry.present(&request.args, &request.stdin, &files)?})))
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|word| word == name).and_then(|at| args.get(at + 1)).map(String::as_str)
}

async fn screen_check(State(state): State<WorkbenchState>, Json(request): Json<UploadedRequest>) -> Result<Json<Value>, ApiError> {
    let files = decoded(request.files)?;
    let action = request.args.first().map(String::as_str).unwrap_or("help");
    if matches!(action, "help" | "--help" | "-h") {
        return Ok(Json(json!({"result":{"help":"atelier tool screen-check windows|capture|check|compare"}})));
    }
    if action == "--schema" {
        return Ok(Json(json!({"result":{"schema":{"actions":["windows","capture","check","compare"],"capture_types":["web","window","image"]}}})));
    }
    if action == "windows" {
        let windows = crate::workbench::screen_check::native_windows()?;
        return Ok(Json(json!({"result":{"windows":windows,"safeguards":["explicit ID required","two matching frames required","no whole-display fallback"]}})));
    }

    let mut captures = Vec::new();
    if action == "compare" {
        let before = option(&request.args, "--before").ok_or_else(|| "--before is required".to_string())?;
        let after = option(&request.args, "--after").ok_or_else(|| "--after is required".to_string())?;
        let before_bytes = files.get(before).ok_or_else(|| format!("no upload for {before}"))?;
        let after_bytes = files.get(after).ok_or_else(|| format!("no upload for {after}"))?;
        let before_stored = state.registry.store_capture(before_bytes, "Before", "image")?;
        let after_stored = state.registry.store_capture(after_bytes, "After", "image")?;
        let comparison = state.registry.compare_captures(before_bytes, after_bytes)?;
        captures.push(json!({"asset":before_stored.asset,"label":"Before","evidence":before_stored.evidence}));
        captures.push(json!({"asset":after_stored.asset,"label":"After","evidence":after_stored.evidence}));
        return Ok(Json(json!({"result":{"check_id":format!("check_{}_{}", before_stored.asset.chars().take(12).collect::<String>(), after_stored.asset.chars().take(12).collect::<String>()),"captures":captures,"comparison":comparison.objective,"diff_asset":comparison.diff_asset,"verdict":"INDETERMINATE"}})));
    }

    let stored = if let Some(recipe) = option(&request.args, "--recipe") {
        let bytes = files.get(recipe).ok_or_else(|| format!("no upload for {recipe}"))?;
        let recipe = crate::workbench::browser::parse_recipe(bytes)?;
        let capture = state.registry.capture_browser(&recipe, &files).await?;
        state.registry.store_capture(&capture.bytes, "Browser capture", "browser")?
    } else if let Some(window_id) = option(&request.args, "--window-id") {
        let stable_ms = option(&request.args, "--stable-ms").and_then(|value| value.parse().ok()).unwrap_or(200);
        let retries = option(&request.args, "--stable-retries").and_then(|value| value.parse().ok()).unwrap_or(5);
        let mut source = crate::workbench::screen_check::NativeWindowSource;
        let (bytes, _, _) = crate::workbench::screen_check::stable_window_capture(&mut source, window_id, Duration::from_millis(stable_ms), retries).await?;
        state.registry.store_capture(&bytes, "Window capture", "window")?
    } else {
        let target = option(&request.args, "--target").ok_or_else(|| "--target, --window-id or --recipe is required".to_string())?;
        let bytes = files.get(target).ok_or_else(|| format!("no upload for {target}"))?;
        state.registry.store_capture(bytes, "Image capture", "image")?
    };
    captures.push(json!({"asset":stored.asset,"label":"Capture","evidence":stored.evidence}));
    Ok(Json(json!({"result":{"check_id":format!("check_{}", stored.asset.chars().take(12).collect::<String>()),"captures":captures,"verdict":if action == "capture" { Value::Null } else { json!("INDETERMINATE") }}})))
}

struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn not_found(message: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message,
        }
    }
}
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response<Body> {
        (self.status, Json(json!({"error":self.message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::{
        protocol::Event,
        registry::{RegistryPaths, UnavailableFactory},
        store::Session,
    };
    use axum::body::Body;
    use futures::StreamExt;
    use serde_json::json;
    use tower::ServiceExt;

    fn fixture() -> (tempfile::TempDir, WorkbenchState) {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let paths = RegistryPaths {
            home: directory.path().to_path_buf(),
            claude_config: directory.path().join("claude"),
            codex_home: directory.path().join("codex"),
            media: directory.path().join("media"),
        };
        let registry = WorkbenchRegistry::new(database, paths, Arc::new(UnavailableFactory));
        (directory, WorkbenchState::new(registry))
    }

    fn saved_session() -> Session {
        Session {
            id: "chat-1".into(),
            brand: "codex".into(),
            external_id: Some("thread-1".into()),
            project_id: "project-1".into(),
            project_path: "/work/project".into(),
            cwd: "/work/project/tree".into(),
            model: Some("gpt-5".into()),
            permission_mode: "default".into(),
            effort: Some("high".into()),
            collaboration_mode: None,
            title: Some("The chat that must remain visible".into()),
            state: "dormant".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00.000Z".into(),
            last_active_at: "2026-08-30T00:01:00.000Z".into(),
            last_spoke_at: Some("2026-08-30T00:00:30.000Z".into()),
        }
    }

    fn notice() -> Event {
        serde_json::from_value(json!({"type":"notice","sessionId":"chat-1","seq":0,"at":"2026-08-30T00:01:00.000Z","text":"still here","providerEvent":{"provider":"codex","threadId":"thread-1","eventId":"n-1","delivery":"live"}})).unwrap()
    }

    async fn first_chunk(response: Response<Body>) -> String {
        let mut body = response.into_body().into_data_stream();
        String::from_utf8(body.next().await.unwrap().unwrap().to_vec()).unwrap()
    }

    #[tokio::test]
    async fn native_workbench_routes_restore_saved_chats_and_stream_their_snapshot() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        state.database().append(notice()).await.unwrap();
        let app = router(state);
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(rows[0]["sessionId"], "chat-1");
        assert_eq!(rows[0]["title"], "The chat that must remain visible");
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/events?session=chat-1&since=0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let chunk = first_chunk(response).await;
        assert!(chunk.contains("event: snapshot"), "{chunk}");
        assert!(chunk.contains("still here"), "{chunk}");
    }

    #[tokio::test]
    async fn native_workbench_routes_publish_the_all_chat_snapshot_and_live_tail() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/watch")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let chunk = first_chunk(response).await;
        assert!(chunk.contains("snapshot"), "{chunk}");
        assert!(chunk.contains("chat-1"), "{chunk}");
        assert!(chunk.contains("\"beads\":[]"), "{chunk}");
        assert!(chunk.contains("\"activity\":\"\""), "{chunk}");
    }

    #[tokio::test]
    async fn native_workbench_routes_execute_provider_independent_commands() {
        let (_directory, state) = fixture();
        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/command")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"type":"provider-defaults.read","brand":"codex"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
