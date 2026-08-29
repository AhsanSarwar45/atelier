//! Worktree route handlers for managing git worktrees and PR status.
//!
//! Provides endpoints for:
//! - Worktree CRUD operations (create, delete, list, status)
//! - PR status checking and management via GitHub CLI

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tokio::process::Command;

use super::validate_path_security;

/// Validate repo_path, returning a FORBIDDEN response on failure.
fn check_repo_path(repo_path: &Path) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    validate_path_security(repo_path).map_err(|e| {
        (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e })))
    })
}

// ============================================================================
// Worktree Status Endpoint
// ============================================================================

/// Query parameters for worktree status endpoint.
#[derive(Deserialize)]
pub struct WorktreeStatusParams {
    /// Path to the git repository.
    pub repo_path: String,
    /// Bead ID to check worktree status for.
    pub bead_id: String,
}

/// Response body for the worktree status endpoint.
#[derive(Serialize)]
pub struct WorktreeStatusResponse {
    /// Whether the worktree exists.
    pub exists: bool,
    /// Path to the worktree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Branch name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Number of commits ahead of main.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<i32>,
    /// Number of commits behind main.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<i32>,
    /// Whether there are uncommitted changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    /// Last modification time of the worktree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<DateTime<Utc>>,
}

/// Get the status of a worktree for a specific bead.
///
/// # Endpoint
///
/// `GET /api/git/worktree-status?repo_path=...&bead_id=...`
///
/// # Response
///
/// Returns worktree existence, path, branch, ahead/behind counts, and dirty status.
pub async fn worktree_status(Query(params): Query<WorktreeStatusParams>) -> impl IntoResponse {
    let repo_path = Path::new(&params.repo_path);
    if let Err(resp) = check_repo_path(repo_path) { return resp.into_response(); }

    // Validate repository path exists
    if !repo_path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Repository path does not exist: {}", params.repo_path)
            })),
        )
            .into_response();
    }

    let branch_name = format!("bd-{}", params.bead_id);
    let worktree_path = repo_path.join(".worktrees").join(&branch_name);

    if !worktree_path.exists() {
        return Json(WorktreeStatusResponse {
            exists: false,
            worktree_path: None,
            branch: None,
            ahead: None,
            behind: None,
            dirty: None,
            last_modified: None,
        })
        .into_response();
    }

    // Get ahead/behind counts relative to main
    let (ahead, behind) = get_ahead_behind_worktree(&params.repo_path, &branch_name).await;

    // Check for uncommitted changes in the worktree
    let dirty = check_worktree_dirty(&worktree_path.to_string_lossy()).await;

    // Get last modification time
    let last_modified = get_last_modified(&worktree_path);

    Json(WorktreeStatusResponse {
        exists: true,
        worktree_path: Some(worktree_path.to_string_lossy().to_string()),
        branch: Some(branch_name),
        ahead: Some(ahead),
        behind: Some(behind),
        dirty: Some(dirty),
        last_modified,
    })
    .into_response()
}

// ============================================================================
// Create Worktree Endpoint (Idempotent)
// ============================================================================

/// Request body for creating a worktree.
#[derive(Deserialize)]
pub struct CreateWorktreeRequest {
    /// Path to the git repository.
    pub repo_path: String,
    /// Bead ID for the worktree.
    pub bead_id: String,
    /// Base branch to create from (defaults to "main").
    #[serde(default = "default_base_branch")]
    pub base_branch: String,
}

fn default_base_branch() -> String {
    "main".to_string()
}

/// Response body for the create worktree endpoint.
#[derive(Serialize)]
pub struct CreateWorktreeResponse {
    /// Whether the operation was successful.
    pub success: bool,
    /// Path to the worktree.
    pub worktree_path: String,
    /// Branch name.
    pub branch: String,
    /// True if worktree already existed (idempotent response).
    pub already_existed: bool,
}

