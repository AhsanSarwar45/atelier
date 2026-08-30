//! Version check route handlers.
//!
//! Checks GitHub Releases for newer versions and caches the result.
//! Also provides auto-update functionality via ephemeral updater scripts.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

/// Current version compiled into the binary.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// GitHub repository for release checks.
const GITHUB_REPO: &str = "AhsanSarwar45/atelier"; // the repository address, not the product name

/// Cache duration in seconds (1 hour).
const CACHE_TTL_SECS: u64 = 3600;

/// Cached version check result.
#[derive(Clone)]
pub struct CachedCheck {
    result: VersionCheckResponse,
    fetched_at: std::time::Instant,
}

/// Shared cache for version check results.
pub type VersionCache = Arc<RwLock<Option<CachedCheck>>>;

/// Creates a new empty version cache.
pub fn new_cache() -> VersionCache {
    Arc::new(RwLock::new(None))
}

/// Response from the version check endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct VersionCheckResponse {
    /// Current running version
    pub current: String,
    /// Latest available version (None if check failed)
    pub latest: Option<String>,
    /// Whether an update is available
    pub update_available: bool,
    /// Download URL for the latest release
    pub download_url: Option<String>,
    /// Release notes (first 500 chars)
    pub release_notes: Option<String>,
    /// Direct download URL for the platform-specific binary asset
    pub asset_url: Option<String>,
    /// Direct download URL for the release's own SHA256SUMS.txt, read off the
    /// same release as `asset_url` so a download can only ever be proved
    /// against the release it came from
    pub checksums_url: Option<String>,
}

/// Minimal GitHub release response.
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Option<Vec<GitHubAsset>>,
}

/// GitHub release asset.
#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// GET /api/version/check
///
/// Returns current version and checks if a newer release exists on GitHub.
/// Caches the result for 1 hour to avoid rate limiting.
pub async fn version_check(
    axum::extract::Extension(cache): axum::extract::Extension<VersionCache>,
) -> impl IntoResponse {
    // Check cache
    {
        let cached = cache.read().await;
        if let Some(ref entry) = *cached {
            if entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS {
                return (StatusCode::OK, Json(entry.result.clone()));
            }
        }
    }

    // Fetch from GitHub
    let result = check_github_release().await;

    // Update cache
    {
        let mut cached = cache.write().await;
        *cached = Some(CachedCheck {
            result: result.clone(),
            fetched_at: std::time::Instant::now(),
        });
    }

    (StatusCode::OK, Json(result))
}

/// Fetches the latest release from GitHub and compares versions.
async fn check_github_release() -> VersionCheckResponse {
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );

    let client = match reqwest::Client::builder()
        .user_agent(crate::identity::NAME)
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return fallback_response(),
    };

    let response = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            info!("GitHub API returned status {}", r.status());
            return fallback_response();
        }
        Err(e) => {
            info!("GitHub release check failed: {}", e);
            return fallback_response();
        }
    };

    let release: GitHubRelease = match response.json().await {
        Ok(r) => r,
        Err(_) => return fallback_response(),
    };

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let update_available = is_newer(&latest_version, CURRENT_VERSION);

    if update_available {
        info!(
            "Update available: {} -> {}",
            CURRENT_VERSION, latest_version
        );
    }

    // Both addresses are read off this one answer, so the checksums a download
    // is proved against belong to the release the download itself came from.
    let asset_named = |name: &str| {
        release.assets.as_ref().and_then(|assets| {
            assets
                .iter()
                .find(|a| a.name == name)
                .map(|a| a.browser_download_url.clone())
        })
    };
    let asset_url = asset_named(&current_platform_asset());
    let checksums_url = asset_named(crate::published::CHECKSUMS_ASSET);

    VersionCheckResponse {
        current: CURRENT_VERSION.to_string(),
        latest: Some(latest_version),
        update_available,
        download_url: Some(release.html_url),
        release_notes: release.body.map(|b| {
            if b.len() > 500 {
                let mut end = 500;
                while !b.is_char_boundary(end) && end > 0 {
                    end -= 1;
                }
                format!("{}…", &b[..end])
            } else {
                b
            }
        }),
        asset_url,
        checksums_url,
    }
}

