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
    CreateProjectInput, CreateTagInput, Database, DbError, ProjectTagInput,
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
    /// What the project already tells its agents, or what a project of this
    /// shape would start by telling them (bw-a9ln.4).
    pub instructions: String,
    pub existing: bool,
    pub storage: Option<ManifestStorage>,
    pub manifest_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeProjectInput {
    pub path: String,
    pub storage: ManifestStorage,
    pub manifest: ProjectManifest,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub is_test: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsAnswer {
    #[serde(flatten)]
    pub located: LocatedManifest,
}

#[derive(Deserialize)]
pub struct MoveManifestInput { pub storage: ManifestStorage }

#[derive(Deserialize)]
pub struct UpdateSettingsInput {
    #[serde(flatten)]
    pub manifest: ProjectManifest,
    #[serde(default)]
    pub instructions: String,
}

fn manifest_error(error: String) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::BAD_REQUEST, Json(ErrorResponse { error }))
}

fn local_root(project: &crate::db::Project) -> Result<std::path::PathBuf, String> {
    let raw = project.local_path.as_deref().unwrap_or(&project.path);
    std::fs::canonicalize(raw).map_err(|error| format!("{raw} could not be read: {error}"))
}

fn located_for(path: &str, local_path: Option<&str>, data: &std::path::Path) -> Option<LocatedManifest> {
    let raw = local_path.unwrap_or(path);
    std::fs::canonicalize(raw).ok().and_then(|root| project_manifest::locate(&root, data))
}

/// The project's settings file, made from what its folder shows when it has none.
///
/// A project added before settings files existed, or by a route that does not
/// write one, used to open Workflow and Review onto a dead end. Its name stays
/// the one on the home screen; everything else is inferred as the Add Project
/// dialog would have inferred it, and kept on this computer only.
fn located_or_created(project: &crate::db::Project, data: &std::path::Path) -> Result<LocatedManifest, String> {
    if let Some(found) = located_for(&project.path, project.local_path.as_deref(), data) {
        return Ok(found);
    }
    let root = local_root(project)?;
    let mut manifest = project_manifest::infer(&root);
    manifest.project.display_name = project.name.clone();
    let path = project_manifest::create(&root, data, ManifestStorage::Personal, &manifest)?;
    project_manifest::write_instructions(&path, &project_manifest::infer_instructions(&root))?;
    located_for(&project.path, project.local_path.as_deref(), data)
        .ok_or_else(|| "the new settings file could not be read back".into())
}

fn data_dir() -> Result<std::path::PathBuf, String> {
    crate::identity::data_dir().ok_or_else(|| "Atelier has no personal data directory".into())
}

/// Take what older versions wired in for the board back out of a project, as
/// it is set up or opened. Best effort: a settings file that does not parse is
/// left as it is and said so in the log, never a reason to refuse the project.
fn tidy(root: &std::path::Path) {
    if let Err(error) = crate::join::tidy(root) {
        tracing::warn!(root = %root.display(), %error, "could not take retired board hooks out");
    }
}

pub async fn probe_project(
    Json(input): Json<ProbeProjectInput>,
) -> Result<Json<ProjectProbe>, (StatusCode, Json<ErrorResponse>)> {
    let root = std::fs::canonicalize(&input.path)
        .map_err(|error| manifest_error(format!("{} could not be read: {error}", input.path)))?;
    if let Some(located) = project_manifest::locate(&root, &data_dir().map_err(manifest_error)?) {
        return Ok(Json(ProjectProbe {
            manifest: located.manifest,
            instructions: located.instructions,
            existing: true,
            storage: Some(located.storage),
            manifest_path: Some(located.path.to_string_lossy().to_string()),
        }));
    }
    Ok(Json(ProjectProbe { manifest: project_manifest::infer(&root),
        instructions: project_manifest::infer_instructions(&root),
        existing: false, storage: None, manifest_path: None }))
}

