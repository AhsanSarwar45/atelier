//! Version check route handlers.
//!
//! Checks GitHub Releases for newer versions and caches the result.
//! Also provides auto-update functionality via ephemeral updater scripts.

use axum::{
    http::StatusCode,
    response::{
        sse::{Event as SseEvent, Sse},
        IntoResponse,
    },
    Json,
};
use futures::Stream;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tracing::{info, warn};

use crate::routes::install_method::{self, InstallMethod};
use crate::routes::update_run::{Phase, UpdateRun, UpdateWatch};

/// Current version compiled into the binary.
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// GitHub repository for release checks.
const GITHUB_REPO: &str = "AhsanSarwar45/atelier"; // the repository address, not the product name

/// How much of a release's notes is kept.
///
/// This was 500 while the notes were only teased in a corner notice. The About
/// section renders them, so it is the length of a real release body now — still
/// bounded, because the field is whatever somebody typed into GitHub.
const NOTES_LIMIT: usize = 4000;

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
    /// Release notes, up to `NOTES_LIMIT`
    pub release_notes: Option<String>,
    /// Direct download URL for the platform-specific binary asset
    pub asset_url: Option<String>,
    /// Direct download URL for the release's own SHA256SUMS.txt, read off the
    /// same release as `asset_url` so a download can only ever be proved
    /// against the release it came from
    pub checksums_url: Option<String>,
    /// The version the person asked not to be told about again, if any.
    ///
    /// Read from the settings table on every answer rather than kept with the
    /// cached release, because a skip takes effect the moment it is made and
    /// the release information behind it is an hour stale by design.
    ///
    /// `update_available` is left alone by a skip: an update that exists still
    /// exists, and the About section goes on offering it. Only the notice
    /// reads this field, and only to decide whether to keep quiet.
    #[serde(default)]
    pub skipped_version: Option<String>,
    /// How this copy was installed — `homebrew` or `standalone`. What updating
    /// will actually do depends on it.
    #[serde(default)]
    pub install_method: Option<String>,
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

/// What a caller may ask of the version check.
#[derive(Debug, Deserialize)]
pub struct CheckQuery {
    /// Ask GitHub again rather than answering from the hour-old cache.
    ///
    /// Without this there is no way to see a release made in the last hour,
    /// which is exactly when somebody who has just heard about one will look.
    #[serde(default)]
    refresh: bool,
}

/// GET /api/version/check
///
/// The running version, the newest released one, and what updating would do.
///
/// The release itself is cached for an hour so GitHub is not asked on every
/// page load; `?refresh=true` asks anyway. The two fields that are not the
/// release — what was skipped, and how this copy was installed — are filled in
/// on every answer, because a skip has to take effect at once and neither is
/// GitHub's to tell us.
pub async fn version_check(
    axum::extract::Extension(cache): axum::extract::Extension<VersionCache>,
    axum::extract::Extension(db): axum::extract::Extension<Arc<crate::db::Database>>,
    axum::extract::Query(asked): axum::extract::Query<CheckQuery>,
) -> impl IntoResponse {
    let mut result = checked(&cache, asked.refresh).await;

    result.skipped_version = crate::routes::update_settings::update_settings(&db)
        .ok()
        .and_then(|settings| settings.skipped_version);
    result.install_method = Some(install_method::current().name().to_string());

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
    let asset_url = current_platform_asset().and_then(|name| asset_named(name));
    let checksums_url = asset_named(crate::published::CHECKSUMS_ASSET);

    VersionCheckResponse {
        current: CURRENT_VERSION.to_string(),
        latest: Some(latest_version),
        update_available,
        download_url: Some(release.html_url),
        release_notes: release.body.map(|b| {
            if b.len() > NOTES_LIMIT {
                let mut end = NOTES_LIMIT;
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
        skipped_version: None,
        install_method: None,
    }
}

/// Compares two semver strings. Returns true if `latest` > `current`.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse =
        |s: &str| -> Vec<u32> { s.split('.').filter_map(|p| p.parse::<u32>().ok()).collect() };
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
        skipped_version: None,
        install_method: None,
    }
}

/// The release archive this platform downloads to update itself.
///
/// A release publishes one single-program archive for each supported platform.
/// The updater must return `None` on platforms the release workflow does not
/// publish rather than advertising an archive that cannot exist.
fn current_platform_asset() -> Option<&'static str> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// The archive name for a named platform, split out so every target the build
/// releases can be proved against the names the workflow uploads, not just the
/// one this test binary happens to run on.
fn asset_for(target_os: &str, target_arch: &str) -> Option<&'static str> {
    match (target_os, target_arch) {
        ("linux", "x86_64") => Some("atelier-linux-x64.tar.gz"),
        _ => None,
    }
}

