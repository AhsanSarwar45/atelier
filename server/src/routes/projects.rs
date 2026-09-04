//! Project and Tag REST API routes
//!
//! Provides CRUD endpoints for projects, tags, and project-tag relationships.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::db::{
    CachedCounts, CreateProjectInput, CreateTagInput, Database, DbError, ProjectTagInput,
    ProjectWithTags, Tag, UpdateProjectInput,
};
use crate::project_manifest::{self, LocatedManifest, ManifestStorage, ProjectManifest};

/// Application state containing the database
pub type AppState = Arc<Database>;

/// Error response structure
#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Success response structure for operations that don't return data
#[derive(Serialize)]
pub struct SuccessResponse {
    pub success: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeProjectInput { pub path: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProbe {
    pub manifest: ProjectManifest,
    pub existing: bool,
    pub storage: Option<ManifestStorage>,
    pub manifest_path: Option<String>,
    /// Whether this computer has `bd` at all. A screen that cannot offer a
    /// board does not ask about one: the checkbox is not drawn rather than
    /// drawn and then refused on save (bw-3tkl.2).
    pub beads_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeProjectInput {
    pub path: String,
    pub storage: ManifestStorage,
    pub manifest: ProjectManifest,
    #[serde(default)]
    pub is_test: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsAnswer {
    #[serde(flatten)]
    pub located: LocatedManifest,
    /// See `ProjectProbe::beads_available`.
    pub beads_available: bool,
}

#[derive(Deserialize)]
pub struct MoveManifestInput { pub storage: ManifestStorage }

fn manifest_error(error: String) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::BAD_REQUEST, Json(ErrorResponse { error }))
}

fn local_root(project: &crate::db::Project) -> Result<std::path::PathBuf, String> {
    let raw = project.local_path.as_deref().unwrap_or(&project.path);
    if raw.starts_with("dolt://") { return Err("this project has no local repository".into()); }
    std::fs::canonicalize(raw).map_err(|error| format!("{raw} could not be read: {error}"))
}

fn located_for(path: &str, local_path: Option<&str>, data: &std::path::Path) -> Option<LocatedManifest> {
    let raw = local_path.unwrap_or(path);
    if raw.starts_with("dolt://") {
        project_manifest::locate_key(path, data)
    } else {
        std::fs::canonicalize(raw).ok().and_then(|root| project_manifest::locate(&root, data))
    }
}

fn data_dir() -> Result<std::path::PathBuf, String> {
    crate::identity::data_dir().ok_or_else(|| "Atelier has no personal data directory".into())
}

fn board_has_issues(root: &std::path::Path) -> bool {
    crate::routes::find_bd().and_then(|bd| std::process::Command::new(bd).arg("list").args(["--limit", "1", "--json"])
        .current_dir(root).output().ok()).map(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).trim() != "[]").unwrap_or(false)
}

fn has_linked_worktrees(root: &std::path::Path) -> bool {
    std::process::Command::new("git").arg("-C").arg(root).args(["worktree", "list", "--porcelain"])
        .output().ok().filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().filter(|line| line.starts_with("worktree ")).count() > 1)
        .unwrap_or(false)
}

fn apply_beads_mode(root: &std::path::Path, manifest: &ProjectManifest) -> Result<(), String> {
    if manifest.project.use_beads { crate::join::install(root, manifest) }
    else { crate::join::remove(root) }
}

