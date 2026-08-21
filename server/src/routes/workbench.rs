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
use std::time::Duration;
use tracing::{info, warn};

/// Loopback only — never bound to the network.
fn sidecar_base() -> String {
    if let Ok(url) = env::var("BEADS_WORKBENCH_URL") {
        return url.trim_end_matches('/').to_string();
    }
    let port = env::var("BEADS_WORKBENCH_PORT").unwrap_or_else(|_| "3009".to_string());
    format!("http://127.0.0.1:{}", port)
}

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
    let (parts, body) = req.into_parts();

    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target: Uri = match format!("{}{}", sidecar_base(), path_and_query).parse() {
        Ok(u) => u,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("bad sidecar uri: {e}")).into_response(),
    };

    let bytes = match axum::body::to_bytes(body, 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("body read failed: {e}")).into_response(),
    };

    let mut headers = HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if !HOP_BY_HOP.contains(&name.as_str()) && name != header::HOST {
            headers.insert(name.clone(), value.clone());
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

const DEFAULT_ENTRY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../workbench/src/server.ts");

/// Starts the sidecar beside the server and restarts it if it dies.
///
/// `BEADS_WORKBENCH_URL` suppresses the spawn and proxies to that URL instead.
pub fn spawn_sidecar() {
    if env::var("BEADS_WORKBENCH_URL").is_ok() {
        info!("workbench: BEADS_WORKBENCH_URL set — not spawning a sidecar");
        return;
    }
    let entry = env::var("BEADS_WORKBENCH_ENTRY").unwrap_or_else(|_| DEFAULT_ENTRY.to_string());
    if !std::path::Path::new(&entry).exists() {
        warn!("workbench: sidecar entry not found at {entry} — the Chat tab will be offline");
        return;
    }

    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            info!("workbench: starting sidecar ({entry})");
            let mut node = tokio::process::Command::new("node");
            node.args([
                "--experimental-strip-types",
                "--disable-warning=ExperimentalWarning",
                "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
                &entry,
            ]);
            // Where this machine keeps our data is asked once, here, and told
            // to the helper. Left to work it out, it knew one kind of machine
            // and only one, and wrote its chats where nothing reads them
            // (bw-8um.3.14).
            if let Some(dir) = crate::identity::data_dir() {
                node.env("ATELIER_DATA_DIR", dir);
            }
            let child = node.kill_on_drop(true).spawn();

            match child {
                Err(e) => {
                    warn!("workbench: could not start node ({e}) — the Chat tab will be offline");
                    return;
                }
                Ok(mut c) => {
                    let status = c.wait().await;
                    warn!("workbench: sidecar exited ({status:?}); restarting in {backoff:?}");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });
}