/// GET /api/update/progress
///
/// What the update running right now is doing, as it does it.
///
/// The state as it stands is sent the moment a watcher connects, so a screen
/// opened halfway through an update draws the right thing instead of waiting
/// for the next chunk to arrive. Every change after that is sent as it
/// happens. `serving.rs` already keeps `text/event-stream` out of the
/// compressor, so frames are not held back waiting for a buffer to fill.
pub async fn update_progress(
    axum::extract::Extension(watch): axum::extract::Extension<UpdateWatch>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let mut changes = watch.watch();
    let opening = watch.now().await;
    let (tx, rx) = tokio::sync::mpsc::channel::<UpdateRun>(64);

    tokio::spawn(async move {
        if tx.send(opening).await.is_err() {
            return;
        }
        loop {
            match changes.recv().await {
                Ok(run) => {
                    if tx.send(run).await.is_err() {
                        break;
                    }
                }
                // A watcher too slow to keep up is caught up to the newest
                // state rather than dropped: a progress bar only ever wants
                // the latest figure, never the ones it missed.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let frames = ReceiverStream::new(rx).map(|run| Ok::<_, Infallible>(frame(&run)));
    Sse::new(frames).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(30))
            .text("ping"),
    )
}

/// One update's state, as an event a screen can read.
fn frame(run: &UpdateRun) -> SseEvent {
    SseEvent::default().json_data(run).unwrap_or_else(|_| {
        SseEvent::default().data(r#"{"phase":"failed","failed":"could not report progress"}"#)
    })
}

/// POST /api/update
///
/// Starts an update and returns at once.
///
/// This used to hold the request open for the whole download, unpack and
/// restart, saying nothing until it was over. It now checks what it can check
/// cheaply, takes the run, and hands the work to a background task that
/// reports itself through `GET /api/update/progress`. The refusals that can be
/// known up front — nothing to update to, no build for this platform, an
/// update already under way — are still answered on this request, because a
/// screen should not have to open a stream to be told it asked for nothing.
pub async fn perform_update(
    axum::extract::Extension(cache): axum::extract::Extension<VersionCache>,
    axum::extract::Extension(watch): axum::extract::Extension<UpdateWatch>,
) -> impl IntoResponse {
    let check = checked(&cache, false).await;

    if !check.update_available {
        return (
            StatusCode::OK,
            Json(serde_json::json!({"status": "up_to_date"})),
        );
    }

    // A Homebrew install upgrades through Homebrew, which needs no release
    // asset of its own — brew fetches the same archive itself. Only a
    // standalone install has to have an asset named for this platform.
    let how = install_method::current();
    if how == InstallMethod::Standalone && (check.asset_url.is_none() || current_platform_asset().is_none())
    {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "No binary available for this platform"})),
        );
    }

    if !watch.claim(check.latest.clone()).await {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "An update is already running"})),
        );
    }

    tokio::spawn(run_update(check, watch, how));

    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"status": "started"})),
    )
}

/// The release to move to, from the cache when it is fresh enough.
async fn checked(cache: &VersionCache, refresh: bool) -> VersionCheckResponse {
    if !refresh {
        let cached = cache.read().await;
        if let Some(ref entry) = *cached {
            if entry.fetched_at.elapsed().as_secs() < CACHE_TTL_SECS {
                return entry.result.clone();
            }
        }
    }

    let result = check_github_release().await;
    let mut cached = cache.write().await;
    *cached = Some(CachedCheck {
        result: result.clone(),
        fetched_at: std::time::Instant::now(),
    });
    result
}

