//! Shared library settings. Uses the same local-origin protection as other
//! settings; imports are copies and never remove native provider files.
use crate::workbench::library;
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
    (StatusCode::UNPROCESSABLE_ENTITY, why)
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
        .filter(|id| !global.items.iter().any(|row| &row.item.id == *id))
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
pub fn routes() -> Router<crate::routes::projects::AppState> {
    Router::new()
        .route("/settings/library", get(read).put(write))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}