pub async fn probe_project(
    Json(input): Json<ProbeProjectInput>,
) -> Result<Json<ProjectProbe>, (StatusCode, Json<ErrorResponse>)> {
    let beads_available = crate::routes::find_bd().is_some();
    if input.path.starts_with("dolt://") {
        let data = data_dir().map_err(manifest_error)?;
        if let Some(located) = project_manifest::locate_key(&input.path, &data) {
            return Ok(Json(ProjectProbe { manifest: located.manifest, existing: true,
                storage: Some(ManifestStorage::Personal), manifest_path: Some(located.path.to_string_lossy().to_string()),
                beads_available }));
        }
        let name = input.path.trim_start_matches("dolt://").replace(['_', '-'], " ");
        return Ok(Json(ProjectProbe { manifest: project_manifest::infer_virtual(&name), existing: false,
            storage: None, manifest_path: None, beads_available }));
    }
    let root = std::fs::canonicalize(&input.path)
        .map_err(|error| manifest_error(format!("{} could not be read: {error}", input.path)))?;
    if let Some(located) = project_manifest::locate(&root, &data_dir().map_err(manifest_error)?) {
        return Ok(Json(ProjectProbe {
            manifest: located.manifest,
            existing: true,
            storage: Some(located.storage),
            manifest_path: Some(located.path.to_string_lossy().to_string()),
            beads_available,
        }));
    }
    Ok(Json(ProjectProbe { manifest: project_manifest::infer(&root), existing: false, storage: None, manifest_path: None, beads_available }))
}

pub async fn initialize_project(
    State(db): State<AppState>,
    Json(input): Json<InitializeProjectInput>,
) -> Result<(StatusCode, Json<ProjectWithTags>), (StatusCode, Json<ErrorResponse>)> {
    if db.get_project_by_path(&input.path).map_err(db_error_response)?.is_some() {
        return Err((StatusCode::CONFLICT, Json(ErrorResponse { error: "This project is already on the home screen".into() })));
    }
    let data = data_dir().map_err(manifest_error)?;
    let virtual_project = input.path.starts_with("dolt://");
    if virtual_project && input.storage != ManifestStorage::Personal {
        return Err(manifest_error("A project without a local repository keeps its settings on this computer".into()));
    }
    let root = if virtual_project { None } else { Some(std::fs::canonicalize(&input.path)
        .map_err(|error| manifest_error(format!("{} could not be read: {error}", input.path)))?) };
    let existing = if virtual_project { project_manifest::locate_key(&input.path, &data) }
        else { project_manifest::locate(root.as_ref().unwrap(), &data) };
    if !virtual_project && input.manifest.project.use_beads
        && !project_manifest::branch_exists(root.as_ref().unwrap(), &input.manifest.git.completed_work_branch) {
        return Err(manifest_error("Completed-work branch must be an existing project branch".into()));
    }
    let (manifest, created_path, previous) = if let Some(existing) = existing {
        if !virtual_project && existing.manifest.beads.issue_id_prefix != input.manifest.beads.issue_id_prefix
            && board_has_issues(root.as_ref().unwrap()) {
            return Err(manifest_error("Issue ID prefix cannot change after the board has issued IDs".into()));
        }
        if !virtual_project && existing.manifest.git.completed_work_branch != input.manifest.git.completed_work_branch
            && has_linked_worktrees(root.as_ref().unwrap()) {
            return Err(manifest_error("Completed-work branch cannot change while linked worktrees exist".into()));
        }
        let previous = Some((existing.manifest.clone(), existing.storage));
        project_manifest::write_atomic(&existing.path, &input.manifest).map_err(manifest_error)?;
        if !virtual_project && existing.storage != input.storage {
            if let Err(error) = project_manifest::move_to(root.as_ref().unwrap(), &data, input.storage) {
                let _ = project_manifest::write_atomic(&existing.path, &existing.manifest);
                return Err(manifest_error(error));
            }
        }
        (input.manifest, None, previous)
    } else {
        let path = if virtual_project { project_manifest::create_key(&input.path, &data, &input.manifest) }
            else { project_manifest::create(root.as_ref().unwrap(), &data, input.storage, &input.manifest) }
            .map_err(manifest_error)?;
        (input.manifest, Some(path), None)
    };
    if !virtual_project {
        if let Err(error) = apply_beads_mode(root.as_ref().unwrap(), &manifest) {
            if let Some(path) = created_path { let _ = std::fs::remove_file(path); }
            if let Some((old, storage)) = previous {
                if let Some(current) = project_manifest::locate(root.as_ref().unwrap(), &data) {
                    let _ = project_manifest::write_atomic(&current.path, &old);
                    if current.storage != storage { let _ = project_manifest::move_to(root.as_ref().unwrap(), &data, storage); }
                }
            }
            return Err(manifest_error(error));
        }
    }
    let project = db.create_project(CreateProjectInput {
        name: manifest.project.display_name,
        path: root.as_ref().map(|path| path.to_string_lossy().to_string()).unwrap_or(input.path),
        local_path: None,
        is_test: input.is_test,
    }).map_err(db_error_response)?;
    Ok((StatusCode::CREATED, Json(ProjectWithTags {
        id: project.id, name: project.name, path: project.path, local_path: project.local_path,
        tags: vec![], last_opened: project.last_opened, created_at: project.created_at,
        archived_at: project.archived_at, is_test: project.is_test,
    })))
}