/// Compares two semver strings. Returns true if `latest` > `current`.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .filter_map(|p| p.parse::<u32>().ok())
            .collect()
    };
    let l = parse(latest);
    let c = parse(current);
    l > c
}

/// Fallback when GitHub API is unreachable.
fn fallback_response() -> VersionCheckResponse {
    VersionCheckResponse {
        current: CURRENT_VERSION.to_string(),
        latest: None,
        update_available: false,
        download_url: None,
        release_notes: None,
        asset_url: None,
        checksums_url: None,
    }
}

/// The release archive this platform downloads to update itself.
///
/// A release no longer publishes a bare program file; it publishes one archive
/// per platform, each carrying the program together with the Node runtime the
/// chat tab runs on (bw-oesd.2). The updater fetches this archive and unpacks
/// the program (and its runtime) out of it, so the name here must be one the
/// build actually uploads. `.github/workflows/release.yml` names each with its
/// matrix `artifact` and appends `.tar.gz`:
/// - `atelier-darwin-arm64.tar.gz` (macOS ARM)
/// - `atelier-darwin-x64.tar.gz` (macOS Intel)
/// - `atelier-linux-x64.tar.gz` (Linux)
/// - `atelier-win-x64.tar.gz` (Windows)
fn current_platform_asset() -> String {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// The archive name for a named platform, split out so every target the build
/// releases can be proved against the names the workflow uploads, not just the
/// one this test binary happens to run on.
fn asset_for(target_os: &str, target_arch: &str) -> String {
    let platform = match (target_os, target_arch) {
        ("windows", _) => "win-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", _) => "darwin-x64",
        _ => "linux-x64",
    };
    format!("atelier-{platform}.tar.gz")
}

