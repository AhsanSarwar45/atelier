//! The one socket a shell is watched and typed into through.
//!
//! A shell is opened, listed and closed over ordinary HTTP next door in
//! `routes.rs`, for the reason given there: a shell existing and a shell being
//! watched are different lifetimes. This is the second of those. It comes and
//! goes with a tab, a reload, a laptop lid, and the shell behind it notices
//! none of that.
//!
//! ## What is carried, and which way
//!
//! Downwards, a binary frame is output, and it is exactly what came off the
//! pseudo-terminal. Nothing here re-flows it, splits it on lines, or touches
//! its line endings. `pump.rs` gives the long version; the short one is that
//! colour, cursor position, character set and screen mode are all carried by
//! escape sequences that span runs of bytes, and a run cut anywhere inside one
//! is a screen the terminal draws wrongly and never recovers from, because
//! nothing later says what the missing half would have said. Where one frame
//! stops and the next begins says nothing at all, though: a browser hands the
//! bytes to its terminal in the order they arrived, and two frames there are
//! the same as one.
//!
//! Everything the viewer missed comes first, and it comes in as many frames as
//! it takes rather than in one. Sending a quarter of a megabyte as a single
//! frame would put the bound further down — the one that decides a viewer is
//! gone — around a whole handover instead of around a socket that has stopped
//! taking bytes, and then how much there is to replay decides who is treated as
//! gone. So the end of the replay is said rather than counted: one text frame,
//! `REPLAY_IS_OVER`, after the last of it, and always exactly one of those even
//! when nothing was missed and no frame came before it. A browser still learns
//! the boundary in one place and settles its scroll once rather than after
//! every frame, and it tells that frame from output by the frame's type alone,
//! without looking inside it.
//!
//! Upwards, binary is keystrokes and text is a control message. The split is
//! the protocol's, not ours. RFC 6455 requires a text frame to be valid UTF-8,
//! and keystrokes are not text: an arrow key is `\x1b[A`, an interrupt is
//! `\x03`, and a paste can carry any byte at all, including ones no decoder
//! will accept. Sent as text they would arrive mangled into replacement
//! characters, which is not a slow keystroke but a wrong one. So keystrokes
//! must be binary, which leaves text free for the handful of small messages
//! that are ours to shape and are already JSON. Nothing needs an envelope, a
//! length prefix, or a first byte reserved as a tag. Downwards the same split
//! is ours rather than the protocol's, and it is safe to have taken for the
//! reason the protocol took it: output is bytes and can never be sent as text,
//! so a text frame going down can only ever be something this file said.
//!
//! ## When a viewer stops reading
//!
//! `pump.rs` deliberately does not drop anything for a viewer that falls
//! behind, because a terminal that quietly loses a run of bytes is worse than
//! one that stops. It waits instead — which means a viewer that never reads
//! again would hold up the pump, and a held-up pump eventually blocks the
//! shell's own writes. A half-open socket, a phone that went into a tunnel, a
//! tab closed with no close frame: none of those may cost the other people
//! watching that shell, or the shell.
//!
//! So the waiting is bounded here rather than there. A send that has not moved
//! at all for `WEDGED_AFTER` is taken as a viewer that is gone, and the socket
//! is dropped. Dropping it drops the receiver, which fails the pump's pending
//! send immediately and lets every other viewer carry on.
//!
//! The bound is on one send, so what one send carries has to be small enough
//! that a viewer still moving finishes it — otherwise the bound is about the
//! size of the transfer and not about the viewer. The live half is already
//! bounded, by the gathering in `pump.rs`; the replay is bounded here, by being
//! handed over in pieces.
//!
//! The bill for that is worth saying out loud too. A viewer that takes one
//! piece and then stops, over and over, is given the window afresh each time,
//! so it can hold a shell up for `WEDGED_AFTER` a piece rather than
//! `WEDGED_AFTER` in all. It is bounded by how many pieces a replay comes in,
//! and it is what asking about progress costs when the only thing that can
//! actually be measured is whether a send finished.
//!
//! That the cut is cheap is what makes it the right answer. A viewer let go of
//! reconnects and is handed a replay, so the cost of being wrong about a slow
//! link is a reload, while the cost of being wrong the other way is everybody
//! else's terminal freezing. The bill is real and worth saying out loud: what
//! the reconnecting viewer gets back is the last quarter megabyte, so a shell
//! that printed a great deal during the stall has lost the middle of it for
//! that viewer. Nothing bounded can promise otherwise.

use crate::terminal::register::{Session, Shells};
use crate::terminal::shell::Shell;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Path as FromUrl};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::stream::SplitSink;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

/// How long one send may make no progress at all before its viewer is taken to
/// be gone.
///
/// Not a budget for the whole of a slow download. `SinkExt::send` will not say
/// how much of a send has moved, so the only way to ask about progress rather
/// than about the total is to keep what one send carries small enough that a
/// viewer moving at all gets to the end of it: a replay goes in pieces of
/// `MOST_IN_ONE_REPLAY_FRAME`, and a live message is whatever `pump.rs`
/// gathered, which is bounded there. Five seconds of a socket that will not
/// take a piece that size is already a long time to be holding up a shell.
const WEDGED_AFTER: Duration = Duration::from_secs(5);

