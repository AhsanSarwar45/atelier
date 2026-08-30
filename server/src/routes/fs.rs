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
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
pub async fn media(headers: HeaderMap, Query(params): Query<FsExistsParams>) -> Response {
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
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read file: {e}")).into_response(),
    };
    let content_type = mime_guess::from_path(&path).first_or_octet_stream().to_string();
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, "inline")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to serve file").into_response())
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