/// Create a worktree for a bead. This operation is idempotent.
///
/// # Endpoint
///
/// `POST /api/git/worktree`
///
/// # Request Body
///
/// ```json
/// {
///   "repo_path": "/path/to/repo",
///   "bead_id": "BD-001",
///   "base_branch": "main"
/// }
/// ```
///
/// # Response
///
/// Returns the worktree path and whether it already existed.
pub async fn create_worktree(Json(request): Json<CreateWorktreeRequest>) -> impl IntoResponse {
    let repo_path = Path::new(&request.repo_path);
    if let Err(resp) = check_repo_path(repo_path) { return resp.into_response(); }

    // Validate repository path exists
    if !repo_path.exists() || !repo_path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Repository path does not exist: {}", request.repo_path)
            })),
        )
            .into_response();
    }

    // Ensure .worktrees/ is in .gitignore
    if let Err(e) = ensure_gitignore_entry(&request.repo_path) {
        tracing::warn!("Failed to update .gitignore: {}", e);
    }

    let branch_name = format!("bd-{}", request.bead_id);
    let worktrees_dir = repo_path.join(".worktrees");
    let worktree_path = worktrees_dir.join(&branch_name);

    // Check if worktree already exists (idempotent)
    if worktree_path.exists() {
        return Json(CreateWorktreeResponse {
            success: true,
            worktree_path: worktree_path.to_string_lossy().to_string(),
            branch: branch_name,
            already_existed: true,
        })
        .into_response();
    }

    // Create .worktrees directory if it doesn't exist
    if let Err(e) = fs::create_dir_all(&worktrees_dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to create .worktrees directory: {}", e)
            })),
        )
            .into_response();
    }

    // Create the worktree with a new branch
    let output = super::git_output(
        &request.repo_path,
        &[
            "worktree",
            "add",
            &worktree_path.to_string_lossy(),
            "-b",
            &branch_name,
            &request.base_branch,
        ],
    )
    .await;

    match output {
        Ok(output) if output.status.success() => Json(CreateWorktreeResponse {
            success: true,
            worktree_path: worktree_path.to_string_lossy().to_string(),
            branch: branch_name,
            already_existed: false,
        })
        .into_response(),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Check if branch already exists (perhaps worktree was removed but branch exists)
            if stderr.contains("already exists") {
                // Try to add worktree using existing branch
                let retry_output = super::git_output(
                    &request.repo_path,
                    &[
                        "worktree",
                        "add",
                        &worktree_path.to_string_lossy(),
                        &branch_name,
                    ],
                )
                .await;

                match retry_output {
                    Ok(output) if output.status.success() => Json(CreateWorktreeResponse {
                        success: true,
                        worktree_path: worktree_path.to_string_lossy().to_string(),
                        branch: branch_name,
                        already_existed: true, // Branch existed even if worktree didn't
                    })
                    .into_response(),
                    Ok(output) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": format!("Failed to create worktree: {}", String::from_utf8_lossy(&output.stderr))
                        })),
                    )
                        .into_response(),
                    Err(e) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": format!("Failed to run git command: {}", e)
                        })),
                    )
                        .into_response(),
                }
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("Failed to create worktree: {}", stderr)
                    })),
                )
                    .into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to run git command: {}", e)
            })),
        )
            .into_response(),
    }
}

// ============================================================================
// Delete Worktree Endpoint
// ============================================================================

/// Request body for deleting a worktree.
#[derive(Deserialize)]
pub struct DeleteWorktreeRequest {
    /// Path to the git repository.
    pub repo_path: String,
    /// Bead ID for the worktree to delete.
    pub bead_id: String,
}

/// Response body for the delete worktree endpoint.
#[derive(Serialize)]
pub struct DeleteWorktreeResponse {
    /// Whether the operation was successful.
    pub success: bool,
}

