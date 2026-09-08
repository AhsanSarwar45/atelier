//! Filesystem API route handlers.
//!
//! Provides endpoints for listing directories and checking path existence.

use axum::{
    body::Body,
    extract::{Path, Query},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use axum_extra::{headers::Range, TypedHeader};
use axum_range::{KnownSize, Ranged};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::AsyncReadExt;

const PRESENTATION_ASSET: &str = "presentation asset";

fn valid_presentation_asset(asset: &str) -> bool {
    asset.split_once('.').is_some_and(|(digest, extension)| digest.len() == 64
        && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && matches!(extension, "png" | "jpg" | "gif" | "webp" | "artifact.json"))
}

fn presentation_asset_path(directory: &std::path::Path, asset: &str) -> Option<PathBuf> {
    if !valid_presentation_asset(asset) { return None; }
    let root = std::fs::canonicalize(directory).ok()?;
    let path = std::fs::canonicalize(directory.join(asset)).ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

use super::validate_path_security;

/// Query parameters for the list directory endpoint.
#[derive(Debug, Deserialize)]
pub struct FsListParams {
    /// The directory path to list
    pub path: String,
}

/// Query parameters for the path exists endpoint.
#[derive(Debug, Deserialize)]
pub struct FsExistsParams {
    /// The path to check for existence
    pub path: String,
}

fn media_origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let Ok(url) = reqwest::Url::parse(origin) else { return false };
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

/// GET /api/fs/media?path=/some/video.webm
///
/// Streams the file rather than reading it whole, and answers a `Range`
/// request with 206 and a `Content-Range`. A `<video>` cannot be seeked
/// otherwise, and Safari refuses to play a source at all when its first
/// range request comes back 200 with the entire file (bw-g3o3.2).
pub async fn media(
    headers: HeaderMap,
    range: Option<TypedHeader<Range>>,
    Query(params): Query<FsExistsParams>,
) -> Response {
    // Unlike the metadata-only filesystem routes, this returns file bytes.
    // Refuse a web page in another origin before resolving its requested path.
    if !media_origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Cross-origin media reads are not allowed").into_response();
    }
    let path = PathBuf::from(&params.path);
    if let Err(e) = validate_path_security(&path) {
        return (StatusCode::FORBIDDEN, e).into_response();
    }
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, "File does not exist").into_response();
    }
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read file: {e}")).into_response(),
    };
    let body = match KnownSize::file(file).await {
        Ok(body) => body,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read file: {e}")).into_response(),
    };
    let content_type = mime_guess::from_path(&path).first_or_octet_stream().to_string();
    // `Ranged` writes the status, `Content-Range`, `Content-Length` and
    // `Accept-Ranges`; the two headers below are this route's own and are put
    // on afterwards so they survive either answer.
    let mut response = Ranged::new(range.map(|TypedHeader(range)| range), body).into_response();
    let ok = |value: &str| header::HeaderValue::from_str(value).ok();
    if let Some(value) = ok(&content_type) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response.headers_mut().insert(header::CONTENT_DISPOSITION, header::HeaderValue::from_static("inline"));
    response
}

/// The most a text read hands back in one answer: 2 MiB. Past that the reader
/// is told the text was cut rather than being made to wait on a file no
/// editor would open anyway.
pub const TEXT_READ_LIMIT: u64 = 2 * 1024 * 1024;

/// How much of a file is looked at before calling it binary. Git's own rule:
/// a NUL byte anywhere in the first 8000 bytes.
pub const BINARY_SNIFF_BYTES: usize = 8000;

/// Query parameters for the tree endpoint.
#[derive(Debug, Deserialize)]
pub struct FsTreeParams {
    /// The absolute directory whose one level is wanted.
    pub dir: String,
}

/// One entry of a directory, as the file browser draws it.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TreeEntry {
    /// The entry's own name, with no directory in front of it.
    pub name: String,
    /// The absolute path of the entry.
    pub path: String,
    /// `dir`, `file` or `link` — a symlink is never followed, so it is a
    /// `link` whatever it points at.
    pub kind: String,
    /// Size in bytes. A directory's is whatever the filesystem says.
    pub size: u64,
    /// Last modified, in milliseconds since the epoch.
    pub mtime: i64,
    /// True when git's ignore rules cover this entry. Ignored entries are
    /// still listed — the tree dims them rather than hiding them.
    pub ignored: bool,
    /// True when the name starts with a dot.
    pub hidden: bool,
}

