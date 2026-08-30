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
use std::{convert::Infallible, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

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
async fn relay_native_watch(state: workbench::WorkbenchState, tx: mpsc::Sender<Tagged>) {
    let mut updates = state.database().subscribe_all();
    let sessions = match workbench::session_summaries(state.database(), None).await {
        Ok(sessions) => sessions,
        Err(_) => return,
    };
    for frame in [
        serde_json::json!({"kind":"snapshot","sessions":sessions}),
        serde_json::json!({"kind":"running","holds":[]}),
    ] {
        if tx
            .send(Tagged::new(Some("workbench"), frame.to_string()))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        match updates.recv().await {
            Ok(update) => {
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
    if since == 0 {
        let Ok(snapshot) = workbench::snapshot(state.database(), &session_id).await else {
            return;
        };
        if tx
            .send(Tagged::scoped(
                "chat.snapshot",
                &session_id,
                snapshot.to_string(),
            ))
            .await
            .is_err()
        {
            return;
        }
    } else if let Ok(events) = state
        .database()
        .events_since(session_id.clone(), since)
        .await
    {
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
    }
    loop {
        match updates.recv().await {
            Ok(event) => {
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
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// One connection carrying every feed this window needs.
pub async fn live(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Extension(native): Extension<workbench::WorkbenchState>,
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

    if let Some(chat) = params.chat.filter(|c| !c.is_empty()) {
        tokio::spawn(relay_native_chat(
            native.clone(), chat, params.since.unwrap_or(0) as i64, tx.clone(),
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
}