/// Delete a worktree for a bead.
///
/// # Endpoint
///
/// `DELETE /api/git/worktree`
///
/// # Request Body
///
/// ```json
/// {
///   "repo_path": "/path/to/repo",
///   "bead_id": "BD-001"
/// }
/// ```
pub async fn delete_worktree(Json(request): Json<DeleteWorktreeRequest>) -> impl IntoResponse {
    let repo_path = Path::new(&request.repo_path);
    if let Err(resp) = check_repo_path(repo_path) { return resp.into_response(); }

    // Validate repository path exists
    if !repo_path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Repository path does not exist: {}", request.repo_path)
            })),
        )
            .into_response();
    }

    let branch_name = format!("bd-{}", request.bead_id);
    let worktree_path = repo_path.join(".worktrees").join(&branch_name);

    // Check if worktree exists
    if !worktree_path.exists() {
        return Json(DeleteWorktreeResponse { success: true }).into_response();
    }

    // Remove the worktree
    let output = super::git_output(
        &request.repo_path,
        &["worktree", "remove", &worktree_path.to_string_lossy()],
    )
    .await;

    let worktree_removed = match output {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Try force remove if there are untracked changes
            if stderr.contains("contains modified or untracked files") {
                let force_output = super::git_output(
                    &request.repo_path,
                    &[
                        "worktree",
                        "remove",
                        "--force",
                        &worktree_path.to_string_lossy(),
                    ],
                )
                .await;

                match force_output {
                    Ok(output) if output.status.success() => true,
                    _ => {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "error": format!("Failed to remove worktree: {}", stderr)
                            })),
                        )
                            .into_response();
                    }
                }
            } else {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("Failed to remove worktree: {}", stderr)
                    })),
                )
                    .into_response();
            }
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to run git command: {}", e)
                })),
            )
                .into_response();
        }
    };

    if worktree_removed {
        // Delete local branch (ignore errors - branch may not exist or be already deleted)
        let _ = super::git_output(&request.repo_path, &["branch", "-D", &branch_name]).await;

        // Close the bead (ignore errors - bead may not exist or already be closed)
        if let Some(bd_path) = super::find_bd() {
            let _ = Command::new(bd_path)
                .args(["close", &request.bead_id])
                .current_dir(&request.repo_path)
                .output()
                .await;
        }
    }

    Json(DeleteWorktreeResponse { success: true }).into_response()
}

// ============================================================================
// List Worktrees Endpoint
// ============================================================================

/// Query parameters for listing worktrees.
#[derive(Deserialize)]
pub struct ListWorktreesParams {
    /// Path to the git repository.
    pub repo_path: String,
}

/// Single worktree entry in the list response.
#[derive(Serialize)]
pub struct WorktreeEntry {
    /// Path to the worktree.
    pub path: String,
    /// Branch name.
    pub branch: String,
    /// Extracted bead ID (if it matches bd-{ID} pattern).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bead_id: Option<String>,
}

/// Response body for the list worktrees endpoint.
#[derive(Serialize)]
pub struct ListWorktreesResponse {
    /// List of worktrees.
    pub worktrees: Vec<WorktreeEntry>,
}

/// List all worktrees in a repository.
///
/// # Endpoint
///
/// `GET /api/git/worktrees?repo_path=...`
///
/// # Response
///
/// Returns a list of all worktrees with their paths, branches, and bead IDs.
pub async fn list_worktrees(Query(params): Query<ListWorktreesParams>) -> impl IntoResponse {
    let repo_path = Path::new(&params.repo_path);
    if let Err(resp) = check_repo_path(repo_path) { return resp.into_response(); }

    // Validate repository path exists
    if !repo_path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Repository path does not exist: {}", params.repo_path)
            })),
        )
            .into_response();
    }

    // List worktrees
    let output = super::git_output(&params.repo_path, &["worktree", "list", "--porcelain"]).await;

    match output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let worktrees = parse_worktree_list(&stdout, &params.repo_path);
            Json(ListWorktreesResponse { worktrees }).into_response()
        }
        Ok(output) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to list worktrees: {}", String::from_utf8_lossy(&output.stderr))
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to run git command: {}", e)
            })),
        )
            .into_response(),
    }
}