/// POST /api/update
///
/// Downloads the latest release binary and creates an ephemeral updater script.
/// The server exits after spawning the updater, which replaces the binary and restarts.
pub async fn perform_update(
    axum::extract::Extension(cache): axum::extract::Extension<VersionCache>,
) -> impl IntoResponse {
    // 1. Get latest release info (use cache if fresh, otherwise re-fetch)
    let check = {
        let cached = cache.read().await;
        if let Some(ref entry) = *cached {
            if entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS {
                entry.result.clone()
            } else {
                drop(cached);
                check_github_release().await
            }
        } else {
            drop(cached);
            check_github_release().await
        }
    };

    if !check.update_available {
        return (
            StatusCode::OK,
            Json(serde_json::json!({"status": "up_to_date"})),
        );
    }

    let asset_url = match check.asset_url {
        Some(url) => url,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(
                    serde_json::json!({"error": "No binary available for this platform"}),
                ),
            )
        }
    };

    // 2. Determine paths
    let current_exe = match std::env::current_exe() {
        Ok(p) => match p.canonicalize() {
            Ok(c) => c,
            Err(_) => p,
        },
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::json!({"error": format!("Cannot determine executable path: {}", e)}),
                ),
            )
        }
    };
    let current_dir = match current_exe.parent() {
        Some(d) => d,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Cannot determine executable directory"})),
            )
        }
    };

    let archive_name = current_platform_asset();
    let archive_path = current_dir.join("atelier-update-archive");

    info!("Downloading update from: {}", asset_url);

    // 3. Download the platform archive, proved against the release's own
    //    checksums, then unpack the program and its runtime out of it.
    let client = match reqwest::Client::builder()
        .user_agent(crate::identity::NAME)
        .timeout(std::time::Duration::from_secs(300))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("HTTP client error: {}", e)})),
            )
        }
    };

    // The archive is written beside the running program under its own name and
    // hashed as it arrives, and it is kept only if it matches the checksum this
    // same release publishes for it. A download that does not match is deleted
    // where it lies and the reason is handed back: the running program is not
    // touched by any of this, because it is only ever replaced by the updater
    // script below, which a refusal never reaches.
    let written = match crate::published::download(
        &client,
        &asset_url,
        check.checksums_url.as_deref(),
        &archive_name,
        &archive_path,
    )
    .await
    {
        Ok(n) => n,
        Err(problem) => {
            if problem.is_refusal() {
                warn!("Refused the update download: {}", problem);
            } else {
                warn!("The update download did not finish: {}", problem);
            }
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": problem.reason()})),
            );
        }
    };

    // Unpack the program -- and the Node runtime carried beside it -- out of the
    // proved archive, staged next to the running program for the updater script
    // to move into place. The archive is removed once its contents are out; only
    // the staged files remain, so a `.tar.gz` is never installed as the program.
    let staged = match stage_from_archive(&archive_path, current_dir) {
        Ok(s) => s,
        Err(e) => {
            let _ = std::fs::remove_file(&archive_path);
            warn!("The update archive could not be unpacked: {}", e);
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": e})),
            );
        }
    };
    let _ = std::fs::remove_file(&archive_path);
    let new_binary = staged.program.clone();

    // 4. Generate and spawn updater script
    info!(
        "Downloaded update: {} bytes -> {} (runtime carried: {})",
        written,
        new_binary.display(),
        staged.runtime.is_some()
    );

    let port = std::env::var("PORT").unwrap_or_else(|_| "3008".to_string());
    let pid = std::process::id();

    let script_result = if cfg!(windows) {
        generate_windows_update_script(
            current_dir,
            &current_exe,
            &new_binary,
            staged.runtime.as_deref(),
            pid,
            &port,
        )
    } else {
        generate_unix_update_script(
            current_dir,
            &current_exe,
            &new_binary,
            staged.runtime.as_deref(),
            pid,
            &port,
        )
    };

    match script_result {
        Ok(script_path) => {
            info!("Spawning updater script: {}", script_path.display());

            let spawn_result = if cfg!(windows) {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "/B", "", script_path.to_str().unwrap_or("")])
                    .spawn()
            } else {
                std::process::Command::new("sh")
                    .arg(&script_path)
                    .spawn()
            };

            if let Err(e) = spawn_result {
                warn!("Failed to spawn updater: {}", e);
                // Clean up
                let _ = std::fs::remove_file(&new_binary);
                let _ = std::fs::remove_file(&script_path);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": format!("Failed to spawn updater: {}", e)})),
                );
            }

            // Schedule server exit after 2 seconds to allow response to be sent
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                info!("Exiting for update...");
                std::process::exit(0);
            });

            (
                StatusCode::OK,
                Json(
                    serde_json::json!({"status": "updating", "message": "Server will restart shortly"}),
                ),
            )
        }
        Err(e) => {
            let _ = std::fs::remove_file(&new_binary);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::json!({"error": format!("Failed to create update script: {}", e)}),
                ),
            )
        }
    }
}

/// The files unpacked from the release archive, staged beside the running
/// program and waiting for the updater script to move them into place.
#[derive(Debug)]
struct StagedUpdate {
    /// The new program, under a name that is not the running one.
    program: PathBuf,
    /// The new Node runtime, if the archive carried one beside the program.
    runtime: Option<PathBuf>,
}