pub async fn initialize_project(
    State(db): State<AppState>,
    Json(input): Json<InitializeProjectInput>,
) -> Result<(StatusCode, Json<ProjectWithTags>), (StatusCode, Json<ErrorResponse>)> {
    // The path as typed. A path that only collides once canonicalised is
    // caught by `create_project` below, in the same words (bw-uk0k.2).
    if let Some(existing) = db.get_project_by_path(&input.path).map_err(db_error_response)? {
        return Err(db_error_response(DbError::ProjectPathAlreadyAdded(existing.name)));
    }
    let data = data_dir().map_err(manifest_error)?;
    let root = std::fs::canonicalize(&input.path)
        .map_err(|error| manifest_error(format!("{} could not be read: {error}", input.path)))?;
    let existing = project_manifest::locate(&root, &data);
    let manifest = if let Some(existing) = existing {
        project_manifest::write_atomic(&existing.path, &input.manifest).map_err(manifest_error)?;
        if existing.storage != input.storage {
            if let Err(error) = project_manifest::move_to(&root, &data, input.storage) {
                let _ = project_manifest::write_atomic(&existing.path, &existing.manifest);
                return Err(manifest_error(error));
            }
        }
        let current = project_manifest::locate(&root, &data).map(|found| found.path).unwrap_or(existing.path);
        project_manifest::write_instructions(&current, &input.instructions).map_err(manifest_error)?;
        input.manifest
    } else {
        let path = project_manifest::create(&root, &data, input.storage, &input.manifest).map_err(manifest_error)?;
        project_manifest::write_instructions(&path, &input.instructions).map_err(manifest_error)?;
        input.manifest
    };
    tidy(&root);
    let project = db.create_project(CreateProjectInput {
        name: manifest.project.display_name,
        path: root.to_string_lossy().to_string(),
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
    let located = located_or_created(&project, &data_dir().map_err(manifest_error)?).map_err(manifest_error)?;
    Ok(Json(ProjectSettingsAnswer { located }))
}

pub async fn update_project_settings(
    State(db): State<AppState>, Path(id): Path<String>, Json(input): Json<UpdateSettingsInput>,
) -> Result<Json<ProjectSettingsAnswer>, (StatusCode, Json<ErrorResponse>)> {
    let UpdateSettingsInput { manifest, instructions } = input;
    let project = db.get_project(&id).map_err(db_error_response)?;
    let located = located_or_created(&project, &data_dir().map_err(manifest_error)?).map_err(manifest_error)?;
    crate::workbench::chat_name::check(&manifest.chat_name).map_err(manifest_error)?;
    project_manifest::write_atomic(&located.path, &manifest).map_err(manifest_error)?;
    project_manifest::write_instructions(&located.path, &instructions).map_err(manifest_error)?;
    // Every list names its chats by the template just written, not the one
    // read a moment ago (workbench::chat_name).
    crate::workbench::chat_name::forget();
    if manifest.project.display_name != project.name {
        db.update_project(&id, UpdateProjectInput { name: Some(manifest.project.display_name.clone()), path: None, local_path: None })
            .map_err(db_error_response)?;
    }
    Ok(Json(ProjectSettingsAnswer { located: LocatedManifest { manifest, instructions: instructions.trim().to_string(), ..located } }))
}

pub async fn move_project_manifest(
    State(db): State<AppState>, Path(id): Path<String>, Json(input): Json<MoveManifestInput>,
) -> Result<Json<ProjectSettingsAnswer>, (StatusCode, Json<ErrorResponse>)> {
    let project = db.get_project(&id).map_err(db_error_response)?;
    let root = local_root(&project).map_err(manifest_error)?;
    let path = project_manifest::move_to(&root, &data_dir().map_err(manifest_error)?, input.storage).map_err(manifest_error)?;
    let located = project_manifest::locate(&root, &data_dir().map_err(manifest_error)?)
        .ok_or_else(|| manifest_error(format!("{} was written but could not be read", path.display())))?;
    Ok(Json(ProjectSettingsAnswer { located }))
}

impl DbError {
    fn status_code(&self) -> StatusCode {
        match self {
            DbError::ProjectNotFound(_) | DbError::TagNotFound(_) => StatusCode::NOT_FOUND,
            // A path already on the home screen is a refusal the caller can
            // read and act on, not a fault in the app (bw-uk0k.2).
            DbError::ProjectPathAlreadyAdded(_) => StatusCode::CONFLICT,
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

/// GET /api/projects - List all projects with their tags
pub async fn list_projects(
    State(db): State<AppState>,
    Query(params): Query<ListProjectsParams>,
) -> Result<Json<Vec<ProjectWithTags>>, (StatusCode, Json<ErrorResponse>)> {
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
    Ok(Json(projects))
}

/// POST /api/projects - Create a new project
pub async fn create_project(
    State(db): State<AppState>,
    Json(input): Json<CreateProjectInput>,
) -> Result<(StatusCode, Json<ProjectWithTags>), (StatusCode, Json<ErrorResponse>)> {
    let project = db.create_project(input).map_err(db_error_response)?;
    tidy(std::path::Path::new(project.local_path.as_deref().unwrap_or(&project.path)));

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
    workbench: Option<axum::Extension<crate::routes::workbench::WorkbenchState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    // Before the project goes, and not after: its chats are found by its id,
    // and once the row is gone there is nothing left to find them by. Failing
    // to tidy them is logged rather than refused — the owner asked for the
    // project to be taken off the list, and one chat that will not close may
    // not stand in the way of that (bw-altj).
    if let Some(axum::Extension(workbench)) = workbench {
        if let Err(why) = workbench.retire_project(&id).await {
            tracing::warn!("a deleted project's chats could not be retired: {why}");
        }
    }
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
    // Opening a project takes out what an older Atelier wired into it.
    if let Ok(project) = db.get_project(&id) {
        tidy(std::path::Path::new(project.local_path.as_deref().unwrap_or(&project.path)));
    }
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

    /// A second registration of the same path is a conflict the caller can
    /// read, not a fault in the app, and the body carries the sentence a
    /// person can act on rather than SQLite's (bw-uk0k.2).
    #[test]
    fn a_path_already_added_answers_409_in_plain_words() {
        let (status, Json(body)) =
            db_error_response(DbError::ProjectPathAlreadyAdded("Atelier".to_string()));
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body.error, "Atelier is already on the home screen");
        assert!(!body.error.to_lowercase().contains("sqlite"), "{}", body.error);
        assert!(!body.error.contains("UNIQUE"), "{}", body.error);
    }

    #[test]
    fn a_project_entry_serializes_camel_case() {
        let json = serde_json::to_string(&make_project_with_tags()).unwrap();
        assert!(json.contains("\"lastOpened\":\"2026-04-22T10:00:00Z\""));
        assert!(json.contains("\"localPath\":null"));
        assert!(!json.contains("cachedCounts"));
    }
}
