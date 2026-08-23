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
    extract::Query,
    response::sse::{Event, Sse},
    Extension,
};
use futures::stream::Stream;
use serde::Deserialize;
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

/// One stream carrying every feed this window needs.
pub async fn live(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<LiveParams>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(100);

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
            ..Feed::new(&base, "chat")
        };
        tokio::spawn(relay(feed, tx.clone()));
    }

    // The last sender is dropped here; a window watching nothing at all gets an
    // open stream that says nothing, rather than an error it cannot act on.
    drop(tx);

    Sse::new(ReceiverStream::new(rx)).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("ping"),
    )
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
}

impl Feed {
    fn new(base: &str, tag: &'static str) -> Self {
        Feed {
            base: base.to_string(),
            tag,
            since: None,
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
async fn relay(mut feed: Feed, tx: mpsc::Sender<Result<Event, Infallible>>) {
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
                    match answer.chunk().await {
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
                                let out = Event::default().event(tag).data(frame.data);
                                if tx.send(Ok(out)).await.is_err() {
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
        tokio::time::sleep(wait).await;
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

    /// Stands in for the chat helper: both of its streams, each written the way
    /// the real one writes it (workbench/src/server.ts).
    async fn a_helper() -> String {
        let app = Router::new()
            .route(
                "/watch",
                get(|| async {
                    (
                        [("content-type", "text/event-stream")],
                        "data: {\"kind\":\"snapshot\",\"sessions\":[]}\n\n",
                    )
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

    /// The whole point of the route: one request, more than one feed, and the
    /// browser able to tell which is which.
    #[tokio::test]
    async fn one_request_carries_every_feed_a_window_watches_each_tagged() {
        std::env::set_var("BEADS_WORKBENCH_URL", a_helper().await);
        workbench::spawn_sidecar(None);

        // A board of our own to watch, so the board feed has something real to
        // report itself connected to.
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

        let asked = format!(
            "http://{at}/api/live?board={}&chat=abc&since=0&workbench=1",
            urlencoded(&project.path().to_string_lossy())
        );
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
        std::env::remove_var("BEADS_WORKBENCH_URL");
    }
}
