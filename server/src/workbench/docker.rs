//! Ties the containers a chat starts to that chat.
//!
//! A container is started by the Docker daemon, not by the command that asked
//! for it, so it is never one of the chat's descendants and the memory report
//! could not see it. Each chat is instead given a Docker endpoint of its own:
//! `DOCKER_HOST` points at a socket this app serves, which passes every call on
//! to the real daemon unchanged except one. A request to create a container
//! has the chat's ID added to its labels, so the container carries its owner
//! for as long as it exists (bw-meh1.1).

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderValue, CONTENT_LENGTH, TRANSFER_ENCODING, UPGRADE};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::net::{UnixListener, UnixStream};

/// The label a created container carries its chat's ID in.
pub const CHAT_LABEL: &str = "atelier.chat";

/// The label Compose records the folder a project was started from in.
pub const WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";

/// A create request is a container's settings, a few kilobytes. Anything past
/// this is not one, and is refused rather than held in memory.
const CREATE_BODY_LIMIT: usize = 16 * 1024 * 1024;

type Body = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

/// The daemon the Docker command line would talk to from this app's own
/// environment, when it is one reached through a local socket. A remote or
/// TCP daemon returns `None`: the chat then keeps whatever the app inherited.
pub fn upstream() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let config = std::env::var_os("DOCKER_CONFIG")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".docker")));
    let socket = resolve_upstream(
        std::env::var("DOCKER_HOST").ok().as_deref(),
        std::env::var("DOCKER_CONTEXT").ok().as_deref(),
        config.as_deref(),
    )?;
    socket.exists().then_some(socket)
}

/// Docker's own order: `DOCKER_HOST`, then `DOCKER_CONTEXT`, then the context
/// the config file names, then the default socket. Setting `DOCKER_HOST` for a
/// chat outranks every one of them, so a chat whose app had chosen another
/// context must be sent on to that context's daemon, not the default one.
fn resolve_upstream(host: Option<&str>, context: Option<&str>, config: Option<&Path>) -> Option<PathBuf> {
    if let Some(host) = host.filter(|host| !host.is_empty()) {
        return unix_path(host);
    }
    let context = match context.filter(|name| !name.is_empty()) {
        Some(name) => Some(name.to_owned()),
        None => config
            .and_then(|dir| std::fs::read(dir.join("config.json")).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("currentContext")?.as_str().map(str::to_owned))
            .filter(|name| !name.is_empty()),
    };
    match context.as_deref() {
        None | Some("default") => Some(PathBuf::from("/var/run/docker.sock")),
        Some(name) => {
            // A context's settings are kept under the hex SHA-256 of its name.
            use sha2::Digest;
            let digest = sha2::Sha256::digest(name.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            let meta = std::fs::read(config?.join("contexts/meta").join(hex).join("meta.json")).ok()?;
            let meta: Value = serde_json::from_slice(&meta).ok()?;
            unix_path(meta.pointer("/Endpoints/docker/Host")?.as_str()?)
        }
    }
}

fn unix_path(host: &str) -> Option<PathBuf> {
    host.strip_prefix("unix://")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// The sockets already serving a chat, by chat ID.
fn serving() -> &'static Mutex<HashMap<String, PathBuf>> {
    static SERVING: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    SERVING.get_or_init(Default::default)
}

/// The `DOCKER_HOST` a chat's processes are started with, opening its socket
/// the first time. `None` leaves the chat's environment as it was: there is no
/// local daemon to pass calls on to, or the socket could not be opened. Must
/// be called from inside the app's runtime.
pub fn host_for(session_id: &str) -> Option<String> {
    let upstream = upstream()?;
    let mut serving = serving().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(path) = serving.get(session_id).filter(|path| path.exists()) {
        return Some(format!("unix://{}", path.display()));
    }
    let path = match open(session_id, upstream) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("could not open the Docker socket for chat {session_id}: {error}");
            return None;
        }
    };
    let host = format!("unix://{}", path.display());
    serving.insert(session_id.to_owned(), path);
    Some(host)
}