pub async fn get_project_settings(
    State(db): State<AppState>, Path(id): Path<String>,
) -> Result<Json<ProjectSettingsAnswer>, (StatusCode, Json<ErrorResponse>)> {
    let project = db.get_project(&id).map_err(db_error_response)?;
    let located = located_for(&project.path, project.local_path.as_deref(), &data_dir().map_err(manifest_error)?)
        .ok_or_else(|| manifest_error("project has no manifest; initialize it first".into()))?;
    Ok(Json(ProjectSettingsAnswer { located, beads_available: crate::routes::find_bd().is_some() }))
}

pub async fn update_project_settings(
    State(db): State<AppState>, Path(id): Path<String>, Json(manifest): Json<ProjectManifest>,
) -> Result<Json<ProjectSettingsAnswer>, (StatusCode, Json<ErrorResponse>)> {
    let project = db.get_project(&id).map_err(db_error_response)?;
    let virtual_project = project.local_path.is_none() && project.path.starts_with("dolt://");
    let root = if virtual_project { None } else { Some(local_root(&project).map_err(manifest_error)?) };
    let located = located_for(&project.path, project.local_path.as_deref(), &data_dir().map_err(manifest_error)?)
        .ok_or_else(|| manifest_error("project has no manifest; initialize it first".into()))?;
    if !virtual_project && manifest.project.use_beads
        && !project_manifest::branch_exists(root.as_ref().unwrap(), &manifest.git.completed_work_branch) {
        return Err(manifest_error("Completed-work branch must be an existing project branch".into()));
    }
    if !virtual_project && located.manifest.beads.issue_id_prefix != manifest.beads.issue_id_prefix && board_has_issues(root.as_ref().unwrap()) {
        return Err(manifest_error("Issue ID prefix cannot change after the board has issued IDs".into()));
    }
    if !virtual_project && located.manifest.git.completed_work_branch != manifest.git.completed_work_branch && has_linked_worktrees(root.as_ref().unwrap()) {
        return Err(manifest_error("Completed-work branch cannot change while linked worktrees exist".into()));
    }
    project_manifest::write_atomic(&located.path, &manifest).map_err(manifest_error)?;
    if !virtual_project && located.manifest.project.use_beads != manifest.project.use_beads {
        if let Err(error) = apply_beads_mode(root.as_ref().unwrap(), &manifest) {
            let _ = project_manifest::write_atomic(&located.path, &located.manifest);
            return Err(manifest_error(error));
        }
    }
    if manifest.project.display_name != project.name {
        db.update_project(&id, UpdateProjectInput { name: Some(manifest.project.display_name.clone()), path: None, local_path: None })
            .map_err(db_error_response)?;
    }
    Ok(Json(ProjectSettingsAnswer { located: LocatedManifest { manifest, ..located },
        beads_available: crate::routes::find_bd().is_some() }))
}