/// Unpack the proved release archive and stage the program -- and the Node
/// runtime beside it -- next to the running program.
///
/// A release archive is a gzipped tar carrying the program and its runtime as
/// two flat entries (`.github/workflows/release.yml`, `scripts/bundle-node.sh`).
/// Only those two names are taken, each written under a `-new` name so the
/// running program is untouched until the updater script swaps it. The archive
/// is our own and already proved against the release's published checksum, but
/// it is still read defensively: only a regular file whose name is exactly the
/// program or the runtime, with no directory part, is unpacked, and to a path
/// this function chooses rather than one the archive names -- so a crafted entry
/// cannot write anywhere else.
fn stage_from_archive(archive: &Path, dir: &Path) -> Result<StagedUpdate, String> {
    let program_name = if cfg!(windows) {
        "atelier.exe"
    } else {
        "atelier"
    };
    let runtime_name = if cfg!(windows) { "node.exe" } else { "node" };
    let staged_program = dir.join(if cfg!(windows) {
        "atelier-new.exe"
    } else {
        "atelier-new"
    });
    let staged_runtime = dir.join(if cfg!(windows) {
        "node-new.exe"
    } else {
        "node-new"
    });

    let bytes = std::fs::read(archive)
        .map_err(|e| format!("could not read the downloaded archive: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut tar = tar::Archive::new(decoder);
    let entries = tar
        .entries()
        .map_err(|e| format!("the update archive could not be read: {e}"))?;

    let mut got_program = false;
    let mut got_runtime = false;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| format!("a file in the update archive could not be read: {e}"))?;
        if entry.header().entry_type() != tar::EntryType::Regular {
            continue;
        }
        let named = entry
            .path()
            .map_err(|e| format!("a file in the update archive has an unreadable name: {e}"))?
            .into_owned();
        // Only a flat, single-component name is one of ours; anything nested or
        // with a directory part is not the program or its runtime.
        let mut parts = named.components();
        let leaf = match (parts.next(), parts.next()) {
            (Some(std::path::Component::Normal(name)), None) => {
                name.to_str().unwrap_or("").to_string()
            }
            _ => continue,
        };
        let dest = if leaf == program_name {
            &staged_program
        } else if leaf == runtime_name {
            &staged_runtime
        } else {
            continue;
        };
        entry
            .unpack(dest)
            .map_err(|e| format!("{}: {e}", dest.display()))?;
        make_runnable(dest)?;
        if leaf == program_name {
            got_program = true;
        } else {
            got_runtime = true;
        }
    }

    if !got_program {
        let _ = std::fs::remove_file(&staged_program);
        let _ = std::fs::remove_file(&staged_runtime);
        return Err("the update archive carried no atelier program".to_string());
    }

    Ok(StagedUpdate {
        program: staged_program,
        runtime: got_runtime.then_some(staged_runtime),
    })
}

/// Give a freshly unpacked program the execute bit it needs to be run.
fn make_runnable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// Generates a Unix shell script that replaces the binary and restarts the server.
fn generate_unix_update_script(
    dir: &Path,
    current_exe: &Path,
    new_binary: &Path,
    new_runtime: Option<&Path>,
    pid: u32,
    port: &str,
) -> Result<PathBuf, String> {
    let script_path = dir.join("beads-update.sh");
    let exe_name = current_exe
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid executable name")?;
    let new_name = new_binary
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid new binary name")?;

    // The running program finds its Node as a sibling file named `node`
    // (`find_runtime`), so the staged runtime takes that name. Each block is
    // empty when the archive carried no runtime.
    let (runtime_swap, runtime_rollback, runtime_cleanup) = match new_runtime {
        Some(rt) => {
            let rt_new = rt
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid new runtime name")?;
            (
                format!(
                    "mv \"node\" \"node.old\" 2>/dev/null\nmv \"{rt_new}\" \"node\"\nchmod +x \"node\"\n"
                ),
                format!(
                    "    mv \"node\" \"{rt_new}\" 2>/dev/null\n    mv \"node.old\" \"node\" 2>/dev/null\n"
                ),
                "    rm -f \"node.old\"\n".to_string(),
            )
        }
        None => (String::new(), String::new(), String::new()),
    };

    let content = format!(
        r#"#!/bin/sh
# atelier auto-updater (self-deleting)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
PID={pid}
PORT={port}

# Wait for old server to exit
echo "Waiting for server (PID $PID) to exit..."
while kill -0 $PID 2>/dev/null; do sleep 0.5; done

# Replace the program, and the runtime the archive carried beside it
mv "{exe_name}" "{exe_name}.old" 2>/dev/null
mv "{new_name}" "{exe_name}"
chmod +x "{exe_name}"
{runtime_swap}
# Start new server
PORT=$PORT ./{exe_name} &
NEW_PID=$!

# Health check: poll once per second for up to 30 attempts.
# The new server needs ~3-4s to bind its port (a ~2s Dolt-detection
# timeout at startup dominates), so a single check would lose the race.
healthy=0
i=0
while [ $i -lt 30 ]; do
    curl -sf "http://localhost:$PORT/api/health" > /dev/null 2>&1 && {{ healthy=1; break; }}
    sleep 1
    i=$((i+1))
done

if [ $healthy -eq 1 ]; then
    echo "Update successful! New server running (PID $NEW_PID)"
    rm -f "{exe_name}.old"
{runtime_cleanup}else
    echo "Health check failed, rolling back..."
    kill $NEW_PID 2>/dev/null
    sleep 1
    mv "{exe_name}" "{new_name}" 2>/dev/null
    mv "{exe_name}.old" "{exe_name}" 2>/dev/null
{runtime_rollback}    PORT=$PORT ./{exe_name} &
fi

# Self-delete
rm -f "$SCRIPT_DIR/beads-update.sh"
"#
    );

    std::fs::write(&script_path, content).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    Ok(script_path)
}

