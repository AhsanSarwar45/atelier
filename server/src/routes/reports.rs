//! Manager reports: the list, and the page for one card.
//!
//! Reports live where this computer keeps this program's data —
//! `<data>/reports/<project>/<slug>.report.json`, with the built page beside
//! it, and the tools that make them in `<data>/tools`. The one place that works
//! out where those are, on every platform, is `crate::identity`; nothing here
//! reads an environment variable of its own.
//!
//! Making a report is part of the product, so the tools travel inside it — see
//! `crate::report_tools`. Nothing has to be installed alongside.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::db::{Database, Project};
use crate::routes::projects::AppState;

const SPEC_SUFFIX: &str = ".report.json";

fn reports_dir() -> Option<PathBuf> {
    crate::identity::reports_dir()
}

/// `/api/reports` and `/api/reports/page`, carrying the database so a page
/// can be opened without the caller naming the folder its board lives in.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/reports", get(list_reports))
        .route("/reports/page", get(report_page))
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

/// The folder that holds `project`'s board — `local_path` when it names
/// one, `path` otherwise. Mirrors `projectDir()` in `src/lib/utils.ts`: a
/// project's own `path` can be a `dolt://` address rather than a real
/// directory, and `local_path` is what the rest of the app then runs
/// filesystem commands in.
fn project_dir(project: &Project) -> String {
    match project.local_path.as_deref() {
        Some(lp) if !lp.trim().is_empty() => lp.to_string(),
        _ => project.path.clone(),
    }
}

/// Where the project a report is filed under keeps its board, found from
/// the app's own project list.
///
/// The match is exact, never fuzzy, and never against a project's display
/// `name`: `reporting/tools/project.py` files a report under the last path
/// segment of the project's main checkout, which is `basename` of the
/// folder `project_dir` resolves to.
fn resolve_project_path(db: &Database, project: &str) -> Option<String> {
    let projects = db.get_projects_filtered(true).ok()?;
    projects.into_iter().find_map(|p| {
        let dir = project_dir(&p);
        let matches = Path::new(&dir).file_name().is_some_and(|n| n.to_string_lossy() == project);
        matches.then_some(dir)
    })
}

/// The folder the build runs in. An explicit `path` wins while it still
/// exists — the screen may pass one — otherwise it is looked up from the
/// project name the report is filed under.
///
/// A link handed over months ago may name a worktree, a second checkout
/// named after a branch and deleted the day that job lands. That link is
/// still about the same report, so a path that has since gone falls through
/// to the lookup rather than failing.
fn resolve_cwd(explicit: Option<&str>, db: &Database, project: &str) -> Option<String> {
    explicit
        .filter(|dir| Path::new(dir).is_dir())
        .map(str::to_string)
        .or_else(|| resolve_project_path(db, project))
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
pub async fn report_page(State(db): State<AppState>, Query(p): Query<PageParams>) -> impl IntoResponse {
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

    let Some(tools) = crate::identity::tools_dir() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "this computer names no folder for a program's data, so the report tools have nowhere to live"
                .to_string(),
        )
            .into_response();
    };

    // The build reads the board and the pictures from the project it is
    // about. An explicit `path` wins while it is still there; otherwise it
    // is looked up from the app's own project list by the name the report is
    // filed under — not every report names a project the app knows (the data
    // folder also holds `keystone`, filed by hand), so that can come up empty.
    let Some(cwd) = resolve_cwd(p.path.as_deref(), &db, &p.project) else {
        return (
            StatusCode::NOT_FOUND,
            format!(
                "this computer's project list names no folder for {}, so this report cannot be \
                 built without &path=<the folder that holds its board>",
                p.project
            ),
        )
            .into_response();
    };
    let built = spec.with_file_name(format!("{}.html", p.slug));
    let out = Command::new("python3")
        .arg(tools.join("build.py"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateProjectInput;

    fn db_with_projects(rows: &[(&str, &str, Option<&str>)]) -> Database {
        let db = Database::new_in_memory().expect("an in-memory database");
        for (name, path, local_path) in rows {
            db.create_project(CreateProjectInput {
                name: name.to_string(),
                path: path.to_string(),
                local_path: local_path.map(str::to_string),
            })
            .expect("create project");
        }
        db
    }

    #[test]
    fn the_project_whose_path_ends_in_the_name_is_picked_out_of_several() {
        let db = db_with_projects(&[
            ("Widgets", "/home/dev/widgets", None),
            ("Beads Web", "/home/ahsan/code/beads-web", None),
            ("Gadgets", "/home/dev/gadgets", None),
        ]);
        assert_eq!(resolve_project_path(&db, "beads-web"), Some("/home/ahsan/code/beads-web".to_string()));
    }

    #[test]
    fn local_path_is_preferred_over_path_when_it_names_a_folder() {
        // Mirrors `projectDir()` in src/lib/utils.ts: a Dolt project's own
        // `path` is a database address, not a directory, so `local_path` is
        // what the rest of the app runs filesystem commands in — and what
        // `reporting/tools/project.py` would have run in, to file the
        // report under this name in the first place.
        let db = db_with_projects(&[("Corsetta", "dolt://corsetta", Some("/home/dev/corsetta-checkout"))]);
        assert_eq!(
            resolve_project_path(&db, "corsetta-checkout"),
            Some("/home/dev/corsetta-checkout".to_string())
        );
    }

    #[test]
    fn nothing_resolves_a_project_name_no_row_matches() {
        let db = db_with_projects(&[("Widgets", "/home/dev/widgets", None)]);
        assert_eq!(resolve_project_path(&db, "keystone"), None);
    }

    #[test]
    fn an_explicit_path_wins_over_the_lookup_while_it_is_there() {
        let db = db_with_projects(&[("Beads Web", "/home/ahsan/code/beads-web", None)]);
        let elsewhere = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(resolve_cwd(Some(&elsewhere), &db, "beads-web"), Some(elsewhere));
    }

    /// The shape of a link handed over before the worktree it was built in
    /// was deleted. It is still about the same report, so it still opens.
    #[test]
    fn an_explicit_path_that_is_gone_falls_through_to_the_lookup() {
        let db = db_with_projects(&[("Beads Web", "/home/ahsan/code/beads-web", None)]);
        assert_eq!(
            resolve_cwd(Some("/home/ahsan/code/beads-web/worktrees/landed"), &db, "beads-web"),
            Some("/home/ahsan/code/beads-web".to_string())
        );
    }
}
