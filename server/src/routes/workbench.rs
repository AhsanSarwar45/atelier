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
use base64::Engine;
use futures::{stream, Stream, StreamExt};
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{convert::Infallible, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::broadcast;

use crate::workbench::{
    actor::ChatDb,
    projection::fold_all,
    protocol::{Command, Event},
    registry::WorkbenchRegistry,
    store::Session,
};

pub type EventStream = Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>>;

#[derive(Clone)]
pub struct WorkbenchState {
    registry: Arc<WorkbenchRegistry>,
    hold_memory: Arc<tokio::sync::Mutex<HoldMemory>>,
    usage_cache: Arc<tokio::sync::Mutex<HashMap<String, (std::time::Instant, Value)>>>,
    usage_refreshes: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    discovery_cache: Arc<tokio::sync::Mutex<HashMap<String, (std::time::Instant, Vec<Value>)>>>,
    discoveries: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    listing_refused: Arc<tokio::sync::Mutex<HashMap<String, std::time::Instant>>>,
    claude_usage_reader:
        Arc<tokio::sync::Mutex<Option<crate::workbench::claude::transport::ClaudeTransport>>>,
    codex_readers: Arc<
        tokio::sync::Mutex<
            HashMap<std::path::PathBuf, crate::workbench::codex::transport::CodexTransport>,
        >,
    >,
    codex_records: Arc<std::sync::Mutex<HashMap<String, std::path::PathBuf>>>,
    claim_sweeps: Arc<tokio::sync::Mutex<HashMap<std::path::PathBuf, std::time::Instant>>>,
    watch_polls: broadcast::Sender<Value>,
    watch_pollers: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
    watch_poll_subscribers: Arc<AtomicUsize>,
    watch_poll_wake: Arc<tokio::sync::Notify>,
    chat_followers: Arc<tokio::sync::Mutex<HashMap<String, Arc<ChatFollowControl>>>>,
}

#[derive(Default)]
struct HoldMemory {
    bursts: HashMap<String, i64>,
    summaries: crate::workbench::summary::SummaryTracker,
}

pub(crate) struct WatchPollLease {
    subscribers: Arc<AtomicUsize>,
    wake: Arc<tokio::sync::Notify>,
}

pub(crate) struct ChatFollowControl {
    viewers: AtomicUsize,
    wake: tokio::sync::Notify,
}

pub(crate) struct ChatFollowLease {
    control: Arc<ChatFollowControl>,
}

impl Drop for ChatFollowLease {
    fn drop(&mut self) {
        self.control.viewers.fetch_sub(1, Ordering::AcqRel);
        self.control.wake.notify_one();
    }
}

impl ChatFollowControl {
    pub(crate) async fn stopped(&self) {
        while self.viewers.load(Ordering::Acquire) > 0 {
            self.wake.notified().await;
        }
    }
}

impl Drop for WatchPollLease {
    fn drop(&mut self) {
        self.subscribers.fetch_sub(1, Ordering::AcqRel);
        self.wake.notify_one();
    }
}

impl WorkbenchState {
    pub fn new(registry: WorkbenchRegistry) -> Self {
        let (watch_polls, _) = broadcast::channel(16);
        Self {
            registry: Arc::new(registry),
            hold_memory: Arc::new(tokio::sync::Mutex::new(HoldMemory::default())),
            usage_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            usage_refreshes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            discovery_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            discoveries: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            listing_refused: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            claude_usage_reader: Arc::new(tokio::sync::Mutex::new(None)),
            codex_readers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            codex_records: Arc::new(std::sync::Mutex::new(HashMap::new())),
            claim_sweeps: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            watch_polls,
            watch_pollers: Arc::new(tokio::sync::Mutex::new(None)),
            watch_poll_subscribers: Arc::new(AtomicUsize::new(0)),
            watch_poll_wake: Arc::new(tokio::sync::Notify::new()),
            chat_followers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    async fn begin_claim_sweep(&self, cwd: &std::path::Path) -> bool {
        const EVERY: Duration = Duration::from_secs(60);
        let now = std::time::Instant::now();
        let mut swept = self.claim_sweeps.lock().await;
        if swept
            .get(cwd)
            .is_some_and(|previous| now.duration_since(*previous) < EVERY)
        {
            return false;
        }
        swept.insert(cwd.to_path_buf(), now);
        true
    }
    pub fn database(&self) -> &ChatDb {
        self.registry.database()
    }
    pub(crate) async fn has_driver(&self, session_id: &str) -> bool {
        self.registry.has_driver(session_id).await
    }
    pub(crate) async fn looked_at(&self, session_id: &str) {
        self.registry.looked_at(session_id).await
    }
    pub(crate) fn claude_config_directory(&self) -> &std::path::Path {
        self.registry.claude_config_directory()
    }
    pub(crate) fn codex_home_directory(&self) -> &std::path::Path {
        self.registry.codex_home_directory()
    }
    pub(crate) fn codex_record(&self, id: &str) -> Option<std::path::PathBuf> {
        fn find(root: &std::path::Path, id: &str, depth: u8) -> Option<std::path::PathBuf> {
            if depth == 0 {
                return None;
            }
            for entry in std::fs::read_dir(root).ok()?.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(found) = find(&path, id, depth - 1) {
                        return Some(found);
                    }
                } else if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name.contains(id) && name.ends_with(".jsonl"))
                {
                    return Some(path);
                }
            }
            None
        }
        let key = id.to_lowercase();
        if let Some(path) = self
            .codex_records
            .lock()
            .ok()
            .and_then(|records| records.get(&key).filter(|path| path.is_file()).cloned())
        {
            return Some(path);
        }
        let found = find(
            self.registry
                .codex_home_directory()
                .join("sessions")
                .as_path(),
            id,
            5,
        );
        if let Some(path) = &found {
            if let Ok(mut records) = self.codex_records.lock() {
                records.insert(key, path.clone());
            }
        }
        found
    }

    fn enrich_unknown_codex_hold(&self, hold: &mut crate::workbench::external::ProviderHold) {
        if hold.doing != crate::workbench::external::HeldDoing::Unknown {
            return;
        }
        if let Some(path) = self.codex_record(&hold.id) {
            let activity = crate::workbench::external::codex_activity_from_path(&path);
            hold.doing = activity.doing;
            hold.detail = activity.detail;
            hold.since = activity.since;
            hold.turn_since = activity.turn_since;
        }
    }

    /// One read-only app-server per working directory. Initializing Codex is
    /// expensive; list, metadata and usage reads must share it just as the
    /// former sidecar's reader cache did.
    async fn codex_reader(
        &self,
        cwd: &std::path::Path,
    ) -> Result<crate::workbench::codex::transport::CodexTransport, String> {
        let key = cwd.to_path_buf();
        let mut readers = self.codex_readers.lock().await;
        if let Some(reader) = readers.get(&key) {
            return Ok(reader.clone());
        }
        let mut config = crate::workbench::codex::transport::CodexTransportConfig::app_server(cwd);
        if let Some(executable) = crate::routes::find_tool("codex", &[]) {
            config.executable = executable;
        }
        let reader = crate::workbench::codex::transport::CodexTransport::start(config)
            .await
            .map_err(|error| error.to_string())?;
        // A read-only client does not consume provider notifications. Drain
        // them so a long-lived cached reader has bounded memory.
        if let Some(mut inbound) = reader.take_inbound() {
            tokio::spawn(async move { while inbound.recv().await.is_some() {} });
        }
        readers.insert(key, reader.clone());
        Ok(reader)
    }

    async fn forget_codex_reader(
        &self,
        cwd: &std::path::Path,
        failed: &crate::workbench::codex::transport::CodexTransport,
    ) {
        let removed = {
            let mut readers = self.codex_readers.lock().await;
            if readers
                .get(cwd)
                .is_some_and(|reader| reader.child_id() == failed.child_id())
            {
                readers.remove(cwd)
            } else {
                None
            }
        };
        if let Some(reader) = removed {
            reader.close().await;
        }
    }

    async fn discovery(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut running = self.discoveries.lock().await;
        running
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn usage_refresh(&self, brand: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut refreshes = self.usage_refreshes.lock().await;
        refreshes
            .entry(brand.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn claude_usage_reader(
        &self,
    ) -> Result<crate::workbench::claude::transport::ClaudeTransport, String> {
        let mut reader = self.claude_usage_reader.lock().await;
        if let Some(transport) = reader.as_ref() {
            return Ok(transport.clone());
        }
        let options = crate::workbench::claude::transport::ClaudeSessionOptions {
            cwd: std::env::current_dir().map_err(|error| error.to_string())?,
            resume: None,
            model: None,
            permission_mode: Some("default".into()),
            effort: None,
            instructions: String::new(),
        };
        let mut config =
            crate::workbench::claude::transport::ClaudeTransportConfig::session(&options);
        if let Some(executable) = crate::routes::find_tool("claude", &[]) {
            config.executable = executable;
        }
        let transport = crate::workbench::claude::transport::ClaudeTransport::start(config)
            .await
            .map_err(|error| error.to_string())?;
        // A usage-only connection does not consume provider notifications.
        // Drain them so the one reused reader cannot accumulate an unbounded
        // inbound queue between its thirty-second requests.
        if let Some(mut inbound) = transport.take_inbound() {
            tokio::spawn(async move { while inbound.recv().await.is_some() {} });
        }
        *reader = Some(transport.clone());
        Ok(transport)
    }

    async fn forget_claude_usage_reader(
        &self,
        failed: &crate::workbench::claude::transport::ClaudeTransport,
    ) {
        let removed = {
            let mut reader = self.claude_usage_reader.lock().await;
            if reader
                .as_ref()
                .is_some_and(|current| current.child_id() == failed.child_id())
            {
                reader.take()
            } else {
                None
            }
        };
        if let Some(transport) = removed {
            transport.close().await;
        }
    }

    pub(crate) async fn watch_poll_subscription(
        &self,
    ) -> (broadcast::Receiver<Value>, WatchPollLease) {
        let receiver = self.watch_polls.subscribe();
        self.watch_poll_subscribers.fetch_add(1, Ordering::AcqRel);
        let lease = WatchPollLease {
            subscribers: self.watch_poll_subscribers.clone(),
            wake: self.watch_poll_wake.clone(),
        };
        let mut poller = self.watch_pollers.lock().await;
        let running = poller.as_ref().is_some_and(|task| !task.is_finished());
        if !running {
            let state = self.clone();
            *poller = Some(tokio::spawn(async move { state.run_watch_poller().await }));
        }
        (receiver, lease)
    }

    /// One external-record follower per chat, however many browser windows
    /// currently read it. The first subscriber starts the task; the last lease
    /// wakes it to stop.
    pub(crate) async fn chat_follow_subscription(
        &self,
        session_id: &str,
    ) -> (ChatFollowLease, Option<Arc<ChatFollowControl>>) {
        let mut followers = self.chat_followers.lock().await;
        if let Some(control) = followers.get(session_id) {
            control.viewers.fetch_add(1, Ordering::AcqRel);
            return (
                ChatFollowLease {
                    control: control.clone(),
                },
                None,
            );
        }
        let control = Arc::new(ChatFollowControl {
            viewers: AtomicUsize::new(1),
            wake: tokio::sync::Notify::new(),
        });
        followers.insert(session_id.to_string(), control.clone());
        (
            ChatFollowLease {
                control: control.clone(),
            },
            Some(control),
        )
    }

    pub(crate) async fn finish_chat_follow(
        &self,
        session_id: &str,
        control: &Arc<ChatFollowControl>,
    ) {
        let mut followers = self.chat_followers.lock().await;
        if followers
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, control))
        {
            followers.remove(session_id);
        }
    }

    #[cfg(test)]
    pub(crate) async fn has_chat_follower(&self, session_id: &str) -> bool {
        self.chat_followers.lock().await.contains_key(session_id)
    }

    async fn run_watch_poller(self) {
        let mut last_holds = serde_json::to_value(self.provider_holds().await).unwrap_or_default();
        let mut hold_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(2),
            Duration::from_secs(2),
        );
        let mut usage_tick = tokio::time::interval(Duration::from_secs(30));
        let (external_tx, mut external_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut external_watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = external_tx.send(event.paths);
                }
            })
            .ok();
        let claude_projects = self.claude_config_directory().join("projects");
        let codex_sessions = self.codex_home_directory().join("sessions");
        if let Some(watcher) = external_watcher.as_mut() {
            let _ = watcher.watch(&claude_projects, RecursiveMode::Recursive);
            let _ = watcher.watch(&codex_sessions, RecursiveMode::Recursive);
        }
        let mut external_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_secs(1),
        );
        let mut external_dirty = HashSet::new();
        let mut external_cwds = HashMap::new();
        // The chats being worked in elsewhere that this task is keeping read.
        // Held here rather than in the state: the leases must be dropped when
        // this task ends, and its ending is what says nobody has the app open.
        let mut followed: HashMap<String, ChatFollowLease> = HashMap::new();
        loop {
            if self.watch_poll_subscribers.load(Ordering::Acquire) == 0 {
                return;
            }
            tokio::select! {
                _ = self.watch_poll_wake.notified() => {},
                changed = external_rx.recv(), if external_watcher.is_some() => {
                    if let Some(paths) = changed {
                        external_dirty.extend(paths);
                    }
                },
                _ = external_tick.tick() => {
                    if !external_dirty.is_empty() {
                        let paths = std::mem::take(&mut external_dirty);
                        let folders = crate::workbench::external::changed_record_folders(
                            &paths,
                            &claude_projects,
                            &codex_sessions,
                            &mut external_cwds,
                        )
                        .unwrap_or_default();
                        let _ = self.watch_polls.send(json!({"kind":"outside","folders":folders}));
                    }
                },
                _ = hold_tick.tick() => {
                    let holds = self.provider_holds().await;
                    self.keep_following_the_worked_in(&holds, &mut followed).await;
                    let current = serde_json::to_value(holds).unwrap_or_default();
                    if current != last_holds {
                        last_holds = current.clone();
                        let _ = self.watch_polls.send(json!({"kind":"running","holds":current}));
                    }
                },
                _ = usage_tick.tick() => {
                    let readings = async {
                        tokio::join!(
                            self.account_usage("claude"),
                            self.account_usage("codex"),
                        )
                    };
                    tokio::select! {
                        _ = self.watch_poll_wake.notified() => {},
                        (claude, codex) = readings => {
                            for (brand, result) in [("claude", claude), ("codex", codex)] {
                                if let Ok(usage) = result {
                                    let _ = self.watch_polls.send(json!({"kind":"usage","brand":brand,"usage":usage}));
                                }
                            }
                        }
                    }
                },
            }
        }
    }

    /**
     * Keep reading every chat somebody else is working in right now.
     *
     * A chat another program holds is read by tailing that program's own
     * record file, and until now that reading started when a browser opened
     * the chat and stopped when it looked away. So a terminal chat went on
     * working while this app knew nothing about it, and switching to it paid
     * for all of it at once: the byte cursor is remembered, so the whole
     * silent stretch arrived as one import — the "stops streaming, then
     * streams massive amounts of messages at once" the owner reported, and
     * the reason switching was never instant (bw-t26l.20).
     *
     * The set is the holds, not the list: a chat nobody is working in is not
     * growing, so there is nothing to miss by not reading it. A follower this
     * keeps alive is the same one a browser opens — the lease is counted, so
     * neither can stop the other's reading.
     */
    async fn keep_following_the_worked_in(
        &self,
        holds: &[crate::workbench::external::ProviderHold],
        followed: &mut HashMap<String, ChatFollowLease>,
    ) {
        let mut worked_in = HashSet::new();
        for hold in holds {
            let Ok(Some(session)) = self.database().session_by_external_id(hold.id.clone()).await
            else {
                continue;
            };
            worked_in.insert(session.id.clone());
            if followed.contains_key(&session.id) {
                continue;
            }
            let (lease, start) = self.chat_follow_subscription(&session.id).await;
            if let Some(control) = start {
                let state = self.clone();
                let id = session.id.clone();
                tokio::spawn(async move {
                    crate::routes::live::follow_native_record(state, id, control).await;
                });
            }
            followed.insert(session.id, lease);
        }
        // A chat nobody is working in any more is let go. The reader may still
        // have it open; that lease is their own and is not this one.
        followed.retain(|id, _| worked_in.contains(id));
    }

    pub(crate) async fn provider_holds(&self) -> Vec<crate::workbench::external::ProviderHold> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let mut holds = self
            .registry
            .provider_holds(std::path::Path::new("/proc"), now);
        // `codex resume` usually has neither the thread id in argv nor its
        // rollout held open. Its process log supplies ownership, and the
        // indexed rollout path supplies the rich activity word. Keep the path
        // after the first lookup so the two-second hold beat stays a bounded
        // tail read rather than a repeated history scan.
        for hold in &mut holds {
            self.enrich_unknown_codex_hold(hold);
        }
        let sessions = self
            .database()
            .list_sessions(None)
            .await
            .unwrap_or_default();
        // Provider marker files are written by Atelier's own drivers too.
        // Remove those before publishing the provider-neutral "elsewhere"
        // set; explicit registry ownership is stronger than a process trace
        // on disk and avoids locking our own composer.
        let mut attached = std::collections::HashSet::new();
        for session in &sessions {
            if self.registry.has_driver(&session.id).await {
                if let Some(id) = &session.external_id {
                    attached.insert(id.to_lowercase());
                }
            }
        }
        holds.retain(|hold| !attached.contains(&hold.id.to_lowercase()));
        let by_external: HashMap<_, _> = sessions
            .iter()
            .filter_map(|s| s.external_id.as_ref().map(|id| (id.to_lowercase(), s)))
            .collect();
        let mut memory = self.hold_memory.lock().await;
        let mut beats = Vec::with_capacity(holds.len());
        let mut present = std::collections::HashSet::new();
        for hold in &mut holds {
            present.insert(hold.id.to_lowercase());
            let busy = !matches!(
                hold.doing,
                crate::workbench::external::HeldDoing::Idle
                    | crate::workbench::external::HeldDoing::Unknown
            );
            let key = hold.id.to_lowercase();
            if busy {
                let began = *memory
                    .bursts
                    .entry(key.clone())
                    .or_insert(hold.since.unwrap_or(now));
                hold.turn_since = Some(began);
            } else {
                memory.bursts.remove(&key);
            }
            let project = by_external
                .get(&key)
                .map(|s| s.project_path.clone())
                .unwrap_or_default();
            beats.push(crate::workbench::summary::Beat {
                id: hold.id.clone(),
                project: project.clone(),
                summarising: hold.doing == crate::workbench::external::HeldDoing::Summarising,
                since: hold.since,
            });
            if hold.doing == crate::workbench::external::HeldDoing::Summarising
                && !project.is_empty()
            {
                let runs = self
                    .database()
                    .summary_runs(project, 20)
                    .await
                    .unwrap_or_default();
                hold.typical_ms = crate::workbench::summary::median(
                    &runs,
                    crate::workbench::summary::RUNS_ENOUGH,
                );
            }
        }
        memory.bursts.retain(|id, _| present.contains(id));
        let finished = memory.summaries.observe(&beats, now);
        drop(memory);
        for run in finished {
            if !run.project.is_empty() {
                let _ = self
                    .database()
                    .note_summary_run(
                        run.project,
                        run.session_id,
                        chrono::Utc::now().to_rfc3339(),
                        run.ms,
                    )
                    .await;
            }
        }
        holds
    }

    pub(crate) async fn account_usage(&self, brand: &str) -> Result<Value, String> {
        if let Some(value) = fresh_usage(&self.usage_cache, brand).await {
            return Ok(value);
        }
        // Only callers for this provider share an in-flight refresh. Claude
        // and Codex must never wait behind each other's fifteen-second native
        // allowance request.
        let refresh = self.usage_refresh(brand).await;
        let _refresh = refresh.lock().await;
        if let Some(value) = fresh_usage(&self.usage_cache, brand).await {
            return Ok(value);
        }
        let at = chrono::Utc::now().to_rfc3339();
        let value = if brand == "codex" {
            let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
            let transport = self.codex_reader(&cwd).await?;
            let result = crate::workbench::usage::read_codex(&transport, at).await;
            if result.is_err() {
                self.forget_codex_reader(&cwd, &transport).await;
            }
            serde_json::to_value(result?).map_err(|e| e.to_string())?
        } else if brand == "claude" {
            let transport = self.claude_usage_reader().await?;
            let result = crate::workbench::usage::read_claude(&transport, at).await;
            if result.is_err() {
                self.forget_claude_usage_reader(&transport).await;
            }
            serde_json::to_value(result?).map_err(|e| e.to_string())?
        } else {
            return Err(format!("unknown usage provider {brand}"));
        };
        let mut cache = self.usage_cache.lock().await;
        cache.insert(
            brand.to_string(),
            (std::time::Instant::now(), value.clone()),
        );
        Ok(value)
    }
    async fn window_now(&self, session: &str) -> Option<Result<Value, String>> {
        self.registry.window_now(session).await
    }
}

