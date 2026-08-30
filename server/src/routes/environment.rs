//! Installed-tool inventory and the only automatic dependency install.

use axum::{extract::Path, http::StatusCode, Extension, Json};
use directories::UserDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::db::Database;

#[derive(Clone)]
pub struct BootstrapBus(pub broadcast::Sender<Value>);

pub fn bootstrap_bus() -> BootstrapBus {
    let (sender, _) = broadcast::channel(64);
    BootstrapBus(sender)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    tool: &'static str,
    required_for: &'static str,
    found: bool,
    path: Option<String>,
    version: Option<String>,
    ok: bool,
    hint: &'static str,
}

const TOOLS: [(&str, &str, &str); 4] = [
    ("git", "projects and history", "Install Git from https://git-scm.com/downloads."),
    ("bd", "Beads boards", "Install here, or install Beads from https://github.com/gastownhall/beads."),
    ("claude", "Claude chats", "Install and sign in at https://docs.anthropic.com/en/docs/claude-code."),
    ("codex", "Codex chats", "Install and sign in at https://developers.openai.com/codex/cli."),
];

fn key(tool: &str) -> String { format!("tool.{tool}.path") }

async fn inspect(tool: &'static str, required_for: &'static str, hint: &'static str) -> ToolStatus {
    let path = super::find_tool(tool, &[]);
    let version = if let Some(program) = path.as_ref() {
        tokio::process::Command::new(program)
            .arg("--version")
            .output().await.ok()
            .map(|output| {
                let text = if output.stdout.is_empty() { &output.stderr } else { &output.stdout };
                String::from_utf8_lossy(text).trim().to_string()
            })
            .filter(|text| !text.is_empty())
    } else { None };
    ToolStatus {
        tool, required_for, found: path.is_some(), ok: path.is_some(),
        path: path.map(|path| path.display().to_string()), version, hint,
    }
}

pub async fn read(Extension(db): Extension<Arc<Database>>) -> Json<Vec<ToolStatus>> {
    for (tool, _, _) in TOOLS {
        if let Ok(path) = db.setting(&key(tool)) {
            super::set_tool_override(tool, path.map(PathBuf::from));
        }
    }
    let mut answer = Vec::with_capacity(TOOLS.len());
    for (tool, required_for, hint) in TOOLS {
        answer.push(inspect(tool, required_for, hint).await);
    }
    Json(answer)
}

#[derive(Deserialize)]
pub struct ToolChoice { path: Option<String> }

pub async fn choose(
    Path(tool): Path<String>, Extension(db): Extension<Arc<Database>>, Json(choice): Json<ToolChoice>,
) -> (StatusCode, Json<Value>) {
    if !TOOLS.iter().any(|known| known.0 == tool) {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Unknown tool"})));
    }
    let chosen = choice.path.map(|path| path.trim().to_string()).filter(|path| !path.is_empty());
    if let Some(path) = chosen.as_ref() {
        let candidate = PathBuf::from(path);
        if !candidate.is_file() {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":format!("{} is not a file", candidate.display())})));
        }
    }
    if let Err(error) = db.set_setting(&key(&tool), chosen.as_deref()) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":error.to_string()})));
    }
    super::set_tool_override(&tool, chosen.map(PathBuf::from));
    (StatusCode::OK, Json(json!({"ok":true})))
}

#[derive(Deserialize)]
struct Release { assets: Vec<Asset> }
#[derive(Deserialize)]
struct Asset { name: String, browser_download_url: String }

fn platform_words() -> Result<(&'static str, &'static str, &'static str), String> {
    let os = match std::env::consts::OS { "macos" => "darwin", "linux" => "linux", "windows" => "windows", other => return Err(format!("Beads has no installer for {other}")) };
    let arch = match std::env::consts::ARCH { "x86_64" => "amd64", "aarch64" => "arm64", other => return Err(format!("Beads has no installer for {other}")) };
    Ok((os, arch, if os == "windows" { ".zip" } else { ".tar.gz" }))
}

