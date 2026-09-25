//! Shared library settings. Uses the same local-origin protection as other
//! settings; imports are copies and never remove native provider files.
use crate::workbench::{agent_memory, library, skill_folders};
use axum::{extract::Query, http::StatusCode, middleware, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
pub struct Scope {
    path: Option<String>,
    preview: Option<String>,
}
fn root(value: Option<&str>) -> Result<Option<PathBuf>, String> {
    value
        .map(|value| {
            let path = Path::new(value);
            if !path.is_absolute() {
                return Err("Choose an absolute project folder".into());
            }
            std::fs::canonicalize(path).map_err(|e| e.to_string())
        })
        .transpose()
}
type Refusal = (StatusCode, String);
fn error(why: String) -> Refusal {
    let status = if why.contains("changed in another editor. Reload before") {
        StatusCode::CONFLICT
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    (status, why)
}
fn answer(scope: &Scope) -> Result<Value, String> {
    let data = library::data_dir()?;
    let path = root(scope.path.as_deref())?;
    let preview = root(scope.preview.as_deref())?;
    let held = library::read(&data, path.as_deref())?;
    let resolved = library::resolve(&data, path.as_deref().or(preview.as_deref()))?;
    let global = library::resolve(&data, None)?;
    let orphaned: Vec<_> = held
        .overrides
        .keys()
        .filter(|id| !global.items.iter().chain(resolved.items.iter()).any(|row| &row.item.id == *id))
        .collect();
    Ok(
        json!({"library":held,"revision":library::revision(&held),"source_revision":library::source_revision(&data)?,"resolved":resolved,"guidance":resolved.guidance(),"orphaned":orphaned,"inherited":global.items.into_iter().filter(|r|r.source == "global").map(|r|r.item).collect::<Vec<_>>()}),
    )
}
async fn read(Query(scope): Query<Scope>) -> Result<Json<Value>, Refusal> {
    tokio::task::spawn_blocking(move || answer(&scope))
        .await
        .map_err(|e| error(e.to_string()))?
        .map(Json)
        .map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    library: library::Library,
    revision: String,
    source_revision: Option<String>,
}
async fn write(
    Query(scope): Query<Scope>,
    Json(update): Json<Update>,
) -> Result<Json<Value>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let path = root(scope.path.as_deref())?;
        let global = library::resolve(&data, None)?;
        if path.is_some() {
            for item in &update.library.items {
                if global.items.iter().any(|g| g.item.id == item.id) {
                    return Err("Use Customize to override an inherited item".into());
                }
            }
        }
        if let Some(id) = update
            .library
            .output_style
            .as_deref()
            .filter(|id| !id.is_empty())
        {
            let found = update
                .library
                .items
                .iter()
                .chain(global.items.iter().filter(|_| path.is_some()).map(|r| &r.item))
                .any(|i| i.id == id && i.kind == library::Kind::OutputStyle);
            if !found {
                return Err("Select an existing output style".into());
            }
        }
        library::write_with_source(&data, path.as_deref(), &update.library, &update.revision, update.source_revision.as_deref())?;
        answer(&scope)
    })
    .await
    .map_err(|e| error(e.to_string()))?
    .map(Json)
    .map_err(error)
}

#[derive(Deserialize)]
struct SkillScope {
    path: Option<String>,
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillUpdate {
    item: library::Item,
    revision: String,
}
async fn read_skill(Query(scope): Query<SkillScope>) -> Result<Json<skill_folders::Editor>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let path = root(scope.path.as_deref())?;
        skill_folders::edit_read(&data, path.as_deref(), &scope.id)
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
async fn write_skill(Query(scope): Query<SkillScope>, Json(update): Json<SkillUpdate>) -> Result<Json<skill_folders::Editor>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let path = root(scope.path.as_deref())?;
        skill_folders::edit_write(&data, path.as_deref(), &scope.id, &update.item, &update.revision)
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteSkill { revision: String }
async fn plan_delete_skill(Query(scope): Query<SkillScope>) -> Result<Json<skill_folders::DeletePlan>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let path = root(scope.path.as_deref())?;
        skill_folders::delete_read(&data, path.as_deref(), &scope.id)
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
async fn delete_skill(Query(scope): Query<SkillScope>, Json(update): Json<DeleteSkill>) -> Result<Json<Value>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let path = root(scope.path.as_deref())?;
        skill_folders::delete_write(&data, path.as_deref(), &scope.id, &update.revision)
            .map(|archive| json!({"archive": archive}))
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
/// A project scope names the folder the editor opened; memory is keyed by its
/// project, so a worktree folder and its main checkout edit the same entries.
fn memory_root(data: &Path, scope: &Scope) -> Result<Option<PathBuf>, String> {
    Ok(root(scope.path.as_deref())?.map(|path| agent_memory::project_root(data, &path).unwrap_or(path)))
}
async fn read_memories(Query(scope): Query<Scope>) -> Result<Json<Value>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        agent_memory::listing(&data, memory_root(&data, &scope)?.as_deref())
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryUpdate {
    scope: agent_memory::Scope,
    memory: agent_memory::Memory,
    /// The ID being edited; absent when adding.
    previous_id: Option<String>,
    revision: Option<String>,
}
async fn write_memory(Query(scope): Query<Scope>, Json(update): Json<MemoryUpdate>) -> Result<Json<Value>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let root = memory_root(&data, &scope)?;
        if update.previous_id.is_some() && update.revision.is_none() {
            return Err("An edit must send the revision it read".into());
        }
        agent_memory::save(&data, update.scope, root.as_deref(), update.previous_id.as_deref(), update.revision.as_deref(), &update.memory)?;
        agent_memory::listing(&data, root.as_deref())
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryDelete {
    scope: agent_memory::Scope,
    id: String,
    revision: String,
}
async fn delete_memory(Query(scope): Query<Scope>, Json(update): Json<MemoryDelete>) -> Result<Json<Value>, Refusal> {
    tokio::task::spawn_blocking(move || {
        let data = library::data_dir()?;
        let root = memory_root(&data, &scope)?;
        agent_memory::remove(&data, update.scope, root.as_deref(), &update.id, Some(&update.revision))?;
        agent_memory::listing(&data, root.as_deref())
    }).await.map_err(|e| error(e.to_string()))?.map(Json).map_err(error)
}
pub fn routes() -> Router<crate::routes::projects::AppState> {
    Router::new()
        .route("/settings/library", get(read).put(write))
        .route("/settings/library/skill", get(read_skill).put(write_skill))
        .route("/settings/library/skill/delete", get(plan_delete_skill).delete(delete_skill))
        .route("/settings/library/memories", get(read_memories).put(write_memory).delete(delete_memory))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn stale_editor_responses_are_conflicts_not_validation_errors() {
        for message in [
            "Skill changed in another editor. Reload before saving.",
            "Library changed in another editor. Reload before saving.",
            "Global library changed in another editor. Reload before customizing it.",
            "Memory tabs changed in another editor. Reload before saving",
        ] {
            assert_eq!(error(message.into()).into_response().status(), StatusCode::CONFLICT);
        }
        assert_eq!(error("Invalid skill folder ID".into()).into_response().status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
}
