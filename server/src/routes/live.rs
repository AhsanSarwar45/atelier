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
}

/// Whether a query flag was written as a yes.
fn asked(flag: &Option<String>) -> bool {
    matches!(
        flag.as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}

/// Feed the combined browser connection from the in-process database. This is
/// the native equivalent of relaying the helper's `/watch` SSE stream.
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
    let Some((session, record)) = followed else {
        state.finish_chat_follow(&session_id, &control).await;
        return;
    };
    let followed_to = state
        .database()
        .followed_to(session_id.clone())
        .await
        .ok()
        .flatten();
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

    loop {
        tokio::select! {
        _ = control.stopped() => break,
        _ = record_tick.tick() => {
            // A native driver is the sole live source while Atelier owns the
            // provider. Advance the durable byte cursor once and retire this
            // outside follower instead of polling beside the driver.
            if state.has_driver(&session.id).await {
                if let Some(tail) = claude_tail.as_mut() { tail.to_end(); }
                if let Some(tail) = codex_tail.as_mut() { tail.to_end(); }
                let at=if session.brand=="claude"{claude_tail.as_ref().map(|tail|tail.through_line())}else{codex_tail.as_ref().map(|tail|tail.through_line())};
                if let Some(at)=at{let _=state.database().remember_followed(session.id.clone(),at as i64).await;}
                break;
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
                    if let Some(growth)=growth{for line in growth.lines{claude_lines.push_back(line)}}
                    let fresh=crate::workbench::claude::history::replay_lines(claude_lines.make_contiguous());
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
                    if let Some(growth)=growth{for line in growth.lines{codex_lines.push_back(line)}}
                    let fresh=crate::workbench::codex::normalize::replay_rollout(&codex_lines.make_contiguous().join("\n"));
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
            let at=if session.brand=="claude"{claude_tail.as_ref().map(|tail|tail.through_line())}else{codex_tail.as_ref().map(|tail|tail.through_line())};if let Some(at)=at{let _=state.database().remember_followed(session.id.clone(),at as i64).await;}
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
            media: directory.path().join("media"),
        };
        let registry = WorkbenchRegistry::new(database, paths, Arc::new(UnavailableFactory));
        (directory, workbench::WorkbenchState::new(registry))
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
            crate::workbench::external::changed_record_folders(&paths, &claude, &codex, &mut HashMap::new()),
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
                &claude,
                &codex,
                &mut HashMap::new(),
            ),
            None
        );
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
                title: Some("External".into()),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: at.into(),
                last_active_at: at.into(),
                last_spoke_at: None,
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
