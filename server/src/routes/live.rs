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
//! | `update`         | how far the running update has got                 |
//! | `git`            | this repository's git directory moved              |
//! | `fs`             | files moved in the folder a file tree draws        |
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
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::{
    convert::Infallible,
    path::PathBuf,
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
    /// Whether anything on screen is watching an update run — the About
    /// section, or the notice that offers the update.
    pub update: Option<String>,
    /// The repository the Git panel is open on, if it is open. One at a time:
    /// the panel is drawn beside one chat, and a chat has one project
    /// (src/workbench/git-view.tsx, bw-8nwh.2).
    pub git: Option<String>,
    /// The folder an open file tree is drawn from, absolute. One at a time,
    /// for the same reason the repository is: the Files tab shows one project
    /// or one of its worktrees (src/workbench/live-wire.ts, bw-g3o3.3).
    pub fs: Option<String>,
}

/// Whether a query flag was written as a yes.
fn asked(flag: &Option<String>) -> bool {
    matches!(
        flag.as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Feed the combined browser connection from the in-process database. This is
/// the one app-wide feed; nothing else streams every chat.
async fn send_native_watch_snapshot(
    state: &workbench::WorkbenchState,
    tx: &mpsc::Sender<Tagged>,
) -> Option<serde_json::Value> {
    let sessions = workbench::session_summaries(state.database(), None)
        .await
        .ok()?;
    let holds = serde_json::to_value(state.provider_holds().await).ok()?;
    for frame in [
        serde_json::json!({"kind":"snapshot","sessions":sessions}),
        serde_json::json!({"kind":"running","holds":holds}),
    ] {
        tx.send(Tagged::new(Some("workbench"), frame.to_string()))
            .await
            .ok()?;
    }
    Some(holds)
}

async fn relay_native_watch(state: workbench::WorkbenchState, tx: mpsc::Sender<Tagged>) {
    let mut updates = state.database().subscribe_all();
    let (mut polls, _poll_lease) = state.watch_poll_subscription().await;
    let Some(_) = send_native_watch_snapshot(&state, &tx).await else {
        return;
    };
    loop {
        tokio::select! {
        polled = polls.recv() => match polled {
            Ok(frame) => if tx.send(Tagged::new(Some("workbench"), frame.to_string())).await.is_err() { return; },
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                if send_native_watch_snapshot(&state, &tx).await.is_none() { return; }
            },
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        },
        received = updates.recv() => match received {
            Ok(update) => {
                if update.batch_from.is_some() {
                    if send_native_watch_snapshot(&state, &tx).await.is_none() { return; }
                    continue;
                }
                if update.event.kind == crate::workbench::protocol::EventKind::SessionStarted {
                    if let Ok(Some(session)) = state.database().get_session(update.session_id.clone()).await {
                        let beads = state.database().beads_for_session(update.session_id.clone()).await.unwrap_or_default();
                        let name = crate::workbench::chat_name::name_session(&session);
                        let frame = serde_json::json!({"kind":"opened","session":{
                            "name":name,
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
            // A complete-history import can publish tens of thousands of
            // events in one actor turn. If the bounded all-chat receiver falls
            // behind that burst, replace its summaries and live ownership in
            // one shot; silently continuing can strand a newly discovered
            // external chat or its final rich state until the page reloads.
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                if send_native_watch_snapshot(&state, &tx).await.is_none() { return; }
            },
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }}
    }
}

async fn send_chat_snapshot(
    state: &workbench::WorkbenchState,
    session_id: &str,
    tx: &mpsc::Sender<Tagged>,
) -> Result<i64, String> {
    state.reconcile_status(session_id).await?;
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
                tracing::warn!(session_id, error, "bounded chat snapshot failed; retrying");
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

/// Follow one provider record into the durable event stream. Browser windows
/// never receive from this task directly: they all consume the same committed
/// per-session broadcast, so one normalization cannot be delivered twice.
///
/// Started by a browser opening the chat, and by the watch poller for a chat
/// somebody else is working in right now whether or not anybody is looking at
/// it (workbench.rs, `keep_following_the_worked_in`).
pub(crate) async fn follow_native_record(
    state: workbench::WorkbenchState,
    session_id: String,
    control: Arc<workbench::ChatFollowControl>,
) {
    let followed = state
        .database()
        .get_session(session_id.clone())
        .await
        .ok()
        .flatten()
        .and_then(|session| {
            let record = session.external_id.as_deref().and_then(|id| {
                if session.brand == "claude" {
                    let config = crate::workbench::profiles::chat_dir(
                        "claude",
                        session.profile.as_deref(),
                        state.claude_config_directory(),
                    );
                    crate::workbench::claude::history::find_record(&config, id)
                } else if session.brand == "codex" {
                    state.codex_record(id, session.profile.as_deref())
                } else {
                    None
                }
            })?;
            Some((session, record))
        });
    let Some((session, record)) = followed else {
        state.finish_chat_follow(&session_id, &control).await;
        return;
    };
    // A driver that died with the last run of the server left its stretch
    // ahead of the cursor; it is handed back before this reads from there.
    state.hand_back_if_orphaned(&session.id).await;
    // With no cursor, a follower starts at the record's end, except beside a
    // driver: there it starts where the driver began, so a note already in
    // the driver's stretch is not skipped.
    let followed_to = match state.database().followed_to(session_id.clone()).await {
        Ok(Some(at)) => Some(at),
        _ => state
            .database()
            .driven_from(session_id.clone())
            .await
            .ok()
            .flatten(),
    };
    let mut claude_tail = (session.brand == "claude").then(|| {
        let mut tail = crate::workbench::external::LineTail::new(&record);
        if let Some(at) = followed_to {
            tail.seek(at.max(0) as u64)
        } else {
            tail.to_end()
        }
        tail
    });
    let mut claude_lines: VecDeque<String> = VecDeque::new();
    let mut claude_helpers = (session.brand == "claude")
        .then(|| crate::workbench::claude::history::HelperFollower::after_import(&record));
    let mut codex_tail = (session.brand == "codex").then(|| {
        let mut tail = crate::workbench::external::LineTail::new(&record);
        if let Some(at) = followed_to {
            tail.seek(at.max(0) as u64)
        } else {
            tail.to_end()
        }
        tail
    });
    let mut codex_lines: VecDeque<String> = VecDeque::new();
    let mut record_tick = tokio::time::interval(Duration::from_millis(250));
    // Where the record was last remembered as read to. A tick that read nothing
    // new has nothing to remember, and writing the same number four times a
    // second is a database write per chat per quarter second (bw-fbzd.5).
    let mut remembered: Option<i64> = None;
    let mut was_supervised = false;

    loop {
        tokio::select! {
        _ = control.stopped() => break,
        _ = record_tick.tick() => {
            // A native driver is the sole live source for the conversation
            // while Atelier owns the provider, so beside one this follower
            // reads the record only for what the wire never carries — for
            // Claude, the ending of a shell or a watch the chat left running
            // (workbench/handback.rs) — and keeps its place, so nothing the
            // driver wrote is read again as new once it goes (bw-6n29).
            //
            // The registry counts a driver as running until its process is
            // closed and its stretch handed back. The first tick after that
            // reads the same way once more: this follower may have read part
            // of the stretch before the driver went, and the rest is still
            // the driver's.
            let supervised = state.is_supervising(&session.id).await;
            let beside_a_driver = supervised || was_supervised;
            was_supervised = supervised;
            if beside_a_driver {
                let tail = if session.brand == "claude" { claude_tail.as_mut() } else { codex_tail.as_mut() };
                let Some(tail) = tail else { continue; };
                if !crate::workbench::handback::keeps_notes(&session.brand) {
                    tail.to_end();
                } else {
                    let Ok(growth) = tail.grown() else { continue; };
                    if growth.rewritten { claude_lines.clear(); codex_lines.clear(); continue; }
                    let rows: Vec<serde_json::Value> = growth.lines.iter()
                        .filter(|line| crate::workbench::handback::may_hold_a_note(&session.brand, line))
                        .filter_map(|line| serde_json::from_str(line).ok())
                        .collect();
                    for note in crate::workbench::handback::record_notes(&session.brand, &rows) {
                        if let Some(event) = crate::workbench::handback::record_event(&session.brand, &session.id, session.external_id.as_deref(), note) {
                            let _ = state.database().append(event).await;
                        }
                    }
                }
                let at = tail.through_line() as i64;
                if Some(at) != remembered {
                    let _ = state.database().remember_followed(session.id.clone(), at).await;
                    remembered = Some(at);
                }
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
                        claude_helpers=Some(crate::workbench::claude::history::HelperFollower::after_reset(&record));
                    } else if let Some(tail)=claude_tail.as_mut(){tail.to_end()}
                    Vec::new()
                } else {
                    // A record that did not grow replays to what was already
                    // appended, so only new lines are worth a replay.
                    let grew=growth.as_ref().is_some_and(|growth|!growth.lines.is_empty());
                    if let Some(growth)=growth{for line in growth.lines{claude_lines.push_back(line)}}
                    let fresh=if grew{crate::workbench::claude::history::replay_lines(claude_lines.make_contiguous())}else{Vec::new()};
                    while claude_lines.len()>256{claude_lines.pop_front();}
                    fresh
                }
            } else {
                let growth=codex_tail.as_mut().and_then(|tail|tail.grown().ok());
                if growth.as_ref().is_some_and(|growth|growth.rewritten){
                    if !state.database().was_driven_here(session.id.clone()).await.unwrap_or(true){
                        let reset:Result<crate::workbench::protocol::Event,_>=serde_json::from_value(serde_json::json!({"type":"transcript.reset","sessionId":session.id,"seq":0,"at":chrono::Utc::now().to_rfc3339()}));
                        if let Ok(reset)=reset{let _=state.database().append(reset).await;}
                        if let Some(tail)=codex_tail.as_mut(){tail.seek(0)}
                        codex_lines.clear();
                    }else if let Some(tail)=codex_tail.as_mut(){tail.to_end()}
                    Vec::new()
                }else{
                    let grew=growth.as_ref().is_some_and(|growth|!growth.lines.is_empty());
                    if let Some(growth)=growth{for line in growth.lines{codex_lines.push_back(line)}}
                    let fresh=if grew{crate::workbench::codex::normalize::replay_rollout(&codex_lines.make_contiguous().join("\n"))}else{Vec::new()};
                    while codex_lines.len()>512{codex_lines.pop_front();}
                    fresh
                }
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
                let event_id=crate::workbench::protocol::provider_record_event_id(&session.brand,&value);
                let Some(object) = value.as_object_mut() else { continue; };
                object.insert("providerEvent".into(),serde_json::json!({"provider":session.brand,"threadId":session.external_id,"eventId":event_id,"delivery":"live"}));
                object.insert("sessionId".into(), serde_json::json!(session.id));
                object.insert("seq".into(), serde_json::json!(0));
                object.entry("at").or_insert_with(|| serde_json::json!(chrono::Utc::now().to_rfc3339()));
                if let Ok(event) = serde_json::from_value(value) {
                    let _ = state.database().append(event).await;
                }
            }
            let at=if session.brand=="claude"{claude_tail.as_ref().map(|tail|tail.through_line())}else{codex_tail.as_ref().map(|tail|tail.through_line())};if let Some(at)=at.map(|at|at as i64).filter(|at|Some(*at)!=remembered){let _=state.database().remember_followed(session.id.clone(),at).await;remembered=Some(at);}
        }}
    }
    state.finish_chat_follow(&session_id, &control).await;
}

/// Feed one open chat into `/api/live` without a loopback HTTP hop.
async fn relay_native_chat(
    state: workbench::WorkbenchState,
    session_id: String,
    since: i64,
    mut updates: tokio::sync::broadcast::Receiver<crate::workbench::actor::SessionUpdate>,
    prepared_watermark: Option<i64>,
    tx: mpsc::Sender<Tagged>,
) {
    // The stored bounded page is the click's critical path. Send it before
    // reconciling provider files or healing stale state; those operations
    // append onto the subscribed live tail and must never hold first paint.
    let opening_watermark = if prepared_watermark.is_some() {
        prepared_watermark
    } else if since == 0 {
        let Some(sent) = recover_chat_snapshot(&state, &session_id, &tx).await else {
            return;
        };
        Some(sent)
    } else {
        None
    };
    // A copied URL and a sidebar click are the same cold read. This is
    // reconciled immediately after its opening page. Any healed state or
    // imported provider history arrives through `updates`; a resumed wire
    // already reconciled this chat and must not start another import.
    if since == 0 {
        state.looked_at(&session_id).await;
    }
    let (_follow_lease, start_follower) = state.chat_follow_subscription(&session_id).await;
    if let Some(control) = start_follower {
        let follow_state = state.clone();
        let followed_session = session_id.clone();
        tokio::spawn(async move {
            follow_native_record(follow_state, followed_session, control).await;
        });
    }
    let mut watermark;
    if let Some(sent) = opening_watermark {
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
        received = updates.recv() => match received {
            Ok(crate::workbench::actor::SessionUpdate::ReplayCommitted { through, .. }) => {
                if through <= watermark { continue; }
                let Some(sent) = recover_chat_snapshot(&state,&session_id,&tx).await else { return; };
                watermark=sent;
            }
            Ok(crate::workbench::actor::SessionUpdate::Event(event)) => {
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
    Extension(updating): Extension<crate::routes::update_run::UpdateWatch>,
    Query(params): Query<LiveParams>,
    upgrade: Option<WebSocketUpgrade>,
) -> Response {
    let (tx, rx) = mpsc::channel::<Tagged>(100);

    // Reserve and construct the selected chat before starting lower-priority
    // board and sidebar snapshots. All of those reads share one SQLite actor;
    // racing them let a fresh sidebar projection sit in front of the click.
    let prepared_chat = if let Some(chat) = params.chat.filter(|c| !c.is_empty()) {
        let since = params.since.unwrap_or(0) as i64;
        let updates = native.database().subscribe_session(&chat);
        let watermark = if since == 0 {
            let started = std::time::Instant::now();
            match send_chat_snapshot(&native, &chat, &tx).await {
                Ok(watermark) => {
                    tracing::info!(session_id = %chat, elapsed_ms = started.elapsed().as_millis(), "priority chat snapshot ready");
                    Some(watermark)
                }
                Err(error) => {
                    tracing::warn!(session_id = %chat, error, "priority chat snapshot failed; relay will retry");
                    None
                }
            }
        } else {
            None
        };
        Some((chat, since, updates, watermark))
    } else {
        None
    };

    for board in boards(&params.board) {
        let tx = tx.clone();
        let dolt_manager = dolt_manager.clone();
        let db = db.clone();
        tokio::spawn(async move {
            super::watch::watch_board(PathBuf::from(board), tx, Some("board"), dolt_manager, db)
                .await;
        });
    }

    // The Git panel, while it is on screen: its repository's git directory
    // watched, so a commit or a push made in a terminal reaches the counts the
    // panel is drawing without anybody pressing refresh (bw-8nwh.2).
    if let Some(repo) = params.git.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        let repo = PathBuf::from(repo);
        let tx = tx.clone();
        tokio::spawn(async move {
            super::git_watch::watch_repo(repo, tx, Some("git")).await;
        });
    }

    // The Files tab, while it is on screen: the folder it is drawing watched,
    // so a file written from a terminal or by an agent appears in the tree
    // without anybody reopening the folder (bw-g3o3.3).
    if let Some(root) = params.fs.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        let root = PathBuf::from(root);
        let tx = tx.clone();
        tokio::spawn(async move {
            super::fs_watch::watch_folder(root, tx, Some("fs")).await;
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

    // An update carries its own state, not just its changes: a screen that
    // opens halfway through one has to draw where it has got to, and the next
    // chunk might be a second away. The state as it stands goes first, then
    // every change after it (routes/update_run.rs).
    if asked(&params.update) {
        let mut changes = updating.watch();
        let opening = updating.now().await;
        let update_tx = tx.clone();
        tokio::spawn(async move {
            let say = |run: &crate::routes::update_run::UpdateRun| {
                serde_json::to_string(run).unwrap_or_default()
            };
            if update_tx
                .send(Tagged::new(Some("update"), say(&opening)))
                .await
                .is_err()
            {
                return;
            }
            loop {
                match changes.recv().await {
                    Ok(run) => {
                        if update_tx
                            .send(Tagged::new(Some("update"), say(&run)))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    // A screen too slow to keep up is caught up to the newest
                    // state rather than dropped: a progress bar only ever
                    // wants the latest figure, never the ones it missed.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    if let Some((chat, since, updates, watermark)) = prepared_chat {
        tokio::spawn(relay_native_chat(
            native.clone(),
            chat,
            since,
            updates,
            watermark,
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
    use crate::workbench::{
        actor::ChatDb,
        registry::{RegistryPaths, UnavailableFactory, WorkbenchRegistry},
        store::Session,
    };
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::io::Write;

    fn workbench_fixture() -> (tempfile::TempDir, workbench::WorkbenchState) {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let paths = RegistryPaths {
            home: directory.path().to_path_buf(),
            claude_config: directory.path().join("claude"),
            codex_home: directory.path().join("codex"),
            profiles: directory.path().join("profiles"),
            media: directory.path().join("media"),
        };
        let registry = WorkbenchRegistry::new(database, paths, Arc::new(UnavailableFactory));
        (directory, workbench::WorkbenchState::new(registry))
    }

    fn a_saved_chat() -> Session {
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
            profile: None,
            title: Some("The chat that must remain visible".into()),
            state: "dormant".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00.000Z".into(),
            last_active_at: "2026-08-30T00:01:00.000Z".into(),
            last_spoke_at: Some("2026-08-30T00:00:30.000Z".into()),
            begun_by: None,
            named_by_owner: false,
        }
    }

    /// The app-wide feed opens on every chat as it stands and who holds what,
    /// before any event, so a window that connects mid-day needs no replay.
    #[tokio::test]
    async fn the_app_wide_feed_opens_on_every_chat_and_who_holds_it() {
        let (_directory, state) = workbench_fixture();
        state.database().create_session(a_saved_chat()).await.unwrap();
        let (tx, mut rx) = mpsc::channel(8);
        tokio::spawn(relay_native_watch(state, tx));

        let snapshot = rx.recv().await.expect("a snapshot").data;
        assert!(snapshot.contains("\"kind\":\"snapshot\""), "{snapshot}");
        assert!(snapshot.contains("chat-1"), "{snapshot}");
        assert!(snapshot.contains("\"beads\":[]"), "{snapshot}");
        assert!(snapshot.contains("\"activity\":\"\""), "{snapshot}");
        let running = rx.recv().await.expect("who holds what").data;
        assert!(running.contains("\"kind\":\"running\""), "{running}");
    }

    /// A burst the feed cannot keep up with — an imported history — is
    /// answered with the whole list again, never by skipping what it missed.
    #[tokio::test]
    async fn the_app_wide_feed_restates_every_chat_after_a_burst_it_fell_behind() {
        let (_directory, state) = workbench_fixture();
        state.database().create_session(a_saved_chat()).await.unwrap();
        // Two frames of room and nobody reading, while more events land than
        // the database broadcast holds: the feed's receiver must fall behind.
        let (tx, mut rx) = mpsc::channel(2);
        tokio::spawn(relay_native_watch(state.clone(), tx));
        // Its first snapshot says it is listening; the burst lands after.
        let first = rx.recv().await.expect("a first snapshot").data;
        assert!(first.contains("\"kind\":\"snapshot\""), "{first}");
        for index in 0..1_200 {
            let event: crate::workbench::protocol::Event = serde_json::from_value(serde_json::json!({
                "type":"notice", "sessionId":"chat-1", "seq":0,
                "at":"2026-08-30T00:01:00.000Z", "text":format!("burst {index}")
            }))
            .unwrap();
            state.database().append(event).await.unwrap();
        }

        let restated = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(frame) = rx.recv().await {
                if frame.data.contains("\"kind\":\"snapshot\"") {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(restated, "the feed fell behind and never restated its chats");
    }

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
            crate::workbench::external::changed_record_folders(
                &paths,
                std::slice::from_ref(&home.path().join("claude/projects")),
                std::slice::from_ref(&codex),
                &mut HashMap::new(),
            ),
            Some(vec!["/work/project".to_string()])
        );
    }

    /// A record written under a second account is still a record.
    ///
    /// The watch used to be handed one `projects/` and one `sessions/`, so a
    /// chat worked on in a terminal under the work account moved nothing on
    /// screen: its path belonged to no root the placer knew, and it was
    /// silently skipped (bw-5ihw.8).
    #[test]
    fn outside_change_is_placed_under_whichever_account_wrote_it() {
        let home = tempfile::tempdir().expect("a temporary provider home");
        let mine = home.path().join("claude/projects");
        let work = home.path().join("profiles/claude/work/projects");
        let codex = home.path().join("codex/sessions");
        let folder = work.join("-work-elsewhere");
        fs::create_dir_all(&folder).expect("the work account's project folder");
        let record = folder.join("session.jsonl");
        fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/elsewhere\"}\n")
            .expect("a Claude record");

        let paths = HashSet::from([record]);
        assert_eq!(
            crate::workbench::external::changed_record_folders(
                &paths,
                std::slice::from_ref(&mine),
                std::slice::from_ref(&codex),
                &mut HashMap::new(),
            ),
            None,
            "the work account's record belonged to no root the placer knew"
        );
        assert_eq!(
            crate::workbench::external::changed_record_folders(
                &paths,
                &[mine, work],
                std::slice::from_ref(&codex),
                &mut HashMap::new(),
            ),
            Some(vec!["/work/elsewhere".to_string()])
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
            crate::workbench::external::changed_record_folders(&paths, std::slice::from_ref(&claude), std::slice::from_ref(&codex), &mut HashMap::new()),
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
            crate::workbench::external::changed_record_folders(
                &HashSet::from([record]),
                std::slice::from_ref(&claude),
                std::slice::from_ref(&codex),
                &mut HashMap::new(),
            ),
            None
        );
    }

    #[tokio::test]
    async fn a_driven_chats_shell_is_closed_by_the_note_in_its_record() {
        let (directory, state) = workbench_fixture();
        let external = "22222222-2222-4222-8222-222222222222";
        let project = directory.path().join("claude/projects/project");
        fs::create_dir_all(&project).unwrap();
        let record = project.join(format!("{external}.jsonl"));
        fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n").unwrap();
        let at = "2026-09-06T04:45:00Z";
        state
            .database()
            .create_session(Session {
                id: "chat-1".into(),
                brand: "claude".into(),
                external_id: Some(external.into()),
                project_id: "project-1".into(),
                project_path: "/work/project".into(),
                cwd: "/work/project".into(),
                model: Some("sonnet".into()),
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                profile: None,
                title: Some("Driven".into()),
                state: "streaming".into(),
                origin: "app".into(),
                created_at: at.into(),
                last_active_at: at.into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        state.pretend_driver("chat-1").await;
        // The driver already said the shell was handed off, off the tool's
        // own answer over ACP; only its ending is missing from the wire.
        state
            .database()
            .append(
                serde_json::from_value(serde_json::json!({
                    "type":"agent.started","sessionId":"chat-1","seq":0,"at":at,
                    "agentId":"b3ovdktbe","toolCallId":"call-bg","kind":"command",
                    "what":"cargo test","agentType":"shell","model":null
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        let control = start.unwrap();
        let follow_state = state.clone();
        tokio::spawn(async move {
            follow_native_record(follow_state, "chat-1".into(), control).await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let note = |id: &str, summary: &str| {
            serde_json::json!({
                "type":"queue-operation","operation":"enqueue","timestamp":"2026-09-06T04:46:29Z",
                "content":format!("<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n<summary>{summary}</summary>\n</task-notification>")
            })
        };
        let mut file = fs::OpenOptions::new().append(true).open(&record).unwrap();
        writeln!(file, "{}", note("b3ovdktbe", "Background command \"Full cargo test\" completed (exit code 0)")).unwrap();
        writeln!(file, "{}", note("a94ba500064fc0b02", "Agent \"SSH prompt\" finished")).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"assistant","uuid":"answer-1","timestamp":at,
                "message":{"id":"turn-1","role":"assistant","content":"words the driver already carried"}
            })
        )
        .unwrap();
        file.flush().unwrap();

        let closed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let events = state.database().events_since("chat-1".into(), 0).await.unwrap();
                if events.iter().any(|event| {
                    event.kind == crate::workbench::protocol::EventKind::AgentFinished
                        && event.fields.get("agentId").and_then(serde_json::Value::as_str) == Some("b3ovdktbe")
                }) {
                    break events;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("beside a driver, the record's note about a finished shell was never read");
        let shell = closed
            .iter()
            .find(|event| {
                event.kind == crate::workbench::protocol::EventKind::AgentFinished
                    && event.fields.get("agentId").and_then(serde_json::Value::as_str) == Some("b3ovdktbe")
            })
            .unwrap();
        assert_eq!(shell.fields.get("state").and_then(serde_json::Value::as_str), Some("done"));
        assert_eq!(shell.fields.get("at").and_then(serde_json::Value::as_str), Some("2026-09-06T04:46:29Z"));

        tokio::time::sleep(Duration::from_millis(350)).await;
        let events = state.database().events_since("chat-1".into(), 0).await.unwrap();
        assert!(
            !events.iter().any(|event| event.fields.get("agentId").and_then(serde_json::Value::as_str) == Some("a94ba500064fc0b02")),
            "a helper's ending is the driver's to report, with its own last words"
        );
        assert!(
            !events.iter().any(|event| event.fields.get("text").and_then(serde_json::Value::as_str) == Some("words the driver already carried")),
            "the conversation itself stays the driver's alone"
        );
        assert!(state.has_chat_follower("chat-1").await, "the follower stays on beside the driver");
    }

    /// A driven chat of one saved record, already read in: the attach import
    /// leaves the cursor at the record's end.
    async fn driven_chat(
        directory: &tempfile::TempDir,
        state: &workbench::WorkbenchState,
        brand: &str,
        external: &str,
    ) -> std::path::PathBuf {
        let record = new_chat(directory, state, brand, external).await;
        state.database().mark_imported("chat-1".into()).await.unwrap();
        let size = fs::metadata(&record).unwrap().len() as i64;
        state.database().remember_followed("chat-1".into(), size).await.unwrap();
        record
    }

    /// A chat of one saved record that was never read in.
    async fn new_chat(
        directory: &tempfile::TempDir,
        state: &workbench::WorkbenchState,
        brand: &str,
        external: &str,
    ) -> std::path::PathBuf {
        let record = if brand == "claude" {
            let project = directory.path().join("claude/projects/project");
            fs::create_dir_all(&project).unwrap();
            let record = project.join(format!("{external}.jsonl"));
            fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n").unwrap();
            record
        } else {
            let day = directory.path().join("codex/sessions/2026/09/24");
            fs::create_dir_all(&day).unwrap();
            let record = day.join(format!("rollout-2026-09-24T17-14-00-{external}.jsonl"));
            fs::write(
                &record,
                "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/work/project\"}}\n",
            )
            .unwrap();
            record
        };
        let at = "2026-09-24T17:14:00Z";
        state
            .database()
            .create_session(Session {
                id: "chat-1".into(),
                brand: brand.into(),
                external_id: Some(external.into()),
                project_id: "project-1".into(),
                project_path: "/work/project".into(),
                cwd: "/work/project".into(),
                model: Some("sonnet".into()),
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                profile: None,
                title: Some("Driven".into()),
                state: "streaming".into(),
                origin: "app".into(),
                created_at: at.into(),
                last_active_at: at.into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        record
    }

    fn write_line(record: &std::path::Path, line: serde_json::Value) {
        let mut file = fs::OpenOptions::new().append(true).open(record).unwrap();
        writeln!(file, "{line}").unwrap();
        file.flush().unwrap();
    }

    fn claude_answer(uuid: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "type":"assistant","uuid":uuid,"timestamp":"2026-09-24T17:14:41Z",
            "message":{"id":format!("msg_{uuid}"),"role":"assistant","content":text}
        })
    }

    fn codex_prompt(text: &str) -> serde_json::Value {
        serde_json::json!({
            "timestamp":"2026-09-24T17:14:41.000Z","type":"event_msg",
            "payload":{"type":"user_message","message":text,"images":[],"local_images":[]}
        })
    }

    fn shell_finished(id: &str) -> serde_json::Value {
        serde_json::json!({
            "type":"queue-operation","operation":"enqueue","timestamp":"2026-09-24T17:15:02Z",
            "content":format!("<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n<summary>Background command \"cargo test\" completed (exit code 0)</summary>\n</task-notification>")
        })
    }

    async fn says(state: &workbench::WorkbenchState, text: &str) -> bool {
        state
            .database()
            .events_since("chat-1".into(), 0)
            .await
            .unwrap()
            .iter()
            .any(|event| event.fields.get("text").and_then(serde_json::Value::as_str) == Some(text))
    }

    async fn event_count(state: &workbench::WorkbenchState) -> usize {
        state.database().events_since("chat-1".into(), 0).await.unwrap().len()
    }

    /// The driver says a shell was handed off, off the tool's answer over ACP.
    async fn shell_started(state: &workbench::WorkbenchState, id: &str) {
        let started = serde_json::json!({
            "type":"agent.started","sessionId":"chat-1","seq":0,"at":"2026-09-24T17:14:30Z",
            "agentId":id,"toolCallId":format!("call-{id}"),"kind":"command",
            "what":"cargo test","agentType":"shell","model":null
        });
        state.database().append(serde_json::from_value(started).unwrap()).await.unwrap();
    }

    async fn shell_ended(state: &workbench::WorkbenchState, id: &str) -> bool {
        state.database().events_since("chat-1".into(), 0).await.unwrap().iter().any(|event| {
            event.kind == crate::workbench::protocol::EventKind::AgentFinished
                && event.fields.get("agentId").and_then(serde_json::Value::as_str) == Some(id)
        })
    }

    fn start_following(state: &workbench::WorkbenchState, control: Arc<workbench::ChatFollowControl>) {
        let state = state.clone();
        tokio::spawn(async move { follow_native_record(state, "chat-1".into(), control).await });
    }

    async fn at_end(state: &workbench::WorkbenchState, record: &std::path::Path) -> bool {
        let size = fs::metadata(record).unwrap().len() as i64;
        state.database().followed_to("chat-1".into()).await.unwrap() == Some(size)
    }

    /// Stopped while somebody watched: the driver's closing lines land after
    /// the registry has let the driver go, and are still the driver's.
    #[tokio::test]
    async fn a_watched_chats_driver_stopping_leaves_nothing_to_read_again() {
        let (directory, state) = workbench_fixture();
        let record = driven_chat(&directory, &state, "claude", "33333333-3333-4333-8333-333333333333").await;
        state.pretend_driver("chat-1").await;
        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(300)).await;
        write_line(&record, claude_answer("driven-1", "an answer the driver carried"));
        tokio::time::sleep(Duration::from_millis(300)).await;
        write_line(&record, claude_answer("driven-2", "the end of the driven turn"));
        state.let_driver_go("chat-1").await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            !says(&state, "an answer the driver carried").await
                && !says(&state, "the end of the driven turn").await,
            "the driven turn was appended again at the end of the chat"
        );
        assert!(at_end(&state, &record).await);
        assert_eq!(state.database().driven_from("chat-1".into()).await.unwrap(), None);

        // What the record gains afterwards is somebody else's again.
        write_line(&record, claude_answer("outside-1", "a terminal took the chat over"));
        let heard = tokio::time::timeout(Duration::from_secs(2), async {
            while !says(&state, "a terminal took the chat over").await {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(heard.is_ok(), "work done after the driver went was never followed");
    }

    /// Stopped while nobody watched: no follower ran beside the driver, so
    /// the stretch is handed back when it goes, shells and all.
    #[tokio::test]
    async fn an_unwatched_chats_driver_stopping_hands_its_stretch_back() {
        let (directory, state) = workbench_fixture();
        let record = driven_chat(&directory, &state, "claude", "44444444-4444-4444-8444-444444444444").await;
        state.pretend_driver("chat-1").await;
        assert!(state.database().driven_from("chat-1".into()).await.unwrap().is_some());
        write_line(&record, claude_answer("driven-1", "an answer the driver carried"));
        shell_started(&state, "bshell01").await;
        write_line(&record, shell_finished("bshell01"));
        write_line(&record, claude_answer("driven-2", "and another"));
        assert!(!state.has_chat_follower("chat-1").await, "nothing reads beside an unwatched driver");

        state.let_driver_go("chat-1").await;
        assert!(at_end(&state, &record).await, "the cursor stayed where the driver was attached");
        assert!(shell_ended(&state, "bshell01").await, "a shell that ended unwatched still shows as running");
        assert_eq!(state.database().driven_from("chat-1".into()).await.unwrap(), None);

        let before = event_count(&state).await;
        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            !says(&state, "an answer the driver carried").await && !says(&state, "and another").await,
            "the driven turn was appended again at the end of the chat"
        );
        assert_eq!(event_count(&state).await, before);
    }

    /// A new chat has no record when its driver starts and no cursor into it
    /// after; the whole record is the driver's stretch.
    #[tokio::test]
    async fn a_new_chats_shell_that_ended_unwatched_shows_as_finished() {
        let (directory, state) = workbench_fixture();
        let record = new_chat(&directory, &state, "claude", "88888888-8888-4888-8888-888888888888").await;
        fs::remove_file(&record).unwrap();
        assert_eq!(state.database().followed_to("chat-1".into()).await.unwrap(), None);
        state.pretend_driver("chat-1").await;
        assert_eq!(state.database().driven_from("chat-1".into()).await.unwrap(), Some(0));

        fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n").unwrap();
        shell_started(&state, "bshell03").await;
        write_line(&record, shell_finished("bshell03"));
        state.let_driver_go("chat-1").await;
        assert!(shell_ended(&state, "bshell03").await, "a new chat's shell still shows as running");
        assert_eq!(state.database().driven_from("chat-1".into()).await.unwrap(), None);
    }

    /// A new chat opened while its driver runs still ends the shells that
    /// finished before anybody looked.
    #[tokio::test]
    async fn a_new_chat_opened_mid_run_still_ends_its_earlier_shells() {
        let (directory, state) = workbench_fixture();
        let record = new_chat(&directory, &state, "claude", "99999999-9999-4999-8999-999999999999").await;
        fs::remove_file(&record).unwrap();
        // Read in, but with no cursor yet: the one a follower keeps is trusted.
        state.database().mark_imported("chat-1".into()).await.unwrap();
        state.pretend_driver("chat-1").await;
        fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n").unwrap();
        shell_started(&state, "bshell04").await;
        write_line(&record, shell_finished("bshell04"));
        write_line(&record, claude_answer("driven-1", "an answer the driver carried"));

        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(400)).await;
        state.let_driver_go("chat-1").await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(shell_ended(&state, "bshell04").await, "a shell that ended before the chat was opened still shows as running");
        assert!(!says(&state, "an answer the driver carried").await);
    }

    /// A driver that died with the server leaves its mark; the next run hands
    /// the stretch back before anything reads it again.
    #[tokio::test]
    async fn a_driver_lost_with_the_server_is_handed_back_on_the_next_start() {
        let (directory, state) = workbench_fixture();
        let record = driven_chat(&directory, &state, "claude", "55555555-5555-4555-8555-555555555555").await;
        state.pretend_driver("chat-1").await;
        write_line(&record, claude_answer("driven-1", "an answer the driver carried"));
        shell_started(&state, "bshell02").await;
        write_line(&record, shell_finished("bshell02"));
        state.lose_driver("chat-1").await;
        assert!(state.database().driven_from("chat-1".into()).await.unwrap().is_some(), "the mark did not survive");

        state.registry().hand_back_the_orphaned().await;
        assert!(at_end(&state, &record).await);
        assert!(shell_ended(&state, "bshell02").await);
        assert_eq!(state.database().driven_from("chat-1".into()).await.unwrap(), None);
        let before = event_count(&state).await;
        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!says(&state, "an answer the driver carried").await);
        assert_eq!(event_count(&state).await, before);
    }

    /// A tool call the driver never saw return ends with it: a server stopped
    /// or lost mid-call leaves nothing that could report it (bw-tdxl).
    #[tokio::test]
    async fn a_tool_left_running_when_its_driver_goes_shows_as_ended() {
        let (directory, state) = workbench_fixture();
        driven_chat(&directory, &state, "codex", "abababab-abab-4bab-8bab-abababababab").await;
        let tool = |kind: &str, call: &str| {
            serde_json::from_value(serde_json::json!({
                "type":kind,"sessionId":"chat-1","seq":0,"at":"2026-09-24T17:14:30Z",
                "toolCallId":call,"name":"exec","title":"sleep 25","ok":true,"output":"done"
            }))
            .unwrap()
        };
        let endings = |call: &'static str| {
            let state = state.clone();
            async move {
                state.database().events_since("chat-1".into(), 0).await.unwrap().into_iter()
                    .filter(|event| event.kind == crate::workbench::protocol::EventKind::ToolCompleted
                        && event.fields.get("toolCallId").and_then(serde_json::Value::as_str) == Some(call))
                    .map(|event| event.fields.get("ok").and_then(serde_json::Value::as_bool))
                    .collect::<Vec<_>>()
            }
        };

        // Lost with the server, then handed back on the next start.
        state.pretend_driver("chat-1").await;
        state.database().append(tool("tool.started", "call-returned")).await.unwrap();
        state.database().append(tool("tool.completed", "call-returned")).await.unwrap();
        state.database().append(tool("tool.started", "call-cut-off")).await.unwrap();
        state.database().append(tool("tool.started", "call-cut-off")).await.unwrap();
        state.lose_driver("chat-1").await;
        assert!(endings("call-cut-off").await.is_empty());
        state.registry().hand_back_the_orphaned().await;
        assert_eq!(endings("call-cut-off").await, vec![Some(false)], "a cut-off call still shows as running");
        assert_eq!(endings("call-returned").await, vec![Some(true)], "a call that returned was ended again");

        // Let go, as a graceful stop does; ended calls are not ended twice.
        state.pretend_driver("chat-1").await;
        state.database().append(tool("tool.started", "call-stopped")).await.unwrap();
        state.let_driver_go("chat-1").await;
        assert_eq!(endings("call-stopped").await, vec![Some(false)]);
        assert_eq!(endings("call-cut-off").await, vec![Some(false)]);
    }

    /// The follower itself hands back a lost driver's stretch when it is the
    /// first to reach the chat after a restart.
    #[tokio::test]
    async fn a_follower_reaching_a_lost_drivers_chat_first_hands_it_back() {
        let (directory, state) = workbench_fixture();
        let record = driven_chat(&directory, &state, "claude", "66666666-6666-4666-8666-666666666666").await;
        state.pretend_driver("chat-1").await;
        write_line(&record, claude_answer("driven-1", "an answer the driver carried"));
        state.lose_driver("chat-1").await;

        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!says(&state, "an answer the driver carried").await);
        assert!(at_end(&state, &record).await);
        assert_eq!(state.database().driven_from("chat-1".into()).await.unwrap(), None);
    }

    /// The same rule for Codex, watched or not.
    #[tokio::test]
    async fn a_codex_chats_driver_stopping_leaves_nothing_to_read_again() {
        let (directory, state) = workbench_fixture();
        let record = driven_chat(&directory, &state, "codex", "77777777-7777-4777-8777-777777777777").await;
        state.pretend_driver("chat-1").await;
        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(300)).await;
        let before = event_count(&state).await;
        write_line(&record, codex_prompt("a prompt the driver carried"));
        tokio::time::sleep(Duration::from_millis(300)).await;
        write_line(&record, codex_prompt("the end of the driven turn"));
        state.let_driver_go("chat-1").await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(event_count(&state).await, before, "the driven turn was appended again");
        assert!(at_end(&state, &record).await);
        assert!(state.has_chat_follower("chat-1").await, "the follower gave up beside the driver");

        // A Codex chat nobody watched is handed back the same way.
        drop(_lease);
        tokio::time::sleep(Duration::from_millis(400)).await;
        state.pretend_driver("chat-1").await;
        write_line(&record, codex_prompt("unwatched driven prompt"));
        state.let_driver_go("chat-1").await;
        assert!(at_end(&state, &record).await);
        let (_lease, start) = state.chat_follow_subscription("chat-1").await;
        start_following(&state, start.unwrap());
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(event_count(&state).await, before, "the unwatched turn was appended again");

        write_line(&record, codex_prompt("somebody else's prompt"));
        let heard = tokio::time::timeout(Duration::from_secs(2), async {
            while event_count(&state).await == before {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(heard.is_ok(), "work done after the driver went was never followed");
    }

    #[tokio::test]
    async fn two_viewers_share_one_content_correct_external_follower() {
        let (directory, state) = workbench_fixture();
        let external = "11111111-1111-4111-8111-111111111111";
        let project = directory.path().join("claude/projects/project");
        fs::create_dir_all(&project).unwrap();
        let record = project.join(format!("{external}.jsonl"));
        fs::write(&record, "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n").unwrap();
        let at = "2026-09-02T00:00:00Z";
        state
            .database()
            .create_session(Session {
                id: "chat-1".into(),
                brand: "claude".into(),
                external_id: Some(external.into()),
                project_id: "project-1".into(),
                project_path: "/work/project".into(),
                cwd: "/work/project".into(),
                model: Some("sonnet".into()),
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                profile: None,
                title: Some("External".into()),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: at.into(),
                last_active_at: at.into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        let mut updates = state.database().subscribe_session("chat-1");
        let (first, start) = state.chat_follow_subscription("chat-1").await;
        let (second, duplicate) = state.chat_follow_subscription("chat-1").await;
        assert!(duplicate.is_none());
        let control = start.unwrap();
        let follow_state = state.clone();
        tokio::spawn(async move {
            follow_native_record(follow_state, "chat-1".into(), control).await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let mut file = fs::OpenOptions::new().append(true).open(&record).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"user","uuid":"question-1","timestamp":at,
                "message":{"role":"user","content":"question"}
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type":"assistant","uuid":"answer-1","parentUuid":"question-1","timestamp":at,
                "message":{"id":"turn-1","role":"assistant","content":"one shared answer"}
            })
        )
        .unwrap();
        file.flush().unwrap();

        let appeared = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let crate::workbench::actor::SessionUpdate::Event(event) = updates.recv().await.unwrap() else { continue; };
                if event.fields.get("text").and_then(serde_json::Value::as_str)
                    == Some("one shared answer")
                {
                    break;
                }
            }
        })
        .await;
        if appeared.is_err() {
            let events = state.database().events_since("chat-1".into(), 0).await.unwrap();
            panic!("the shared follower did not publish the exact appended words: {events:?}");
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let events = state.database().events_since("chat-1".into(), 0).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.fields.get("text").and_then(serde_json::Value::as_str)
                        == Some("one shared answer")
                })
                .count(),
            1,
            "two viewers must not normalize the same provider line twice"
        );

        drop(first);
        assert!(state.has_chat_follower("chat-1").await);
        drop(second);
        tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                if !state.has_chat_follower("chat-1").await {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the last viewer stops and removes the follower");
    }
}
