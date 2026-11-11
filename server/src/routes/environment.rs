//! Installed-tool inventory.

use axum::{extract::Path, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
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
    ("claude", "Claude chats", "Install and sign in at https://docs.anthropic.com/en/docs/claude-code."),
    ("codex", "Codex chats", "Install and sign in at https://developers.openai.com/codex/cli."),
    ("browser", "each chat's private Chrome and screen checks", "Install Chrome, Chromium, or Edge to use the browser and capture evidence."),
];

fn key(tool: &str) -> String { format!("tool.{tool}.path") }

async fn inspect(tool: &'static str, required_for: &'static str, hint: &'static str) -> ToolStatus {
    let path = if tool == "browser" {
        crate::workbench::browser::browser_executable()
    } else {
        super::find_tool(tool, &[])
    };
    let version = if let Some(program) = path.as_ref() {
        tokio::time::timeout(std::time::Duration::from_secs(3),
            tokio::process::Command::new(program).arg("--version").output()).await.ok().and_then(Result::ok)
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
    Json(futures::future::join_all(TOOLS.map(|(tool, required_for, hint)|
        inspect(tool, required_for, hint))).await)
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
        if !super::runnable(&candidate) {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":format!("{} is not an executable file", candidate.display())})));
        }
    }
    if let Err(error) = db.set_setting(&key(&tool), chosen.as_deref()) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":error.to_string()})));
    }
    super::set_tool_override(&tool, chosen.map(PathBuf::from));
    (StatusCode::OK, Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_bootstrap_reports_every_real_external_dependency() {
        assert_eq!(TOOLS.iter().map(|row| row.0).collect::<Vec<_>>(),
            ["git", "claude", "codex", "browser"]);
        assert!(TOOLS.iter().all(|row| !matches!(row.0, "node" | "npm" | "python" | "python3")));
    }
}