async fn fresh_usage(
    cache: &tokio::sync::Mutex<HashMap<String, (std::time::Instant, Value)>>,
    brand: &str,
) -> Option<Value> {
    cache
        .lock()
        .await
        .get(brand)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
        .map(|(_, value)| value.clone())
}

pub fn router(state: WorkbenchState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/sessions", get(sessions))
        .route("/restore", get(restore))
        .route("/session/:id", get(session))
        .route("/search", get(search))
        .route("/tool", get(tool))
        .route("/spend", get(spend))
        .route("/usage", get(usage))
        .route("/tokens", get(tokens))
        .route("/links/bead/:id", get(chats_for_bead))
        .route("/links/session/:id", get(beads_for_chat))
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
struct SearchQuery {
    q: Option<String>,
}
async fn search(
    State(state): State<WorkbenchState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let q = query.q.unwrap_or_default().trim().to_string();
    Ok(Json(if q.is_empty() {
        json!([])
    } else {
        serde_json::to_value(state.database().search(q, 100).await?).map_err(|e| e.to_string())?
    }))
}

#[derive(Deserialize)]
struct ToolQuery {
    session: String,
    tool: String,
}
async fn tool(
    State(state): State<WorkbenchState>,
    Query(query): Query<ToolQuery>,
) -> Result<Json<Value>, ApiError> {
    state
        .database()
        .tool_details(query.session, query.tool)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such tool call".into()))
}

async fn spend(State(state): State<WorkbenchState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        serde_json::to_value(state.database().spend().await?).map_err(|e| e.to_string())?,
    ))
}

