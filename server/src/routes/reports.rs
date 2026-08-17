//! Manager reports: the list, and the page for one card.
//!
//! Reports live where this computer keeps this program's data —
//! `<data>/reports/<project>/<slug>.report.json`, with the built page beside
//! it. The one place that works out where that is, on every platform, is
//! `crate::identity`; nothing here reads an environment variable of its own.

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

const SPEC_SUFFIX: &str = ".report.json";

fn reports_dir() -> Option<PathBuf> {
    crate::identity::reports_dir()
}

/// One report, as the screen lists it.
#[derive(Debug, Serialize)]
pub struct ReportEntry {
    pub project: String,
    pub slug: String,
    pub title: String,
    /// The card this report belongs to, when it names one.
    pub card: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PageParams {
    pub project: String,
    pub slug: String,
    /// The project folder the report is about — pictures and the board resolve there.
    pub path: Option<String>,
}

fn read_spec(spec: &Path) -> Option<(String, Option<String>)> {
    let raw = std::fs::read_to_string(spec).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let title = v.get("title")?.as_str()?.to_string();
    let card = v
        .get("status")
        .and_then(|s| s.get("card"))
        .and_then(|c| c.as_str())
        .map(str::to_string);
    Some((title, card))
}

/// Every report on this machine, newest first.
pub async fn list_reports() -> impl IntoResponse {
    let Some(root) = reports_dir() else {
        return Json(Vec::<ReportEntry>::new());
    };
    let mut out: Vec<(std::time::SystemTime, ReportEntry)> = Vec::new();

    let projects = match std::fs::read_dir(&root) {
        Ok(d) => d,
        Err(_) => return Json(Vec::<ReportEntry>::new()),
    };
    for project in projects.flatten() {
        if !project.path().is_dir() {
            continue;
        }
        let project_name = project.file_name().to_string_lossy().to_string();
        let Ok(specs) = std::fs::read_dir(project.path()) else { continue };
        for spec in specs.flatten() {
            let name = spec.file_name().to_string_lossy().to_string();
            let Some(slug) = name.strip_suffix(SPEC_SUFFIX) else { continue };
            let Some((title, card)) = read_spec(&spec.path()) else { continue };
            let when = spec.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            out.push((
                when,
                ReportEntry { project: project_name.clone(), slug: slug.to_string(), title, card },
            ));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Json(out.into_iter().map(|(_, e)| e).collect::<Vec<_>>())
}

/// One report, rebuilt from its spec so the board it shows is current.
pub async fn report_page(Query(p): Query<PageParams>) -> impl IntoResponse {
    if p.project.contains(['/', '\\', '.']) || p.slug.contains(['/', '\\']) {
        return (StatusCode::BAD_REQUEST, "bad name".to_string()).into_response();
    }
    let Some(root) = reports_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this computer names no folder for a program's data, so there is nowhere to keep reports"
                .to_string(),
        )
            .into_response();
    };
    let spec = root.join(&p.project).join(format!("{}{}", p.slug, SPEC_SUFFIX));
    if !spec.is_file() {
        return (StatusCode::NOT_FOUND, format!("no report called {}", p.slug)).into_response();
    }

    // The build reads the board and the pictures from the project it is about.
    let cwd = p.path.clone().unwrap_or_else(|| root.to_string_lossy().to_string());
    let built = spec.with_file_name(format!("{}.html", p.slug));
    let out = Command::new("python3")
        .arg(root.join("tools/build.py"))
        .arg(&spec)
        .arg("--project")
        .arg(&cwd)
        .current_dir(&cwd)
        .output();

    match out {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let why = String::from_utf8_lossy(&o.stderr).to_string();
            return (StatusCode::UNPROCESSABLE_ENTITY, format!("this report does not build:\n{why}"))
                .into_response();
        }
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("the report builder did not run: {e}"))
                .into_response()
        }
    }

    match std::fs::read_to_string(&built) {
        // Without the charset the browser reads the page as windows-1252.
        Ok(html) => (
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            html,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("built page unreadable: {e}")).into_response(),
    }
}