/// Parse the porcelain output of `git worktree list`.
fn parse_worktree_list(output: &str, repo_path: &str) -> Vec<WorktreeEntry> {
    let mut worktrees = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        if line.starts_with("worktree ") {
            // Save previous entry if complete
            if let (Some(path), Some(branch)) = (current_path.take(), current_branch.take()) {
                // Only include worktrees in .worktrees directory
                if path.contains(".worktrees/bd-") {
                    let bead_id = extract_bead_id(&branch);
                    worktrees.push(WorktreeEntry {
                        path,
                        branch,
                        bead_id,
                    });
                }
            }
            current_path = Some(line.trim_start_matches("worktree ").to_string());
        } else if line.starts_with("branch ") {
            // Extract just the branch name from refs/heads/...
            let full_ref = line.trim_start_matches("branch ");
            current_branch = Some(
                full_ref
                    .trim_start_matches("refs/heads/")
                    .to_string(),
            );
        }
    }

    // Don't forget the last entry
    if let (Some(path), Some(branch)) = (current_path, current_branch) {
        if path.contains(".worktrees/bd-") {
            let bead_id = extract_bead_id(&branch);
            worktrees.push(WorktreeEntry {
                path,
                branch,
                bead_id,
            });
        }
    }

    // Also include worktrees from main repo .worktrees directory that may not be in git worktree list
    // (handles orphaned worktree directories)
    let worktrees_dir = Path::new(repo_path).join(".worktrees");
    if worktrees_dir.exists() {
        if let Ok(entries) = fs::read_dir(&worktrees_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.is_dir() {
                    let dir_name = entry.file_name().to_string_lossy().to_string();
                    if dir_name.starts_with("bd-") {
                        // Check if already in list
                        let already_listed = worktrees.iter().any(|w| w.path.ends_with(&dir_name));
                        if !already_listed {
                            let bead_id = extract_bead_id(&dir_name);
                            worktrees.push(WorktreeEntry {
                                path: entry_path.to_string_lossy().to_string(),
                                branch: dir_name,
                                bead_id,
                            });
                        }
                    }
                }
            }
        }
    }

    worktrees
}

/// Extract bead ID from a branch name like "bd-BD-001".
fn extract_bead_id(branch: &str) -> Option<String> {
    if branch.starts_with("bd-") {
        Some(branch.trim_start_matches("bd-").to_string())
    } else {
        None
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Get the number of commits ahead and behind for a worktree branch.
async fn get_ahead_behind_worktree(repo_path: &str, branch: &str) -> (i32, i32) {
    let base_branches = ["main", "master"];

    for base in base_branches {
        let output = super::git_output(
            repo_path,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{}...{}", base, branch),
            ],
        )
        .await;

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let parts: Vec<&str> = stdout.trim().split('\t').collect();
                if parts.len() == 2 {
                    let behind = parts[0].parse().unwrap_or(0);
                    let ahead = parts[1].parse().unwrap_or(0);
                    return (ahead, behind);
                }
            }
        }
    }

    (0, 0)
}

/// Check if a worktree has uncommitted changes.
async fn check_worktree_dirty(worktree_path: &str) -> bool {
    let output = super::git_output(worktree_path, &["status", "--porcelain"]).await;

    match output {
        Ok(o) => !o.stdout.is_empty(),
        Err(_) => false,
    }
}

/// Get the last modification time of a directory.
fn get_last_modified(path: &Path) -> Option<DateTime<Utc>> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(DateTime::<Utc>::from)
}

/// Ensure .worktrees/ is in the repository's .gitignore.
fn ensure_gitignore_entry(repo_path: &str) -> Result<(), std::io::Error> {
    let gitignore_path = format!("{}/.gitignore", repo_path);
    let content = fs::read_to_string(&gitignore_path).unwrap_or_default();

    if !content.contains(".worktrees/") && !content.contains(".worktrees") {
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&gitignore_path)?;
        writeln!(file, "\n# Git worktrees\n.worktrees/")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_bead_id() {
        assert_eq!(extract_bead_id("bd-BD-001"), Some("BD-001".to_string()));
        assert_eq!(extract_bead_id("bd-EPIC-001.1"), Some("EPIC-001.1".to_string()));
        assert_eq!(extract_bead_id("main"), None);
        assert_eq!(extract_bead_id("feature-branch"), None);
    }

    #[test]
    fn test_worktree_status_response_serialization() {
        let response = WorktreeStatusResponse {
            exists: true,
            worktree_path: Some("/repo/.worktrees/bd-BD-001".to_string()),
            branch: Some("bd-BD-001".to_string()),
            ahead: Some(5),
            behind: Some(2),
            dirty: Some(false),
            last_modified: None,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"exists\":true"));
        assert!(json.contains("\"ahead\":5"));
        assert!(json.contains("\"behind\":2"));
    }

    #[test]
    fn test_create_worktree_response_serialization() {
        let response = CreateWorktreeResponse {
            success: true,
            worktree_path: "/repo/.worktrees/bd-BD-001".to_string(),
            branch: "bd-BD-001".to_string(),
            already_existed: false,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"already_existed\":false"));
    }
}