#[derive(Deserialize)]
struct UsageQuery {
    brand: Option<String>,
}
async fn usage(
    State(state): State<WorkbenchState>,
    Query(query): Query<UsageQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        state
            .account_usage(query.brand.as_deref().unwrap_or("claude"))
            .await?,
    ))
}

#[derive(Deserialize)]
struct TokensQuery {
    session: String,
}
async fn tokens(
    State(state): State<WorkbenchState>,
    Query(query): Query<TokensQuery>,
) -> Result<Json<Value>, ApiError> {
    let session = state
        .database()
        .get_session(query.session.clone())
        .await?
        .ok_or_else(|| ApiError::not_found("no such session".into()))?;
    let stats = state.database().token_stats(query.session).await?;
    let record = session
        .external_id
        .as_deref()
        .filter(|_| session.brand == "claude")
        .and_then(|id| {
            crate::workbench::claude::history::find_record(state.claude_config_directory(), id)
        });
    let spent = record.as_deref().and_then(crate::workbench::claude::history::token_spend).or_else(||stats.cost.as_ref().map(|cost| {
        let own = json!({"input":cost["input"],"cacheWrite":0,"cacheRead":0,"output":cost["output"],"thinking":0,"total":cost["total"]});
        json!({"own":own,"helpers":{"input":0,"cacheWrite":0,"cacheRead":0,"output":0,"thinking":0,"total":0},"total":own,
            "turns":stats.turns,"toolCalls":stats.tool_calls,"forgettings":stats.forgettings,"helperCount":stats.helper_count,"models":[{"model":session.model.unwrap_or_else(||"unnamed".into()),"spend":own,"turns":stats.turns}]})
    }));
    let (window, window_note) = match state.window_now(&session.id).await {
        None => (
            Value::Null,
            json!("Context details are unavailable for archived chats."),
        ),
        Some(Ok(raw)) => match crate::workbench::usage::window_now(&raw) {
            Some(window) => (window, Value::Null),
            None => (
                Value::Null,
                json!("The program driving this chat did not say what is in its window."),
            ),
        },
        Some(Err(_)) => (
            Value::Null,
            json!("This chat could not be asked what is in its window just now."),
        ),
    };
    Ok(Json(json!({"window":window,"windowNote":window_note,
        "spent":spent,"spentNote":if spent.is_some(){Value::Null}else if record.is_none(){json!("This chat has no record on disk yet.")}else{json!("This chat's record could not be read.")}})))
}

#[derive(Deserialize)]
struct LinkQuery {
    path: Option<String>,
}
async fn chats_for_bead(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
    Query(query): Query<LinkQuery>,
) -> Result<Json<Value>, ApiError> {
    let cached = state.database().sessions_for_bead(id.clone()).await?;
    let board = if let Some(path) = query.path {
        crate::workbench::beads_links::sessions_for_issue(
            &Default::default(),
            std::path::Path::new(&path),
            &id,
        )
        .await
    } else {
        vec![]
    };
    let wanted = if board.is_empty() {
        cached.iter().map(|s| s.id.clone()).collect()
    } else {
        board
    };
    Ok(Json(json!(wanted.into_iter().map(|session_id| {
        let row = cached.iter().find(|s|s.id == session_id);
        json!({"sessionId":session_id,"title":row.and_then(|s|s.title.clone()),"brand":row.map(|s|s.brand.clone()),"lastActiveAt":row.map(|s|s.last_active_at.clone()),"projectId":row.map(|s|s.project_id.clone())})
    }).collect::<Vec<_>>())))
}

async fn beads_for_chat(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut beads = state.database().beads_for_session(id.clone()).await?;
    if let Some(session) = state.database().get_session(id.clone()).await? {
        beads.extend(
            crate::workbench::beads_links::issues_for_session(
                &Default::default(),
                std::path::Path::new(&session.cwd),
                &id,
            )
            .await,
        );
    }
    beads.sort();
    beads.dedup();
    Ok(Json(json!(beads)))
}

#[derive(Deserialize)]
struct SessionsQuery {
    project: Option<String>,
}

async fn sessions(
    State(state): State<WorkbenchState>,
    Query(query): Query<SessionsQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    Ok(Json(
        session_summaries(state.database(), query.project).await?,
    ))
}

pub(crate) async fn session_summaries(
    database: &ChatDb,
    project: Option<String>,
) -> Result<Vec<Value>, String> {
    let sessions = database.list_sessions(project).await?;
    let ids = sessions.iter().map(|session| session.id.clone()).collect();
    let mut beads = database.beads_for_sessions(ids).await?;
    let mut activities = database.session_activities().await?;
    let mut values = Vec::with_capacity(sessions.len());
    for session in sessions {
        let linked = beads.remove(&session.id).unwrap_or_default();
        let activity =
            activities
                .remove(&session.id)
                .unwrap_or(crate::workbench::store::SessionActivity {
                    label: String::new(),
                    busy_since: None,
                });
        let mut value = serde_json::to_value(session).map_err(|error| error.to_string())?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| "session was not an object".to_string())?;
        object.insert("activity".into(), json!(activity.label));
        object.insert("busySince".into(), json!(activity.busy_since));
        object.insert("beads".into(), json!(linked));
        values.push(value);
    }
    Ok(values)
}

#[derive(Deserialize)]
struct RestoreQuery {
    project: Option<String>,
    path: Option<String>,
    all: Option<String>,
    local: Option<String>,
}

