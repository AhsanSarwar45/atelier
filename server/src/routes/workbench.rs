//! Reverse proxy to the agent-workbench sidecar, plus its supervisor.
//!
//! Design: docs/agent-workbench.md §1.1.
//!
//! The whole Rust surface of the feature. The sidecar binds loopback only, so
//! every browser request reaches it through here.

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, HeaderName, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

/// Where the helper THIS process started is answering, and the word that proves
/// a caller is us.
///
/// There used to be a fixed port here — 3009 unless told otherwise — and the
/// proxy forwarded to it on trust. Whatever program held that port received the
/// reader's conversation, and answered the health check in our name: a release
/// binary whose helper never started once still reported the chat healthy
/// (bw-8um.3.5). The port is now learned from our own child, so an address is
/// only ever forwarded to while the child that named it is alive.
#[derive(Clone)]
struct Live {
    base: String,
    token: Option<String>,
}

/// `None` — the state at startup and after every exit — means there is nothing
/// of ours to forward to, and the proxy says so instead of guessing.
fn live() -> &'static RwLock<Option<Live>> {
    static LIVE: OnceLock<RwLock<Option<Live>>> = OnceLock::new();
    LIVE.get_or_init(|| RwLock::new(None))
}

fn set_live(up: Option<Live>) {
    if let Ok(mut slot) = live().write() {
        *slot = up;
    }
}

fn get_live() -> Option<Live> {
    live().read().ok().and_then(|slot| slot.clone())
}

/// Carries the shared word to the helper. Loopback is not a boundary — any
/// program on this machine can reach it — so the helper answers nobody else.
const TOKEN_HEADER: HeaderName = HeaderName::from_static("x-atelier-workbench");

/// The line the helper prints once it is listening, minus the address.
const ANNOUNCE: &str = "[workbench] listening ";

/// Describe one hop; copying them to the next breaks the stream.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

pub fn router() -> Router {
    Router::new().fallback(proxy)
}

/// Forwards one request to the sidecar and streams the answer back.
async fn proxy(req: Request) -> Response {
    // No helper of ours up, no forwarding: this is the whole of the fix for a
    // health check that used to answer 200 out of a stranger's process.
    let Some(up) = get_live() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The agent workbench is not running. It starts with the server; \
             set BEADS_WORKBENCH_URL to point at your own instance.",
        )
            .into_response();
    };

    let (parts, body) = req.into_parts();

    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target: Uri = match format!("{}{}", up.base, path_and_query).parse() {
        Ok(u) => u,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("bad sidecar uri: {e}")).into_response(),
    };

    let bytes = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("body read failed: {e}")).into_response(),
    };

    let mut headers = HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if !HOP_BY_HOP.contains(&name.as_str())
            && name != header::HOST
            && name != TOKEN_HEADER
        {
            headers.insert(name.clone(), value.clone());
        }
    }
    // Ours, not the browser's: a page cannot borrow it by sending its own.
    if let Some(token) = up.token.as_deref() {
        if let Ok(value) = token.parse() {
            headers.insert(TOKEN_HEADER, value);
        }
    }

    // No timeout: an SSE stream stays open for the life of a chat.
    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("client: {e}")).into_response(),
    };

    let upstream = client
        .request(parts.method, target.to_string())
        .headers(headers)
        .body(bytes)
        .send()
        .await;

    let upstream = match upstream {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "The agent workbench is not running ({e}). It starts with the server; \
                     set BEADS_WORKBENCH_URL to point at your own instance."
                ),
            )
                .into_response()
        }
    };

    let status = upstream.status();
    let mut out = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        // Content-Length cannot survive re-framing as a stream.
        if !HOP_BY_HOP.contains(&name.as_str()) && name != header::CONTENT_LENGTH {
            out = out.header(name.clone(), value.clone());
        }
    }
    if status.is_success() {
        out = out.header(HeaderName::from_static("x-accel-buffering"), "no");
    }

    out.body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|e| (StatusCode::BAD_GATEWAY, format!("stream: {e}")).into_response())
}