fn safe_relative(path: &FsPath) -> bool {
    path.components().all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn extract_bd(archive: &FsPath, destination: &FsPath, zip: bool) -> Result<(), String> {
    let staged = destination.with_extension("new");
    let _ = std::fs::remove_file(&staged);
    if zip {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
            let Some(name) = entry.enclosed_name() else { continue };
            if name.file_name().and_then(|n| n.to_str()) == Some("bd.exe") {
                let mut output = std::fs::File::create(&staged).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
                std::fs::rename(&staged, destination).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    } else {
        let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        for item in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = item.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?;
            if safe_relative(&path) && path.file_name().and_then(|n| n.to_str()) == Some("bd") {
                let mut output = std::fs::File::create(&staged).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
                output.flush().map_err(|e| e.to_string())?;
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
                }
                std::fs::rename(&staged, destination).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    let _ = std::fs::remove_file(staged);
    Err("The Beads archive did not contain bd".into())
}

fn progress(bus: &BootstrapBus, phase: &str, detail: impl Into<String>) {
    let _ = bus.0.send(json!({"tool":"bd","phase":phase,"detail":detail.into()}));
}

pub async fn install_bd(Extension(bus): Extension<BootstrapBus>) -> (StatusCode, Json<Value>) {
    if let Some(path) = super::find_bd() {
        return (StatusCode::OK, Json(json!({"ok":true,"path":path})));
    }
    progress(&bus, "checking", "Finding the latest Beads release");
    let client = match reqwest::Client::builder().user_agent(crate::identity::NAME).timeout(std::time::Duration::from_secs(300)).build() {
        Ok(client) => client,
        Err(error) => return failed(&bus, error.to_string()),
    };
    let release = match client.get("https://api.github.com/repos/gastownhall/beads/releases/latest").send().await {
        Ok(response) => match response.error_for_status() { Ok(response) => match response.json::<Release>().await { Ok(release) => release, Err(error) => return failed(&bus, error.to_string()) }, Err(error) => return failed(&bus, error.to_string()) },
        Err(error) => return failed(&bus, error.to_string()),
    };
    let (os, arch, ending) = match platform_words() { Ok(value) => value, Err(error) => return failed(&bus, error) };
    let asset = release.assets.iter().find(|asset| asset.name.contains(os) && asset.name.contains(arch) && asset.name.ends_with(ending));
    let checksums = release.assets.iter().find(|asset| asset.name.eq_ignore_ascii_case("checksums.txt") || asset.name.eq_ignore_ascii_case(crate::published::CHECKSUMS_ASSET));
    let Some(asset) = asset else { return failed(&bus, "No Beads archive is published for this platform".into()) };
    let Some(checksums) = checksums else { return failed(&bus, "The Beads release publishes no checksum list; refusing an unverified install".into()) };
    let Some(home) = UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf()) else { return failed(&bus, "Could not find your home directory".into()) };
    let directory = home.join(".beads/bin");
    if let Err(error) = std::fs::create_dir_all(&directory) { return failed(&bus, error.to_string()) }
    let archive = directory.join(format!(".{}-download", asset.name));
    progress(&bus, "downloading", format!("Downloading {}", asset.name));
    if let Err(error) = crate::published::download(&client, &asset.browser_download_url, Some(&checksums.browser_download_url), &asset.name, &archive).await {
        return failed(&bus, error.to_string());
    }
    progress(&bus, "installing", "Installing the verified bd binary");
    let destination = directory.join(if cfg!(windows) { "bd.exe" } else { "bd" });
    let extracted = extract_bd(&archive, &destination, ending == ".zip");
    let _ = std::fs::remove_file(&archive);
    if let Err(error) = extracted { return failed(&bus, error) }
    super::set_tool_override("bd", Some(destination.clone()));
    progress(&bus, "complete", format!("Installed {}", destination.display()));
    (StatusCode::OK, Json(json!({"ok":true,"path":destination})))
}

fn failed(bus: &BootstrapBus, error: String) -> (StatusCode, Json<Value>) {
    progress(bus, "error", error.clone());
    (StatusCode::BAD_GATEWAY, Json(json!({"error":error})))
}