/// Take the update, reporting every step, and exit so the new program starts.
///
/// Nothing here returns a status code, because nobody is waiting on a request:
/// every outcome is published to whoever is watching. A failure leaves the
/// running program exactly as it was — that is true of the download because a
/// mismatch deletes what it wrote, and true of everything after it because the
/// program is only ever replaced by the script at the very end.
async fn run_update(check: VersionCheckResponse, watch: UpdateWatch, how: InstallMethod) {
    let outcome = match how {
        InstallMethod::Homebrew => run_homebrew(&watch).await,
        InstallMethod::Standalone => run_standalone(check, &watch).await,
    };

    match outcome {
        Ok(script) => {
            watch.phase(Phase::Restarting, None).await;
            let spawned = if cfg!(windows) {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "/B", "", script.to_str().unwrap_or("")])
                    .spawn()
            } else {
                std::process::Command::new("sh").arg(&script).spawn()
            };

            if let Err(e) = spawned {
                warn!("Failed to spawn updater: {}", e);
                let _ = std::fs::remove_file(&script);
                watch
                    .failed(format!("Failed to start the updater: {}", e))
                    .await;
                return;
            }

            watch.done().await;

            // Long enough for the last frame to reach whoever is watching
            // before the stream goes down with the process.
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                info!("Exiting for update...");
                std::process::exit(0);
            });
        }
        Err(why) => {
            warn!("The update did not happen: {}", why);
            watch.failed(why).await;
        }
    }
}

/// Download the release archive, prove it, stage it, and write the script that
/// swaps it in. Returns the script to run.
async fn run_standalone(
    check: VersionCheckResponse,
    watch: &UpdateWatch,
) -> Result<PathBuf, String> {
    let asset_url = check
        .asset_url
        .clone()
        .ok_or("No binary available for this platform")?;

    let current_exe = std::env::current_exe()
        .map(|p| p.canonicalize().unwrap_or(p))
        .map_err(|e| format!("Cannot determine executable path: {}", e))?;
    let current_dir = current_exe
        .parent()
        .ok_or("Cannot determine executable directory")?
        .to_path_buf();
    let current_adapters = crate::workbench::acp::adapter::find("claude")
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| current_dir.join("atelier-adapters"));

    let archive_name = current_platform_asset().ok_or("No binary available for this platform")?;
    let archive_path = current_dir.join("atelier-update-archive");

    info!("Downloading update from: {}", asset_url);

    let client = reqwest::Client::builder()
        .user_agent(crate::identity::NAME)
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // The archive is written beside the running program under its own name and
    // hashed as it arrives, and it is kept only if it matches the checksum this
    // same release publishes for it. A download that does not match is deleted
    // where it lies and the reason is handed back: the running program is not
    // touched by any of this, because it is only ever replaced by the updater
    // script below, which a refusal never reaches.
    //
    // The byte count is published as it goes. It counts bytes *received*, not
    // bytes proved, which is why `Verifying` is its own phase after the bar
    // fills rather than part of it.
    let counting = {
        let watch = watch.clone();
        move |received: u64, total: Option<u64>| {
            let watch = watch.clone();
            tokio::spawn(async move { watch.arrived(received, total).await });
        }
    };

    let written = crate::published::download_watched(
        &client,
        &asset_url,
        check.checksums_url.as_deref(),
        archive_name,
        &archive_path,
        &counting,
    )
    .await
    .map_err(|problem| {
        if problem.is_refusal() {
            warn!("Refused the update download: {}", problem);
        } else {
            warn!("The update download did not finish: {}", problem);
        }
        problem.reason().to_string()
    })?;

    // The proof happened inside the download, as the bytes went past. Saying so
    // here keeps the phases honest about the order work actually happened in.
    watch.phase(Phase::Verifying, None).await;

    // Unpack the program out of the proved archive, staged next to the running
    // program for the updater script to move into place. The archive is removed
    // once its contents are out, so a `.tar.gz` is never installed as the program.
    watch
        .phase(Phase::Unpacking, Some("Unpacking the new version".into()))
        .await;
    let staged = stage_from_archive(&archive_path, &current_dir).inspect_err(|e| {
        let _ = std::fs::remove_file(&archive_path);
        warn!("The update archive could not be unpacked: {}", e);
    })?;
    let _ = std::fs::remove_file(&archive_path);

    info!(
        "Downloaded update: {} bytes -> {}",
        written,
        staged.program.display()
    );

    let port = std::env::var("PORT").unwrap_or_else(|_| "3008".to_string());
    let pid = std::process::id();

    let script = if cfg!(windows) {
        generate_windows_update_script(
            &current_dir,
            &current_exe,
            &staged.program,
            &current_adapters,
            &staged.adapters,
            pid,
            &port,
        )
    } else {
        generate_unix_update_script(
            &current_dir,
            &current_exe,
            &staged.program,
            &current_adapters,
            &staged.adapters,
            pid,
            &port,
        )
    };

    script.map_err(|e| {
        let _ = std::fs::remove_file(&staged.program);
        let _ = std::fs::remove_dir_all(&staged.adapters);
        format!("Failed to create update script: {}", e)
    })
}