fn folder_of(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

fn restore_row(
    session: Session,
    beads: Vec<String>,
    holds: &[crate::workbench::external::ProviderHold],
) -> Value {
    let folder = folder_of(&session.cwd);
    let held = session
        .external_id
        .as_deref()
        .and_then(|id| holds.iter().find(|hold| hold.id.eq_ignore_ascii_case(id)));
    json!({
        "sessionId": session.id, "externalId": session.external_id, "brand": session.brand, "model":session.model,
        "title": session.title, "lastActiveAt": session.last_active_at,
        "lastSpokeAt": session.last_spoke_at, "state": session.state, "origin": session.origin,
        "projectId": session.project_id, "cwdHint": session.cwd, "folder": folder,
        "branch": Value::Null, "beads": beads, "runningElsewhere": held.is_some(), "held": held,
    })
}

fn restore_clock(row: &Value) -> &str {
    row["lastSpokeAt"]
        .as_str()
        .or_else(|| row["lastActiveAt"].as_str())
        .unwrap_or_default()
}

/// How long one discovery answer serves every reader who asks for the same
/// folder. Discovery is not a database read: it starts an ACP adapter for each
/// provider, waits out its handshake, pages `session/list`, and reads the
/// provider's own record beside it. The sidebar asks on open, on focus and on
/// every project switch, so the answers overlapped — each one paying that price
/// again, and each one holding a connection open while the others did.
const DISCOVERY_FRESH: Duration = Duration::from_secs(5);

/// Every saved chat a provider knows about, asked once for everyone.
///
/// Callers asking about the same folder in the same breath wait on one another
/// rather than starting their own adapters, and the one that runs leaves its
/// answer behind for the rest of the window. This is also what keeps a chat to
/// one row: two overlapping discoveries each saw a chat no row matched, and
/// each cached a row for it (bw-t26l.20).
async fn provider_sessions_shared(
    state: &WorkbenchState,
    project: Option<&str>,
    everything: bool,
) -> Vec<Value> {
    let key = format!("{}\u{0}{everything}", project.unwrap_or_default());
    if let Some(rows) = fresh_discovery(&state.discovery_cache, &key).await {
        return rows;
    }
    let running = state.discovery(&key).await;
    let _running = running.lock().await;
    if let Some(rows) = fresh_discovery(&state.discovery_cache, &key).await {
        return rows;
    }
    let rows = provider_sessions(state, project, everything).await;
    state
        .discovery_cache
        .lock()
        .await
        .insert(key, (std::time::Instant::now(), rows.clone()));
    rows
}

async fn fresh_discovery(
    cache: &tokio::sync::Mutex<HashMap<String, (std::time::Instant, Vec<Value>)>>,
    key: &str,
) -> Option<Vec<Value>> {
    cache
        .lock()
        .await
        .get(key)
        .filter(|(at, _)| at.elapsed() < DISCOVERY_FRESH)
        .map(|(_, rows)| rows.clone())
}

/// How long a provider that cannot answer `session/list` is left alone.
///
/// Starting an adapter to be told "Authentication required" costs the same as
/// starting one that answers, and a provider that is not signed in says it
/// every time. Measured on a run of this app's own tests: seventeen of them,
/// one per discovery, each paying for a process that could not help.
const LISTING_REFUSED_FOR: Duration = Duration::from_secs(60);

/// Ask one provider for its saved chats, unless it has just refused.
async fn ask_provider_to_list(
    state: &WorkbenchState,
    brand: &str,
    filter: Option<&std::path::Path>,
) -> Result<Vec<crate::workbench::acp::client::ListedSession>, String> {
    if let Some(refused) = state.listing_refused.lock().await.get(brand) {
        if refused.elapsed() < LISTING_REFUSED_FOR {
            return Err(format!("{brand} refused session/list a moment ago"));
        }
    }
    let listed = crate::workbench::acp::client::list_sessions(brand, filter).await;
    let mut refusals = state.listing_refused.lock().await;
    if listed.is_err() {
        refusals.insert(brand.to_string(), std::time::Instant::now());
    } else {
        refusals.remove(brand);
    }
    listed
}

/// Every saved chat a provider knows about, however it is asked.
///
/// ACP `session/list` is the standard way to ask and is asked first, but the
/// answer is thinner than the record: an id, a folder, a clock, and a title the
/// adapter guessed. The restore list also draws the branch a chat ran on and
/// names it the app's own way — by what was first asked of it, not by what the
/// agent answered ("Reply with exactly: READY", where the adapter offers
/// "Ready"). Neither is a field `session/list` has. So the record is read
/// alongside, and lends those two to every chat the adapter listed; the clock
/// stays the adapter's, and a chat only the record knows is still listed
/// (bw-t26l.20).
///
/// Asking starts an adapter process per provider and waits for it to read its
/// records: a second when the machine is quiet, half a minute or more when the
/// file cache is cold. The chat list asks every time a record moves on disk
/// and every opened chat asks again, so an adapter that has not answered in
/// eight seconds is let go for the record scan that already stands in when
/// there is no adapter at all (bw-uxoe). The local list is drawn before any of
/// this, and a chat begun elsewhere still arrives on the live feed.
async fn provider_sessions(
    state: &WorkbenchState,
    project: Option<&str>,
    everything: bool,
) -> Vec<Value> {
    const ANSWER_WITHIN: Duration = Duration::from_secs(8);
    let project_path = project.map(std::path::Path::new);
    let filter = (!everything).then_some(project_path).flatten();
    let ask = |brand: &'static str| async move {
        match tokio::time::timeout(ANSWER_WITHIN, ask_provider_to_list(state, brand, filter)).await
        {
            Ok(answer) => answer,
            Err(_) => Err(format!(
                "no session/list answer within {}s",
                ANSWER_WITHIN.as_secs()
            )),
        }
    };
    let (claude_acp, codex_acp) = tokio::join!(ask("claude"), ask("codex"));
    let mut rows = Vec::new();
    for (brand, result) in [("claude", claude_acp), ("codex", codex_acp)] {
        let recorded = recorded_sessions(state, brand, project, project_path, everything).await;
        match result {
            Ok(sessions) => {
                let mut recorded: std::collections::HashMap<String, Value> = recorded
                    .into_iter()
                    .filter_map(|row| {
                        Some((row["externalId"].as_str()?.to_lowercase(), row))
                    })
                    .collect();
                for session in sessions {
                    let known = recorded.remove(&session.session_id.to_lowercase());
                    let mut row = json!({
                        "brand":brand,
                        "externalId":session.session_id,
                        "lastActiveAt":session.updated_at,
                        "lastSpokeAt":Value::Null,
                        "name":session.title,
                        "cwd":session.cwd,
                        "branch":Value::Null,
                        "acpMeta":session.meta,
                    });
                    if let Some(known) = known {
                        // The name and the branch only. The clock stays the
                        // adapter's: it is the record's own timestamp, and a
                        // chat that ran yesterday must file under yesterday
                        // whether or not anything inside it is read.
                        for field in ["name", "branch"] {
                            match known.get(field) {
                                Some(value) if !value.is_null() => {
                                    row[field] = value.clone();
                                }
                                _ => {}
                            }
                        }
                    }
                    rows.push(row);
                }
                // A chat the adapter did not name is still a chat on disk.
                rows.extend(recorded.into_values());
            }
            Err(error) => {
                tracing::warn!(provider = brand, %error, "ACP session/list unavailable; using compatibility discovery");
                rows.extend(recorded);
            }
        }
    }
    rows
}

/// What the provider's own record says about the saved chats in a folder.
async fn recorded_sessions(
    state: &WorkbenchState,
    brand: &str,
    project: Option<&str>,
    project_path: Option<&std::path::Path>,
    everything: bool,
) -> Vec<Value> {
    if brand == "claude" {
        let project_owned = project.map(std::path::PathBuf::from);
        let claude_config = state.registry.claude_config_directory().to_path_buf();
        return tokio::task::spawn_blocking(move || {
            crate::workbench::claude::history::list_sessions(
                &claude_config,
                project_owned.as_deref(),
                everything,
            )
            .into_iter()
            .map(|session| json!({
                "brand":"claude", "externalId":session.session_id, "lastActiveAt":session.last_modified,
                "name":session.name, "cwd":session.cwd, "branch":session.git_branch,
                "lastSpokeAt":session.last_spoke_at,
            }))
            .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
    }
    let cwd = project_path.unwrap_or_else(|| std::path::Path::new("."));
    let Ok(transport) = state.codex_reader(cwd).await else {
        return Vec::new();
    };
    let listed =
        crate::workbench::codex::history::list_threads(&transport, project_path, everything).await;
    let Ok(threads) = listed else {
        state.forget_codex_reader(cwd, &transport).await;
        return Vec::new();
    };
    threads
        .into_iter()
        .filter_map(|thread| {
            let id = thread["id"].as_str()?;
            let updated = thread["updatedAt"]
                .as_i64()
                .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0).map(|at| at.to_rfc3339()));
            let preview = thread["preview"].as_str().unwrap_or_default();
            Some(json!({"brand":"codex","externalId":id,"lastActiveAt":updated,
                "name":thread.get("name").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(crate::workbench::metadata::conversation_title(preview))),
                "cwd":thread["cwd"],"branch":thread["gitInfo"]["branch"],"lastSpokeAt":thread["path"].as_str().and_then(|path|crate::workbench::codex::history::last_spoke_at(std::path::Path::new(path)))}))
        })
        .collect()
}