/// Milliseconds since the epoch, or 0 when the filesystem will not say.
fn modified_millis(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// A walk of one level of `dir`. `ignores` decides whether git's ignore rules
/// are obeyed; the two walks are what tell an ignored entry from a plain one,
/// since a walk that obeys the rules simply never mentions the ignored ones.
fn one_level(dir: &std::path::Path, ignores: bool) -> Vec<PathBuf> {
    ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        // Hidden entries are the reader's business, not the walk's: `.env` and
        // `.github` belong in the tree, flagged.
        .hidden(false)
        .ignore(ignores)
        .git_ignore(ignores)
        .git_global(ignores)
        .git_exclude(ignores)
        // A .gitignore further up the tree covers this directory too, so the
        // one level shown must be read with the parents in hand.
        .parents(ignores)
        // Without this, a directory that is not in a git repository at all has
        // its .gitignore quietly disregarded.
        .require_git(false)
        .build()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.into_path())
        .filter(|path| path != dir)
        .collect()
}

/// GET /api/fs/tree?dir=/some/directory
///
/// One level of a directory, with git's ignore rules applied but not obeyed:
/// an ignored entry is listed and flagged, so the tree can dim it or hide it
/// on the reader's say-so rather than the server's. `.git` itself is never
/// listed.
pub async fn tree(Query(params): Query<FsTreeParams>) -> impl IntoResponse {
    let dir = PathBuf::from(&params.dir);

    if let Err(e) = validate_path_security(&dir) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e })));
    }
    if !dir.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Path does not exist" })),
        );
    }
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Path is not a directory" })),
        );
    }

    // Two walks: one that obeys the ignore rules and one that does not. What
    // the first left out is exactly what is ignored, which is the only way to
    // flag an entry the obeying walk never mentions at all.
    let walked = tokio::task::spawn_blocking({
        let dir = dir.clone();
        move || (one_level(&dir, false), one_level(&dir, true))
    })
    .await;
    let (listed, kept) = match walked {
        Ok((listed, kept)) => (listed, kept.into_iter().collect::<std::collections::HashSet<_>>()),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to read directory: {e}") })),
            )
        }
    };

    let mut entries: Vec<TreeEntry> = Vec::new();
    for path in listed {
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else {
            continue;
        };
        // The repository's own machinery is not a folder anybody browses, and
        // opening it by accident is a folder of thousands of loose objects.
        if name == ".git" {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else { continue };
        let kind = if metadata.file_type().is_symlink() {
            "link"
        } else if metadata.is_dir() {
            "dir"
        } else {
            "file"
        };
        entries.push(TreeEntry {
            hidden: name.starts_with('.'),
            ignored: !kept.contains(&path),
            name,
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            size: metadata.len(),
            mtime: modified_millis(&metadata),
        });
    }

    entries.sort_by(|a, b| {
        match (a.kind == "dir", b.kind == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    (
        StatusCode::OK,
        Json(serde_json::json!({ "dir": dir.to_string_lossy(), "entries": entries })),
    )
}

/// What a file read hands back. A binary file is an answer, not an error: the
/// reader is told what it is and how big, and shows a placeholder.
#[derive(Debug, Serialize)]
pub struct FileRead {
    /// `text` or `binary`.
    pub kind: String,
    /// The file's whole size in bytes, whatever was actually read.
    pub size: u64,
    /// Last modified, in milliseconds since the epoch.
    pub mtime: i64,
    /// The decoded text, absent for a binary file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// True when the file was longer than [`TEXT_READ_LIMIT`] and `text` holds
    /// only its beginning. Absent for a binary file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// SHA-256 of the bytes that were actually read — so a later write can say
    /// which text it is replacing. Absent for a binary file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// Git's own test for a binary file: a NUL byte in the first 8000 bytes.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0)
}

/// GET /api/fs/read?path=/some/file.ts
///
/// The text of a file, decoded UTF-8 lossily and capped at [`TEXT_READ_LIMIT`].
pub async fn read_file(Query(params): Query<FsExistsParams>) -> impl IntoResponse {
    let path = PathBuf::from(&params.path);

    if let Err(e) = validate_path_security(&path) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e })));
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Path does not exist" })),
            )
        }
    };
    if metadata.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Path is a directory" })),
        );
    }

    let size = metadata.len();
    let mtime = modified_millis(&metadata);

    let mut bytes = Vec::new();
    let read = async {
        let file = tokio::fs::File::open(&path).await?;
        file.take(TEXT_READ_LIMIT).read_to_end(&mut bytes).await
    };
    if let Err(e) = read.await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("Failed to read file: {e}") })),
        );
    }

    if looks_binary(&bytes) {
        return (
            StatusCode::OK,
            serde_json::to_value(FileRead {
                kind: "binary".to_string(),
                size,
                mtime,
                text: None,
                truncated: None,
                sha256: None,
            })
            .map(Json)
            .unwrap_or_else(|_| Json(serde_json::json!({ "error": "Failed to read file" }))),
        );
    }

    let digest = Sha256::digest(&bytes);
    let answer = FileRead {
        kind: "text".to_string(),
        size,
        mtime,
        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        truncated: Some((bytes.len() as u64) < size),
        sha256: Some(format!("{digest:x}")),
    };
    (
        StatusCode::OK,
        serde_json::to_value(answer)
            .map(Json)
            .unwrap_or_else(|_| Json(serde_json::json!({ "error": "Failed to read file" }))),
    )
}