/// Opens one of the helper's streams from THIS process, rather than from the
/// browser.
///
/// The browser allows six connections to one address across every window it
/// has, and an event stream never gives its slot back — which is what left an
/// ordinary read queued behind streams that never end (live.rs, bw-zkh4). A
/// connection made here is not one of those six, so the window can hold one
/// stream while the server holds as many as the feeds need.
pub async fn upstream(path_and_query: &str) -> Result<reqwest::Response, String> {
    let Some(up) = get_live() else {
        return Err("no helper of ours is up".to_string());
    };
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut asking = client.get(format!("{}{}", up.base, path_and_query));
    // Ours, not the browser's, exactly as the proxy above sends it.
    if let Some(token) = up.token.as_deref() {
        asking = asking.header(TOKEN_HEADER, token);
    }
    let answer = asking.send().await.map_err(|e| e.to_string())?;
    if !answer.status().is_success() {
        return Err(format!("the helper answered {}", answer.status()));
    }
    Ok(answer)
}

/// Starts the sidecar beside the server and restarts it if it dies.
///
/// `laid_down` is the copy of the helper the product carried and wrote out
/// beside the data; `None` when that could not be done. This used to be a path
/// baked in at compile time — the build machine's own checkout — so every copy
/// but the maintainer's started nothing at all (bw-8um.3.9).
///
/// `BEADS_WORKBENCH_URL` suppresses the spawn and proxies to that URL instead.
/// `BEADS_WORKBENCH_ENTRY` names a helper to start instead of the carried one,
/// which is how somebody working on the helper runs their own edits.
pub fn spawn_sidecar(laid: Option<crate::helper::Laid>) {
    if let Ok(url) = env::var("BEADS_WORKBENCH_URL") {
        info!("workbench: BEADS_WORKBENCH_URL set — not spawning a sidecar");
        // Named by hand, so it is trusted by hand: no word is sent, because
        // whoever set this is running the helper themselves.
        set_live(Some(Live {
            base: url.trim_end_matches('/').to_string(),
            token: None,
        }));
        return;
    }
    // A helper named by hand is somebody's own checkout, and its packages are
    // their business; the carried one is fetched for.
    let (entry, package): (PathBuf, Option<PathBuf>) = match env::var("BEADS_WORKBENCH_ENTRY") {
        Ok(said) if !said.trim().is_empty() => (PathBuf::from(said), None),
        _ => match laid {
            Some(laid) => (laid.entry, Some(laid.package)),
            None => {
                warn!("workbench: the chat helper was not laid down — the Chat tab will not answer");
                return;
            }
        },
    };
    if !entry.exists() {
        warn!(
            "workbench: no chat helper at {} — the Chat tab will not answer",
            entry.display()
        );
        return;
    }
    let entry = entry.display().to_string();

    tokio::spawn(async move {
        // The kit the helper talks to Claude with is fetched here rather than
        // before the server binds, so a first run serves the board while it
        // happens and only the Chat tab waits.
        if let Some(package) = package {
            if let Err(e) = crate::helper::fetch_kit(&package).await {
                warn!("workbench: {e}");
                return;
            }
        }

        // Invented here and told to nobody else, so a program that guesses the
        // port still cannot drive the reader's chat.
        let token = uuid::Uuid::new_v4().to_string();

        let mut backoff = Duration::from_secs(1);
        loop {
            info!("workbench: starting sidecar ({entry})");
            // The runtime is looked for and started by its own path rather
            // than by a bare name: a copy the machine starts at login was
            // never handed the reader's own list of places, and the one thing
            // the Chat tab is made of would be missing on a computer that has
            // it (bw-oxrg). Asked again on every turn of this loop, and the
            // remembered answer dropped whenever it is no, so a runtime
            // installed on the advice below is picked up without a restart.
            let runtime = match crate::routes::find_node() {
                Some(runtime) => runtime,
                None => {
                    crate::routes::forget_tools();
                    warn!("workbench: no node on this computer — the Chat tab cannot answer. \
                           Install Node {NEEDS}+ and it will be picked up here.");
                    backoff = waited(backoff).await;
                    continue;
                }
            };
            if let Some(said) = too_old(&runtime).await {
                crate::routes::forget_tools();
                warn!("workbench: {said} — the Chat tab cannot answer until there is a newer one.");
                backoff = waited(backoff).await;
                continue;
            }
            let mut node = tokio::process::Command::new(&runtime);
            node.args([
                "--experimental-strip-types",
                "--disable-warning=ExperimentalWarning",
                "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
                &entry,
            ]);
            node.env("ATELIER_WORKBENCH_TOKEN", &token);
            // Read, not inherited: the helper's first line says which port it
            // bound, and that line is the only thing that opens the proxy.
            node.stdout(Stdio::piped());
            // Where this machine keeps our data is asked once, here, and told
            // to the helper. Left to work it out, it knew one kind of machine
            // and only one, and wrote its chats where nothing reads them
            // (bw-8um.3.14).
            if let Some(dir) = crate::identity::data_dir() {
                node.env("ATELIER_DATA_DIR", dir);
            }
            if let Some(dir) = crate::identity::rules_dir() {
                node.env("ATELIER_RULES_DIR", dir);
            }
            let child = node.kill_on_drop(true).spawn();

            match child {
                Err(e) => {
                    warn!("workbench: could not start node ({e}) — the Chat tab will be offline");
                    return;
                }
                Ok(mut c) => {
                    let said = c.stdout.take();
                    let mine = token.clone();
                    let listener = tokio::spawn(async move {
                        let Some(said) = said else { return };
                        let mut lines = BufReader::new(said).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            match line.strip_prefix(ANNOUNCE) {
                                Some(address) => {
                                    let base = format!("http://{}", address.trim());
                                    info!("workbench: sidecar answering at {base}");
                                    set_live(Some(Live {
                                        base,
                                        token: Some(mine.clone()),
                                    }));
                                }
                                None => info!("workbench: {line}"),
                            }
                        }
                    });
                    let status = c.wait().await;
                    // Forgotten before anything else can be reached at that
                    // port: the operating system is free to hand it out again
                    // the moment the child is gone.
                    set_live(None);
                    listener.abort();
                    warn!("workbench: sidecar exited ({status:?}); restarting in {backoff:?}");
                }
            }
            backoff = waited(backoff).await;
        }
    });
}