async fn restore(
    State(state): State<WorkbenchState>,
    Query(query): Query<RestoreQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let everything = query.all.is_some();
    let sessions = state
        .database()
        .list_restore_sessions(query.project.clone(), everything)
        .await?;
    let ids = sessions.iter().map(|session| session.id.clone()).collect();
    let mut beads = state.database().beads_for_sessions(ids).await?;
    // This first response exists solely to put durable rows on screen while
    // provider discovery continues in the concurrent full request. Do not put
    // process-table and provider-marker discovery back on its critical path;
    // the app-wide live feed already overlays ownership as soon as it speaks.
    if query.local.is_some() {
        let mut rows: Vec<Value> = sessions
            .into_iter()
            .map(|session| {
                let linked = beads.remove(&session.id).unwrap_or_default();
                restore_row(session, linked, &[])
            })
            .collect();
        rows.sort_by(|a, b| restore_clock(b).cmp(restore_clock(a)));
        return Ok(Json(rows));
    }

    let holds = state.provider_holds().await;
    let mut rows: Vec<Value> = sessions
        .into_iter()
        .map(|session| {
            let linked = beads.remove(&session.id).unwrap_or_default();
            restore_row(session, linked, &holds)
        })
        .collect();
    let known_sessions = provider_sessions_shared(&state, query.path.as_deref(), everything).await;
    for known in known_sessions {
        let key = format!(
            "{}:{}",
            known["brand"].as_str().unwrap_or_default(),
            known["externalId"].as_str().unwrap_or_default()
        );
        let held = known["externalId"]
            .as_str()
            .and_then(|id| holds.iter().find(|hold| hold.id.eq_ignore_ascii_case(id)));
        if let Some(row) = rows.iter_mut().find(|row| {
            format!(
                "{}:{}",
                row["brand"].as_str().unwrap_or_default(),
                row["externalId"].as_str().unwrap_or_default()
            ) == key
        }) {
            if let Some(title) = known["name"]
                .as_str()
                .filter(|title| !title.trim().is_empty())
            {
                if row["title"].as_str() != Some(title) {
                    row["title"] = json!(title);
                    if let Some(session_id) = row["sessionId"].as_str() {
                        // The local response is deliberately drawn before this
                        // provider reconciliation. Keep its next answer
                        // identical: otherwise every refresh alternates the
                        // stored generated title and the provider's canonical
                        // title while the two requests finish.
                        state
                            .database()
                            .update_session(
                                session_id.to_string(),
                                crate::workbench::store::SessionPatch {
                                    title: Some(Some(title.to_string())),
                                    ..crate::workbench::store::SessionPatch::default()
                                },
                                None,
                            )
                            .await?;
                    }
                }
            }
            if known["lastActiveAt"].as_str() > row["lastActiveAt"].as_str() {
                let latest = known["lastActiveAt"].as_str().map(str::to_string);
                row["lastActiveAt"] = known["lastActiveAt"].clone();
                if let (Some(session_id), Some(latest)) = (row["sessionId"].as_str(), latest) {
                    // The fast durable response is painted before provider
                    // discovery. Persist its clock just like its title and
                    // human clock, or every refresh briefly moves the row to
                    // its old day and then back to the provider's current day.
                    state
                        .database()
                        .update_session(
                            session_id.to_string(),
                            crate::workbench::store::SessionPatch::default(),
                            Some(latest),
                        )
                        .await?;
                }
            }
            if known["lastSpokeAt"].as_str() > row["lastSpokeAt"].as_str() {
                row["lastSpokeAt"] = known["lastSpokeAt"].clone();
                if let (Some(session_id), Some(at)) =
                    (row["sessionId"].as_str(), known["lastSpokeAt"].as_str())
                {
                    // Provider discovery is also reconciliation. Persist the
                    // human clock so the next fast local restore draws the
                    // same group and order instead of flickering until this
                    // slower request finishes.
                    state
                        .database()
                        .mark_spoke(session_id.to_string(), at.to_string())
                        .await?;
                }
            }
            if !known["cwd"].is_null() {
                row["cwdHint"] = known["cwd"].clone();
                row["folder"] = json!(known["cwd"].as_str().and_then(folder_of));
            }
            row["branch"] = known["branch"].clone();
            row["runningElsewhere"] = json!(held.is_some());
            row["held"] = json!(held);
            continue;
        }
        let durable_id = if let (Some(project_id), Some(external_id), Some(brand), Some(cwd)) = (
            query.project.as_deref(),
            known["externalId"].as_str(),
            known["brand"].as_str(),
            known["cwd"].as_str(),
        ) {
            let at = known["lastActiveAt"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            let session = Session {
                id: uuid::Uuid::new_v4().to_string(),
                brand: brand.to_string(),
                external_id: Some(external_id.to_string()),
                project_id: project_id.to_string(),
                project_path: query.path.clone().unwrap_or_else(|| cwd.to_string()),
                cwd: cwd.to_string(),
                model: None,
                permission_mode: if brand == "claude" { "default" } else { "on-request" }.into(),
                effort: None,
                collaboration_mode: None,
                title: known["name"].as_str().map(str::to_string),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: at.clone(),
                last_active_at: at,
                last_spoke_at: known["lastSpokeAt"].as_str().map(str::to_string),
            };
            // The rows above are only the ones this request's own listing
            // drew. A row cached by a request already in flight — the sidebar
            // asks on open, on focus and on every project switch — is not in
            // them, and creating a second one for the same chat is how one
            // terminal chat came to be drawn four times (bw-t26l.20). Ask the
            // database, which sees every request's writes, before writing.
            match state
                .database()
                .session_by_external_id(external_id.to_string())
                .await?
            {
                Some(cached) => Some(cached.id),
                None => match state.database().create_session(session.clone()).await {
                    Ok(()) => Some(session.id),
                    Err(error) => {
                        // Two of them looked in the same breath. The unique
                        // pair refuses the second write, and the row the first
                        // one made is the answer for both.
                        let raced = state
                            .database()
                            .session_by_external_id(external_id.to_string())
                            .await?
                            .map(|session| session.id);
                        if raced.is_none() {
                            tracing::warn!(%error, %external_id, "could not cache ACP-discovered session");
                        }
                        raced
                    }
                },
            }
        } else {
            None
        };
        rows.push(json!({"sessionId":durable_id,"externalId":known["externalId"],"brand":known["brand"],
            "title":known["name"],"lastActiveAt":known["lastActiveAt"],"lastSpokeAt":known["lastSpokeAt"],
            "state":"dormant","origin":"terminal","projectId":query.project,"cwdHint":known["cwd"],
            "folder":known["cwd"].as_str().and_then(folder_of),"branch":known["branch"],"beads":[],
            "runningElsewhere":held.is_some(),"held":held}));
    }
    rows.sort_by(|a, b| restore_clock(b).cmp(restore_clock(a)));
    Ok(Json(rows))
}

async fn session(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let found = state
        .database()
        .get_session(id.clone())
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no session {id}")))?;
    // Asked on every open, and it used to start an adapter per provider each
    // time: the shared answer is the one the sidebar just drew from.
    let known = provider_sessions_shared(&state, Some(&found.project_path), false)
        .await
        .into_iter()
        .find(|known| {
            known["brand"] == found.brand
                && found.external_id.as_ref().is_some_and(|id| {
                    known["externalId"]
                        .as_str()
                        .is_some_and(|external| external.eq_ignore_ascii_case(id))
                })
        });
    let cwd = known
        .as_ref()
        .and_then(|row| row["cwd"].as_str())
        .unwrap_or(&found.cwd)
        .to_string();
    let folder = folder_of(&cwd);
    let mut linked = state
        .database()
        .beads_for_sessions(vec![found.id.clone()])
        .await?;
    let mut beads = linked.remove(&found.id).unwrap_or_default();
    beads.extend(
        crate::workbench::beads_links::issues_for_session(
            &Default::default(),
            std::path::Path::new(&cwd),
            &found.id,
        )
        .await,
    );
    beads.sort();
    beads.dedup();
    for bead in &beads {
        let _ = state
            .database()
            .remember_bead_link(
                found.id.clone(),
                bead.clone(),
                "claim".into(),
                chrono::Utc::now().to_rfc3339(),
            )
            .await;
    }
    if state.begin_claim_sweep(std::path::Path::new(&cwd)).await {
        let sweep = state.database().clone();
        let sweep_cwd = std::path::PathBuf::from(&cwd);
        tokio::spawn(async move {
            let Ok(sessions) = sweep.list_sessions(None).await else {
                return;
            };
            let here = sessions
                .iter()
                .filter(|session| std::path::Path::new(&session.cwd) == sweep_cwd)
                .filter_map(|session| Some((session.id.as_str(), session.external_id.as_deref()?)))
                .collect::<Vec<_>>();
            if here.is_empty() {
                return;
            }
            let runner = crate::workbench::beads_links::BdRunner::default();
            let cards = crate::workbench::beads_links::claimed_cards(&runner, &sweep_cwd).await;
            let links = crate::workbench::beads_links::claimed_links(here, &cards);
            let at = chrono::Utc::now().to_rfc3339();
            for (session, beads) in links {
                for bead in beads {
                    let _ = sweep
                        .remember_bead_link(session.clone(), bead, "claim".into(), at.clone())
                        .await;
                }
            }
        });
    }
    let holds = state.provider_holds().await;
    let held = found
        .external_id
        .as_deref()
        .and_then(|id| holds.iter().find(|hold| hold.id.eq_ignore_ascii_case(id)));
    Ok(Json(json!({
        "sessionId": found.id, "origin": found.origin, "brand": found.brand,
        "externalId": found.external_id, "runningElsewhere": held.is_some(), "held": held,
        "title": known.as_ref().and_then(|row|row["name"].as_str()).map(str::to_string).or(found.title),
        "cwd": cwd, "folder": folder, "branch": known.as_ref().map(|row|row["branch"].clone()).unwrap_or(Value::Null), "beads": beads,
    })))
}

#[derive(Deserialize)]
struct HistoryQuery {
    session: String,
    before: Option<i64>,
    parent: Option<String>,
}

async fn history(
    State(state): State<WorkbenchState>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let page = if let Some(parent) = query.parent {
        state
            .database()
            .agent_transcript_items(query.session, parent, query.before, 40)
            .await?
    } else {
        let before = query
            .before
            .ok_or_else(|| ApiError::from("before is required".to_string()))?;
        state
            .database()
            .transcript_items(query.session, Some(before), 40)
            .await?
    };
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

fn session_tail(
    receiver: broadcast::Receiver<crate::workbench::actor::SessionUpdate>,
    database: ChatDb,
    session_id: String,
    after: i64,
) -> EventStream {
    Box::pin(stream::unfold(
        (
            receiver,
            database,
            session_id,
            after,
            VecDeque::<Event>::new(),
        ),
        |(mut receiver, database, session_id, mut after, mut replay)| async move {
            loop {
                if let Some(event) = replay.pop_front() {
                    let seq = event
                        .fields
                        .get("seq")
                        .and_then(Value::as_i64)
                        .unwrap_or_default();
                    if seq <= after {
                        continue;
                    }
                    after = seq;
                    return Some((
                        Ok(event_frame(&event)),
                        (receiver, database, session_id, after, replay),
                    ));
                }
                match receiver.recv().await {
                    Ok(crate::workbench::actor::SessionUpdate::ReplayCommitted {
                        from, ..
                    }) => {
                        let Ok(events) = database
                            .events_since(session_id.clone(), after.min(from.saturating_sub(1)))
                            .await
                        else {
                            return None;
                        };
                        replay.extend(events);
                    }
                    Ok(crate::workbench::actor::SessionUpdate::Event(event)) => {
                        let seq = event
                            .fields
                            .get("seq")
                            .and_then(Value::as_i64)
                            .unwrap_or_default();
                        if seq <= after {
                            continue;
                        }
                        return Some((
                            Ok(event_frame(&event)),
                            (receiver, database, session_id, seq, replay),
                        ));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(events) = database.events_since(session_id.clone(), after).await
                        else {
                            return None;
                        };
                        replay.extend(events);
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    ))
}

async fn events(
    State(state): State<WorkbenchState>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<EventStream>, ApiError> {
    // Subscribe before replay so an append racing the snapshot cannot fall in the gap.
    let receiver = state.database().subscribe_session(&query.session);
    let since = query.since.unwrap_or(0).max(0);
    let (initial, watermark) = if since == 0 {
        let view = snapshot(state.database(), &query.session).await?;
        let watermark = view["lastSeq"].as_i64().unwrap_or_default();
        (vec![Ok(snapshot_frame(&view))], watermark)
    } else {
        let replay = state
            .database()
            .events_since(query.session.clone(), since)
            .await?;
        let watermark = replay
            .last()
            .and_then(|event| event.fields.get("seq"))
            .and_then(Value::as_i64)
            .unwrap_or(since);
        (
            replay.iter().map(|event| Ok(event_frame(event))).collect(),
            watermark,
        )
    };
    // The compatibility endpoint follows the multiplexed feed's latency
    // contract too: publish the bounded stored page first, then reconcile the
    // provider record without holding the HTTP response open.
    if since == 0 {
        let reconcile = state.clone();
        let session_id = query.session.clone();
        tokio::spawn(async move { reconcile.looked_at(&session_id).await });
    }
    let output: EventStream = Box::pin(stream::iter(initial).chain(session_tail(
        receiver,
        state.database().clone(),
        query.session,
        watermark,
    )));
    Ok(Sse::new(output).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("keep-alive"),
    ))
}

pub(crate) async fn snapshot(database: &ChatDb, session_id: &str) -> Result<Value, String> {
    let snapshot = database.snapshot(session_id.to_string()).await?;
    let mut view = fold_all(&snapshot.history).view;
    let fields = ["models", "permissionModes", "efforts", "collaborationModes"];
    if fields.iter().any(|field| {
        view["menu"][field]
            .as_array()
            .is_none_or(|rows| rows.is_empty())
    }) {
        // Most chats carry their own current session.menu. The provider-wide
        // catalog is only a migration fallback, and on a large event store its
        // global lookup must not sit in front of every ordinary transcript.
        let steering = database.steering_menu(session_id.to_string()).await?;
        for field in fields {
            let empty = view["menu"][field]
                .as_array()
                .is_none_or(|rows| rows.is_empty());
            if empty
                && steering[field]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            {
                view["menu"][field] = steering[field].clone();
            }
        }
    }
    // A picker with no options is intentionally absent in the browser. Older
    // sessions can predate session.menu while still carrying exact saved pins
    // in session.started/session.pinned. Keep those controls visible without
    // inventing a provider catalog: the one known current value is a safe
    // fallback until an ACP/provider menu replaces it.
    let model = view["model"].as_str().map(str::to_string).or_else(|| {
        matches!(view["brand"].as_str(), Some("claude" | "codex")).then(|| "default".to_string())
    });
    let permission_mode = view["permissionMode"].as_str().map(str::to_string);
    let effort = view["effort"].as_str().map(str::to_string);
    let collaboration_mode = view["collaborationMode"].as_str().map(str::to_string);
    if view["menu"]["models"]
        .as_array()
        .is_none_or(|rows| rows.is_empty())
    {
        if let Some(value) = model {
            let display_name = if value == "default" {
                "Default".to_string()
            } else {
                value.clone()
            };
            view["menu"]["models"] = json!([{
                "value":value,
                "displayName":display_name,
                "description":"Saved session selection; the full provider catalog loads when available.",
                "group":"session"
            }]);
        }
    }
    if view["menu"]["permissionModes"]
        .as_array()
        .is_none_or(|rows| rows.is_empty())
    {
        if let Some(value) = permission_mode {
            view["menu"]["permissionModes"] = json!([value]);
        }
    }
    if view["menu"]["efforts"]
        .as_array()
        .is_none_or(|rows| rows.is_empty())
    {
        if let Some(value) = effort {
            let display_name = value.clone();
            view["menu"]["efforts"] = json!([{"value":value,"displayName":display_name}]);
        }
    }
    if view["menu"]["collaborationModes"]
        .as_array()
        .is_none_or(|rows| rows.is_empty())
    {
        if let Some(value) = collaboration_mode {
            let display_name = value.clone();
            view["menu"]["collaborationModes"] =
                json!([{"value":value,"displayName":display_name}]);
        }
    }
    view["items"] = json!(snapshot.page.items);
    view["agents"] = json!(snapshot.agents);
    view["lastSeq"] = json!(snapshot.page.newest_seq);
    view["historyCursor"] = json!(snapshot.page.cursor);
    view["hasOlder"] = json!(snapshot.page.has_older);
    Ok(view)
}

fn watch_frame(value: Value) -> SseEvent {
    SseEvent::default()
        .json_data(value)
        .expect("watch frame serializes")
}

async fn send_watch_snapshot(
    state: &WorkbenchState,
    tx: &tokio::sync::mpsc::Sender<Result<SseEvent, Infallible>>,
) -> Option<Value> {
    let sessions = session_summaries(state.database(), None).await.ok()?;
    let holds = serde_json::to_value(state.provider_holds().await).ok()?;
    for frame in [
        json!({"kind":"snapshot","sessions":sessions}),
        json!({"kind":"running","holds":holds}),
    ] {
        tx.send(Ok(watch_frame(frame))).await.ok()?;
    }
    Some(holds)
}

async fn watch(State(state): State<WorkbenchState>) -> Result<Sse<EventStream>, ApiError> {
    let mut receiver = state.database().subscribe_all();
    let (tx, rx) = tokio::sync::mpsc::channel(100);
    tokio::spawn(async move {
        let (mut polls, _poll_lease) = state.watch_poll_subscription().await;
        let Some(_) = send_watch_snapshot(&state, &tx).await else {
            return;
        };
        loop {
            tokio::select! {
                polled=polls.recv()=>match polled {
                    Ok(frame) => {
                        if tx.send(Ok(watch_frame(frame))).await.is_err(){return}
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                received=receiver.recv()=>match received{
                    Ok(update)=>{
                        if update.batch_from.is_some(){
                            if send_watch_snapshot(&state,&tx).await.is_none(){return}
                            continue
                        }
                        if update.event.kind==crate::workbench::protocol::EventKind::SessionStarted{
                            if let Ok(Some(session))=state.database().get_session(update.session_id.clone()).await{
                                let beads=state.database().beads_for_session(update.session_id.clone()).await.unwrap_or_default();
                                if tx.send(Ok(watch_frame(json!({"kind":"opened","session":{"id":session.id,"brand":session.brand,"externalId":session.external_id,"projectId":session.project_id,"projectPath":session.project_path,"cwd":session.cwd,"model":session.model,"permissionMode":session.permission_mode,"effort":session.effort,"collaborationMode":session.collaboration_mode,"title":session.title,"state":session.state,"origin":session.origin,"createdAt":session.created_at,"lastActiveAt":session.last_active_at,"lastSpokeAt":session.last_spoke_at,"activity":"","busySince":Value::Null,"beads":beads}})))).await.is_err(){return}
                            }
                        }
                        if tx.send(Ok(watch_frame(json!({"kind":"event","event":update.event})))).await.is_err(){return}
                    },
                    Err(broadcast::error::RecvError::Lagged(_))=>{
                        if send_watch_snapshot(&state,&tx).await.is_none(){return}
                    },
                    Err(broadcast::error::RecvError::Closed)=>return
                }
            }
        }
    });
    let output: EventStream = Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx));
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
    files
        .into_iter()
        .map(|(path, encoded)| {
            let label = path.clone();
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map(|bytes| (path, bytes))
                .map_err(|error| format!("{label}: {error}"))
        })
        .collect()
}

async fn present(
    State(state): State<WorkbenchState>,
    Json(request): Json<UploadedRequest>,
) -> Result<Json<Value>, ApiError> {
    let files = decoded(request.files)?;
    Ok(Json(
        json!({"output":state.registry.present(&request.args, &request.stdin, &files)?}),
    ))
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|word| word == name)
        .and_then(|at| args.get(at + 1))
        .map(String::as_str)
}

async fn screen_check(
    State(state): State<WorkbenchState>,
    Json(request): Json<UploadedRequest>,
) -> Result<Json<Value>, ApiError> {
    let files = decoded(request.files)?;
    let action = request.args.first().map(String::as_str).unwrap_or("help");
    if matches!(action, "help" | "--help" | "-h") {
        return Ok(Json(
            json!({"result":{"help":"atelier tool screen-check windows|capture|check|compare"}}),
        ));
    }
    if action == "--schema" {
        return Ok(Json(
            json!({"result":{"schema":{"actions":["windows","capture","check","compare"],"capture_types":["web","window","image"]}}}),
        ));
    }
    if action == "windows" {
        let windows = crate::workbench::screen_check::native_windows()?;
        return Ok(Json(
            json!({"result":{"windows":windows,"safeguards":["explicit ID required","two matching frames required","no whole-display fallback"]}}),
        ));
    }

    let mut captures = Vec::new();
    if action == "compare" {
        let before =
            option(&request.args, "--before").ok_or_else(|| "--before is required".to_string())?;
        let after =
            option(&request.args, "--after").ok_or_else(|| "--after is required".to_string())?;
        let before_bytes = files
            .get(before)
            .ok_or_else(|| format!("no upload for {before}"))?;
        let after_bytes = files
            .get(after)
            .ok_or_else(|| format!("no upload for {after}"))?;
        let before_stored = state
            .registry
            .store_capture(before_bytes, "Before", "image")?;
        let after_stored = state
            .registry
            .store_capture(after_bytes, "After", "image")?;
        let comparison = state.registry.compare_captures(before_bytes, after_bytes)?;
        captures.push(
            json!({"asset":before_stored.asset,"label":"Before","evidence":before_stored.evidence}),
        );
        captures.push(
            json!({"asset":after_stored.asset,"label":"After","evidence":after_stored.evidence}),
        );
        return Ok(Json(
            json!({"result":{"check_id":format!("check_{}_{}", before_stored.asset.chars().take(12).collect::<String>(), after_stored.asset.chars().take(12).collect::<String>()),"captures":captures,"comparison":comparison.objective,"diff_asset":comparison.diff_asset,"verdict":"INDETERMINATE"}}),
        ));
    }

    let stored = if let Some(recipe) = option(&request.args, "--recipe") {
        let bytes = files
            .get(recipe)
            .ok_or_else(|| format!("no upload for {recipe}"))?;
        let recipe = crate::workbench::browser::parse_recipe(bytes)?;
        let capture = state.registry.capture_browser(&recipe, &files).await?;
        state
            .registry
            .store_capture(&capture.bytes, "Browser capture", "browser")?
    } else if let Some(window_id) = option(&request.args, "--window-id") {
        let stable_ms = option(&request.args, "--stable-ms")
            .and_then(|value| value.parse().ok())
            .unwrap_or(200);
        let retries = option(&request.args, "--stable-retries")
            .and_then(|value| value.parse().ok())
            .unwrap_or(5);
        let mut source = crate::workbench::screen_check::NativeWindowSource;
        let (bytes, _, _) = crate::workbench::screen_check::stable_window_capture(
            &mut source,
            window_id,
            Duration::from_millis(stable_ms),
            retries,
        )
        .await?;
        state
            .registry
            .store_capture(&bytes, "Window capture", "window")?
    } else {
        let target = option(&request.args, "--target")
            .ok_or_else(|| "--target, --window-id or --recipe is required".to_string())?;
        let bytes = files
            .get(target)
            .ok_or_else(|| format!("no upload for {target}"))?;
        state
            .registry
            .store_capture(bytes, "Image capture", "image")?
    };
    captures.push(json!({"asset":stored.asset,"label":"Capture","evidence":stored.evidence}));
    Ok(Json(
        json!({"result":{"check_id":format!("check_{}", stored.asset.chars().take(12).collect::<String>()),"captures":captures,"verdict":if action == "capture" { Value::Null } else { json!("INDETERMINATE") }}}),
    ))
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

    /**
     * A chat somebody else is working in is read whether or not it is open.
     *
     * The lease is what is asserted, because the lease is the decision: while
     * this task holds one the follower cannot retire, and the reader's own
     * lease on the same chat is counted separately from it (bw-t26l.20).
     */
    #[tokio::test]
    async fn native_workbench_keeps_reading_a_chat_somebody_else_is_working_in() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let working = crate::workbench::external::ProviderHold {
            id: "thread-1".into(),
            holder: crate::workbench::external::Holder::Terminal,
            doing: crate::workbench::external::HeldDoing::Working,
            detail: None,
            told: false,
            since: None,
            turn_since: None,
            typical_ms: None,
            pids: Default::default(),
        };
        let mut followed = HashMap::new();
        state
            .keep_following_the_worked_in(&[working.clone()], &mut followed)
            .await;
        assert_eq!(followed.keys().collect::<Vec<_>>(), vec!["chat-1"]);

        // Asking again while the same chat is still being worked in does not
        // start a second reading of it.
        state
            .keep_following_the_worked_in(&[working], &mut followed)
            .await;
        assert_eq!(followed.len(), 1);

        // And a chat nobody is working in any more is let go.
        state.keep_following_the_worked_in(&[], &mut followed).await;
        assert!(followed.is_empty());

        // A chat with no row of ours is not followed: there is nowhere to put
        // what it says.
        let stranger = crate::workbench::external::ProviderHold {
            id: "thread-nobody-knows".into(),
            holder: crate::workbench::external::Holder::Terminal,
            doing: crate::workbench::external::HeldDoing::Working,
            detail: None,
            told: false,
            since: None,
            turn_since: None,
            typical_ms: None,
            pids: Default::default(),
        };
        state
            .keep_following_the_worked_in(&[stranger], &mut followed)
            .await;
        assert!(followed.is_empty());
    }

    #[tokio::test]
    async fn external_claim_sweep_is_once_per_project_window() {
        let (_directory, state) = fixture();
        let first = std::path::Path::new("/work/project");
        let second = std::path::Path::new("/work/another");

        assert!(state.begin_claim_sweep(first).await);
        assert!(!state.begin_claim_sweep(first).await);
        assert!(state.begin_claim_sweep(second).await);
    }

    #[tokio::test]
    async fn usage_single_flights_are_shared_per_provider_not_across_providers() {
        let (_directory, state) = fixture();
        let claude = state.usage_refresh("claude").await;
        let same_claude = state.usage_refresh("claude").await;
        let codex = state.usage_refresh("codex").await;

        assert!(Arc::ptr_eq(&claude, &same_claude));
        assert!(!Arc::ptr_eq(&claude, &codex));
        let _claude_guard = claude.lock().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), codex.lock())
                .await
                .is_ok()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), same_claude.lock())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn every_browser_shares_one_poller_and_the_last_one_stops_it() {
        let (_directory, state) = fixture();
        {
            let mut cache = state.usage_cache.lock().await;
            for brand in ["claude", "codex"] {
                cache.insert(
                    brand.into(),
                    (std::time::Instant::now(), json!({"at":"now"})),
                );
            }
        }

        let (_first_rx, first) = state.watch_poll_subscription().await;
        let first_task = state.watch_pollers.lock().await.as_ref().unwrap().id();
        let (_second_rx, second) = state.watch_poll_subscription().await;
        let second_task = state.watch_pollers.lock().await.as_ref().unwrap().id();
        assert_eq!(first_task, second_task);
        assert_eq!(state.watch_poll_subscribers.load(Ordering::Acquire), 2);

        drop(first);
        assert_eq!(state.watch_poll_subscribers.load(Ordering::Acquire), 1);
        drop(second);
        tokio::time::timeout(Duration::from_millis(250), async {
            loop {
                if state
                    .watch_pollers
                    .lock()
                    .await
                    .as_ref()
                    .is_some_and(|task| task.is_finished())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the shared poller outlived its last browser");
    }

    #[tokio::test]
    async fn every_viewer_shares_one_chat_follower_until_the_last_leaves() {
        let (_directory, state) = fixture();
        let (first, started) = state.chat_follow_subscription("chat-1").await;
        let control = started.expect("the first viewer starts the follower");
        let (second, started_again) = state.chat_follow_subscription("chat-1").await;
        assert!(started_again.is_none());
        assert_eq!(control.viewers.load(Ordering::Acquire), 2);

        drop(first);
        assert_eq!(control.viewers.load(Ordering::Acquire), 1);
        drop(second);
        tokio::time::timeout(Duration::from_millis(50), control.stopped())
            .await
            .expect("the last viewer wakes the one shared follower");
        state.finish_chat_follow("chat-1", &control).await;
        assert!(!state.chat_followers.lock().await.contains_key("chat-1"));
    }

    #[tokio::test]
    async fn shared_poller_broadcasts_one_external_record_change_to_every_browser() {
        let (directory, state) = fixture();
        let project = directory.path().join("claude/projects/-work-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(directory.path().join("codex/sessions")).unwrap();
        {
            let mut cache = state.usage_cache.lock().await;
            for brand in ["claude", "codex"] {
                cache.insert(
                    brand.into(),
                    (std::time::Instant::now(), json!({"brand":brand})),
                );
            }
        }

        let (mut first_rx, first) = state.watch_poll_subscription().await;
        let (mut second_rx, second) = state.watch_poll_subscription().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(
            project.join("session.jsonl"),
            "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n",
        )
        .unwrap();

        async fn outside(receiver: &mut broadcast::Receiver<Value>) -> Value {
            loop {
                let frame = receiver.recv().await.unwrap();
                if frame["kind"] == "outside" {
                    return frame;
                }
            }
        }
        let (first_frame, second_frame) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(outside(&mut first_rx), outside(&mut second_rx))
        })
        .await
        .expect("the shared filesystem watcher announces within its settle window");
        assert_eq!(first_frame["folders"], json!(["/work/project"]));
        assert_eq!(second_frame, first_frame);

        drop(first);
        drop(second);
    }

    fn notice() -> Event {
        serde_json::from_value(json!({"type":"notice","sessionId":"chat-1","seq":0,"at":"2026-08-30T00:01:00.000Z","text":"still here","providerEvent":{"provider":"codex","threadId":"thread-1","eventId":"n-1","delivery":"live"}})).unwrap()
    }

    async fn first_chunk(response: Response<Body>) -> String {
        let mut body = response.into_body().into_data_stream();
        String::from_utf8(body.next().await.unwrap().unwrap().to_vec()).unwrap()
    }

    #[test]
    fn native_workbench_restores_rich_codex_status_when_no_rollout_fd_is_open() {
        let (directory, state) = fixture();
        let id = "6f729ab8-6b7d-4ad6-a78e-5dc8cc05eddb";
        let rollout = directory
            .path()
            .join("codex/sessions/2026/09/01")
            .join(format!("rollout-{id}.jsonl"));
        std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        std::fs::write(
            &rollout,
            "{\"payload\":{\"type\":\"task_started\"}}\n{\"payload\":{\"type\":\"reasoning\"}}\n",
        )
        .unwrap();
        let mut hold = crate::workbench::external::ProviderHold {
            id: id.into(),
            holder: crate::workbench::external::Holder::Terminal,
            doing: crate::workbench::external::HeldDoing::Unknown,
            detail: None,
            told: false,
            since: None,
            turn_since: None,
            typical_ms: None,
            pids: std::collections::BTreeSet::from([42]),
        };

        state.enrich_unknown_codex_hold(&mut hold);

        assert_eq!(hold.doing, crate::workbench::external::HeldDoing::Thinking);
        assert_eq!(state.codex_record(id).as_deref(), Some(rollout.as_path()));
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
        let mut catalog = saved_session();
        catalog.id = "catalog-chat".into();
        // Another chat is another thread. One row per chat another program is
        // holding is what the store enforces now (bw-t26l.20).
        catalog.external_id = Some("thread-2".into());
        catalog.project_id = "another-project".into();
        state.database().create_session(catalog).await.unwrap();
        let menu: Event = serde_json::from_value(json!({
            "type":"session.menu", "sessionId":"catalog-chat", "seq":0, "at":"now",
            "models":[{"value":"gpt-5","displayName":"GPT-5"}],
            "permissionModes":["on-request"], "commands":[{"name":"project-only"}]
        }))
        .unwrap();
        state.database().append(menu).await.unwrap();
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
        assert!(chunk.contains("GPT-5"), "{chunk}");
        assert!(!chunk.contains("project-only"), "{chunk}");
    }

    #[tokio::test]
    async fn saved_pins_keep_every_known_picker_visible_without_a_historical_menu() {
        let (_directory, state) = fixture();
        let mut session = saved_session();
        session.permission_mode = "on-request".into();
        session.effort = Some("high".into());
        session.collaboration_mode = Some("plan".into());
        state
            .database()
            .create_session(session.clone())
            .await
            .unwrap();
        let started: Event = serde_json::from_value(json!({
            "type":"session.started","sessionId":session.id,"seq":0,"at":session.created_at,
            "brand":session.brand,"externalId":session.external_id,"model":session.model,
            "cwd":session.cwd,"permissionMode":session.permission_mode,"effort":session.effort,
            "collaborationMode":session.collaboration_mode
        }))
        .unwrap();
        state.database().append(started).await.unwrap();

        let view = snapshot(state.database(), &session.id).await.unwrap();
        assert_eq!(view["menu"]["models"][0]["value"], "gpt-5");
        assert_eq!(view["menu"]["permissionModes"], json!(["on-request"]));
        assert_eq!(view["menu"]["efforts"][0]["value"], "high");
        assert_eq!(view["menu"]["collaborationModes"][0]["value"], "plan");
    }

    #[tokio::test]
    async fn native_workbench_local_restore_returns_durable_rows_without_discovery() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject&local=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(rows.as_array().map(Vec::len), Some(1));
        assert_eq!(rows[0]["sessionId"], "chat-1");
        assert_eq!(rows[0]["title"], "The chat that must remain visible");
        assert_eq!(rows[0]["runningElsewhere"], false);
    }

    /**
     * One discovery answer serves everyone who asks in the same breath.
     *
     * The sidebar asks on open, on focus and on every project switch, and each
     * ask used to start an ACP adapter per provider and read the provider's
     * whole record beside it. What is asserted here is the gate that stops
     * that: an answer inside its window is handed back as it stands, and one
     * past it is not (bw-t26l.20).
     */
    #[tokio::test]
    async fn native_workbench_shares_one_discovery_between_overlapping_asks() {
        let (_directory, state) = fixture();
        let key = format!("/work/project\u{0}false");
        let listed = vec![json!({"brand":"claude","externalId":"thread-1"})];
        state
            .discovery_cache
            .lock()
            .await
            .insert(key.clone(), (std::time::Instant::now(), listed.clone()));
        let rows = provider_sessions_shared(&state, Some("/work/project"), false).await;
        assert_eq!(rows, listed, "a fresh answer is handed back as it stands");

        state.discovery_cache.lock().await.insert(
            key.clone(),
            (
                std::time::Instant::now() - DISCOVERY_FRESH - Duration::from_secs(1),
                listed,
            ),
        );
        assert!(
            fresh_discovery(&state.discovery_cache, &key).await.is_none(),
            "an answer past its window is asked again"
        );
        // And the folder is part of what makes an answer this reader's.
        assert!(
            fresh_discovery(&state.discovery_cache, "/somewhere/else\u{0}false")
                .await
                .is_none()
        );
    }

    /**
     * A provider that cannot answer is left alone for a while.
     *
     * Starting an adapter to be told "Authentication required" costs what
     * starting one that answers costs, and a provider that is not signed in
     * refuses every time it is asked (bw-t26l.20).
     */
    #[tokio::test]
    async fn native_workbench_stops_asking_a_provider_that_just_refused_to_list() {
        let (_directory, state) = fixture();
        state
            .listing_refused
            .lock()
            .await
            .insert("codex".into(), std::time::Instant::now());
        let answer = ask_provider_to_list(&state, "codex", None).await;
        assert!(answer.is_err_and(|why| why.contains("a moment ago")));

        // A refusal old enough is not an answer, and the provider is asked
        // again — here there is no adapter to ask, so it refuses afresh.
        state.listing_refused.lock().await.insert(
            "codex".into(),
            std::time::Instant::now() - LISTING_REFUSED_FOR - Duration::from_secs(1),
        );
        let answer = ask_provider_to_list(&state, "codex", None).await;
        assert!(answer.is_err_and(|why| !why.contains("a moment ago")));
        assert!(state.listing_refused.lock().await.contains_key("codex"));
    }

    #[tokio::test]
    async fn native_workbench_local_restore_orders_and_groups_by_human_clock() {
        let (_directory, state) = fixture();
        let mut older_human = saved_session();
        older_human.id = "opened-today".into();
        older_human.external_id = Some("thread-opened-today".into());
        older_human.last_active_at = "2026-09-01T09:50:00Z".into();
        older_human.last_spoke_at = Some("2026-08-30T22:05:00Z".into());
        let mut newer_human = saved_session();
        newer_human.id = "spoken-today".into();
        newer_human.external_id = Some("thread-spoken-today".into());
        newer_human.last_active_at = "2026-09-01T09:00:00Z".into();
        newer_human.last_spoke_at = Some("2026-09-01T08:55:00Z".into());
        state.database().create_session(older_human).await.unwrap();
        state.database().create_session(newer_human).await.unwrap();

        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&local=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(rows[0]["sessionId"], "spoken-today");
        assert_eq!(rows[1]["sessionId"], "opened-today");
    }

    #[tokio::test]
    async fn native_workbench_persists_the_provider_title_for_the_next_fast_restore() {
        let (directory, state) = fixture();
        let external_id = "c0704045-2fd3-4e88-bbe2-b7361ebf6a32";
        let mut session = saved_session();
        session.brand = "claude".into();
        session.external_id = Some(external_id.into());
        session.title = Some("Temporary stored label".into());
        state.database().create_session(session).await.unwrap();
        let record = directory
            .path()
            .join("claude/projects/-work-project")
            .join(format!("{external_id}.jsonl"));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            record,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-01T06:00:00Z\",",
                "\"cwd\":\"/work/project\",\"customTitle\":\"Canonical provider title\",",
                "\"message\":{\"role\":\"user\",\"content\":\"A prompt\"}}\n"
            ),
        )
        .unwrap();

        let app = router(state);
        let full = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let full: Value = serde_json::from_slice(
            &axum::body::to_bytes(full.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(full[0]["title"], "Canonical provider title");
        let provider_clock = full[0]["lastActiveAt"].clone();

        let local = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject&local=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let local: Value = serde_json::from_slice(
            &axum::body::to_bytes(local.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(local[0]["title"], "Canonical provider title");
        assert_eq!(local[0]["lastActiveAt"], provider_clock);
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
    async fn native_workbench_watch_can_restate_every_summary_after_a_lag() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let holds = send_watch_snapshot(&state, &tx)
            .await
            .expect("a lag recovery snapshot");
        assert!(holds.is_array());
        let snapshot = rx.recv().await.unwrap().unwrap();
        let running = rx.recv().await.unwrap().unwrap();
        assert!(format!("{snapshot:?}").contains("chat-1"));
        assert!(format!("{running:?}").contains("running"));
    }

    #[tokio::test]
    async fn native_workbench_watch_recovers_instead_of_skipping_a_burst() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/watch")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // The route's outgoing queue holds 100 frames and the database
        // broadcast holds 1,024. Not reading the body while this burst lands
        // deterministically forces the all-chat receiver to lag.
        for index in 0..1_200 {
            let event: Event = serde_json::from_value(json!({
                "type":"notice", "sessionId":"chat-1", "seq":0,
                "at":"2026-08-30T00:01:00.000Z", "text":format!("burst {index}")
            }))
            .unwrap();
            state.database().append(event).await.unwrap();
        }

        let mut body = response.into_body().into_data_stream();
        let recovered = tokio::time::timeout(Duration::from_secs(5), async {
            let mut received = String::new();
            while let Some(chunk) = body.next().await {
                received.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
                if received.matches("\"kind\":\"snapshot\"").count() >= 2 {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(recovered, "the lagged watch never restated its summaries");
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

    #[tokio::test]
    async fn native_workbench_snapshot_handoff_does_not_deliver_buffered_events_twice() {
        let (_directory, state) = fixture();
        let (sender, receiver) = tokio::sync::broadcast::channel(8);
        let old: Event = serde_json::from_value(
            json!({"type":"notice","sessionId":"chat-1","seq":4,"at":"now","text":"in snapshot"}),
        )
        .unwrap();
        let fresh: Event = serde_json::from_value(json!({"type":"notice","sessionId":"chat-1","seq":5,"at":"now","text":"after snapshot"})).unwrap();
        sender
            .send(crate::workbench::actor::SessionUpdate::Event(old))
            .unwrap();
        sender
            .send(crate::workbench::actor::SessionUpdate::Event(fresh))
            .unwrap();
        let mut tail = session_tail(receiver, state.database().clone(), "chat-1".into(), 4);
        let frame = tail.next().await.unwrap().unwrap();
        assert!(format!("{frame:?}").contains("after snapshot"));
    }

    #[tokio::test]
    async fn native_workbench_session_tail_replays_every_durable_event_after_a_lag() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let receiver = state.database().subscribe_session("chat-1");
        for index in 0..1_100 {
            let event: Event = serde_json::from_value(json!({
                "type":"notice", "sessionId":"chat-1", "seq":0,
                "at":"2026-08-30T00:01:00.000Z", "text":format!("burst {index}")
            }))
            .unwrap();
            state.database().append(event).await.unwrap();
        }
        let mut tail = session_tail(receiver, state.database().clone(), "chat-1".into(), 0);
        let first = tail.next().await.unwrap().unwrap();
        assert!(
            format!("{first:?}").contains("burst 0"),
            "the lag recovery skipped the oldest durable event"
        );
    }
}