/// This app's own folder of chat sockets. It is named after the process, so
/// two copies of the app never share one, and a copy that died has its folder
/// removed by the next one to start.
fn socket_dir() -> std::io::Result<PathBuf> {
    let parent = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(std::env::temp_dir);
    static SWEPT: std::sync::Once = std::sync::Once::new();
    SWEPT.call_once(|| sweep(&parent));
    let dir = parent.join(format!("atelier-docker-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Removes the socket folders of copies of the app that are no longer running.
fn sweep(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.strip_prefix("atelier-docker-"))
            .and_then(|pid| pid.parse::<i32>().ok())
        else {
            continue;
        };
        #[cfg(unix)]
        let gone = pid != std::process::id() as i32
            && unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        #[cfg(not(unix))]
        let gone = false;
        if gone {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn open(session_id: &str, upstream: PathBuf) -> std::io::Result<PathBuf> {
    // A socket path is limited to about a hundred bytes, so the file is named
    // by a short digest of the chat's ID rather than by the ID itself.
    use sha2::Digest;
    let digest = sha2::Sha256::digest(session_id.as_bytes());
    let name: String = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect();
    let path = socket_dir()?.join(format!("{name}.sock"));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    tokio::spawn(serve(listener, Arc::new(upstream), Arc::new(session_id.to_owned())));
    Ok(path)
}

/// Answers every connection on one chat's socket until the app exits.
pub async fn serve(listener: UnixListener, upstream: Arc<PathBuf>, session_id: Arc<String>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(error) => {
                tracing::warn!("the Docker socket for chat {session_id} stopped accepting: {error}");
                return;
            }
        };
        let upstream = upstream.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let upstream = upstream.clone();
                let session_id = session_id.clone();
                async move { Ok::<_, Infallible>(forward(request, &upstream, &session_id).await) }
            });
            // Upgrades carry `docker run -it`, `attach`, `exec` and BuildKit's
            // session: after the switch they are a raw two-way stream.
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await;
        });
    }
}

async fn forward(request: Request<Incoming>, upstream: &Path, session_id: &str) -> Response<Body> {
    match pass_on(request, upstream, session_id).await {
        Ok(response) => response,
        Err(error) => failure(StatusCode::BAD_GATEWAY, &format!("Atelier could not reach Docker: {error}")),
    }
}

async fn pass_on(
    mut request: Request<Incoming>,
    upstream: &Path,
    session_id: &str,
) -> Result<Response<Body>, Box<dyn std::error::Error + Send + Sync>> {
    let wants_upgrade = request.headers().contains_key(UPGRADE);
    let client_side = wants_upgrade.then(|| hyper::upgrade::on(&mut request));
    let (mut parts, body) = request.into_parts();
    let body: Body = if is_create(&parts.method, parts.uri.path()) {
        let bytes = match Limited::new(body, CREATE_BODY_LIMIT).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(_) => {
                return Ok(failure(StatusCode::PAYLOAD_TOO_LARGE, "container settings are too large"));
            }
        };
        let bytes = labelled(&bytes, session_id).unwrap_or(bytes);
        parts.headers.remove(TRANSFER_ENCODING);
        parts.headers.insert(CONTENT_LENGTH, HeaderValue::from(bytes.len()));
        Full::new(bytes).map_err(|never| match never {}).boxed()
    } else {
        body.map_err(Into::into).boxed()
    };
    let stream = UnixStream::connect(upstream).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(connection.with_upgrades());
    let mut response = sender.send_request(Request::from_parts(parts, body)).await?;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(client_side) = client_side {
            let daemon_side = hyper::upgrade::on(&mut response);
            tokio::spawn(async move {
                let (Ok(client), Ok(daemon)) = tokio::join!(client_side, daemon_side) else {
                    return;
                };
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(daemon)).await;
            });
        }
    }
    Ok(response.map(|body| body.map_err(Into::into).boxed()))
}