/// The oldest runtime the helper can be started with, as a reader writes it.
///
/// The helper is TypeScript run straight off the disk, with
/// `--experimental-strip-types`; nothing before this release knows that word.
const NEEDS: &str = "22.6";

/// The same, to compare a version against.
const NEEDED: (u32, u32) = (22, 6);

/// Wait out this pause, and give back the next, longer one.
async fn waited(backoff: Duration) -> Duration {
    tokio::time::sleep(backoff).await;
    (backoff * 2).min(Duration::from_secs(30))
}

/// What to tell a reader whose node is too old for the helper, if it is.
///
/// Asked before the start rather than found out from it: a runtime that does
/// not know `--experimental-strip-types` quits on the spot, so left to the
/// loop the reader is told the sidecar exited, over and over, and never why
/// (bw-oxrg). A runtime that will not say what it is gets the benefit of the
/// doubt and is started anyway.
async fn too_old(runtime: &Path) -> Option<String> {
    let said = tokio::process::Command::new(runtime)
        .arg("--version")
        .output()
        .await
        .ok()?;
    let version = String::from_utf8_lossy(&said.stdout).trim().to_string();
    (release(&version)? < NEEDED).then(|| {
        format!(
            "node {version} at {} is older than the {NEEDS} the chat helper needs",
            runtime.display()
        )
    })
}

/// The release a `node --version` line names, if it names one.
fn release(said: &str) -> Option<(u32, u32)> {
    let mut parts = said.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A runtime is judged on what it says it is, and only turned away when
    /// what it says is older than the word the helper is started with.
    #[test]
    fn a_runtime_older_than_the_helper_needs_is_the_only_one_turned_away() {
        assert_eq!(release(NEEDS), Some(NEEDED), "the two ways of writing it say the same release");
        assert_eq!(release("v22.6.0"), Some(NEEDED), "the oldest one that will do");
        assert!(release("v20.11.1").expect("a release") < NEEDED, "before the word existed");
        assert!(release("v22.5.9").expect("a release") < NEEDED, "the release just before it");
        assert!(release("v22.6.0").expect("a release") >= NEEDED);
        assert!(release("v24.0.1").expect("a release") >= NEEDED, "and everything after");
    }

    /// Nothing readable, no verdict: a runtime that will not say what it is
    /// gets started rather than refused on a guess.
    #[test]
    fn a_runtime_that_names_no_release_is_not_judged_on_one() {
        for said in ["", "node", "vNext", "v.6.0", "22"] {
            assert_eq!(release(said), None, "{said:?} names no release");
        }
    }
}