/// Generates a Windows batch script that replaces the binary and restarts the server.
fn generate_windows_update_script(
    dir: &Path,
    current_exe: &Path,
    new_binary: &Path,
    new_runtime: Option<&Path>,
    pid: u32,
    port: &str,
) -> Result<PathBuf, String> {
    let script_path = dir.join("beads-update.bat");
    let exe_name = current_exe
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid executable name")?;
    let new_name = new_binary
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid new binary name")?;

    // The runtime the program finds beside it is named `node.exe`; each block is
    // empty when the archive carried no runtime.
    let (runtime_swap, runtime_rollback, runtime_cleanup) = match new_runtime {
        Some(rt) => {
            let rt_new = rt
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid new runtime name")?;
            (
                format!(
                    "if exist \"node.exe.old\" del /f \"node.exe.old\"\r\nrename \"node.exe\" \"node.exe.old\"\r\nrename \"{rt_new}\" \"node.exe\"\r\n"
                ),
                "del /f \"node.exe\" 2>nul\r\nrename \"node.exe.old\" \"node.exe\"\r\n".to_string(),
                "del /f \"node.exe.old\" 2>nul\r\n".to_string(),
            )
        }
        None => (String::new(), String::new(), String::new()),
    };

    let content = format!(
        r#"@echo off
rem atelier auto-updater (self-deleting)
cd /d "%~dp0"
set PID={pid}
set PORT={port}

echo Waiting for server (PID %PID%) to exit...
:wait_loop
tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_loop
)

echo Replacing binary...
if exist "{exe_name}.old" del /f "{exe_name}.old"
rename "{exe_name}" "{exe_name}.old"
rename "{new_name}" "{exe_name}"
{runtime_swap}
echo Starting new server...
set PORT=%PORT%
start /B "" "{exe_name}"

rem Health check: poll once per second for up to 30 attempts.
rem The new server needs ~3-4s to bind its port (a ~2s Dolt-detection
rem timeout at startup dominates), so a single check would lose the race.
set /a tries=0
:health_loop
timeout /t 1 /nobreak >nul
curl -sf "http://localhost:%PORT%/api/health" >nul 2>&1
if %errorlevel% equ 0 goto health_ok
set /a tries+=1
if %tries% lss 30 goto health_loop

echo Health check failed, rolling back...
taskkill /F /IM "{exe_name}" 2>nul
del /f "{exe_name}" 2>nul
rename "{exe_name}.old" "{exe_name}"
{runtime_rollback}set PORT=%PORT%
start /B "" "{exe_name}"
goto cleanup

:health_ok
echo Update successful!
del /f "{exe_name}.old" 2>nul
{runtime_cleanup}
:cleanup
rem Self-delete
(goto) 2>nul & del /f "%~f0"
"#
    );

    std::fs::write(&script_path, content).map_err(|e| e.to_string())?;
    Ok(script_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a release archive the way the build does: a gzipped tar carrying
    /// the named files as flat entries, no wrapping directory.
    fn make_flat_archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut tarred = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tarred);
            for (name, content) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o755);
                builder.append_data(&mut header, name, *content).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tarred).unwrap();
        encoder.finish().unwrap()
    }

    /// Serve a release's files over loopback and return the address.
    async fn serve_release(routes: Vec<(String, Vec<u8>)>) -> std::net::SocketAddr {
        use axum::{routing::get, Router};
        use std::sync::Arc;
        let mut app = Router::new();
        for (path, body) in routes {
            let body = Arc::new(body);
            let path: &'static str = Box::leak(path.into_boxed_str());
            app = app.route(
                path,
                get(move || {
                    let body = body.clone();
                    async move { body.to_vec() }
                }),
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        address
    }

    /// The updater must only ever ask for an asset the release workflow uploads.
    ///
    /// The workflow builds one archive per matrix `artifact`, uploaded as
    /// `<artifact>.tar.gz`. If `current_platform_asset()` returned a name the
    /// build does not publish -- the bare-binary names it used to -- then
    /// `check_github_release` would find no asset and every update would 404.
    #[test]
    fn every_platform_asset_is_one_the_release_workflow_uploads() {
        let workflow = include_str!("../../../.github/workflows/release.yml");
        let uploaded: Vec<String> = workflow
            .lines()
            .filter_map(|l| l.trim().strip_prefix("artifact: "))
            .map(|a| format!("{}.tar.gz", a.trim()))
            .collect();
        assert!(
            !uploaded.is_empty(),
            "no matrix artifacts found in release.yml"
        );
        for (os, arch) in [
            ("linux", "x86_64"),
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("windows", "x86_64"),
        ] {
            let asset = asset_for(os, arch);
            assert!(
                uploaded.contains(&asset),
                "the updater asks for {asset} on {os}/{arch}, which release.yml does not \
                 upload; it uploads {uploaded:?}"
            );
        }
    }

    /// An update, run against a fixture release, ends as a runnable program at
    /// the destination -- not the archive it arrived in -- with the carried
    /// runtime staged beside it.
    #[tokio::test]
    async fn an_update_ends_as_a_runnable_program_not_the_archive() {
        use sha2::{Digest, Sha256};
        let program = b"#!/bin/sh\necho atelier-vNEXT\n";
        let runtime = b"#!/bin/sh\necho v24.20.0\n";
        let asset = if cfg!(windows) {
            "atelier-win-x64.tar.gz"
        } else if cfg!(target_os = "macos") {
            "atelier-darwin-x64.tar.gz"
        } else {
            "atelier-linux-x64.tar.gz"
        };
        let program_name = if cfg!(windows) {
            "atelier.exe"
        } else {
            "atelier"
        };
        let runtime_name = if cfg!(windows) { "node.exe" } else { "node" };
        let archive = make_flat_archive(&[
            (program_name, program.as_slice()),
            (runtime_name, runtime.as_slice()),
        ]);
        let sum = format!("{:x}", Sha256::digest(&archive));
        let checksums = format!("{sum}  {asset}\n");

        let address = serve_release(vec![
            (format!("/{asset}"), archive.clone()),
            ("/SHA256SUMS.txt".to_string(), checksums.into_bytes()),
        ])
        .await;

        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::new();
        let archive_path = dir.path().join("atelier-update-archive");

        // The whole fetch path: proved against the release's own checksums.
        let written = crate::published::download(
            &client,
            &format!("http://{address}/{asset}"),
            Some(&format!("http://{address}/SHA256SUMS.txt")),
            asset,
            &archive_path,
        )
        .await
        .expect("the fixture release's archive is proved and downloaded");
        assert_eq!(written, archive.len() as u64);

        let staged = stage_from_archive(&archive_path, dir.path())
            .expect("the archive unpacks into a staged program and runtime");

        // The destination holds the program itself, not the archive.
        let landed = std::fs::read(&staged.program).unwrap();
        assert_eq!(
            landed, program,
            "the staged file must be the program itself"
        );
        assert_ne!(
            landed, archive,
            "the archive must never be installed as the program"
        );
        assert!(
            staged.runtime.is_some(),
            "the runtime the archive carried must be staged too"
        );
        assert_eq!(
            std::fs::read(staged.runtime.as_ref().unwrap()).unwrap(),
            runtime
        );
        // The archive itself is consumed by the unpack; only staged files remain.
        assert!(
            archive_path.exists(),
            "download stays until the caller removes it"
        );

        // And the staged program actually runs.
        #[cfg(unix)]
        {
            let out = std::process::Command::new(&staged.program)
                .output()
                .expect("the staged program runs");
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "atelier-vNEXT");
        }
    }

    /// A crafted archive cannot make the unpacker write outside the staging
    /// directory, and an archive with no program is refused.
    #[test]
    fn the_unpacker_takes_only_the_two_flat_files_it_knows() {
        let dir = tempfile::tempdir().unwrap();
        let archive_path = dir.path().join("only-junk.tar.gz");
        // Names with a directory part are not the flat program/runtime we take.
        let archive = make_flat_archive(&[
            ("nested/atelier", b"no".as_slice()),
            ("bin/node", b"no".as_slice()),
        ]);
        std::fs::write(&archive_path, &archive).unwrap();
        let refused = stage_from_archive(&archive_path, dir.path())
            .expect_err("an archive carrying no flat atelier must be refused");
        assert!(
            refused.contains("no atelier"),
            "the refusal must say the program was missing, got: {refused}"
        );
        assert!(
            !dir.path().join("atelier-new").exists(),
            "nothing may be staged when the program is missing"
        );
    }

    #[test]
    fn test_is_newer() {
        assert!(is_newer("0.4.0", "0.3.1"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.3.1", "0.3.1"));
        assert!(!is_newer("0.3.0", "0.3.1"));
        assert!(is_newer("0.3.2", "0.3.1"));
    }

    // ── fallback_response tests ─────────────────────────────────────────

    #[test]
    fn test_fallback_response_returns_current_version() {
        let resp = fallback_response();
        assert_eq!(resp.current, CURRENT_VERSION);
    }

    #[test]
    fn test_fallback_response_has_no_latest() {
        let resp = fallback_response();
        assert!(resp.latest.is_none());
    }

    #[test]
    fn test_fallback_response_no_update_available() {
        let resp = fallback_response();
        assert!(!resp.update_available);
    }

    #[test]
    fn test_fallback_response_no_download_url() {
        let resp = fallback_response();
        assert!(resp.download_url.is_none());
    }

    #[test]
    fn test_fallback_response_no_release_notes() {
        let resp = fallback_response();
        assert!(resp.release_notes.is_none());
    }

    // ── is_newer edge cases ─────────────────────────────────────────────

    #[test]
    fn test_is_newer_empty_strings() {
        // Both empty -> equal, not newer
        assert!(!is_newer("", ""));
    }

    #[test]
    fn test_is_newer_latest_empty() {
        // Empty latest vs valid current -> not newer
        assert!(!is_newer("", "1.0.0"));
    }

    #[test]
    fn test_is_newer_current_empty() {
        // Valid latest vs empty current -> newer
        assert!(is_newer("1.0.0", ""));
    }

    #[test]
    fn test_is_newer_single_digit_versions() {
        assert!(is_newer("2", "1"));
        assert!(!is_newer("1", "2"));
        assert!(!is_newer("1", "1"));
    }

    #[test]
    fn test_is_newer_different_length_versions() {
        // "1.0.1" vs "1.0" — 1.0.1 > 1.0 because [1,0,1] > [1,0]
        assert!(is_newer("1.0.1", "1.0"));
        // "1.0" vs "1.0.1" — not newer
        assert!(!is_newer("1.0", "1.0.1"));
    }

    #[test]
    fn test_is_newer_non_numeric_parts_ignored() {
        // Non-numeric parts are filtered out by parse::<u32>().ok()
        // "1.2.beta" parses as [1, 2], "1.2.3" parses as [1, 2, 3]
        assert!(!is_newer("1.2.beta", "1.2.3"));
    }

    #[test]
    fn test_is_newer_major_version_bump() {
        assert!(is_newer("2.0.0", "1.99.99"));
    }

    // ── updater script generation (health-check poll loop) ──────────────

    #[test]
    fn test_windows_update_script_uses_poll_loop() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let current_exe = dir.path().join("atelier.exe");
        let new_binary = dir.path().join("atelier-new.exe");

        let script_path = generate_windows_update_script(
            dir.path(),
            &current_exe,
            &new_binary,
            None,
            4242,
            "3008",
        )
        .expect("generate windows script");
        let content = std::fs::read_to_string(&script_path).expect("read windows script");

        // Poll loop present.
        assert!(
            content.contains(":health_loop"),
            "windows script must contain a :health_loop label, got:\n{content}"
        );
        assert!(
            content.contains("if %tries% lss 30"),
            "windows script must retry up to 30 times, got:\n{content}"
        );
        assert!(
            content.contains(":health_ok"),
            "windows script must have a :health_ok success branch, got:\n{content}"
        );
        // Old single-shot pattern (fixed 3s sleep then one check) must be gone.
        assert!(
            !content.contains("timeout /t 3 /nobreak"),
            "windows script must NOT use the old fixed 3s sleep, got:\n{content}"
        );
    }

    #[test]
    fn test_unix_update_script_uses_poll_loop() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let current_exe = dir.path().join("atelier");
        let new_binary = dir.path().join("atelier-new");

        let script_path =
            generate_unix_update_script(dir.path(), &current_exe, &new_binary, None, 4242, "3008")
                .expect("generate unix script");
        let content = std::fs::read_to_string(&script_path).expect("read unix script");

        // Poll loop present.
        assert!(
            content.contains("while [ $i -lt 30 ]"),
            "unix script must poll up to 30 times, got:\n{content}"
        );
        assert!(
            content.contains("healthy=1"),
            "unix script must set a healthy flag on success, got:\n{content}"
        );
        // Old single-shot pattern (fixed `sleep 3` then one check) must be gone.
        assert!(
            !content.contains("\nsleep 3\n"),
            "unix script must NOT use the old fixed `sleep 3`, got:\n{content}"
        );
    }
    #[test]
    fn test_unix_update_script_swaps_the_carried_runtime() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let current_exe = dir.path().join("atelier");
        let new_binary = dir.path().join("atelier-new");
        let new_runtime = dir.path().join("node-new");

        let with_node = std::fs::read_to_string(
            generate_unix_update_script(
                dir.path(),
                &current_exe,
                &new_binary,
                Some(&new_runtime),
                4242,
                "3008",
            )
            .expect("generate unix script with a runtime"),
        )
        .expect("read unix script");
        assert!(
            with_node.contains("mv \"node-new\" \"node\""),
            "with a carried runtime the script must move it into place, got:\n{with_node}"
        );
        assert!(
            with_node.contains("mv \"node\" \"node.old\""),
            "the old runtime must be kept for rollback, got:\n{with_node}"
        );

        // With no runtime, no node lines appear at all.
        let without = std::fs::read_to_string(
            generate_unix_update_script(dir.path(), &current_exe, &new_binary, None, 4242, "3008")
                .expect("generate unix script without a runtime"),
        )
        .expect("read unix script");
        assert!(
            !without.contains("node"),
            "with no carried runtime the script must not mention node, got:\n{without}"
        );
    }
}