/// Upgrade through Homebrew, then write a script that only restarts.
///
/// Brew has already put the new files where it wants them, so there is nothing
/// to move and no `.old` to keep — the program just has to go down and come
/// back. Brew does not say how many bytes it is fetching, so this path reports
/// its own output lines instead and leaves the bar indeterminate.
async fn run_homebrew(watch: &UpdateWatch) -> Result<PathBuf, String> {
    let brew = install_method::brew().ok_or(
        "This copy was installed with Homebrew, but brew cannot be found to upgrade it.",
    )?;

    // `brew upgrade` can only see a release the tap has been told about.
    watch
        .phase(Phase::Downloading, Some("Refreshing Homebrew".into()))
        .await;
    say(&brew, &["update"], watch).await?;

    watch
        .phase(
            Phase::Downloading,
            Some(format!("Upgrading {}", install_method::FORMULA)),
        )
        .await;
    say(&brew, &["upgrade", install_method::FORMULA], watch).await?;

    let current_exe = std::env::current_exe()
        .map(|p| p.canonicalize().unwrap_or(p))
        .map_err(|e| format!("Cannot determine executable path: {}", e))?;
    let current_dir = current_exe
        .parent()
        .ok_or("Cannot determine executable directory")?
        .to_path_buf();
    let port = std::env::var("PORT").unwrap_or_else(|_| "3008".to_string());

    // Started again through the link on the path, not through the resolved
    // Cellar path this process was launched from: that one still names the
    // version brew has just replaced.
    let restart_as = install_method::linked(&current_exe).unwrap_or(current_exe);

    generate_unix_restart_script(&current_dir, &restart_as, std::process::id(), &port)
        .map_err(|e| format!("Failed to create restart script: {}", e))
}

/// Run one brew command, publishing each line it prints.
///
/// Brew writes its progress to stderr and its results to stdout, and a person
/// watching wants whichever came last, so both are read as one.
async fn say(brew: &Path, args: &[&str], watch: &UpdateWatch) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = tokio::process::Command::new(brew)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run brew {}: {}", args.join(" "), e))?;

    let out = child.stdout.take().ok_or("Could not read brew's output")?;
    let err = child.stderr.take().ok_or("Could not read brew's output")?;
    let mut lines = BufReader::new(out).lines();
    let mut trouble = BufReader::new(err).lines();

    // The last thing brew said, kept so a failure can be reported in brew's own
    // words rather than as a bare exit code.
    let mut newest = String::new();

    loop {
        let line = tokio::select! {
            said = lines.next_line() => said,
            said = trouble.next_line() => said,
        };
        match line {
            Ok(Some(said)) => {
                let said = said.trim().to_string();
                if !said.is_empty() {
                    info!("brew: {}", said);
                    newest = said.clone();
                    watch.note(said).await;
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Could not read brew's output: {}", e)),
        }
    }

    let ended = child
        .wait()
        .await
        .map_err(|e| format!("brew {} did not finish: {}", args.join(" "), e))?;

    if !ended.success() {
        return Err(if newest.is_empty() {
            format!("brew {} failed. Nothing was replaced.", args.join(" "))
        } else {
            format!(
                "brew {} failed: {}. Nothing was replaced.",
                args.join(" "),
                newest
            )
        });
    }

    Ok(())
}

/// A script that waits for this process to go and starts the program again.
///
/// The swapping script's sibling, for the Homebrew path, where there is
/// nothing to swap: brew has already replaced the files. It waits for the old
/// process to exit so the port is free, starts the program again, and removes
/// itself. There is no rollback because nothing here was moved — if the new
/// program will not start, brew is the thing that knows how to put the old one
/// back, and it still has it.
fn generate_unix_restart_script(
    dir: &Path,
    start: &Path,
    pid: u32,
    port: &str,
) -> Result<PathBuf, String> {
    let script_path = dir.join("beads-restart.sh");
    let start = start.to_string_lossy();

    let content = format!(
        r#"#!/bin/sh
# Written by the running program and removed by its last line. Waits for the
# old process to let go of the port, then starts the new one Homebrew installed.
set -e

for _ in $(seq 1 30); do
  kill -0 {pid} 2>/dev/null || break
  sleep 1
done

PORT={port} "{start}" &

rm -f "$0"
"#
    );

    std::fs::write(&script_path, content)
        .map_err(|e| format!("Failed to write restart script: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to make the restart script runnable: {}", e))?;
    }

    Ok(script_path)
}