/// GET /api/presentation-assets/:asset
pub async fn presentation_asset(headers: HeaderMap, Path(asset): Path<String>) -> Response {
    if !media_origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Cross-origin media reads are not allowed").into_response();
    }
    if !valid_presentation_asset(&asset) {
        return (StatusCode::BAD_REQUEST, format!("Invalid {PRESENTATION_ASSET}")).into_response();
    }
    let Some(directory) = crate::identity::presentation_media_dir() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Presentation storage is unavailable").into_response();
    };
    let Some(path) = presentation_asset_path(&directory, &asset) else {
        return (StatusCode::NOT_FOUND, "Presentation asset does not exist").into_response();
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read presentation asset: {e}")).into_response(),
    };
    let content_type = match asset.rsplit_once('.').map(|(_, extension)| extension).unwrap_or_default() {
        "png" => "image/png", "jpg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "json" => "application/json", _ => unreachable!(),
    };
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, "inline")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to serve presentation asset").into_response())
}

/// Request body for opening a path in an external application.
#[derive(Debug, Deserialize)]
pub struct OpenExternalRequest {
    /// The path to open
    pub path: String,
    /// Target application: "vscode", "cursor", or "finder"
    pub target: String,
    /// The line to sit on, when the address named one. The editors take it;
    /// the system's own opener has no way to be told (bw-khe.13).
    #[serde(default)]
    pub line: Option<u32>,
}

/// What an editor is handed: the file, or the file and the line inside it.
///
/// VS Code and Cursor both read `-g path:line`; without `-g` the same argument
/// is a filename with a colon in it, so the flag is not optional.
pub fn editor_args(path: &std::path::Path, line: Option<u32>) -> Vec<String> {
    match line {
        Some(n) => vec!["-g".to_string(), format!("{}:{}", path.display(), n)],
        None => vec![path.display().to_string()],
    }
}

/// A single directory entry.
#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    /// The file/directory name
    pub name: String,
    /// The full path
    pub path: String,
    /// Whether this entry is a directory
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

/// GET /api/fs/list?path=/some/directory
///
/// Lists the contents of a directory, filtering out hidden files
/// except for .beads directories.
pub async fn list_directory(Query(params): Query<FsListParams>) -> impl IntoResponse {
    let dir_path = PathBuf::from(&params.path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&dir_path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    // Check if path exists and is a directory
    if !dir_path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Path does not exist" })),
        );
    }

    if !dir_path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Path is not a directory" })),
        );
    }

    // Read directory entries
    let read_dir = match std::fs::read_dir(&dir_path) {
        Ok(rd) => rd,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to read directory: {}", e) })),
            );
        }
    };

    let mut entries: Vec<DirectoryEntry> = Vec::new();

    for entry_result in read_dir {
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("Failed to read directory entry: {}", e);
                continue;
            }
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // Filter out hidden files except .beads
        if name.starts_with('.') && name != ".beads" {
            continue;
        }

        let path = entry.path();
        let is_directory = path.is_dir();

        entries.push(DirectoryEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_directory,
        });
    }

    // Sort entries: directories first, then alphabetically
    entries.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    (StatusCode::OK, Json(serde_json::json!({ "entries": entries })))
}

