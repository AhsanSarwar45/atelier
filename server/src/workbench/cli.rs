//! CLI adapters for presentation and screen-check requests.
//!
//! The CLI sends uploads to the already-running Rust server so durable media
//! remains owned by that process. It contains no provider runtime or sidecar.

use base64::Engine;
use serde::Serialize;

#[derive(Serialize)]
struct UploadedRequest<'a> {
    args: &'a [String],
    stdin: String,
    files: std::collections::BTreeMap<String, String>,
}

fn uploaded_request<'a>(
    rest: &'a [String],
    stdin: String,
    upload_flags: &[&str],
) -> Result<UploadedRequest<'a>, String> {
    let mut files = std::collections::BTreeMap::new();
    for (at, word) in rest.iter().enumerate() {
        if !upload_flags.contains(&word.as_str()) {
            continue;
        }
        let path = rest
            .get(at + 1)
            .ok_or_else(|| format!("missing value for {word}"))?;
        let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        files.insert(
            path.clone(),
            base64::engine::general_purpose::STANDARD.encode(bytes),
        );
    }
    Ok(UploadedRequest {
        args: rest,
        stdin,
        files,
    })
}

fn presentation_request(rest: &[String], stdin: String) -> Result<UploadedRequest<'_>, String> {
    uploaded_request(rest, stdin, &["--file", "--input", "--before", "--after"])
}

fn screen_check_request(rest: &[String]) -> Result<UploadedRequest<'_>, String> {
    let mut request = uploaded_request(
        rest,
        String::new(),
        &[
            "--target",
            "--before",
            "--after",
            "--recipe",
            "--before-recipe",
            "--after-recipe",
        ],
    )?;
    for (at, word) in rest.iter().enumerate() {
        if !matches!(
            word.as_str(),
            "--recipe" | "--before-recipe" | "--after-recipe"
        ) {
            continue;
        }
        let path = rest
            .get(at + 1)
            .ok_or_else(|| format!("missing value for {word}"))?;
        let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        let recipe: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|error| format!("{path}: {error}"))?;
        let mut references = Vec::new();
        if let Some(state) = recipe
            .pointer("/auth/storage_state")
            .and_then(|value| value.as_str())
        {
            references.push(state.to_string());
        }
        references.extend(
            recipe["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|action| action["file"].as_str().map(str::to_string)),
        );
        let directory = std::path::Path::new(path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .canonicalize()
            .map_err(|error| format!("{path}: {error}"))?;
        for reference in references {
            let candidate = if std::path::Path::new(&reference).is_absolute() {
                std::path::PathBuf::from(&reference)
            } else {
                directory.join(&reference)
            };
            let canonical = candidate
                .canonicalize()
                .map_err(|error| format!("{reference}: {error}"))?;
            if !canonical.starts_with(&directory) {
                return Err(format!(
                    "{reference}: recipe files must stay beside the recipe"
                ));
            }
            let data =
                std::fs::read(&canonical).map_err(|error| format!("{reference}: {error}"))?;
            let key = if word == "--recipe" {
                reference
            } else {
                format!("{path}::{reference}")
            };
            request
                .files
                .insert(key, base64::engine::general_purpose::STANDARD.encode(data));
        }
    }
    Ok(request)
}

fn server_url(path: &str) -> String {
    let port = std::env::var("ATELIER_PORT")
        .or_else(|_| std::env::var("BEADS_WEB_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    format!("http://127.0.0.1:{port}{path}")
}

pub async fn present(rest: &[String]) -> Result<i32, String> {
    use std::io::Read;
    let mut stdin = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin)
        .map_err(|error| format!("stdin: {error}"))?;
    let response = reqwest::Client::new()
        .post(server_url("/api/workbench/present"))
        .json(&presentation_request(rest, stdin)?)
        .send()
        .await
        .map_err(|error| format!("Presentation failed: {error}"))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid presentation response: {error}"))?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Atelier refused the presentation")
            .to_string());
    }
    print!(
        "{}",
        value["output"]
            .as_str()
            .ok_or_else(|| "Atelier returned no presentation output".to_string())?
    );
    Ok(0)
}

pub async fn screen_check(rest: &[String]) -> Result<i32, String> {
    let response = reqwest::Client::new()
        .post(server_url("/api/workbench/screen-check"))
        .json(&screen_check_request(rest)?)
        .send()
        .await
        .map_err(|error| format!("Screen check failed: {error}"))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid screen-check response: {error}"))?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Atelier refused the screen check")
            .to_string());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&value["result"]).map_err(|error| error.to_string())?
    );
    Ok(0)
}
