//! How much memory one chat may hold before Atelier stops it.
//!
//! Held by the server, in the same `settings` table the search and the
//! new-chat defaults use, because the server is what watches the processes and
//! what stops them. A limit kept in one browser would be no limit at all the
//! moment that browser was closed.
//!
//! Unset by default. While nothing is stored here, no chat is ever stopped for
//! its size; the watcher in `workbench::memory_limit` simply does nothing.

use axum::{extract::State, http::StatusCode, middleware, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::routes::projects::AppState;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

pub const LIMIT_GB: &str = "workbench.memory.limit-gb";

/// The smallest and largest limit worth storing. Below the first, a chat would
/// be stopped before its provider had finished starting; above the second, the
/// number is larger than any machine this runs on and means "no limit" said
/// the long way.
const SMALLEST_GB: f64 = 0.5;
const LARGEST_GB: f64 = 512.0;

const BYTES_PER_GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySettings {
    /// `None` is no limit, which is what an Atelier nobody has configured does.
    pub limit_gb: Option<f64>,
}

/// What the screen sends: the field it draws, as it now stands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choosing {
    limit_gb: Option<f64>,
}

/// The limit as stored, for the watcher as well as for the screen.
pub fn memory_settings(db: &AppState) -> Result<MemorySettings, String> {
    let stored = db.setting(LIMIT_GB).map_err(|why| why.to_string())?;
    Ok(MemorySettings {
        limit_gb: stored.and_then(|gb| gb.parse::<f64>().ok()).filter(sane),
    })
}

/// The limit in bytes, for comparing against a chat's measured size. `None`
/// when no limit is set, and when a stored value is one this server would now
/// refuse — a limit it cannot vouch for is no limit, not a wrong one.
pub fn limit_bytes(db: &AppState) -> Result<Option<u64>, String> {
    Ok(memory_settings(db)?
        .limit_gb
        .map(|gb| (gb * BYTES_PER_GB) as u64))
}

fn sane(gb: &f64) -> bool {
    gb.is_finite() && (SMALLEST_GB..=LARGEST_GB).contains(gb)
}

/// GET /api/settings/memory
async fn read(State(db): State<AppState>) -> Result<Json<MemorySettings>, Refusal> {
    memory_settings(&db)
        .map(Json)
        .map_err(|why| unreadable("The memory limit could not be read", why))
}

/// PUT /api/settings/memory
///
/// Answers the limit as it now stands, so the screen redraws from what the
/// server holds rather than from what it hoped it did.
async fn write(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<MemorySettings>, Refusal> {
    let stored = match asked.limit_gb {
        None => None,
        Some(gb) if sane(&gb) => Some(trimmed_number(gb)),
        Some(gb) => {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "A chat can be given between {SMALLEST_GB} and {LARGEST_GB} GB, not {gb}."
                ),
            ))
        }
    };
    db.set_setting(LIMIT_GB, stored.as_deref())
        .map_err(|why| unreadable("The memory limit could not be saved", why))?;
    read(State(db)).await
}

fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// `8` rather than `8.0`, so what is stored reads the way it was typed.
fn trimmed_number(gb: f64) -> String {
    let text = format!("{gb}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The routes, behind the guard the settings next door wear.
pub fn memory_settings_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/memory", get(read).put(write))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use axum::body::Body;
    use axum::http::{header, Method, Request};
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tower::ServiceExt;

    const OURS: &str = "localhost:3008";
    const WHERE: &str = "/api/settings/memory";

    fn browser(db: &AppState) -> Router {
        Router::new().nest("/api", memory_settings_routes().with_state(Arc::clone(db)))
    }

    async fn ask(app: &Router, method: Method, body: Option<Value>) -> (StatusCode, Value) {
        let building = Request::builder()
            .method(method)
            .uri(WHERE)
            .header(header::HOST, OURS);
        let request = match body {
            Some(json) => building
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json.to_string())),
            None => building.body(Body::empty()),
        }
        .unwrap();
        let answer = app.clone().oneshot(request).await.unwrap();
        let status = answer.status();
        let said = axum::body::to_bytes(answer.into_body(), 64 * 1024)
            .await
            .unwrap();
        let said = String::from_utf8_lossy(&said).into_owned();
        (
            status,
            serde_json::from_str(&said).unwrap_or(Value::String(said)),
        )
    }

    #[tokio::test]
    async fn an_atelier_nobody_configured_has_no_limit() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        let (status, answer) = ask(&browser(&db), Method::GET, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer, json!({ "limitGb": null }));
        assert_eq!(limit_bytes(&db).unwrap(), None);
    }

    #[tokio::test]
    async fn what_is_chosen_is_what_the_next_browser_reads() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        let (status, answer) = ask(&browser(&db), Method::PUT, Some(json!({"limitGb": 8}))).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(answer, json!({ "limitGb": 8.0 }));
        // A reload is a fresh router over the same database.
        let (_, again) = ask(&browser(&db), Method::GET, None).await;
        assert_eq!(again, json!({ "limitGb": 8.0 }));
        assert_eq!(limit_bytes(&db).unwrap(), Some(8 * 1024 * 1024 * 1024));
    }

    #[tokio::test]
    async fn clearing_the_limit_forgets_it_rather_than_storing_nothing() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        ask(&browser(&db), Method::PUT, Some(json!({"limitGb": 4.5}))).await;
        let (status, answer) = ask(&browser(&db), Method::PUT, Some(json!({"limitGb": null}))).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(answer, json!({ "limitGb": null }));
        assert_eq!(db.setting(LIMIT_GB).unwrap(), None);
    }

    #[tokio::test]
    async fn an_unreasonable_limit_is_refused_and_the_old_one_stands() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        ask(&browser(&db), Method::PUT, Some(json!({"limitGb": 8}))).await;
        for absurd in [0.1, 4096.0] {
            let (status, said) =
                ask(&browser(&db), Method::PUT, Some(json!({"limitGb": absurd}))).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        }
        let (_, answer) = ask(&browser(&db), Method::GET, None).await;
        assert_eq!(answer, json!({ "limitGb": 8.0 }));
    }

    /// A limit written by a build that allowed more than this one does is not
    /// a limit this server will enforce against a chat.
    #[tokio::test]
    async fn a_stored_limit_outside_the_range_reads_as_no_limit() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        db.set_setting(LIMIT_GB, Some("9999")).unwrap();
        assert_eq!(memory_settings(&db).unwrap().limit_gb, None);
        assert_eq!(limit_bytes(&db).unwrap(), None);
    }
}