fn failure(status: StatusCode, message: &str) -> Response<Body> {
    let body = serde_json::json!({ "message": message }).to_string();
    let mut response = Response::new(Full::new(Bytes::from(body)).map_err(|never| match never {}).boxed());
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(hyper::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

/// `POST /containers/create`, with or without the API version in front.
fn is_create(method: &Method, path: &str) -> bool {
    if method != Method::POST {
        return false;
    }
    let Some(prefix) = path.strip_suffix("/containers/create") else {
        return false;
    };
    prefix.is_empty()
        || prefix
            .strip_prefix("/v")
            .is_some_and(|version| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// The create request with the chat's label added. Anything that is not a
/// settings object is passed on as it came, for the daemon to refuse.
fn labelled(body: &[u8], session_id: &str) -> Option<Bytes> {
    let mut settings: Value = serde_json::from_slice(body).ok()?;
    let settings_object = settings.as_object_mut()?;
    let labels = settings_object
        .entry("Labels")
        .or_insert_with(|| Value::Object(Default::default()));
    if labels.is_null() {
        *labels = Value::Object(Default::default());
    }
    labels
        .as_object_mut()?
        .insert(CHAT_LABEL.into(), Value::String(session_id.into()));
    serde_json::to_vec(&settings).ok().map(Bytes::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn only_a_container_create_is_changed() {
        assert!(is_create(&Method::POST, "/containers/create"));
        assert!(is_create(&Method::POST, "/v1.47/containers/create"));
        assert!(!is_create(&Method::GET, "/v1.47/containers/create"));
        assert!(!is_create(&Method::POST, "/v1.47/containers/abc/start"));
        assert!(!is_create(&Method::POST, "/v1.47/services/create"));
        assert!(!is_create(&Method::POST, "/evil/containers/create"));
    }

    #[test]
    fn the_label_is_added_beside_the_labels_already_asked_for() {
        let body = br#"{"Image":"alpine","Labels":{"com.docker.compose.project":"shop"}}"#;
        let changed: Value = serde_json::from_slice(&labelled(body, "chat-1").unwrap()).unwrap();
        assert_eq!(changed["Labels"]["com.docker.compose.project"], "shop");
        assert_eq!(changed["Labels"][CHAT_LABEL], "chat-1");
        assert_eq!(changed["Image"], "alpine");
        for body in [&br#"{"Image":"alpine"}"#[..], br#"{"Image":"alpine","Labels":null}"#] {
            let changed: Value = serde_json::from_slice(&labelled(body, "chat-1").unwrap()).unwrap();
            assert_eq!(changed["Labels"][CHAT_LABEL], "chat-1");
        }
        assert!(labelled(b"not json", "chat-1").is_none());
        assert!(labelled(b"[1]", "chat-1").is_none());
    }

    #[test]
    fn the_daemon_is_the_one_docker_itself_would_choose() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_upstream(Some("unix:///run/user/1000/docker.sock"), Some("other"), Some(dir.path())),
            Some(PathBuf::from("/run/user/1000/docker.sock"))
        );
        assert_eq!(resolve_upstream(Some("tcp://10.0.0.2:2375"), None, Some(dir.path())), None);
        assert_eq!(
            resolve_upstream(None, None, Some(dir.path())),
            Some(PathBuf::from("/var/run/docker.sock"))
        );
        use sha2::Digest;
        let hex: String = sha2::Sha256::digest(b"rootless").iter().map(|b| format!("{b:02x}")).collect();
        let meta = dir.path().join("contexts/meta").join(hex);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("meta.json"),
            r#"{"Name":"rootless","Endpoints":{"docker":{"Host":"unix:///run/user/1000/docker.sock"}}}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"currentContext":"rootless"}"#).unwrap();
        assert_eq!(
            resolve_upstream(None, None, Some(dir.path())),
            Some(PathBuf::from("/run/user/1000/docker.sock"))
        );
        assert_eq!(
            resolve_upstream(None, Some("default"), Some(dir.path())),
            Some(PathBuf::from("/var/run/docker.sock"))
        );
    }

    /// A stand-in daemon: it answers a create with the body it was sent, and
    /// switches an attach to a raw stream that echoes what it is sent.
    async fn daemon(listener: UnixListener) {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(|mut request: Request<Incoming>| async move {
                    if request.uri().path().ends_with("/attach") {
                        let upgrade = hyper::upgrade::on(&mut request);
                        tokio::spawn(async move {
                            let mut raw = TokioIo::new(upgrade.await.unwrap());
                            let mut buffer = [0u8; 5];
                            raw.read_exact(&mut buffer).await.unwrap();
                            raw.write_all(&buffer).await.unwrap();
                        });
                        let mut response = Response::new(Full::new(Bytes::new()));
                        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
                        response.headers_mut().insert(UPGRADE, HeaderValue::from_static("tcp"));
                        response
                            .headers_mut()
                            .insert(hyper::header::CONNECTION, HeaderValue::from_static("Upgrade"));
                        return Ok::<_, Infallible>(response);
                    }
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    Ok(Response::new(Full::new(body)))
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    }

    async fn client(socket: &Path) -> hyper::client::conn::http1::SendRequest<Full<Bytes>> {
        let stream = UnixStream::connect(socket).await.unwrap();
        let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.unwrap();
        tokio::spawn(connection.with_upgrades());
        sender
    }

    #[tokio::test]
    async fn a_created_container_carries_its_chat_and_a_stream_still_flows_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        let daemon_path = dir.path().join("daemon.sock");
        tokio::spawn(daemon(UnixListener::bind(&daemon_path).unwrap()));
        let proxy_path = dir.path().join("chat.sock");
        tokio::spawn(serve(
            UnixListener::bind(&proxy_path).unwrap(),
            Arc::new(daemon_path),
            Arc::new("chat-7".into()),
        ));

        let mut sender = client(&proxy_path).await;
        let create = Request::post("/v1.47/containers/create?name=web")
            .header("host", "docker")
            .body(Full::new(Bytes::from_static(br#"{"Image":"alpine"}"#)))
            .unwrap();
        let answered = sender.send_request(create).await.unwrap().into_body().collect().await.unwrap();
        let answered: Value = serde_json::from_slice(&answered.to_bytes()).unwrap();
        assert_eq!(answered["Labels"][CHAT_LABEL], "chat-7");

        // The same connection keeps working, and other calls are untouched.
        let start = Request::post("/v1.47/containers/web/start")
            .header("host", "docker")
            .body(Full::new(Bytes::from_static(b"{}")))
            .unwrap();
        let answered = sender.send_request(start).await.unwrap().into_body().collect().await.unwrap();
        assert_eq!(&answered.to_bytes()[..], b"{}");

        let mut sender = client(&proxy_path).await;
        let attach = Request::post("/v1.47/containers/web/attach?stream=1&stdin=1")
            .header("host", "docker")
            .header(hyper::header::CONNECTION, "Upgrade")
            .header(UPGRADE, "tcp")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let mut response = sender.send_request(attach).await.unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let mut raw = TokioIo::new(hyper::upgrade::on(&mut response).await.unwrap());
        raw.write_all(b"hello").await.unwrap();
        let mut echoed = [0u8; 5];
        raw.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"hello");
    }

    /// Against the machine's real daemon, through the real command line:
    /// `cargo test real_docker -- --ignored`. Needs a local `alpine` image.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_docker_labels_a_container_and_streams_run_and_build() {
        let dir = tempfile::tempdir().unwrap();
        let proxy_path = dir.path().join("chat.sock");
        tokio::spawn(serve(
            UnixListener::bind(&proxy_path).unwrap(),
            Arc::new(upstream().expect("a local Docker daemon")),
            Arc::new("real-docker-test".into()),
        ));
        let host = format!("unix://{}", proxy_path.display());
        let name = format!("atelier-proxy-test-{}", std::process::id());
        let run = tokio::task::spawn_blocking({
            let name = name.clone();
            move || {
                let docker = |args: &[&str]| {
                    let output = std::process::Command::new("docker")
                        .args(args)
                        .env("DOCKER_HOST", &host)
                        .output()
                        .unwrap();
                    assert!(output.status.success(), "docker {args:?}: {}", String::from_utf8_lossy(&output.stderr));
                    String::from_utf8(output.stdout).unwrap()
                };
                let said = docker(&["run", "--name", &name, "alpine", "echo", "through the proxy"]);
                let label = docker(&["inspect", "--format", "{{index .Config.Labels \"atelier.chat\"}}", &name]);
                docker(&["rm", &name]);
                let piped = std::process::Command::new("docker")
                    .args(["run", "--rm", "-i", "alpine", "cat"])
                    .env("DOCKER_HOST", &host)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .unwrap();
                use std::io::Write;
                piped.stdin.as_ref().unwrap().write_all(b"typed in\n").unwrap();
                let echoed = piped.wait_with_output().unwrap();
                let context = tempfile::tempdir().unwrap();
                std::fs::write(context.path().join("Dockerfile"), "FROM alpine\nRUN echo built > /built\n").unwrap();
                let tag = format!("atelier-proxy-test:{}", std::process::id());
                docker(&["build", "-q", "-t", &tag, context.path().to_str().unwrap()]);
                docker(&["rmi", &tag]);
                let project = format!("atelier-proxy-test-{}", std::process::id());
                let compose = context.path().join("compose.yml");
                std::fs::write(&compose, "services:\n  idle:\n    image: alpine\n    command: sleep 60\n").unwrap();
                let compose = compose.to_str().unwrap();
                docker(&["compose", "-p", &project, "-f", compose, "up", "-d"]);
                let composed = docker(&[
                    "ps", "--filter", &format!("label=com.docker.compose.project={project}"),
                    "--format", "{{.Label \"atelier.chat\"}}",
                ]);
                docker(&["compose", "-p", &project, "-f", compose, "down", "-t", "0"]);
                assert_eq!(composed.trim(), "real-docker-test");
                (said, label, String::from_utf8(echoed.stdout).unwrap())
            }
        });
        let (said, label, echoed) = run.await.unwrap();
        assert_eq!(said.trim(), "through the proxy");
        assert_eq!(label.trim(), "real-docker-test");
        assert_eq!(echoed.trim(), "typed in");
    }
}