pub async fn move_project_manifest(
    State(db): State<AppState>, Path(id): Path<String>, Json(input): Json<MoveManifestInput>,
) -> Result<Json<ProjectSettingsAnswer>, (StatusCode, Json<ErrorResponse>)> {
    let project = db.get_project(&id).map_err(db_error_response)?;
    if project.local_path.is_none() && project.path.starts_with("dolt://") {
        return Err(manifest_error("Repository storage requires a local repository".into()));
    }
    let root = local_root(&project).map_err(manifest_error)?;
    let path = project_manifest::move_to(&root, &data_dir().map_err(manifest_error)?, input.storage).map_err(manifest_error)?;
    let located = project_manifest::locate(&root, &data_dir().map_err(manifest_error)?)
        .ok_or_else(|| manifest_error(format!("{} was written but could not be read", path.display())))?;
    Ok(Json(ProjectSettingsAnswer { located, beads_available: crate::routes::find_bd().is_some() }))
}

impl DbError {
    fn status_code(&self) -> StatusCode {
        match self {
            DbError::ProjectNotFound(_) | DbError::TagNotFound(_) => StatusCode::NOT_FOUND,
            DbError::Sqlite(_) | DbError::PathError | DbError::ProjectSettings(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

fn db_error_response(err: DbError) -> (StatusCode, Json<ErrorResponse>) {
    let status = err.status_code();
    (
        status,
        Json(ErrorResponse {
            error: err.to_string(),
        }),
    )
}

// ===== Project Routes =====

/// Query parameters for listing projects
#[derive(Deserialize)]
pub struct ListProjectsParams {
    pub include_archived: Option<bool>,
    /// When true, includes projects marked `isTest` (registered by the e2e
    /// suite). Defaults to false so fixture projects stay off the dashboard.
    pub include_test: Option<bool>,
}

/// A project list entry — `ProjectWithTags` flattened with the cached
/// bead counts attached. The `cachedCounts` field is `null` until
/// `/api/beads` has been called for the project at least once.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWithTagsAndCounts {
    #[serde(flatten)]
    pub project: ProjectWithTags,
    pub cached_counts: Option<CachedCounts>,
    /// Controls whether the project has board UI and card reads.
    pub uses_beads: bool,
}

/// GET /api/projects - List all projects with their tags and cached bead counts
pub async fn list_projects(
    State(db): State<AppState>,
    Query(params): Query<ListProjectsParams>,
) -> Result<Json<Vec<ProjectWithTagsAndCounts>>, (StatusCode, Json<ErrorResponse>)> {
    let include_archived = params.include_archived.unwrap_or(false);
    let include_test = params.include_test.unwrap_or(false);
    let mut projects = db.get_projects_with_tags_filtered(include_archived, include_test).map_err(db_error_response)?;
    // Normalize Windows backslashes in paths for consistent frontend behavior
    for p in &mut projects {
        p.path = p.path.replace('\\', "/");
        if let Some(ref lp) = p.local_path {
            p.local_path = Some(lp.replace('\\', "/"));
        }
    }

    let beads_available = crate::routes::find_bd().is_some();
    let mut result = Vec::with_capacity(projects.len());
    for project in projects {
        // Cache reads are best-effort — log and fall back to None on error
        // so a single corrupt row can't block the whole projects list.
        let cached_counts = match db.get_cached_counts(&project.id) {
            Ok(counts) => counts,
            Err(e) => {
                tracing::warn!(
                    "Failed to read cached counts for project {}: {}",
                    project.id,
                    e
                );
                None
            }
        };
        // A board this computer cannot read is not a board to draw. The
        // manifest still says what the project is; `usesBeads` says what the
        // screen can honestly show, so a machine with no `bd` gets the
        // chat-only shape rather than a board tab whose every read is a 503
        // (bw-3tkl.2).
        let uses_beads = beads_available
            && located_for(&project.path, project.local_path.as_deref(), &data_dir().map_err(manifest_error)?)
                .map(|found| found.manifest.project.use_beads).unwrap_or(false);
        result.push(ProjectWithTagsAndCounts {
            uses_beads,
            project,
            cached_counts,
        });
    }

    Ok(Json(result))
}

/// POST /api/projects - Create a new project
pub async fn create_project(
    State(db): State<AppState>,
    Json(input): Json<CreateProjectInput>,
) -> Result<(StatusCode, Json<ProjectWithTags>), (StatusCode, Json<ErrorResponse>)> {
    let project = db.create_project(input).map_err(db_error_response)?;

    // Return project with empty tags array
    let project_with_tags = ProjectWithTags {
        id: project.id,
        name: project.name,
        path: project.path,
        local_path: project.local_path,
        tags: vec![],
        last_opened: project.last_opened,
        created_at: project.created_at,
        archived_at: project.archived_at,
        is_test: project.is_test,
    };

    Ok((StatusCode::CREATED, Json(project_with_tags)))
}

/// PATCH /api/projects/:id - Update a project
pub async fn update_project(
    State(db): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateProjectInput>,
) -> Result<Json<ProjectWithTags>, (StatusCode, Json<ErrorResponse>)> {
    let project = db.update_project(&id, input).map_err(db_error_response)?;
    let tags = db.get_project_tags(&id).map_err(db_error_response)?;

    Ok(Json(ProjectWithTags {
        id: project.id,
        name: project.name,
        path: project.path,
        local_path: project.local_path,
        tags,
        last_opened: project.last_opened,
        created_at: project.created_at,
        archived_at: project.archived_at,
        is_test: project.is_test,
    }))
}

/// DELETE /api/projects/:id - Delete a project
pub async fn delete_project(
    State(db): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    db.delete_project(&id).map_err(db_error_response)?;
    Ok(StatusCode::NO_CONTENT)
}

/// PATCH /api/projects/:id/archive - Archive a project
pub async fn archive_project(
    State(db): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    db.archive_project(&id).map_err(db_error_response)?;
    Ok(StatusCode::NO_CONTENT)
}

/// PATCH /api/projects/:id/unarchive - Unarchive a project
pub async fn unarchive_project(
    State(db): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    db.unarchive_project(&id).map_err(db_error_response)?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/projects/:id/touch — bump last_opened to now without touching other fields
pub async fn touch_project(
    State(db): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    db.touch_project(&id).map_err(db_error_response)?;
    Ok(StatusCode::NO_CONTENT)
}

// ===== Tag Routes =====

/// GET /api/tags - List all tags
pub async fn list_tags(
    State(db): State<AppState>,
) -> Result<Json<Vec<Tag>>, (StatusCode, Json<ErrorResponse>)> {
    db.get_tags().map(Json).map_err(db_error_response)
}

/// POST /api/tags - Create a new tag
pub async fn create_tag(
    State(db): State<AppState>,
    Json(input): Json<CreateTagInput>,
) -> Result<(StatusCode, Json<Tag>), (StatusCode, Json<ErrorResponse>)> {
    let tag = db.create_tag(input).map_err(db_error_response)?;
    Ok((StatusCode::CREATED, Json(tag)))
}

/// DELETE /api/tags/:id - Delete a tag
pub async fn delete_tag(
    State(db): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    db.delete_tag(&id).map_err(db_error_response)?;
    Ok(StatusCode::NO_CONTENT)
}

// ===== Project-Tag Relationship Routes =====

/// POST /api/project-tags - Add a tag to a project
pub async fn add_project_tag(
    State(db): State<AppState>,
    Json(input): Json<ProjectTagInput>,
) -> Result<(StatusCode, Json<SuccessResponse>), (StatusCode, Json<ErrorResponse>)> {
    db.add_tag_to_project(&input.project_id, &input.tag_id)
        .map_err(db_error_response)?;
    Ok((StatusCode::CREATED, Json(SuccessResponse { success: true })))
}

/// DELETE /api/project-tags/:project_id/:tag_id - Remove a tag from a project
pub async fn remove_project_tag(
    State(db): State<AppState>,
    Path((project_id, tag_id)): Path<(String, String)>,
) -> Result<Json<SuccessResponse>, (StatusCode, Json<ErrorResponse>)> {
    db.remove_tag_from_project(&project_id, &tag_id)
        .map_err(db_error_response)?;
    Ok(Json(SuccessResponse { success: true }))
}

/// Creates the project/tag router with all routes
pub fn project_routes() -> axum::Router<AppState> {
    use axum::routing::{delete, get, patch, post};

    axum::Router::new()
        // Project routes
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/:id",
            patch(update_project).delete(delete_project),
        )
        .route("/projects/:id/archive", patch(archive_project))
        .route("/projects/:id/unarchive", patch(unarchive_project))
        .route("/projects/:id/touch", post(touch_project))
        .route("/projects/probe", post(probe_project))
        .route("/projects/initialize", post(initialize_project))
        .route("/projects/:id/settings", get(get_project_settings).patch(update_project_settings))
        .route("/projects/:id/settings/move", post(move_project_manifest))
        // Tag routes
        .route("/tags", get(list_tags).post(create_tag))
        .route("/tags/:id", delete(delete_tag))
        // Project-tag relationship routes
        .route("/project-tags", post(add_project_tag))
        .route("/project-tags/:project_id/:tag_id", delete(remove_project_tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_project_with_tags() -> ProjectWithTags {
        ProjectWithTags {
            id: "proj-1".to_string(),
            name: "Sample".to_string(),
            path: "/sample".to_string(),
            local_path: None,
            tags: vec![],
            last_opened: "2026-04-22T10:00:00Z".to_string(),
            created_at: "2026-04-22T09:00:00Z".to_string(),
            archived_at: None,
            is_test: false,
        }
    }

    /// The screen learns whether this computer has bd from the same answer
    /// that carries the manifest, so the board question is drawn or not drawn
    /// without a second round trip (bw-3tkl.2).
    #[test]
    fn the_probe_says_whether_this_computer_has_bd() {
        let probe = ProjectProbe {
            manifest: crate::project_manifest::infer(std::path::Path::new(".")),
            existing: false,
            storage: None,
            manifest_path: None,
            beads_available: false,
        };
        let json = serde_json::to_string(&probe).unwrap();
        assert!(json.contains("\"beadsAvailable\":false"), "{json}");
        assert!(!json.contains("beads_available"), "{json}");
    }

    #[test]
    fn test_project_with_counts_serializes_camel_case_and_flattens() {
        let entry = ProjectWithTagsAndCounts {
            project: make_project_with_tags(),
            cached_counts: Some(CachedCounts {
                open: 3,
                in_progress: 1,
                inreview: 0,
                manager_review: 4,
                closed: 2,
                cancelled: 1,
                data_source: Some("cli".to_string()),
                updated_at: "2026-04-22T10:00:00Z".to_string(),
            }),
            uses_beads: true,
        };
        let json = serde_json::to_string(&entry).unwrap();

        // Flattened fields preserve ProjectWithTags' camelCase rename
        assert!(json.contains("\"lastOpened\":\"2026-04-22T10:00:00Z\""));
        assert!(json.contains("\"createdAt\":\"2026-04-22T09:00:00Z\""));
        assert!(json.contains("\"localPath\":null"));
        assert!(json.contains("\"archivedAt\":null"));

        // cachedCounts wrapper is camelCase
        assert!(json.contains("\"cachedCounts\":{"));
        assert!(json.contains("\"usesBeads\":true"));
        // CachedCounts inner fields are camelCase
        assert!(json.contains("\"inProgress\":1"));
        assert!(json.contains("\"dataSource\":\"cli\""));
        assert!(json.contains("\"updatedAt\":\"2026-04-22T10:00:00Z\""));
        // No snake_case leaks
        assert!(!json.contains("\"in_progress\""));
        assert!(!json.contains("\"data_source\""));
        assert!(!json.contains("\"cached_counts\""));
    }

    #[test]
    fn test_project_with_counts_serializes_null_when_no_cache() {
        let entry = ProjectWithTagsAndCounts {
            project: make_project_with_tags(),
            cached_counts: None,
            uses_beads: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"cachedCounts\":null"));
    }
}
