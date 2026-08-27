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
use tracing::info;

use super::workbench;
use crate::db::Database;
use crate::dolt::DoltManager;

/// How long after a helper stream drops before it is opened again, and the
/// ceiling that wait climbs to.
///
/// The helper may not be running at all — the board half of the app works
/// without it — so this backs off rather than hammering a door nobody is
/// behind. It never stops trying: a helper that comes back is the ordinary
/// case, a rebuild or a restart, and the browser is holding this one stream
/// either way.
const AGAIN_MS: u64 = 2_000;
const AGAIN_CEILING_MS: u64 = 30_000;

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

/// One connection carrying every feed this window needs.
pub async fn live(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
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
        let tx = tx.clone();
        tokio::spawn(relay(Feed::new("/watch", "workbench"), tx));
    }

    if let Some(chat) = params.chat.filter(|c| !c.is_empty()) {
        let base = format!("/events?session={}", urlencoded(&chat));
        let feed = Feed {
            since: Some(params.since.unwrap_or(0)),
            scope: Some(chat),
            ..Feed::new(&base, "chat")
        };
        tokio::spawn(relay(feed, tx.clone()));
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

/// Percent-encodes what a query value may not carry literally.
fn urlencoded(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// One of the helper's streams, as this route reads it.
struct Feed {
    /// The helper's path, with everything but the resume point on it.
    base: String,
    /// What every event off it is tagged with on the way out.
    tag: &'static str,
    /// Where to resume from, for a feed that can be resumed. Moves as events
    /// arrive, so a helper that restarts does not replay what the browser has
    /// already drawn — this stream outlives the helper behind it.
    since: Option<u64>,
    /// The immutable conversation identity carried by every chat frame.
    scope: Option<String>,
}

impl Feed {
    fn new(base: &str, tag: &'static str) -> Self {
        Feed {
            base: base.to_string(),
            tag,
            since: None,
            scope: None,
        }
    }

    /// The path to ask for now, resume point included.
    fn path(&self) -> String {
        match self.since {
            Some(n) => format!(
                "{}{}since={n}",
                self.base,
                if self.base.contains('?') { "&" } else { "?" }
            ),
            None => self.base.clone(),
        }
    }
}

/// Carries one helper stream onto this window's one connection, and keeps
/// carrying it across the helper's own restarts.
async fn relay(mut feed: Feed, tx: mpsc::Sender<Tagged>) {
    let mut wait = Duration::from_millis(AGAIN_MS);
    loop {
        if tx.is_closed() {
            return;
        }
        match workbench::upstream(&feed.path()).await {
            Ok(mut answer) => {
                wait = Duration::from_millis(AGAIN_MS);
                let mut buffer: Vec<u8> = Vec::new();
                loop {
                    let heard = tokio::select! {
                        // The browser went away. Nothing else here would notice
                        // in time: a keep-alive is dropped before any send, and
                        // sending is the only thing that reads whether the other
                        // end is still there — so a window closed while its
                        // helper had nothing to say used to leave this task and
                        // its connection to the helper standing for ever, which
                        // is the same leak this route exists to end, moved one
                        // hop inwards (bw-zkh4.8).
                        _ = tx.closed() => return,
                        chunk = answer.chunk() => chunk,
                    };
                    match heard {
                        Ok(Some(bytes)) => {
                            buffer.extend_from_slice(&bytes);
                            for frame in frames(&mut buffer) {
                                if let Some(id) = frame.id {
                                    feed.since = Some(id);
                                }
                                let tag = match &frame.name {
                                    Some(name) => format!("{}.{name}", feed.tag),
                                    None => feed.tag.to_string(),
                                };
                                let tagged = match &feed.scope {
                                    Some(scope) => Tagged::scoped(&tag, scope, frame.data),
                                    None => Tagged::new(Some(&tag), frame.data),
                                };
                                if tx.send(tagged).await.is_err() {
                                    return;
                                }
                            }
                        }
                        // The helper closed the stream, or the read failed:
                        // either way this feed is opened again below.
                        Ok(None) | Err(_) => break,
                    }
                }
            }
            Err(e) => info!("live: {} is not answering ({e})", feed.tag),
        }
        // Waiting out a helper that is down, and up to half a minute of it. A
        // browser that closes in the meantime is not made to wait for the end
        // of a wait it has no interest in (bw-zkh4.8).
        tokio::select! {
            _ = tx.closed() => return,
            _ = tokio::time::sleep(wait) => {}
        }
        wait = (wait * 2).min(Duration::from_millis(AGAIN_CEILING_MS));
    }
}

/// One frame off an event stream.
#[derive(Debug, PartialEq)]
struct Frame {
    /// What the sender named it, when it named it at all.
    name: Option<String>,
    /// The number a reconnection resumes from, when the sender gives one.
    id: Option<u64>,
    data: String,
}

/// Where `needle` starts in `hay`.
fn at(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Takes every complete frame out of `buffer`, leaving a half-arrived tail
/// where it is.
///
/// Bytes rather than text, because a chunk boundary falls wherever the network
/// puts it — including the middle of a character. Only whole frames are
/// decoded, and a frame is whole by definition.
fn frames(buffer: &mut Vec<u8>) -> Vec<Frame> {
    let mut out = Vec::new();
    loop {
        let plain = at(buffer, b"\n\n").map(|i| (i, i + 2));
        let crlf = at(buffer, b"\r\n\r\n").map(|i| (i, i + 4));
        let boundary = match (plain, crlf) {
            (Some(p), Some(c)) if c.0 < p.0 => Some(c),
            (Some(p), _) => Some(p),
            (None, c) => c,
        };
        let Some((end, past)) = boundary else { break };

        let raw = String::from_utf8_lossy(&buffer[..end]).into_owned();
        buffer.drain(..past);

        let mut name = None;
        let mut id = None;
        let mut data = String::new();
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                name = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("id:") {
                id = rest.trim().parse().ok();
            } else if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            }
        }
        // A keep-alive is a comment line and carries nothing; it kept the
        // connection warm, which was its whole job.
        if !data.is_empty() {
            out.push(Frame { name, id, data });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_frame_is_read_once_it_is_whole() {
        let mut buffer = b"data: {\"a\":1}\n\ndata: {\"b\"".to_vec();
        let read = frames(&mut buffer);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].data, "{\"a\":1}");
        // The half-arrived one is still waiting, not lost and not guessed at.
        assert_eq!(buffer, b"data: {\"b\"".to_vec());
    }

    #[test]
    fn a_named_frame_keeps_its_name_and_its_number() {
        let mut buffer = b"id: 42\nevent: snapshot\ndata: {}\n\n".to_vec();
        let read = frames(&mut buffer);
        assert_eq!(
            read,
            vec![Frame {
                name: Some("snapshot".to_string()),
                id: Some(42),
                data: "{}".to_string(),
            }]
        );
    }

    #[test]
    fn a_keep_alive_carries_nothing_and_is_dropped() {
        let mut buffer = b": keep-alive\n\n".to_vec();
        assert!(frames(&mut buffer).is_empty());
    }

    #[test]
    fn a_frame_written_the_other_way_reads_the_same() {
        let mut buffer = b"event: ping\r\ndata: hi\r\n\r\n".to_vec();
        let read = frames(&mut buffer);
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].data, "hi");
        assert_eq!(read[0].name.as_deref(), Some("ping"));
    }

    #[test]
    fn every_board_the_window_watches_is_watched() {
        assert_eq!(boards(&None), Vec::<String>::new());
        assert_eq!(boards(&Some(String::new())), Vec::<String>::new());
        assert_eq!(boards(&Some("/one".into())), vec!["/one".to_string()]);
        assert_eq!(
            boards(&Some("/one\n/two\n".into())),
            vec!["/one".to_string(), "/two".to_string()]
        );
    }

    #[test]
    fn a_feed_asks_again_from_where_it_left_off() {
        let mut feed = Feed::new("/events?session=abc", "chat");
        feed.since = Some(0);
        assert_eq!(feed.path(), "/events?session=abc&since=0");
        feed.since = Some(17);
        assert_eq!(feed.path(), "/events?session=abc&since=17");
        assert_eq!(Feed::new("/watch", "workbench").path(), "/watch");
    }

    /// Counts the helper's ends of relayed streams as they are let go of.
    ///
    /// Which is all the leak can be seen by from outside: the relay dropping
    /// its side is what closes this, and nothing else closes it.
    struct LettingGoIsNoticed(Arc<AtomicUsize>);

    impl Drop for LettingGoIsNoticed {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Stands in for the chat helper: both of its streams, each written the way
    /// the real one writes it (workbench/src/server.ts).
    async fn a_helper(let_go: Arc<AtomicUsize>) -> String {
        let app = Router::new()
            .route(
                "/watch",
                get(move || {
                    let noticed = LettingGoIsNoticed(let_go.clone());
                    async move {
                        // One real frame and then nothing but keep-alives: what
                        // a helper sends whenever nobody is typing, and the
                        // state a browser going away used to go unnoticed in.
                        let said =
                            futures::stream::unfold((0u32, noticed), |(n, noticed)| async move {
                                if n > 0 {
                                    tokio::time::sleep(Duration::from_millis(20)).await;
                                }
                                let text = if n == 0 {
                                    "data: {\"kind\":\"snapshot\",\"sessions\":[]}\n\n".to_string()
                                } else {
                                    ": keep-alive\n\n".to_string()
                                };
                                Some((Ok::<_, std::io::Error>(text), (n + 1, noticed)))
                            });
                        (
                            [("content-type", "text/event-stream")],
                            axum::body::Body::from_stream(said),
                        )
                    }
                }),
            )
            .route(
                "/events",
                get(|| async {
                    (
                        [("content-type", "text/event-stream")],
                        "id: 3\nevent: snapshot\ndata: {\"lastSeq\":3}\n\n",
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{at}")
    }

    /// The helper this route reads is named by a process-wide global, so two
    /// cases each standing up their own would take that name off one another
    /// halfway through. Every case here holds this for as long as it runs.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A server of our own, with a board of its own to watch, a helper of its
    /// own behind it, and the count of that helper's connections let go of.
    async fn a_server() -> (
        String,
        tempfile::TempDir,
        Arc<AtomicUsize>,
        tokio::sync::MutexGuard<'static, ()>,
    ) {
        let alone = ONE_AT_A_TIME.lock().await;
        let let_go = Arc::new(AtomicUsize::new(0));
        std::env::set_var("BEADS_WORKBENCH_URL", a_helper(let_go.clone()).await);
        workbench::spawn_sidecar(None);

        let home = directories::UserDirs::new().unwrap().home_dir().to_path_buf();
        let project = tempfile::TempDir::new_in(&home).unwrap();
        std::fs::create_dir_all(project.path().join(".beads")).unwrap();

        let app = Router::new()
            .route("/api/live", get(live))
            .layer(Extension(Arc::new(Database::new_in_memory().unwrap())))
            .layer(Extension(Arc::new(DoltManager::new())));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (at.to_string(), project, let_go, alone)
    }

    /// What a window asks for: every feed at once, on one connection.
    fn asking_for_everything(project: &tempfile::TempDir) -> String {
        format!(
            "/api/live?board={}&chat=abc&since=0&workbench=1",
            urlencoded(&project.path().to_string_lossy())
        )
    }

    /// The whole point of the route, and the way the app itself asks for it:
    /// one connection, every feed, and the browser able to tell them apart.
    ///
    /// A socket rather than an event stream is what lets a reader keep as many
    /// windows open as he likes — a browser rations event streams against the
    /// six connections it allows one address, and does not ration sockets
    /// (bw-zkh4.10).
    #[tokio::test]
    async fn one_socket_carries_every_feed_a_window_watches_each_naming_itself() {
        use futures::StreamExt as _;
        use tokio_tungstenite::tungstenite::Message as Said;

        let (at, project, _let_go, _alone) = a_server().await;
        let asked = format!("ws://{at}{}", asking_for_everything(&project));
        let (mut socket, _) = tokio_tungstenite::connect_async(&asked).await.unwrap();

        let mut tags: Vec<String> = Vec::new();
        let all_three = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(Ok(said)) = socket.next().await {
                if let Said::Text(text) = said {
                    let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                    // Every frame names its feed and carries what that feed
                    // said untouched, which is the whole contract with
                    // src/workbench/live-wire.ts.
                    assert!(frame["data"].is_string(), "a frame carried no data: {text}");
                    let tag = frame["tag"].as_str().unwrap_or_default();
                    if tag == "chat" || tag == "chat.snapshot" {
                        assert_eq!(
                            frame["scope"].as_str(),
                            Some("abc"),
                            "a chat frame did not carry its immutable owner: {text}",
                        );
                    }
                    tags.push(tag.to_string());
                }
                if ["board", "workbench", "chat.snapshot"]
                    .iter()
                    .all(|want| tags.iter().any(|got| got == want))
                {
                    return true;
                }
            }
            false
        })
        .await;

        assert!(
            all_three.unwrap_or(false),
            "one socket should carry all three feeds, each naming itself; it said: {tags:?}"
        );
    }

    /// The same feeds, asked for the old way.
    ///
    /// Nothing in the app asks like this any more. It is kept because a person
    /// with curl can read it, and because it is the same fanning-in behind
    /// both — so this case failing while the one above passes means the two
    /// ways out have drifted apart.
    #[tokio::test]
    async fn the_same_feeds_are_there_for_a_reader_with_curl() {
        let (at, project, _let_go, _alone) = a_server().await;
        let asked = format!("http://{at}{}", asking_for_everything(&project));
        let mut answer = reqwest::get(&asked).await.unwrap();
        assert!(answer.status().is_success());

        let mut said = String::new();
        let heard = tokio::time::timeout(Duration::from_secs(10), async {
            while let Ok(Some(bytes)) = answer.chunk().await {
                said.push_str(&String::from_utf8_lossy(&bytes));
                if said.contains("event: board")
                    && said.contains("event: workbench")
                    && said.contains("event: chat.snapshot")
                {
                    return true;
                }
            }
            false
        })
        .await;

        assert!(
            heard.unwrap_or(false),
            "one stream should carry all three feeds, tagged; it said:\n{said}"
        );
    }

    /// A window that goes away takes the server's own connections with it.
    ///
    /// The fault this holds shut: the browser's end of a stream costs a slot
    /// out of six, and this route exists to spend one instead of three. But the
    /// server then holds a connection of its own to the helper for every window
    /// — and it only ever noticed a window had gone by failing to hand it
    /// something. A helper with nothing to say sends keep-alives, which carry
    /// nothing and are dropped before that hand-off, so a window closed during
    /// a quiet spell left the relay and its connection to the helper standing
    /// for ever: the same leak, one hop further in, and growing with every
    /// window ever opened (bw-zkh4.8).
    #[tokio::test]
    async fn a_window_going_away_lets_go_of_the_helper_it_was_reading() {
        use futures::StreamExt as _;
        use tokio_tungstenite::tungstenite::Message as Said;

        let (at, _project, let_go, _alone) = a_server().await;
        let asked = format!("ws://{at}/api/live?workbench=1");
        let (mut socket, _) = tokio_tungstenite::connect_async(&asked).await.unwrap();

        // Wait until the helper's feed is really being carried, so what is let
        // go of below is an open connection rather than one never opened.
        let carrying = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(Ok(said)) = socket.next().await {
                if let Said::Text(text) = said {
                    if text.contains("\"workbench\"") {
                        return true;
                    }
                }
            }
            false
        })
        .await;
        assert!(
            carrying.unwrap_or(false),
            "the helper's feed never reached the window"
        );
        assert_eq!(
            let_go.load(Ordering::SeqCst),
            0,
            "the helper was let go of while the window was still reading it"
        );

        // The window closes — abruptly, the way a shut browser closes it, with
        // no goodbye and the helper mid keep-alive.
        drop(socket);

        let noticed = tokio::time::timeout(Duration::from_secs(10), async {
            while let_go.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(
            noticed.is_ok(),
            "the window went away and the server kept its own connection to the helper open"
        );
    }
}