/// How much of a replay one frame carries.
///
/// A quarter of a megabyte is what a viewer can have missed, and a send of that
/// size bounded by `WEDGED_AFTER` asks for fifty kilobytes a second before it
/// asks whether anything is moving, so everybody under that is cut however
/// steadily they are reading — and handed the same quarter megabyte when they
/// come back. In pieces this size the slowest link that finishes one inside the
/// bound is around six kilobytes a second, which is slower than a link could
/// hold a socket open over at all, and a whole replay is eight frames rather
/// than one. Smaller again would cost little and buy nothing: the point is to
/// be well under what a real link does, not to be as small as possible.
const MOST_IN_ONE_REPLAY_FRAME: usize = 32 * 1024;

/// What is said when the replay is over.
///
/// Text, because downwards a binary frame is output and nothing else, so a
/// browser tells this from a byte of terminal by the frame's type and never has
/// to look inside it or count what came before it. JSON with a `type` in it
/// because that is the shape the messages going the other way already have, and
/// because a second kind of message down here should cost neither end an
/// envelope nor a reserved first byte.
const REPLAY_IS_OVER: &str = "{\"type\":\"replayed\"}";

/// The end of the socket that bytes go out of.
type ToBrowser = SplitSink<WebSocket, Message>;

/// What a browser can ask this server to do besides type.
///
/// Anything unrecognised is ignored rather than refused. A browser one version
/// ahead of its server should lose the feature it is asking for, not the
/// terminal it is asking through.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Control {
    /// The window changed shape. Sizes are in characters, not pixels.
    Resize { cols: u16, rows: u16 },
}

/// Attaches a socket to one shell.
///
/// The shell is found before the upgrade rather than inside it, so that asking
/// for a shell that is not there is answered as an ordinary HTTP refusal that
/// anything can read. Refusing after the upgrade would mean a socket that opens
/// and then closes for reasons only a close code could carry, which is a worse
/// answer to the same question.
pub async fn watch(
    upgrade: WebSocketUpgrade,
    Extension(shells): Extension<Shells>,
    FromUrl(id): FromUrl<String>,
) -> Response {
    let Some(session) = Uuid::parse_str(&id).ok().and_then(|named| shells.get(named)) else {
        return (
            StatusCode::NOT_FOUND,
            "There is no shell here by that name.",
        )
            .into_response();
    };

    upgrade.on_upgrade(move |socket| carry(socket, session))
}

/// Everything the shell prints, out; everything the person does, in.
///
/// Both halves are one task on purpose. The socket is dropped when this
/// returns, and the receiver with it, so there is no way for the thing holding
/// a share of the pump to outlive the thing it was feeding.
async fn carry(socket: WebSocket, session: Arc<Session>) {
    let (mut to_browser, mut from_browser) = socket.split();

    // One call, and it has to be one call. What was missed and what is still to
    // come have to be decided at the same instant under the same lock, because
    // asking for the past and then subscribing to the future leaves a gap
    // between the two questions, and anything printed inside that gap is either
    // lost or shown twice.
    let (missed, mut live) = session.pump.attach();

    if !hand_over_the_replay(&mut to_browser, missed).await {
        return;
    }

    loop {
        tokio::select! {
            printed = live.recv() => {
                // The output ending is the shell ending. Nothing more will ever
                // come, so say goodbye properly below rather than hanging up and
                // leaving the browser to guess whether its network died.
                let Some(run) = printed else { break };
                if !hand_on(&mut to_browser, run.to_vec()).await {
                    // Cut, and on purpose without a parting close frame: the
                    // send that stalled may have left half a frame on the wire,
                    // and a close frame after it is the other half of nothing.
                    // Returning here is what lets the receiver go.
                    return;
                }
            }
            said = from_browser.next() => match said {
                Some(Ok(Message::Binary(keys))) => {
                    if to_the_shell(&session, move |shell| shell.type_into(&keys).is_ok()).await
                        != Some(true)
                    {
                        break;
                    }
                }
                Some(Ok(Message::Text(said))) => reshape(&session, &said).await,
                // A close frame, a broken socket and a stream that simply ended
                // are the same news: this viewer is gone.
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                // Ping and pong are answered under us and are not ours to read.
                Some(Ok(_)) => {}
            },
        }
    }

    let _ = tokio::time::timeout(WEDGED_AFTER, to_browser.send(Message::Close(None))).await;
}

/// Hands one run of output to the browser, or reports the viewer gone.
async fn hand_on(to_browser: &mut ToBrowser, run: Vec<u8>) -> bool {
    matches!(
        tokio::time::timeout(WEDGED_AFTER, to_browser.send(Message::Binary(run))).await,
        Ok(Ok(()))
    )
}

/// Hands over everything the viewer missed, and then says that it is over.
///
/// In pieces because `WEDGED_AFTER` bounds one send: a replay handed over whole
/// asks a viewer to take a quarter of a megabyte inside that window rather than
/// asking whether it is taking anything, which cuts people for being slow and
/// then hands the same quarter megabyte to them again when they reconnect. The
/// pieces are indistinguishable from the live half once they arrive — a browser
/// feeds them all to its terminal in order — so where the replay stops is said
/// with a frame of its own instead of being counted.
///
/// False the moment a piece or the marker stops moving, which is the same news
/// as any other send that stopped: this viewer is gone.
async fn hand_over_the_replay(to_browser: &mut ToBrowser, missed: Vec<u8>) -> bool {
    for piece in missed.chunks(MOST_IN_ONE_REPLAY_FRAME) {
        if !hand_on(to_browser, piece.to_vec()).await {
            return false;
        }
    }

    matches!(
        tokio::time::timeout(
            WEDGED_AFTER,
            to_browser.send(Message::Text(REPLAY_IS_OVER.to_owned())),
        )
        .await,
        Ok(Ok(()))
    )
}

