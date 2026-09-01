//! One stream for a whole browser window.
//!
//! A window used to open a permanent connection per feed: the helper's own
//! stream from the top bar, the project's board file wherever the card list
//! was drawn, and the open chat. A browser allows six connections to one
//! address across every window it has, and a stream never ends — so two or
//! three windows of the app spent the whole budget, and every ordinary read
//! then queued behind streams that would never give a slot back. That is what
//! a screen stuck on loading was, and why reloading it worked: a reload frees
//! that window's streams, and the reads go out before the streams reopen
//! (bw-zkh4).
//!
//! So the fanning-in happens here instead. This route takes what the window is
//! watching, runs the board watcher itself, and reads the helper's two streams
//! over its own connections — server to server, where no six-connection budget
//! applies — handing the browser one stream with every event tagged by the
//! feed it came from.
//!
//! The tags, which are the contract with `src/workbench/live-wire.ts`:
//!
//! | tag              | what it carries                                    |
//! |------------------|----------------------------------------------------|
//! | `board`          | this project's board file moved                    |
//! | `workbench`      | one frame of the helper's all-sessions stream      |
//! | `chat`           | one event in the open chat                         |
//! | `chat.snapshot`  | the open chat's conversation as it stands          |
//! | `chat.error`     | a readable snapshot failure while retrying          |
//! | `bootstrap`      | dependency installation progress                   |
//!
//! A named upstream event keeps its name after the tag, which is where
//! `chat.snapshot` comes from: the helper names that frame `snapshot`.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    Extension,
};
use futures::{sink::SinkExt, stream::StreamExt};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::Read;
use std::{
    convert::Infallible,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::environment::BootstrapBus;
use super::workbench;
use crate::db::Database;
use crate::dolt::DoltManager;

/// One thing a feed said, and which feed said it.
///
/// Every feed this route fans in writes these, and the two ways out of here
/// dress them differently: a WebSocket sends the whole thing as one JSON
/// object, an event stream sends the data with the tag as the event's name.
#[derive(Debug, Clone, Serialize)]
pub(super) struct Tagged {
    /// The feed it belongs to. `None` on a connection carrying one feed only,
    /// where naming it would say nothing (watch.rs).
    pub tag: Option<String>,
    /// Which chat produced this frame. Chat data is never routed by whichever
    /// conversation the browser happens to call current when it arrives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// What the feed said, exactly as it said it.
    pub data: String,
}
impl Tagged {
    pub(super) fn new(tag: Option<&str>, data: String) -> Self {
        Tagged {
            tag: tag.map(str::to_string),
            scope: None,
            data,
        }
    }

    fn scoped(tag: &str, scope: &str, data: String) -> Self {
        Tagged {
            tag: Some(tag.to_string()),
            scope: Some(scope.to_string()),
            data,
        }
    }

    /// The same thing on an event stream, where the tag is the event's name.
    pub(super) fn as_event(&self) -> Event {
        let said = Event::default().data(self.data.clone());
        match &self.tag {
            Some(tag) => said.event(tag),
            None => said,
        }
    }

    /// The same thing on a WebSocket, where nothing names a frame for us.
    fn as_text(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// What this window is watching. Everything is optional: a window drawing only
/// the board asks for only the board, and pays for nothing else.
#[derive(Debug, Deserialize, Default)]
pub struct LiveParams {
    /// The projects whose board files to watch, joined by a newline. A
    /// repeated key is the one thing a query string cannot say plainly, and a
    /// project path never contains a newline (src/workbench/live-wire.ts).
    pub board: Option<String>,
    /// The chat that is open, if one is.
    pub chat: Option<String>,
    /// The last chat event this window has already drawn, so a re-ask never
    /// folds a conversation onto itself.
    pub since: Option<u64>,
    /// Whether anything on screen reads the helper's all-sessions feed.
    pub workbench: Option<String>,
    /// Whether this screen is showing dependency installation progress.
    pub bootstrap: Option<String>,
}

/// Whether a query flag was written as a yes.
fn asked(flag: &Option<String>) -> bool {
    matches!(
        flag.as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// The working directory named at the head of a provider record. Both Claude
/// and Codex put it in their opening metadata; reading only the head keeps an
/// outside-session notification independent of transcript size.
fn record_cwd(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut front = Vec::with_capacity(64_000);
    file.by_ref().take(64_000).read_to_end(&mut front).ok()?;
    String::from_utf8_lossy(&front).lines().find_map(|line| {
        let row: serde_json::Value = serde_json::from_str(line).ok()?;
        row["cwd"]
            .as_str()
            .or_else(|| row["payload"]["cwd"].as_str())
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_string)
    })
}

/// A Claude project folder's flattened name cannot be reversed safely. Read
/// one record in it, exactly as the retired implementation did, and remember
/// only successful answers so a half-written first record is retried.
fn claude_folder_cwd(folder: &Path) -> Option<String> {
    std::fs::read_dir(folder).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "jsonl")
            .then(|| record_cwd(&path))
            .flatten()
    })
}

/// Scope a burst of provider-record writes to the projects they can affect.
/// `None` deliberately means "unplaceable": the browser then performs the
/// conservative all-project refresh used by the established wire contract.
fn outside_folders(
    paths: &HashSet<PathBuf>,
    claude_projects: &Path,
    codex_sessions: &Path,
    known: &mut HashMap<PathBuf, String>,
) -> Option<Vec<String>> {
    if paths.is_empty() {
        return None;
    }
    let mut moved = Vec::new();
    for path in paths {
        let key = if let Ok(relative) = path.strip_prefix(claude_projects) {
            let project = relative.components().next()?.as_os_str();
            claude_projects.join(project)
        } else if path.starts_with(codex_sessions) {
            path.clone()
        } else {
            continue;
        };
        let cwd = known.get(&key).cloned().or_else(|| {
            let found = if key.starts_with(claude_projects) {
                claude_folder_cwd(&key)
            } else {
                record_cwd(&key)
            }?;
            known.insert(key.clone(), found.clone());
            Some(found)
        })?;
        moved.push(cwd);
    }
    moved.sort();
    moved.dedup();
    (!moved.is_empty()).then_some(moved)
}

/// Feed the combined browser connection from the in-process database. This is
/// the native equivalent of relaying the helper's `/watch` SSE stream.
async fn relay_native_watch(state: workbench::WorkbenchState, tx: mpsc::Sender<Tagged>) {
    let usage_state = state.clone();
    let usage_tx = tx.clone();
    tokio::spawn(async move {
        let mut beat = tokio::time::interval(Duration::from_secs(30));
        loop {
            beat.tick().await;
            for brand in ["claude", "codex"] {
                if let Ok(usage) = usage_state.account_usage(brand).await {
                    let frame = serde_json::json!({"kind":"usage","brand":brand,"usage":usage});
                    if usage_tx
                        .send(Tagged::new(Some("workbench"), frame.to_string()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    let mut updates = state.database().subscribe_all();
    let sessions = match workbench::session_summaries(state.database(), None).await {
        Ok(sessions) => sessions,
        Err(_) => return,
    };
    let mut holds = serde_json::to_value(state.provider_holds().await).unwrap_or_default();
    for frame in [
        serde_json::json!({"kind":"snapshot","sessions":sessions}),
        serde_json::json!({"kind":"running","holds":holds}),
    ] {
        if tx
            .send(Tagged::new(Some("workbench"), frame.to_string()))
            .await
            .is_err()
        {
            return;
        }
    }
    let mut hold_tick = tokio::time::interval(Duration::from_secs(2));
    let (external_tx, mut external_rx) = mpsc::unbounded_channel();
    let mut external_watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if let Ok(event) = event {
                let _ = external_tx.send(event.paths);
            }
        })
        .ok();
    let claude_projects = state.claude_config_directory().join("projects");
    let codex_sessions = state.codex_home_directory().join("sessions");
    if let Some(watcher) = external_watcher.as_mut() {
        let _ = watcher.watch(&claude_projects, RecursiveMode::Recursive);
        let _ = watcher.watch(&codex_sessions, RecursiveMode::Recursive);
    }
    let mut external_tick = tokio::time::interval(Duration::from_secs(1));
    let mut external_dirty = HashSet::new();
    let mut external_cwds = HashMap::new();
    loop {
        tokio::select! {
        _ = hold_tick.tick() => {
            let current = serde_json::to_value(state.provider_holds().await).unwrap_or_default();
            if current != holds {
                holds = current;
                let frame = serde_json::json!({"kind":"running","holds":holds});
                if tx.send(Tagged::new(Some("workbench"), frame.to_string())).await.is_err() { return; }
            }
        }
        changed=external_rx.recv(), if external_watcher.is_some()=>{
            if let Some(paths)=changed { external_dirty.extend(paths); }
        }
        _ = external_tick.tick() => {
            if !external_dirty.is_empty() {
                let paths=std::mem::take(&mut external_dirty);
                let folders=outside_folders(&paths,&claude_projects,&codex_sessions,&mut external_cwds)
                    .unwrap_or_default();
                let frame = serde_json::json!({"kind":"outside","folders":folders});
                if tx.send(Tagged::new(Some("workbench"), frame.to_string())).await.is_err() { return; }
            }
        }
        received = updates.recv() => match received {
            Ok(update) => {
                if update.event.kind == crate::workbench::protocol::EventKind::SessionStarted {
                    if let Ok(Some(session)) = state.database().get_session(update.session_id.clone()).await {
                        let beads = state.database().beads_for_session(update.session_id.clone()).await.unwrap_or_default();
                        let frame = serde_json::json!({"kind":"opened","session":{
                            "id":session.id,"brand":session.brand,"externalId":session.external_id,
                            "projectId":session.project_id,"projectPath":session.project_path,"cwd":session.cwd,
                            "model":session.model,"permissionMode":session.permission_mode,"effort":session.effort,
                            "collaborationMode":session.collaboration_mode,"title":session.title,"state":session.state,
                            "origin":session.origin,"createdAt":session.created_at,"lastActiveAt":session.last_active_at,
                            "lastSpokeAt":session.last_spoke_at,"activity":"","busySince":serde_json::Value::Null,"beads":beads
                        }});
                        if tx.send(Tagged::new(Some("workbench"), frame.to_string())).await.is_err() { return; }
                    }
                }
                let frame = serde_json::json!({"kind":"event","event":update.event});
                if tx
                    .send(Tagged::new(Some("workbench"), frame.to_string()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }}
    }
}

async fn send_chat_snapshot(
    state: &workbench::WorkbenchState,
    session_id: &str,
    tx: &mpsc::Sender<Tagged>,
) -> Result<i64, String> {
    let snapshot = workbench::snapshot(state.database(), session_id)
        .await
        .map_err(|error| format!("Could not load this conversation: {error}"))?;
    let watermark = snapshot["lastSeq"].as_i64().unwrap_or_default();
    tx.send(Tagged::scoped(
        "chat.snapshot",
        session_id,
        snapshot.to_string(),
    ))
    .await
    .map_err(|_| "conversation reader closed".to_string())?;
    Ok(watermark)
}

/// A transient database or projection failure must neither disappear nor
/// strand the browser on an eternal loading shell. Say what failed, then keep
/// retrying the bounded snapshot while the window is still listening.
async fn recover_chat_snapshot(
    state: &workbench::WorkbenchState,
    session_id: &str,
    tx: &mpsc::Sender<Tagged>,
) -> Option<i64> {
    loop {
        match send_chat_snapshot(state, session_id, tx).await {
            Ok(watermark) => return Some(watermark),
            Err(error) => {
                if tx
                    .send(Tagged::scoped(
                        "chat.error",
                        session_id,
                        serde_json::json!({"error":error}).to_string(),
                    ))
                    .await
                    .is_err()
                {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

/// Feed one open chat into `/api/live` without a loopback HTTP hop.
async fn relay_native_chat(
    state: workbench::WorkbenchState,
    session_id: String,
    since: i64,
    tx: mpsc::Sender<Tagged>,
) {
    let mut updates = state.database().subscribe_session(&session_id);
    // A copied URL and a sidebar click are the same cold read. This is
    // intentionally before the opening snapshot so a stale busy state cannot
    // survive a process restart, while history parsing itself continues in
    // background. A resumed wire already reconciled this chat and must not
    // start another import.
    if since == 0 {
        state.looked_at(&session_id).await;
    }
    let followed = state
        .database()
        .get_session(session_id.clone())
        .await
        .ok()
        .flatten()
        .and_then(|session| {
            let record = session.external_id.as_deref().and_then(|id| {
                if session.brand == "claude" {
                    crate::workbench::claude::history::find_record(
                        state.claude_config_directory(),
                        id,
                    )
                } else if session.brand == "codex" {
                    state.codex_record(id)
                } else {
                    None
                }
            })?;
            Some((session, record))
        });
    let followed_to = state
        .database()
        .followed_to(session_id.clone())
        .await
        .ok()
        .flatten();
    let mut claude_tail = followed
        .as_ref()
        .filter(|(session, _)| session.brand == "claude")
        .map(|(_, record)| {
            let mut tail = crate::workbench::external::LineTail::new(record);
            if let Some(at) = followed_to {
                tail.seek(at.max(0) as u64)
            } else {
                tail.to_end()
            }
            tail
        });
    let mut claude_lines: VecDeque<String> = VecDeque::new();
    let mut claude_helpers = followed
        .as_ref()
        .filter(|(session, _)| session.brand == "claude")
        .map(|(_, record)| crate::workbench::claude::history::HelperFollower::after_import(record));
    let mut codex_tail = followed
        .as_ref()
        .filter(|(session, _)| session.brand == "codex")
        .map(|(_, record)| {
            let mut tail = crate::workbench::external::LineTail::new(record);
            if let Some(at) = followed_to {
                tail.seek(at.max(0) as u64)
            } else {
                tail.to_end()
            }
            tail
        });
    let mut codex_lines: VecDeque<String> = VecDeque::new();
    let mut record_tick = tokio::time::interval(Duration::from_millis(250));
    let mut watermark;
    if since == 0 {
        let Some(sent) = recover_chat_snapshot(&state, &session_id, &tx).await else {
            return;
        };
        watermark = sent;
    } else if let Ok(events) = state
        .database()
        .events_since(session_id.clone(), since)
        .await
    {
        watermark = events
            .last()
            .and_then(|event| event.fields.get("seq"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(since);
        for event in events {
            let Ok(data) = serde_json::to_string(&event) else {
                continue;
            };
            if tx
                .send(Tagged::scoped("chat", &session_id, data))
                .await
                .is_err()
            {
                return;
            }
        }
    } else {
        watermark = since;
    }
    loop {
        tokio::select! {
        _ = record_tick.tick(), if followed.is_some() => {
            let (session, record) = followed.as_ref().unwrap();
            // A native driver is the one live source while Atelier owns the
            // provider. Keep the durable file cursor current without replaying
            // the same prompt/answer a second time from the provider record.
            if state.has_driver(&session.id).await {
                if let Some(tail) = claude_tail.as_mut() { tail.to_end(); }
                if let Some(tail) = codex_tail.as_mut() { tail.to_end(); }
                claude_lines.clear();
                codex_lines.clear();
                let at=if session.brand=="claude"{claude_tail.as_ref().map(|tail|tail.through_line())}else{codex_tail.as_ref().map(|tail|tail.through_line())};
                if let Some(at)=at{let _=state.database().remember_followed(session.id.clone(),at as i64).await;}
                continue;
            }
            let mut fresh = if session.brand=="claude" {
                let growth=claude_tail.as_mut().and_then(|tail|tail.grown().ok());
                if growth.as_ref().is_some_and(|growth|growth.rewritten) {
                    if !state.database().was_driven_here(session.id.clone()).await.unwrap_or(true) {
                        let reset:Result<crate::workbench::protocol::Event,_>=serde_json::from_value(serde_json::json!({"type":"transcript.reset","sessionId":session.id,"seq":0,"at":chrono::Utc::now().to_rfc3339()}));
                        if let Ok(reset)=reset{let _=state.database().append(reset).await;}
                        if let Some(tail)=claude_tail.as_mut(){tail.seek(0)}
                        claude_lines.clear();
                        // A reset removes child rows with the parent transcript.
                        // Re-observe every current helper on this same beat.
                        claude_helpers=Some(crate::workbench::claude::history::HelperFollower::after_import(record));
                    } else if let Some(tail)=claude_tail.as_mut(){tail.to_end()}
                    Vec::new()
                } else {
                    if let Some(growth)=growth{for line in growth.lines{claude_lines.push_back(line)}}
                    let fresh=crate::workbench::claude::history::replay_lines(claude_lines.make_contiguous());
                    while claude_lines.len()>256{claude_lines.pop_front();}
                    fresh
                }
            } else {
                let growth=codex_tail.as_mut().and_then(|tail|tail.grown().ok());
                if growth.as_ref().is_some_and(|growth|growth.rewritten){if !state.database().was_driven_here(session.id.clone()).await.unwrap_or(true){let reset:Result<crate::workbench::protocol::Event,_>=serde_json::from_value(serde_json::json!({"type":"transcript.reset","sessionId":session.id,"seq":0,"at":chrono::Utc::now().to_rfc3339()}));if let Ok(reset)=reset{let _=state.database().append(reset).await;}if let Some(tail)=codex_tail.as_mut(){tail.seek(0)}codex_lines.clear();}else if let Some(tail)=codex_tail.as_mut(){tail.to_end()}Vec::new()}else{if let Some(growth)=growth{for line in growth.lines{codex_lines.push_back(line)}}let fresh=crate::workbench::codex::normalize::replay_rollout(&codex_lines.make_contiguous().join("\n"));while codex_lines.len()>512{codex_lines.pop_front();}fresh}
            };
            if let Some(helpers) = claude_helpers.as_mut() {
                let (updates, finished) = helpers.poll(&fresh);
                if !updates.is_empty() || !finished.is_empty() {
                    let mut together = Vec::with_capacity(updates.len() + fresh.len() + finished.len());
                    together.extend(updates);
                    together.extend(fresh);
                    together.extend(finished);
                    fresh = together;
                }
            }
            for mut value in fresh {
                let event_id=crate::workbench::protocol::record_event_id(&value);
                let Some(object) = value.as_object_mut() else { continue; };
                object.insert("providerEvent".into(),serde_json::json!({"provider":session.brand,"threadId":session.external_id,"eventId":event_id,"delivery":"live"}));
                object.insert("sessionId".into(), serde_json::json!(session.id));
                object.insert("seq".into(), serde_json::json!(0));
                object.entry("at").or_insert_with(|| serde_json::json!(chrono::Utc::now().to_rfc3339()));
                if let Ok(event) = serde_json::from_value(value) {
                    if let Ok(Some(stored)) = state.database().append(event).await {
                        let seq=stored.fields.get("seq").and_then(serde_json::Value::as_i64).unwrap_or_default();
                        if seq>watermark {
                            let Ok(data)=serde_json::to_string(&stored) else { continue; };
                            if tx.send(Tagged::scoped("chat",&session_id,data)).await.is_err(){return;}
                            watermark=seq;
                        }
                    }
                }
            }
            let at=if session.brand=="claude"{claude_tail.as_ref().map(|tail|tail.through_line())}else{codex_tail.as_ref().map(|tail|tail.through_line())};if let Some(at)=at{let _=state.database().remember_followed(session.id.clone(),at as i64).await;}
        }
        received = updates.recv() => match received {
            Ok(event) => {
                let seq = event.fields.get("seq").and_then(serde_json::Value::as_i64).unwrap_or_default();
                if seq <= watermark { continue; }
                // A replay import is committed and published as one batch. If
                // this receiver falls behind that burst, replace its bounded
                // newest page instead of streaming thousands of stale rows or
                // silently accepting a hole in the durable sequence.
                if seq > watermark.saturating_add(1) {
                    let Some(sent) = recover_chat_snapshot(&state,&session_id,&tx).await else { return; };
                    watermark=sent;
                    continue;
                }
                let Ok(data) = serde_json::to_string(&event) else {
                    continue;
                };
                if tx
                    .send(Tagged::scoped("chat", &session_id, data))
                    .await
                    .is_err()
                {
                    return;
                }
                watermark=seq;
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let Some(sent) = recover_chat_snapshot(&state,&session_id,&tx).await else { return; };
                watermark=sent;
            },
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }}
    }
}

/// One connection carrying every feed this window needs.
pub async fn live(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Extension(native): Extension<workbench::WorkbenchState>,
    Extension(bootstrap): Extension<BootstrapBus>,
    Query(params): Query<LiveParams>,
    upgrade: Option<WebSocketUpgrade>,
) -> Response {
    let (tx, rx) = mpsc::channel::<Tagged>(100);

    for board in boards(&params.board) {
        let tx = tx.clone();
        let dolt_manager = dolt_manager.clone();
        let db = db.clone();
        tokio::spawn(async move {
            super::watch::watch_board(PathBuf::from(board), tx, Some("board"), dolt_manager, db)
                .await;
        });
    }

    if asked(&params.workbench) {
        tokio::spawn(relay_native_watch(native.clone(), tx.clone()));
    }

    if asked(&params.bootstrap) {
        let mut updates = bootstrap.0.subscribe();
        let bootstrap_tx = tx.clone();
        tokio::spawn(async move {
            loop {
                match updates.recv().await {
                    Ok(value) => {
                        if bootstrap_tx
                            .send(Tagged::new(Some("bootstrap"), value.to_string()))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    if let Some(chat) = params.chat.filter(|c| !c.is_empty()) {
        tokio::spawn(relay_native_chat(
            native.clone(),
            chat,
            params.since.unwrap_or(0) as i64,
            tx.clone(),
        ));
    }

    // The last sender is dropped here; a window watching nothing at all gets an
    // open connection that says nothing, rather than an error it cannot act on.
    drop(tx);

    match upgrade {
        Some(upgrade) => upgrade.on_upgrade(move |socket| carry(socket, rx)),
        // Nothing in the app asks this way any more. It is kept because a
        // stream is what a person with curl, and this file's own tests, can
        // read — and because the feeds behind it are the same either way.
        None => Sse::new(ReceiverStream::new(rx).map(|said| Ok::<_, Infallible>(said.as_event())))
            .keep_alive(
                axum::response::sse::KeepAlive::new()
                    .interval(Duration::from_secs(30))
                    .text("ping"),
            )
            .into_response(),
    }
}

/// How often the socket is pinged while nothing is happening.
///
/// A window can sit on a quiet board for hours. This is what tells the two
/// ends apart from a connection that has silently died, and it is what the
/// browser's own drop handler waits for.
const PING_EVERY: Duration = Duration::from_secs(30);

/// Carries every fanned-in feed onto one WebSocket until either end stops.
///
/// The reason this is a socket and not an event stream: a browser rations
/// connections to one address — six, across every window it has — and an event
/// stream holds one of those six for as long as it is open. A WebSocket is not
/// counted against that ration at all, so a reader can have as many windows of
/// this app open as he likes and an ordinary read still goes out at once
/// (bw-zkh4.10).
async fn carry(socket: WebSocket, mut rx: mpsc::Receiver<Tagged>) {
    let (mut writing, mut reading) = socket.split();
    let mut feeds_open = true;
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // the first tick is now, and there is nothing to say yet

    loop {
        tokio::select! {
            said = rx.recv(), if feeds_open => match said {
                Some(said) => {
                    if writing.send(Message::Text(said.as_text())).await.is_err() {
                        return;
                    }
                }
                // Every feed has stopped. The socket stays up rather than
                // dropping: the browser reads a close as a fault and opens
                // another, and there would be nothing different about it.
                None => feeds_open = false,
            },
            // Nothing on this app is sent up the wire; this is here to hear
            // the window go away, which is the ordinary end of the connection.
            heard = reading.next() => match heard {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                _ => {}
            },
            _ = ping.tick() => {
                if writing.send(Message::Ping(Vec::new())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// The projects to watch, as the browser joined them.
///
/// Every one of them, never only the first: a window drawing two boards that
/// silently watched one would show a card list that stopped following its file,
/// which is the fault this whole route exists to end.
fn boards(asked: &Option<String>) -> Vec<String> {
    asked
        .as_deref()
        .unwrap_or("")
        .split('\n')
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn native_live_splits_each_requested_board_without_empty_entries() {
        assert_eq!(
            boards(&Some("/one\n\n /two ".into())),
            vec!["/one".to_string(), "/two".to_string()]
        );
    }

    #[test]
    fn native_live_tags_chat_frames_with_their_immutable_session() {
        let tagged = Tagged::scoped("chat", "session-1", "{\"seq\":2}".into());
        assert_eq!(tagged.tag.as_deref(), Some("chat"));
        assert_eq!(tagged.scope.as_deref(), Some("session-1"));
        assert!(tagged.as_text().contains("session-1"));
    }

    #[test]
    fn outside_change_names_only_the_claude_project_from_record_metadata() {
        let home = tempfile::tempdir().expect("a temporary provider home");
        let claude = home.path().join("claude/projects/-work-project");
        let codex = home.path().join("codex/sessions");
        fs::create_dir_all(&claude).expect("a Claude project folder");
        fs::create_dir_all(&codex).expect("a Codex sessions folder");
        let record = claude.join("session.jsonl");
        fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n")
            .expect("a Claude record");

        let paths = HashSet::from([record]);
        assert_eq!(
            outside_folders(
                &paths,
                &home.path().join("claude/projects"),
                &codex,
                &mut HashMap::new(),
            ),
            Some(vec!["/work/project".to_string()])
        );
    }

    #[test]
    fn outside_change_reads_codex_payload_cwd_without_scanning_the_transcript() {
        let home = tempfile::tempdir().expect("a temporary provider home");
        let claude = home.path().join("claude/projects");
        let codex = home.path().join("codex/sessions");
        let record = codex.join("2026/09/01/rollout.jsonl");
        fs::create_dir_all(record.parent().unwrap()).expect("a Codex date folder");
        fs::write(
            &record,
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/work/codex\"}}\n",
        )
        .expect("a Codex record");

        let paths = HashSet::from([record]);
        assert_eq!(
            outside_folders(&paths, &claude, &codex, &mut HashMap::new()),
            Some(vec!["/work/codex".to_string()])
        );
    }

    #[test]
    fn outside_change_falls_back_to_all_projects_when_any_record_is_unplaceable() {
        let home = tempfile::tempdir().expect("a temporary provider home");
        let claude = home.path().join("claude/projects");
        let codex = home.path().join("codex/sessions");
        let record = codex.join("unfinished.jsonl");
        fs::create_dir_all(&codex).expect("a Codex sessions folder");
        fs::write(&record, "{\"type\":\"session_meta\"}\n").expect("an unfinished record");

        assert_eq!(
            outside_folders(
                &HashSet::from([record]),
                &claude,
                &codex,
                &mut HashMap::new(),
            ),
            None
        );
    }
}