/// The files unpacked from the release archive, staged beside the running
/// program and waiting for the updater script to move them into place.
#[derive(Debug)]
struct StagedUpdate {
    /// The new program, under a name that is not the running one.
    program: PathBuf,
    /// Complete provider bundle, staged as one directory for an atomic swap.
    adapters: PathBuf,
}

/// Unpack the proved release archive and stage the program next to the running
/// program.
///
/// A release archive is a gzipped tar carrying one flat program entry
/// (`.github/workflows/release.yml`). Only that name is taken and written under
/// a `-new` name so the running program is untouched until the updater script
/// swaps it. The archive
/// is our own and already proved against the release's published checksum, but
/// it is still read defensively: only a regular file whose name is exactly the
/// program, with no directory part, is unpacked, and to a path
/// this function chooses rather than one the archive names -- so a crafted entry
/// cannot write anywhere else.
fn stage_from_archive(archive: &Path, dir: &Path) -> Result<StagedUpdate, String> {
    let program_name = if cfg!(windows) {
        "atelier.exe"
    } else {
        "atelier"
    };
    let staged_program = dir.join(if cfg!(windows) {
        "atelier-new.exe"
    } else {
        "atelier-new"
    });
    let staged_adapters = dir.join("atelier-adapters-new");
    let _ = std::fs::remove_dir_all(&staged_adapters);
    std::fs::create_dir(&staged_adapters)
        .map_err(|e| format!("{}: {e}", staged_adapters.display()))?;

    let bytes = std::fs::read(archive)
        .map_err(|e| format!("could not read the downloaded archive: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut tar = tar::Archive::new(decoder);
    let entries = tar
        .entries()
        .map_err(|e| format!("the update archive could not be read: {e}"))?;

    let mut got_program = false;
    let adapter_names = if cfg!(windows) {
        [
            "claude-acp.exe",
            "codex-acp.exe",
            "goose-acp.exe",
            "manifest.json",
        ]
    } else {
        ["claude-acp", "codex-acp", "goose-acp", "manifest.json"]
    };
    let mut got_adapters = std::collections::HashSet::new();
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
        let mut parts = named.components();
        let first = parts.next();
        let second = parts.next();
        let third = parts.next();
        if let (Some(std::path::Component::Normal(name)), None, None) = (first, second, third) {
            if name == program_name {
                entry
                    .unpack(&staged_program)
                    .map_err(|e| format!("{}: {e}", staged_program.display()))?;
                make_runnable(&staged_program)?;
                got_program = true;
            }
            continue;
        }
        let (
            Some(std::path::Component::Normal(folder)),
            Some(std::path::Component::Normal(file)),
            None,
        ) = (first, second, third)
        else {
            continue;
        };
        if folder != "atelier-adapters" {
            continue;
        }
        let leaf = file.to_str().unwrap_or_default();
        if !adapter_names.contains(&leaf) || !got_adapters.insert(leaf.to_string()) {
            continue;
        }
        let destination = staged_adapters.join(leaf);
        entry
            .unpack(&destination)
            .map_err(|e| format!("{}: {e}", destination.display()))?;
        if leaf != "manifest.json" {
            make_runnable(&destination)?;
        }
    }

    if !got_program {
        let _ = std::fs::remove_file(&staged_program);
        let _ = std::fs::remove_dir_all(&staged_adapters);
        return Err("the update archive carried no atelier program".to_string());
    }
    if got_adapters.len() != adapter_names.len() {
        let _ = std::fs::remove_file(&staged_program);
        let _ = std::fs::remove_dir_all(&staged_adapters);
        return Err("the update archive carried an incomplete ACP adapter bundle".to_string());
    }

    Ok(StagedUpdate {
        program: staged_program,
        adapters: staged_adapters,
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
    current_adapters: &Path,
    new_adapters: &Path,
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
    let adapters = current_adapters.to_string_lossy();
    let new_adapters = new_adapters.to_string_lossy();

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

# Replace the program
mv "{exe_name}" "{exe_name}.old" 2>/dev/null
mv "{new_name}" "{exe_name}"
chmod +x "{exe_name}"
mv "{adapters}" "{adapters}.old" 2>/dev/null
mv "{new_adapters}" "{adapters}"
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
    rm -rf "{adapters}.old"
else
    echo "Health check failed, rolling back..."
    kill $NEW_PID 2>/dev/null
    sleep 1
    mv "{exe_name}" "{new_name}" 2>/dev/null
    mv "{exe_name}.old" "{exe_name}" 2>/dev/null
    rm -rf "{adapters}"
    mv "{adapters}.old" "{adapters}" 2>/dev/null
    PORT=$PORT ./{exe_name} &
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
    current_adapters: &Path,
    new_adapters: &Path,
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
    let adapters = current_adapters.to_string_lossy();
    let new_adapters = new_adapters.to_string_lossy();

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
if exist "{adapters}.old" rmdir /s /q "{adapters}.old"
if exist "{adapters}" move /y "{adapters}" "{adapters}.old" >nul
move /y "{new_adapters}" "{adapters}" >nul
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
if exist "{adapters}" rmdir /s /q "{adapters}"
if exist "{adapters}.old" move /y "{adapters}.old" "{adapters}" >nul
set PORT=%PORT%
start /B "" "{exe_name}"
goto cleanup

:health_ok
echo Update successful!
del /f "{exe_name}.old" 2>nul
if exist "{adapters}.old" rmdir /s /q "{adapters}.old"
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
    /// the named program and adapter entries.
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
            if let Some(asset) = asset_for(os, arch) {
                assert!(
                    uploaded.iter().any(|uploaded| uploaded == asset),
                    "the updater asks for {asset} on {os}/{arch}, which release.yml does not \
                     upload; it uploads {uploaded:?}"
                );
            }
        }
        assert_eq!(
            asset_for("linux", "x86_64"),
            uploaded.first().map(String::as_str)
        );
        assert_eq!(asset_for("macos", "aarch64"), None);
        assert_eq!(asset_for("macos", "x86_64"), None);
        assert_eq!(asset_for("windows", "x86_64"), None);
    }

    /// An update, run against a fixture release, ends as a runnable program at
    /// the destination -- not the archive it arrived in.
    #[tokio::test]
    async fn an_update_ends_as_a_runnable_program_not_the_archive() {
        use sha2::{Digest, Sha256};
        let program = b"#!/bin/sh\necho atelier-vNEXT\n";
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
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let archive = make_flat_archive(&[
            (program_name, program.as_slice()),
            (
                &format!("atelier-adapters/claude-acp{suffix}"),
                b"claude-acp",
            ),
            (&format!("atelier-adapters/codex-acp{suffix}"), b"codex-acp"),
            (&format!("atelier-adapters/goose-acp{suffix}"), b"goose-acp"),
            ("atelier-adapters/manifest.json", b"{}"),
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
            .expect("the archive unpacks into a staged program");

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
        assert_eq!(
            std::fs::read(staged.adapters.join(format!("codex-acp{suffix}"))).unwrap(),
            b"codex-acp"
        );
        assert_eq!(
            std::fs::read(staged.adapters.join(format!("goose-acp{suffix}"))).unwrap(),
            b"goose-acp"
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
    fn the_unpacker_takes_only_the_flat_program_it_knows() {
        let dir = tempfile::tempdir().unwrap();
        let archive_path = dir.path().join("only-junk.tar.gz");
        // Names with a directory part are not the flat program we take.
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
            &dir.path().join("atelier-adapters"),
            &dir.path().join("atelier-adapters-new"),
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

        let script_path = generate_unix_update_script(
            dir.path(),
            &current_exe,
            &new_binary,
            &dir.path().join("atelier-adapters"),
            &dir.path().join("atelier-adapters-new"),
            4242,
            "3008",
        )
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
    fn update_scripts_never_mention_node() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let current_exe = dir.path().join("atelier");
        let new_binary = dir.path().join("atelier-new");
        let unix = std::fs::read_to_string(
            generate_unix_update_script(
                dir.path(),
                &current_exe,
                &new_binary,
                &dir.path().join("atelier-adapters"),
                &dir.path().join("atelier-adapters-new"),
                4242,
                "3008",
            )
            .expect("generate unix script"),
        )
        .expect("read unix script");
        assert!(
            !unix.to_ascii_lowercase().contains("node"),
            "the Unix updater must not mention Node, got:\n{unix}"
        );

        let windows = std::fs::read_to_string(
            generate_windows_update_script(
                dir.path(),
                &dir.path().join("atelier.exe"),
                &dir.path().join("atelier-new.exe"),
                &dir.path().join("atelier-adapters"),
                &dir.path().join("atelier-adapters-new"),
                4242,
                "3008",
            )
            .expect("generate Windows script"),
        )
        .expect("read Windows script");
        assert!(
            !windows.to_ascii_lowercase().contains("node"),
            "the Windows updater must not mention Node, got:\n{windows}"
        );
    }
}