/// Tells the shell the window changed shape.
async fn reshape(session: &Arc<Session>, said: &str) {
    let Ok(Control::Resize { cols, rows }) = serde_json::from_str::<Control>(said) else {
        return;
    };

    // A tab that is hidden measures nothing and says so, and a terminal no
    // characters wide makes every program that divides by its width wrong. One
    // by one is a shape; zero by zero is a missing answer wearing one.
    let (cols, rows) = (cols.max(1), rows.max(1));
    to_the_shell(session, move |shell| {
        let _ = shell.resize(cols, rows);
    })
    .await;
}

/// Does something to the shell, off the runtime.
///
/// Writing to a pseudo-terminal blocks until the program on the far end reads
/// its input, and a program that is not reading — anything ignoring its input
/// while a person pastes into it — can hold a write there for as long as it
/// likes. That is a blocking call and does not belong on a thread that other
/// tabs are sharing. Waiting for the shell's lock is the same call once
/// removed, since whoever holds it may be holding it for exactly that reason,
/// so reshaping goes the same way even though the ioctl itself returns at once.
///
/// `None` when the work could not be done at all, which is only ever a panic
/// under it, and is a reason to let the socket go rather than to carry on
/// pretending the keystrokes landed.
async fn to_the_shell<T: Send + 'static>(
    session: &Arc<Session>,
    doing: impl FnOnce(&mut Shell) -> T + Send + 'static,
) -> Option<T> {
    let session = Arc::clone(session);
    tokio::task::spawn_blocking(move || {
        let mut shell = session
            .shell
            .lock()
            .expect("the shell lock is never poisoned");
        doing(&mut shell)
    })
    .await
    .ok()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::pump::Message as Printed;
    use crate::terminal::routes::tests::{a_register, answered, open_one, OURS, THEIRS};
    use crate::terminal::routes::MOUNTED_AT;
    use axum::body::Body;
    use axum::http::Request;
    use axum::Router;
    use hyper_util::rt::TokioIo;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::sync::mpsc::Receiver;
    use tokio_tungstenite::tungstenite;
    use tokio_tungstenite::tungstenite::Message as Frame;
    use tower::ServiceExt;

    /// The browser's end of one socket.
    type Socket = tokio_tungstenite::WebSocketStream<DuplexStream>;

    /// How long a case waits for something it is expecting before it gives up.
    ///
    /// The giving up is an assertion, as it is in `pump.rs`: a socket that never
    /// says the thing it was going to say would otherwise hang the whole suite
    /// with nothing at all to show for it.
    const PATIENCE: Duration = Duration::from_secs(20);

    /// How long the shell must have said nothing for before it is taken to have
    /// finished saying it.
    ///
    /// A shell prints a prompt after a command as well as before it, and there
    /// is no marker at the end of a prompt to wait for, so what a shell has
    /// finished printing is what it has stopped printing.
    const QUIET_FOR: Duration = Duration::from_secs(1);

    /// How much of the browser's end of a connection will hold before the
    /// server's writes into it start waiting.
    ///
    /// A real socket has a buffer in the kernel at each end and this is the
    /// same thing at the same scale. Small enough that a viewer which stops
    /// reading is wedged within a few frames rather than after a megabyte,
    /// which is what one case needs and no other case can tell apart from a
    /// socket of any other size.
    const PIPE_HOLDS: usize = 16 * 1024;

    /// How much of a slow link's backlog moves at a time.
    ///
    /// Sixteen kilobytes every half second is thirty-two a second, which is a
    /// poor mobile link and is well under the fifty a quarter megabyte in one
    /// send would demand. The pace is the whole of what one case turns on, so
    /// it is worked out here rather than left to be inferred: a quarter of a
    /// megabyte at this rate takes eight seconds, which is longer than
    /// `WEDGED_AFTER` by enough that it could be nothing else, while each
    /// thirty-two kilobyte piece of it is a second's work and finishes with
    /// four to spare.
    const TRICKLE: usize = 16 * 1024;

    /// How often that much of it moves.
    const TRICKLE_EVERY: Duration = Duration::from_millis(500);

    /// Twenty thousand numbered lines, which is more than every queue between a
    /// shell and a browser could hold at once however generously they were
    /// sized. Sixty digits wide so a line is a line and not a wrapped one.
    ///
    /// The last line is printed in two pieces because a pty echoes what is
    /// typed at it, so a marker written whole into the command would be in the
    /// output twice over and a case waiting for it would be answered by the
    /// echo before the shell had run anything at all.
    const PRINT_A_LOT: &[u8] =
        b"awk 'BEGIN{for(i=0;i<20000;i++) printf \"%060d\\n\", i}'; printf 'THE%s\\n' END; exit\n";

    /// A hundred kilobytes at once and then thirty lines a twentieth of a
    /// second apart.
    ///
    /// Both halves are load-bearing. The burst is what a socket arriving
    /// afterwards is handed as a replay, and it is larger than the connection
    /// will hold, so handing it over is a write that has to wait for the
    /// browser rather than an instant. The slow lines are what the shell prints
    /// *during* that wait, which is the only thing that can fall down a seam:
    /// output the past has already been asked for and the future has not yet
    /// been subscribed to. Under the keep limit in total, so the replay is the
    /// untrimmed kind that can be compared byte for byte.
    const PRINT_A_LOT_THEN_SLOWLY: &[u8] =
        b"awk 'BEGIN{for(i=0;i<1600;i++) printf \"%060d\\n\", i}'; \
          i=0; while [ $i -lt 30 ]; do printf 'LINE%03d\\n' $i; \
          sleep 0.05; i=$((i+1)); done; printf 'THE%s\\n' END; exit\n";

    /// The browser's end of one whole HTTP connection to `app`, with no port
    /// under it.
    ///
    /// A handshake cannot be made by calling the router as a function, and this
    /// is why the tests carry a server at all: what hands a request its half of
    /// the connection is an extension hyper puts there when a real connection
    /// carried it, and a call that never had a connection has nothing to put.
    /// Axum answers such a request `426 Upgrade Required`, which is not the
    /// thing under test. So there is a real connection here, and it is a pipe
    /// rather than a socket so that a case binds nothing.
    fn one_connection(app: &Router) -> DuplexStream {
        let (browser, server) = tokio::io::duplex(PIPE_HOLDS);
        let app = app.clone();
        tokio::spawn(async move {
            let served = hyper::service::service_fn(move |asked: Request<hyper::body::Incoming>| {
                let app = app.clone();
                async move { app.oneshot(asked.map(Body::new)).await }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(server), served)
                .with_upgrades()
                .await;
        });
        browser
    }

    /// The browser's end of a connection that takes bytes steadily and slowly.
    ///
    /// A second pipe with a task in between, because the slowness has to be
    /// under the websocket rather than over it. A case that simply waited
    /// between reads would still drain whatever frame it asked for as fast as
    /// the pipe would give it, so a replay sent as one enormous frame would
    /// arrive at full speed and the case would prove nothing about the size of
    /// a frame. Here it is bytes that are slow, which is what is slow about a
    /// slow link.
    ///
    /// Only downwards. Nothing typed matters to the case this is for, and a
    /// link that was slow both ways would be two things at once for no reason.
    fn a_slow_connection(app: &Router) -> DuplexStream {
        let (mut from_server, mut to_server) = tokio::io::split(one_connection(app));
        let (browser, relayed) = tokio::io::duplex(PIPE_HOLDS);
        let (mut from_browser, mut to_browser) = tokio::io::split(relayed);

        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut from_browser, &mut to_server).await;
        });
        tokio::spawn(async move {
            let mut carried = vec![0u8; TRICKLE];
            loop {
                let taken = match from_server.read(&mut carried).await {
                    Ok(0) | Err(_) => break,
                    Ok(taken) => taken,
                };
                if to_browser.write_all(&carried[..taken]).await.is_err() {
                    break;
                }
                tokio::time::sleep(TRICKLE_EVERY).await;
            }
        });

        browser
    }

    /// Asks to watch one shell as a browser on `host` would, and gives back
    /// either the socket or the refusal that came instead of it.
    async fn watching(app: &Router, id: &str, host: &str) -> Result<Socket, StatusCode> {
        let asking = format!("ws://{host}{MOUNTED_AT}/{id}/stream");
        match tokio_tungstenite::client_async(asking, one_connection(app)).await {
            Ok((socket, _)) => Ok(socket),
            Err(tungstenite::Error::Http(refused)) => Err(refused.status()),
            Err(why) => panic!("the server should answer a handshake one way or the other: {why}"),
        }
    }

    /// A socket watching one shell, opened the way the app opens one.
    async fn watched(app: &Router, id: &str) -> Socket {
        match watching(app, id, OURS).await {
            Ok(socket) => socket,
            Err(refused) => panic!("watching a shell on this machine was refused {refused}"),
        }
    }

    /// A socket watching one shell over a link that only takes a trickle.
    async fn watched_slowly(app: &Router, id: &str) -> Socket {
        let asking = format!("ws://{OURS}{MOUNTED_AT}/{id}/stream");
        match tokio_tungstenite::client_async(asking, a_slow_connection(app)).await {
            Ok((socket, _)) => socket,
            Err(why) => panic!("watching a shell over a slow link was refused: {why}"),
        }
    }

    /// The one frame that must be there, which must be bytes.
    async fn one_frame(socket: &mut Socket) -> Vec<u8> {
        match tokio::time::timeout(PATIENCE, socket.next()).await {
            Ok(Some(Ok(Frame::Binary(run)))) => run,
            other => panic!("the socket should have carried a frame of bytes, and carried {other:?}"),
        }
    }

    /// The pieces the replay arrived in, read up to the frame that says it is
    /// over.
    ///
    /// Where the pieces fall is nobody's business, so most cases join these
    /// back together at once and ask about the bytes. What is worth reading
    /// here is what is not allowed: a socket that ends, or says goodbye, or
    /// says anything else at all before it has said the replay is over has
    /// dropped a viewer part-way through being shown what it missed, which is
    /// the one thing several of these cases exist to catch. It is said plainly
    /// here rather than left to confuse whichever case asked.
    async fn the_replay_in_pieces(socket: &mut Socket) -> Vec<Vec<u8>> {
        let mut pieces: Vec<Vec<u8>> = Vec::new();
        loop {
            match tokio::time::timeout(PATIENCE, socket.next()).await {
                Ok(Some(Ok(Frame::Binary(piece)))) => pieces.push(piece),
                Ok(Some(Ok(Frame::Text(said)))) => {
                    assert_eq!(
                        said, REPLAY_IS_OVER,
                        "the only thing a socket says downwards as text is that the replay is \
                         over, and it said {said:?}"
                    );
                    return pieces;
                }
                // Ping and pong are answered under the socket and are not output.
                Ok(Some(Ok(Frame::Ping(_) | Frame::Pong(_)))) => {}
                other => panic!(
                    "the socket should have carried the whole replay and then said it was \
                     over, and carried {other:?} after {} bytes of it",
                    pieces.concat().len()
                ),
            }
        }
    }

    /// Everything the viewer missed, put back together.
    async fn the_whole_replay(socket: &mut Socket) -> Vec<u8> {
        the_replay_in_pieces(socket).await.concat()
    }

    /// Every frame the socket carries until the whole of them satisfies
    /// `enough`, or the socket ends, or the case gives up waiting.
    async fn frames_until(socket: &mut Socket, enough: impl Fn(&str) -> bool) -> Vec<Vec<u8>> {
        let mut frames: Vec<Vec<u8>> = Vec::new();
        let mut joined = Vec::new();
        let giving_up = Instant::now() + PATIENCE;
        while !enough(&String::from_utf8_lossy(&joined)) {
            let left = giving_up.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, socket.next()).await {
                Ok(Some(Ok(Frame::Binary(run)))) => {
                    joined.extend_from_slice(&run);
                    frames.push(run);
                }
                // Ping, pong and the close frame are not output.
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_)) | None) => break,
                Err(_) => panic!(
                    "the socket never carried what this case was waiting for, and carried: {:?}",
                    String::from_utf8_lossy(&joined)
                ),
            }
        }
        frames
    }

    /// Every frame of output a socket carries to the end of it, and whether the
    /// server said goodbye before it went.
    ///
    /// The goodbye is the difference between the two ways a socket ends. A
    /// shell that ended is followed by a close frame; a viewer that was cut for
    /// not reading is not, because the send that stalled may have left half a
    /// frame on the wire and a close frame after it is the other half of
    /// nothing.
    async fn everything_carried(socket: &mut Socket) -> (Vec<Vec<u8>>, bool) {
        let mut frames = Vec::new();
        let mut goodbye = false;
        let giving_up = Instant::now() + PATIENCE;
        loop {
            let left = giving_up.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, socket.next()).await {
                Ok(Some(Ok(Frame::Binary(run)))) => frames.push(run),
                Ok(Some(Ok(Frame::Close(_)))) => goodbye = true,
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_)) | None) => return (frames, goodbye),
                Err(_) => panic!("the socket neither ended nor carried anything more"),
            }
        }
    }

    /// Everything the shell has printed, read on until it has gone quiet.
    async fn printed_until_quiet(viewer: &mut Receiver<Printed>) -> Vec<u8> {
        let mut seen = Vec::new();
        while let Ok(said) = tokio::time::timeout(QUIET_FOR, viewer.recv()).await {
            match said {
                Some(run) => seen.extend_from_slice(&run),
                None => break,
            }
        }
        seen
    }

    /// Everything the shell prints from now until it ends, taken off the pump
    /// itself so that what a socket was sent can be held against it.
    fn printed_in_full(session: &Arc<Session>) -> tokio::task::JoinHandle<Vec<u8>> {
        let (missed, mut viewer) = session.pump.attach();
        tokio::spawn(async move {
            let mut whole = missed;
            while let Some(run) = viewer.recv().await {
                whole.extend_from_slice(&run);
            }
            whole
        })
    }

    /// Where the tail of what the shell printed stops agreeing with what the
    /// socket carried, and what each of them says there.
    ///
    /// Said in a few dozen bytes rather than by printing both streams, which
    /// run to a hundred kilobytes and would bury the one place they differ.
    fn where_they_part(printed: &[u8], carried: &[u8]) -> String {
        let tail = &printed[printed.len().saturating_sub(carried.len())..];
        let parted = tail
            .iter()
            .zip(carried)
            .position(|(printed, carried)| printed != carried)
            .unwrap_or(tail.len().min(carried.len()));
        let from = parted.saturating_sub(40);
        let excerpt = |run: &[u8]| {
            String::from_utf8_lossy(&run[from.min(run.len())..(parted + 40).min(run.len())])
                .into_owned()
        };
        format!(
            "{} bytes in and {} from the end, the shell had {:?} where the socket had {:?}",
            parted,
            carried.len() - parted.min(carried.len()),
            excerpt(tail),
            excerpt(carried),
        )
    }

    /// Waits until the shell has printed `mark`, and says so if it never does.
    ///
    /// A fixed sleep in its place is a guess at how long a shell takes to start,
    /// read its profile and get a command run, which is a few milliseconds on an
    /// idle machine and can be most of a second with the rest of the suite
    /// running beside it. Guess low and the case reaches the moment it is about
    /// before there is anything there; guess high and it walks past it. Neither
    /// is a fault in what is being tested, so neither should be able to fail a
    /// case about it.
    async fn printed_as_far_as(session: &Arc<Session>, mark: &str) {
        let giving_up = Instant::now() + PATIENCE;
        while Instant::now() < giving_up {
            if String::from_utf8_lossy(&session.pump.replay()).contains(mark) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "the shell never printed {mark:?}, so this case never reached the moment it is about"
        )
    }

    /// The one shell a case has opened.
    fn the_shell(shells: &Shells) -> Arc<Session> {
        shells.list().pop().expect("the shell that was just opened")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_socket_is_handed_byte_for_byte_what_the_shell_printed_before_it_came() {
        let (shells, app) = a_register();
        let id = open_one(&app, None).await;
        let session = the_shell(&shells);

        // A second viewer, straight off the pump. What the socket is handed has
        // to be held against what the shell printed, and the only way to know
        // that independently of the socket is to watch the same shell from the
        // other side.
        let (missed, mut watching_too) = session.pump.attach();
        session
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'MARK\\033[31mRED\\033[0mMARK\\n'\n")
            .expect("a shell that just started should take keystrokes");

        let mut printed = missed;
        printed.extend_from_slice(&printed_until_quiet(&mut watching_too).await);

        let mut socket = watched(&app, &id).await;
        // Joined back together: the replay is handed over in pieces and where
        // the pieces fall is not what a viewer coming back to a shell cares
        // about. What it is owed is every byte, in order, and nothing else.
        let replay = the_whole_replay(&mut socket).await;

        assert!(
            printed_until_quiet(&mut watching_too).await.is_empty(),
            "the shell printed again between being read and being replayed, so this case is \
             comparing the replay against a moment that had already passed"
        );
        assert!(
            printed.len() < 256 * 1024,
            "this case is only worth anything below the point where a replay is trimmed, and \
             {} bytes went past",
            printed.len()
        );
        assert_eq!(
            replay,
            printed,
            "someone coming back to a shell should be handed exactly what it printed while \
             they were away, and was handed {:?} where the shell printed {:?}",
            String::from_utf8_lossy(&replay),
            String::from_utf8_lossy(&printed)
        );
        assert!(
            String::from_utf8_lossy(&replay).contains("MARK\u{1b}[31mRED\u{1b}[0mMARK"),
            "an escape sequence should reach the browser whole, with the text either side of \
             it still attached: {:?}",
            String::from_utf8_lossy(&replay)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_that_has_printed_nothing_is_still_told_the_replay_is_over() {
        let (shells, app) = a_register();
        // Opened here rather than through the route, so that nothing but the
        // handshake stands between the shell starting and the socket attaching.
        // A shell has to be exec'd and has to read its profile before it can
        // print a prompt, and this connection is a pipe with no kernel in it.
        let session = shells
            .open(std::path::PathBuf::from("/"), 80, 24, None)
            .expect("a shell should start");
        let mut socket = watched(&app, &session.id.to_string()).await;

        // Nothing missed is no frames of it, and then the marker anyway. That
        // is the whole promise: a browser settles its scroll when it hears the
        // replay is over, and one that is never told because there was nothing
        // to tell would wait for a boundary that never comes.
        let replay = the_replay_in_pieces(&mut socket).await;
        assert!(
            replay.is_empty(),
            "the shell printed {:?} before the socket could attach, so this case never saw the \
             empty replay it exists to prove",
            String::from_utf8_lossy(&replay.concat())
        );

        let live = one_frame(&mut socket).await;
        assert!(
            !live.is_empty(),
            "the shell should have printed a prompt, and the frame after the replay was empty"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_socket_attaching_mid_stream_misses_nothing_and_is_shown_nothing_twice() {
        let (shells, app) = a_register();
        let id = open_one(&app, None).await;
        let session = the_shell(&shells);
        let printed = printed_in_full(&session);

        session
            .shell
            .lock()
            .unwrap()
            .type_into(PRINT_A_LOT_THEN_SLOWLY)
            .expect("a shell that just started should take keystrokes");

        // Well inside the printing and nowhere near the end of it. The burst is
        // printed and the slow half has begun, which leaves a second and a half
        // of live output still to come for the seam to be found in.
        printed_as_far_as(&session, "LINE000").await;
        let mut socket = watched(&app, &id).await;
        // Attached, and then nothing is read from it for a moment, the way a
        // viewer on a slow link reads nothing for a moment. This is what turns
        // the seam from an instant into a window: the replay is larger than the
        // connection will hold, so handing it over waits here, and the shell
        // goes on printing throughout. Anything asked for as the past and
        // subscribed to as the future in two steps is lost in this window.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let replay = the_whole_replay(&mut socket).await;
        let (frames, _) = everything_carried(&mut socket).await;
        let printed = printed.await.expect("the shell's output should have been gathered");

        let carried = [replay.clone(), frames.concat()].concat();
        assert!(
            String::from_utf8_lossy(&replay).contains("LINE00"),
            "this case is about a seam, and the socket attached before the shell had printed \
             anything to be handed: {:?}",
            String::from_utf8_lossy(&replay)
        );
        assert!(
            !String::from_utf8_lossy(&replay).contains("THEEND"),
            "the shell had finished printing before the socket attached, so there was no live \
             half for the replay to be joined to"
        );
        assert!(
            frames.len() > 2,
            "the live half should be several frames, and the socket carried {} of them after \
             the replay",
            frames.len()
        );
        assert!(
            replay.len() > PIPE_HOLDS,
            "the replay is {} bytes and the connection holds {PIPE_HOLDS}, so handing it over              never had to wait and the seam this case is about was an instant rather than a              window",
            replay.len()
        );
        assert!(
            String::from_utf8_lossy(&carried).contains("THEEND"),
            "the socket should have carried the shell's output to the end of it"
        );
        assert!(
            printed.ends_with(&carried),
            "what the socket carried is not the tail of what the shell printed, so something \
             was lost between the replay and the live stream, or shown in both. The shell \
             printed {} bytes and the socket carried {}, and {}",
            printed.len(),
            carried.len(),
            where_they_part(&printed, &carried)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn what_is_typed_into_the_socket_reaches_the_shell_and_its_answer_comes_back() {
        let (_shells, app) = a_register();
        let id = open_one(&app, None).await;
        let mut socket = watched(&app, &id).await;

        // Binary, because that is what a keystroke is. An arrow key is
        // `\x1b[A`, an interrupt is `\x03`, and neither is text.
        socket
            .send(Frame::Binary(b"printf 'TYPED[%s]\\n' hello\n".to_vec()))
            .await
            .expect("a socket should take keystrokes");

        let frames = frames_until(&mut socket, |said| answered(said, "TYPED") == "hello").await;
        let said = String::from_utf8_lossy(&frames.concat()).into_owned();
        assert_eq!(
            answered(&said, "TYPED"),
            "hello",
            "the shell should have run what was typed at the socket and printed its answer \
             back down the same socket, and said: {said:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_resize_reaches_the_shell_and_a_message_it_cannot_read_is_ignored() {
        let (_shells, app) = a_register();
        // Eighty by twenty-four to begin with, which is what the resize has to
        // be seen to change.
        let id = open_one(&app, None).await;
        let mut socket = watched(&app, &id).await;

        // A browser one version ahead of its server should lose the feature it
        // is asking for, not the terminal it is asking through. These come
        // first so that everything after them is proof they were survived.
        for beyond_us in [
            "{\"type\":\"telepathy\",\"cols\":100}",
            "{\"type\":\"resize\",\"cols\":\"wide\"}",
            "not json at all",
            "",
        ] {
            socket
                .send(Frame::Text(beyond_us.to_string()))
                .await
                .expect("a socket should take a message it does not understand");
        }

        socket
            .send(Frame::Text("{\"type\":\"resize\",\"cols\":100,\"rows\":40}".to_string()))
            .await
            .expect("a socket should take a resize");
        // Asked of the shell rather than of the server. What matters is the
        // shape the program a person is about to run will see, and only the
        // shell can answer that.
        socket
            .send(Frame::Binary(b"printf 'SIZE[%s]\\n' \"$(stty size)\"\n".to_vec()))
            .await
            .expect("a socket should take keystrokes");

        let frames = frames_until(&mut socket, |said| answered(said, "SIZE") == "40 100").await;
        let said = String::from_utf8_lossy(&frames.concat()).into_owned();
        assert_eq!(
            answered(&said, "SIZE"),
            "40 100",
            "the shell should think it is forty rows of a hundred characters, and says it is \
             {:?}: {said:?}",
            answered(&said, "SIZE")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_viewer_that_stops_reading_is_cut_and_the_other_one_carries_on() {
        let (shells, app) = a_register();
        let id = open_one(&app, None).await;
        let mut wedged = watched(&app, &id).await;
        let mut carrying_on = watched(&app, &id).await;
        // Both replays read to the end of them, so both viewers are known to be
        // attached before anything is printed for them to fall behind on.
        the_replay_in_pieces(&mut wedged).await;
        the_replay_in_pieces(&mut carrying_on).await;

        the_shell(&shells)
            .shell
            .lock()
            .unwrap()
            .type_into(PRINT_A_LOT)
            .expect("a shell that just started should take keystrokes");

        // `wedged` is deliberately not read from here on. Its end of the pipe
        // fills, the send into it stops moving, its share of the pump backs up,
        // and the pump waits — which is the whole reason there is a bound in
        // this file at all.
        let started = Instant::now();
        let (frames, goodbye) = everything_carried(&mut carrying_on).await;
        let carried = frames.concat();

        assert!(
            String::from_utf8_lossy(&carried).contains("THEEND"),
            "one viewer stopped reading and the other never saw the end of the shell's output, \
             so a tab that went into a tunnel took everybody else's terminal with it"
        );
        assert!(
            goodbye,
            "the shell ended, so the viewer that was still reading should have been told so \
             rather than left to guess whether its network died"
        );
        assert!(
            started.elapsed() >= WEDGED_AFTER,
            "the other viewer finished in {:?}, which is sooner than the wedged one can have \
             been waited for, so this case did not prove what it says it does",
            started.elapsed()
        );

        let (_, goodbye) = everything_carried(&mut wedged).await;
        assert!(
            !goodbye,
            "the wedged viewer was sent a close frame, which is the other half of a frame that \
             was left unfinished on the wire"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_sockets_watching_one_shell_are_both_shown_what_it_prints() {
        let (shells, app) = a_register();
        let id = open_one(&app, None).await;
        let mut one = watched(&app, &id).await;
        let mut other = watched(&app, &id).await;
        the_replay_in_pieces(&mut one).await;
        the_replay_in_pieces(&mut other).await;

        the_shell(&shells)
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'BOTH[%s]\\n' here\n")
            .expect("a shell that just started should take keystrokes");

        for (which, socket) in [("one", &mut one), ("other", &mut other)] {
            let frames = frames_until(socket, |said| answered(said, "BOTH") == "here").await;
            let said = String::from_utf8_lossy(&frames.concat()).into_owned();
            assert_eq!(
                answered(&said, "BOTH"),
                "here",
                "the {which} of two sockets on the same shell was not shown what it printed, \
                 and was shown: {said:?}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_socket_attaching_to_a_shell_that_has_already_ended_is_still_shown_it() {
        let (shells, app) = a_register();
        let id = open_one(&app, None).await;
        let session = the_shell(&shells);
        let printed = printed_in_full(&session);

        session
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'THEEND\\n'; exit\n")
            .expect("a shell that just started should take keystrokes");
        let printed = printed.await.expect("the shell's output should have been gathered");
        assert!(
            session.pump.over(),
            "the shell's output ended, so the pump should agree that it did"
        );

        let mut socket = watched(&app, &id).await;
        let replay = the_whole_replay(&mut socket).await;
        let (afterwards, goodbye) = everything_carried(&mut socket).await;

        assert_eq!(
            replay,
            printed,
            "a page reloaded a second after a shell ended still wants the last of what it \
             printed, and was handed {:?}",
            String::from_utf8_lossy(&replay)
        );
        assert!(
            afterwards.is_empty(),
            "a shell that has ended has nothing left to say, so there was nothing to send after \
             the replay was over, and {} frames came after it",
            afterwards.len()
        );
        assert!(
            goodbye,
            "a socket attached to a shell that is over should be told the output has ended \
             rather than left open on a shell that will never print again"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_viewer_reading_steadily_but_slowly_is_shown_the_whole_replay_and_is_not_cut() {
        let (shells, app) = a_register();
        let id = open_one(&app, None).await;
        let session = the_shell(&shells);
        let printed = printed_in_full(&session);

        // Well over a quarter of a megabyte, and read to the end before the
        // slow socket attaches. What is kept is then the whole of what can be
        // kept, and the replay is the entire case: no live output arrives
        // beside it to muddle what was cut off from what was never sent.
        session
            .shell
            .lock()
            .unwrap()
            .type_into(PRINT_A_LOT)
            .expect("a shell that just started should take keystrokes");
        printed.await.expect("the shell's output should have been gathered");

        let kept = session.pump.replay();
        assert!(
            kept.len() > 250_000,
            "this case is about a replay too large for one send to a slow viewer, and the shell \
             left only {} bytes of one",
            kept.len()
        );

        // Thirty-two kilobytes a second, steadily, with nothing ever stopping.
        // That is slower than the fifty a single send of this replay would
        // demand inside `WEDGED_AFTER` and far faster than a wedged socket,
        // which takes nothing at all — the difference this file has to be able
        // to tell, and could not when the limit was on the handover rather than
        // on a frame of it.
        let mut socket = watched_slowly(&app, &id).await;
        let started = Instant::now();
        let replay = the_whole_replay(&mut socket).await;
        let took = started.elapsed();

        assert!(
            took > WEDGED_AFTER,
            "the whole replay reached this viewer in {took:?}, which is inside the window one \
             send is given, so the link was not slow enough for this case to be about anything"
        );
        assert_eq!(
            replay.len(),
            kept.len(),
            "a viewer that never stopped reading was handed {} of the {} bytes kept for it, so \
             how much there was to send is what decided it was gone",
            replay.len(),
            kept.len()
        );
        assert!(
            replay == kept,
            "the viewer was handed the right number of bytes and the wrong ones, and {}",
            where_they_part(&kept, &replay)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_socket_naming_a_shell_that_never_existed_is_refused_before_it_opens() {
        let (_shells, app) = a_register();
        // A name that is an id and names nothing, and a name that is not an id
        // at all. Neither names a shell, which is the same answer.
        for named in [Uuid::new_v4().to_string(), "not-an-id".to_string()] {
            let refused = watching(&app, &named, OURS).await.err();
            assert_eq!(
                refused,
                Some(StatusCode::NOT_FOUND),
                "asking to watch {named:?} should have been refused as plainly as any other \
                 request, and was answered {refused:?} — a socket that opens and then closes \
                 says why only in a close code, which is a worse answer to the same question"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_handshake_naming_a_host_this_machine_is_not_is_refused_the_upgrade() {
        let (_shells, app) = a_register();
        let id = open_one(&app, None).await;

        let refused = watching(&app, &id, THEIRS).await.err();
        assert_eq!(
            refused,
            Some(StatusCode::FORBIDDEN),
            "a page on {THEIRS} was answered {refused:?} by the socket that hands out a shell. \
             A handshake is outside the same-origin policy entirely, so the permissive CORS \
             this server is mounted behind never sees one and this guard is the only thing \
             standing there"
        );

        assert!(
            watching(&app, &id, OURS).await.is_ok(),
            "the socket should still be opened for a browser on this machine"
        );
    }
}