/// GET /api/fs/exists?path=/some/path
///
/// Checks if a path exists on the filesystem.
pub async fn path_exists(Query(params): Query<FsExistsParams>) -> impl IntoResponse {
    let path = PathBuf::from(&params.path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    let exists = path.exists();

    (StatusCode::OK, Json(serde_json::json!({ "exists": exists })))
}

/// Runs launcher commands in order and stops at the first one that exits cleanly.
///
/// [`open::that`] walks the same list but gives up as soon as a launcher
/// *spawns*: a launcher that runs and then exits non-zero is turned straight
/// into an error, so everything behind it is never tried. On a desktop where
/// the server holds no `DISPLAY`, `xdg-open` cannot work out which desktop it
/// is on and exits 3, which hid the `gio` behind it that opens the file
/// manager perfectly well (bw-1hmu.1). This keeps walking, and only reports
/// failure once every launcher has actually been tried.
fn first_working_launcher(commands: Vec<std::process::Command>) -> Result<(), String> {
    let mut failures = Vec::new();

    for mut command in commands {
        // Named before the run, while the command is still worth printing.
        let attempted = format!("{command:?}");
        let status = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        match status {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => failures.push(format!("{attempted} exited with {status}")),
            Err(e) => failures.push(format!("{attempted} could not be started: {e}")),
        }
    }

    Err(match failures.len() {
        0 => "no launcher was available to try".to_string(),
        n => format!("all {n} launchers were tried and failed: {}", failures.join("; ")),
    })
}

/// POST /api/fs/open-external
///
/// Opens a path in an external application (VS Code, Cursor, or Finder/Explorer).
///
/// # Security constraints:
/// - Path must be within user's home directory
/// - Target must be one of: "vscode", "cursor", "finder"
pub async fn open_external(Json(request): Json<OpenExternalRequest>) -> impl IntoResponse {
    let path = PathBuf::from(&request.path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    // Check if path exists
    if !path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Path does not exist" })),
        );
    }

    // Execute the appropriate command based on target
    let args = editor_args(&path, request.line);
    let result = match request.target.as_str() {
        "vscode" => {
            // Try "code" command first, fall back to macOS open command
            let code_result = std::process::Command::new("code").args(&args).spawn();
            if code_result.is_err() {
                // Fallback for macOS: use open -a "Visual Studio Code"
                #[cfg(target_os = "macos")]
                {
                    std::process::Command::new("open")
                        .args(["-a", "Visual Studio Code", "--args"])
                        .args(&args)
                        .spawn()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    code_result
                }
            } else {
                code_result
            }
        }
        "cursor" => {
            // Try "cursor" command first, fall back to macOS open command
            let cursor_result = std::process::Command::new("cursor").args(&args).spawn();
            if cursor_result.is_err() {
                // Fallback for macOS: use open -a "Cursor"
                #[cfg(target_os = "macos")]
                {
                    std::process::Command::new("open")
                        .args(["-a", "Cursor", "--args"])
                        .args(&args)
                        .spawn()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    cursor_result
                }
            } else {
                cursor_result
            }
        }
        "finder" => {
            // The `open` crate's launcher list gives the cross-platform support
            // (macOS: Finder, Linux: file manager, Windows: Explorer); walking it
            // here rather than through `open::that` is what lets a launcher that
            // exits non-zero fall through to the next one.
            return match first_working_launcher(open::commands(&path)) {
                Ok(()) => (
                    StatusCode::OK,
                    Json(serde_json::json!({ "success": true })),
                ),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("Failed to open: {}", e)
                    })),
                ),
            };
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "Invalid target. Must be 'vscode', 'cursor', or 'finder'"
                })),
            );
        }
    };

    match result {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to open: {}. Make sure the application is installed.", e)
            })),
        ),
    }
}

/// GET /api/fs/roots
///
/// Returns the user's home directory and filesystem root paths.
/// On Windows, roots are available drive letters (C:\, D:\, M:\, etc.).
/// On Unix, roots is just ["/"].
pub async fn fs_roots() -> impl IntoResponse {
    let home = directories::UserDirs::new()
        .map(|u| u.home_dir().to_string_lossy().to_string())
        .unwrap_or_default();

    let roots: Vec<String> = if cfg!(windows) {
        // Check drives A-Z for existence
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let drive = format!("{}:\\", letter as char);
                if PathBuf::from(&drive).exists() {
                    Some(drive)
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec!["/".to_string()]
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({ "home": home, "roots": roots })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use tower::ServiceExt;

    /// A scratch tree inside the home directory, because every filesystem
    /// route is jailed to the home directory and `/tmp` is outside it.
    fn scratch() -> tempfile::TempDir {
        let home = directories::UserDirs::new().unwrap().home_dir().to_path_buf();
        tempfile::Builder::new().prefix(".atelier-fs-test-").tempdir_in(home).unwrap()
    }

    fn fs_router() -> axum::Router {
        axum::Router::new()
            .route("/api/fs/tree", axum::routing::get(tree))
            .route("/api/fs/read", axum::routing::get(read_file))
            .route("/api/fs/media", axum::routing::get(media))
    }

    async fn get(uri: String) -> (StatusCode, HeaderMap, Vec<u8>) {
        let asked = axum::http::Request::builder().uri(uri).body(Body::empty()).unwrap();
        answered(asked).await
    }

    async fn answered(asked: axum::http::Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let answer = fs_router().oneshot(asked).await.unwrap();
        let status = answer.status();
        let headers = answer.headers().clone();
        let bytes = axum::body::to_bytes(answer.into_body(), usize::MAX).await.unwrap();
        (status, headers, bytes.to_vec())
    }

    async fn json_of(uri: String) -> (StatusCode, serde_json::Value) {
        let (status, _, bytes) = get(uri).await;
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn asked_for(route: &str, key: &str, value: &std::path::Path) -> String {
        format!("{route}?{key}={}", urlencode(&value.to_string_lossy()))
    }

    /// Percent-encoding enough for a path in a query string: the tests' own
    /// scratch directories are ordinary names, but a home directory with a
    /// space in it is not exotic.
    fn urlencode(text: &str) -> String {
        text.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    (byte as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect()
    }

    /// A tree with a .gitignore at the root, another one a level down, a
    /// hidden file, a symlink and a `.git` nobody should ever be shown.
    fn a_project() -> tempfile::TempDir {
        let root = scratch();
        let at = |name: &str| root.path().join(name);
        std::fs::create_dir(at(".git")).unwrap();
        std::fs::write(at(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(at(".gitignore"), "build/\n*.tmp\n").unwrap();
        std::fs::write(at(".env"), "SECRET=1\n").unwrap();
        std::fs::create_dir(at("build")).unwrap();
        std::fs::write(at("build/out.js"), "made\n").unwrap();
        std::fs::create_dir(at("src")).unwrap();
        std::fs::write(at("src/.gitignore"), "*.log\n").unwrap();
        std::fs::write(at("src/a.log"), "noise\n").unwrap();
        std::fs::write(at("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(at("notes.txt"), "hello\n").unwrap();
        std::fs::write(at("scratch.tmp"), "junk\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(at("notes.txt"), at("link")).unwrap();
        root
    }

    fn named(entries: &serde_json::Value) -> Vec<String> {
        entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn entry<'a>(entries: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
        entries
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap_or_else(|| panic!("no entry named {name} in {entries}"))
    }

    /// One level, dirs first, `.git` never, and an ignored entry listed with a
    /// flag rather than left out — the tree dims it, which it cannot do for
    /// something it was never told about.
    #[tokio::test]
    async fn the_tree_lists_one_level_and_flags_what_git_ignores() {
        let root = a_project();
        let (status, answer) = json_of(asked_for("/api/fs/tree", "dir", root.path())).await;
        assert_eq!(status, StatusCode::OK);
        let entries = &answer["entries"];

        // Directories first, then names without regard to case.
        let names = named(entries);
        assert_eq!(&names[..2], &["build".to_string(), "src".to_string()]);
        assert!(!names.contains(&".git".to_string()), "the tree offered .git: {names:?}");

        assert_eq!(entry(entries, "build")["kind"], "dir");
        assert_eq!(entry(entries, "build")["ignored"], true);
        assert_eq!(entry(entries, "scratch.tmp")["ignored"], true);
        assert_eq!(entry(entries, "src")["ignored"], false);
        assert_eq!(entry(entries, "notes.txt")["ignored"], false);
        assert_eq!(entry(entries, "notes.txt")["kind"], "file");
        assert_eq!(entry(entries, "notes.txt")["size"], 6);
        assert!(entry(entries, "notes.txt")["mtime"].as_i64().unwrap() > 0);

        // A dot at the front is `hidden`, and nothing more: `.env` is listed,
        // and it is not ignored.
        assert_eq!(entry(entries, ".env")["hidden"], true);
        assert_eq!(entry(entries, ".env")["ignored"], false);
        assert_eq!(entry(entries, "notes.txt")["hidden"], false);

        #[cfg(unix)]
        assert_eq!(entry(entries, "link")["kind"], "link");
    }

    /// A .gitignore inside the directory being listed counts, and so does the
    /// one above it — which is why the walk is made with its parents in hand.
    #[tokio::test]
    async fn the_tree_obeys_an_ignore_file_further_down_the_tree() {
        let root = a_project();
        let (status, answer) = json_of(asked_for("/api/fs/tree", "dir", &root.path().join("src"))).await;
        assert_eq!(status, StatusCode::OK);
        let entries = &answer["entries"];

        assert_eq!(entry(entries, "a.log")["ignored"], true);
        assert_eq!(entry(entries, "main.rs")["ignored"], false);
        assert_eq!(entry(entries, ".gitignore")["hidden"], true);
    }

    #[tokio::test]
    async fn the_tree_refuses_a_path_outside_the_home_directory() {
        let (status, answer) = json_of("/api/fs/tree?dir=%2Fetc".to_string()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(answer["error"].as_str().unwrap().contains("home directory"));
    }

    /// Text comes back decoded, whole, and with the digest of what was read.
    #[tokio::test]
    async fn a_text_file_is_read_back_with_its_digest() {
        let root = scratch();
        let file = root.path().join("main.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();

        let (status, answer) = json_of(asked_for("/api/fs/read", "path", &file)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["kind"], "text");
        assert_eq!(answer["text"], "fn main() {}\n");
        assert_eq!(answer["truncated"], false);
        assert_eq!(answer["size"], 13);
        assert_eq!(answer["sha256"], format!("{:x}", Sha256::digest(b"fn main() {}\n")));
        assert!(answer["mtime"].as_i64().unwrap() > 0);
    }

    /// Git's rule, and git's rule only: a NUL byte in the first 8000. The
    /// answer is 200 with `binary` on it, not an error — the viewer has
    /// something to draw either way.
    #[tokio::test]
    async fn a_binary_file_is_answered_as_binary_rather_than_refused() {
        let root = scratch();
        let file = root.path().join("logo.png");
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(&file, &bytes).unwrap();

        let (status, answer) = json_of(asked_for("/api/fs/read", "path", &file)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["kind"], "binary");
        assert_eq!(answer["size"], bytes.len());
        assert!(answer["text"].is_null());
        assert!(answer["sha256"].is_null());
    }

    /// A file with a NUL after the first 8000 bytes is still text, because
    /// that is where git stops looking too.
    #[tokio::test]
    async fn a_nul_past_the_first_eight_thousand_bytes_is_still_text() {
        let root = scratch();
        let file = root.path().join("odd.txt");
        let mut bytes = vec![b'a'; BINARY_SNIFF_BYTES];
        bytes.push(0);
        std::fs::write(&file, &bytes).unwrap();

        let (_, answer) = json_of(asked_for("/api/fs/read", "path", &file)).await;

        assert_eq!(answer["kind"], "text");
    }

    /// Three megabytes: two come back, the reader is told so, and the digest
    /// is of the two that came back and not of the file on disk.
    #[tokio::test]
    async fn a_file_past_the_cap_comes_back_cut_with_the_digest_of_what_was_read() {
        let root = scratch();
        let file = root.path().join("huge.txt");
        let whole = vec![b'x'; 3 * 1024 * 1024];
        std::fs::write(&file, &whole).unwrap();

        let (status, answer) = json_of(asked_for("/api/fs/read", "path", &file)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer["kind"], "text");
        assert_eq!(answer["truncated"], true);
        assert_eq!(answer["size"], 3 * 1024 * 1024);
        assert_eq!(answer["text"].as_str().unwrap().len(), TEXT_READ_LIMIT as usize);
        assert_eq!(
            answer["sha256"],
            format!("{:x}", Sha256::digest(&whole[..TEXT_READ_LIMIT as usize])),
        );
    }

    /// A `<video>` seeks by asking for a slice, and a source that answers the
    /// whole file with 200 is one Safari will not play at all.
    #[tokio::test]
    async fn a_range_request_for_media_is_answered_with_that_range() {
        let root = scratch();
        let file = root.path().join("clip.webm");
        std::fs::write(&file, b"0123456789").unwrap();

        let asked = axum::http::Request::builder()
            .uri(asked_for("/api/fs/media", "path", &file))
            .header(header::RANGE, "bytes=2-5")
            .body(Body::empty())
            .unwrap();
        let (status, headers, bytes) = answered(asked).await;

        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(headers[header::CONTENT_LENGTH], "4");
        assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
        assert_eq!(headers[header::CONTENT_TYPE], "video/webm");
        assert_eq!(headers[header::CONTENT_DISPOSITION], "inline");
        assert_eq!(bytes, b"2345");
    }

    /// And without a Range it is the whole file, saying that ranges are on
    /// offer — which is how the player knows it may seek at all.
    #[tokio::test]
    async fn media_with_no_range_is_the_whole_file_and_says_ranges_are_taken() {
        let root = scratch();
        let file = root.path().join("clip.webm");
        std::fs::write(&file, b"0123456789").unwrap();

        let (status, headers, bytes) = get(asked_for("/api/fs/media", "path", &file)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
        assert!(!headers.contains_key(header::CONTENT_RANGE));
        assert_eq!(headers[header::CONTENT_TYPE], "video/webm");
        assert_eq!(bytes, b"0123456789");
    }

    #[test]
    fn test_directory_entry_serialization() {
        let entry = DirectoryEntry {
            name: "test".to_string(),
            path: "/home/user/test".to_string(),
            is_directory: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"isDirectory\":true"));
    }

    /// A chip that named a line must land the reader on that line, and an
    /// editor only reads a line when it is told to with `-g` (bw-khe.13).
    #[test]
    fn open_external_hands_the_editor_the_line() {
        let path = PathBuf::from("/home/someone/project/src/main.rs");
        assert_eq!(
            editor_args(&path, Some(42)),
            vec!["-g".to_string(), "/home/someone/project/src/main.rs:42".to_string()]
        );
    }

    /// Without a line it is the bare path, so a file with a colon in its name
    /// is not read as a line number.
    #[test]
    fn open_external_without_a_line_is_the_bare_path() {
        let path = PathBuf::from("/home/someone/project/notes.md");
        assert_eq!(
            editor_args(&path, None),
            vec!["/home/someone/project/notes.md".to_string()]
        );
    }

    /// A request that names no line is still a request: the field is optional
    /// on the wire, because every caller before this one omitted it.
    #[test]
    fn open_external_accepts_a_request_with_no_line() {
        let asked: OpenExternalRequest =
            serde_json::from_str(r#"{"path":"/home/someone/x","target":"finder"}"#).unwrap();
        assert_eq!(asked.line, None);
        let with_line: OpenExternalRequest =
            serde_json::from_str(r#"{"path":"/home/someone/x","target":"vscode","line":7}"#).unwrap();
        assert_eq!(with_line.line, Some(7));
    }

    #[test]
    fn media_bytes_are_only_read_for_the_local_app() {
        let mut local = HeaderMap::new();
        local.insert(header::ORIGIN, "http://127.0.0.1:3008".parse().unwrap());
        assert!(media_origin_allowed(&local));

        let mut foreign = HeaderMap::new();
        foreign.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!media_origin_allowed(&foreign));
    }

    #[test]
    fn presentation_media_accepts_only_content_names() {
        let digest = "a".repeat(64);
        assert!(valid_presentation_asset(&format!("{digest}.png")));
        assert!(valid_presentation_asset(&format!("{digest}.webp")));
        assert!(valid_presentation_asset(&format!("{digest}.artifact.json")));
        assert!(!valid_presentation_asset("../secret.png"));
        assert!(!valid_presentation_asset(&format!("{}.svg", "a".repeat(64))));
        assert!(!valid_presentation_asset(&format!("{}.png", "A".repeat(64))));
    }

    #[test]
    fn presentation_media_stays_inside_its_store() {
        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        std::fs::create_dir(&media).unwrap();
        let name = format!("{}.png", "b".repeat(64));
        std::fs::write(media.join(&name), b"picture").unwrap();
        assert_eq!(presentation_asset_path(&media, &name), Some(media.join(&name)));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("outside.png"), media.join(format!("{}.png", "c".repeat(64)))).unwrap();
            std::fs::write(root.path().join("outside.png"), b"outside").unwrap();
            assert!(presentation_asset_path(&media, &format!("{}.png", "c".repeat(64))).is_none());
        }
    }

    /// The walk must survive a launcher that runs and *then* fails. `xdg-open`
    /// exits 3 when it cannot work out which desktop it is on, and `open::that`
    /// reads any launcher that got as far as spawning as the end of the list —
    /// so the `gio` sitting behind it, which raises the file manager perfectly
    /// well, was never reached (bw-1hmu.1).
    #[cfg(unix)]
    #[test]
    fn open_external_launcher_walk_carries_on_past_a_non_zero_exit() {
        let scratch = tempfile::tempdir().unwrap();
        let reached = scratch.path().join("the-second-launcher-ran");

        let mut exits_three = std::process::Command::new("sh");
        exits_three.args(["-c", "exit 3"]);
        let mut leaves_a_mark = std::process::Command::new("sh");
        leaves_a_mark.args(["-c", "touch \"$1\"", "sh"]).arg(&reached);

        assert_eq!(first_working_launcher(vec![exits_three, leaves_a_mark]), Ok(()));
        assert!(
            reached.exists(),
            "the launcher behind the failing one was never actually run"
        );
    }

    /// A launcher that is not installed at all was already stepped over, and
    /// still is: the walk answers to the exit status and to a missing binary
    /// alike.
    #[cfg(unix)]
    #[test]
    fn open_external_launcher_walk_steps_over_a_launcher_that_is_absent() {
        let absent = std::process::Command::new("atelier-no-such-launcher-bw-1hmu");
        let mut installed = std::process::Command::new("sh");
        installed.args(["-c", "exit 0"]);

        assert_eq!(first_working_launcher(vec![absent, installed]), Ok(()));
    }

    /// When nothing works the reader is told the whole list was tried, rather
    /// than being handed the name of whichever launcher happened to be first
    /// and left to assume it was the only one.
    #[cfg(unix)]
    #[test]
    fn open_external_launcher_walk_names_every_launcher_when_none_work() {
        let mut exits_three = std::process::Command::new("sh");
        exits_three.args(["-c", "exit 3"]);
        let absent = std::process::Command::new("atelier-no-such-launcher-bw-1hmu");

        let complaint = first_working_launcher(vec![exits_three, absent]).unwrap_err();
        assert!(complaint.contains("all 2 launchers"), "{complaint}");
        assert!(complaint.contains("exited with"), "{complaint}");
        assert!(complaint.contains("atelier-no-such-launcher-bw-1hmu"), "{complaint}");
    }

    /// The real route, carrying a real request, against whatever launchers this
    /// machine actually has. Ignored by default because succeeding opens a file
    /// manager window; run it to watch the fix work:
    /// `cargo test --manifest-path server/Cargo.toml open_external -- --ignored`
    #[tokio::test]
    #[ignore = "a success opens a real file manager window"]
    async fn open_external_finder_opens_a_real_path() {
        use tower::ServiceExt;

        let home = directories::UserDirs::new().unwrap().home_dir().to_path_buf();
        let app = axum::Router::new()
            .route("/api/fs/open-external", axum::routing::post(open_external));

        let asked = axum::http::Request::builder()
            .method("POST")
            .uri("/api/fs/open-external")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                serde_json::json!({ "path": home, "target": "finder" }).to_string(),
            ))
            .unwrap();

        assert_eq!(app.oneshot(asked).await.unwrap().status(), StatusCode::OK);
    }
}
