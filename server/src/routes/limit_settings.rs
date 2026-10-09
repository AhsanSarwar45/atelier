//! Whether a chat stopped by a usage limit resumes on its own once the limit
//! resets.
//!
//! Held by the server, beside the memory limit, because the server is what
//! watches for the reset and sends the chat on its way; a choice kept in one
//! browser would stop working the moment that browser closed.
//!
//! Off by default. While it is off the watcher in `workbench::limit_resume`
//! reads this one setting and does nothing else. On, it stores when it was
//! turned on: only a limit that resets after that is resumed from, so turning
//! it on does not wake every chat that ever ran into a limit.

use chrono::{DateTime, Utc};
use axum::{extract::State, http::StatusCode, middleware, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::routes::projects::AppState;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

pub const AUTO_RESUME: &str = "workbench.limits.auto-resume";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitSettings {
    pub auto_resume: bool,
}

/// The choice as stored, for the screen.
pub fn limit_settings(db: &AppState) -> Result<LimitSettings, String> {
    Ok(LimitSettings {
        auto_resume: resuming_since(db)?.is_some(),
    })
}

/// When resuming was turned on, or `None` while it is off. A stored value
/// that is not a time reads as off: a choice this server cannot date is not
/// one it can keep to.
pub fn resuming_since(db: &AppState) -> Result<Option<DateTime<Utc>>, String> {
    let stored = db.setting(AUTO_RESUME).map_err(|why| why.to_string())?;
    Ok(stored
        .and_then(|at| DateTime::parse_from_rfc3339(&at).ok())
        .map(|at| at.to_utc()))
}

/// GET /api/settings/limits
async fn read(State(db): State<AppState>) -> Result<Json<LimitSettings>, Refusal> {
    limit_settings(&db)
        .map(Json)
        .map_err(|why| unreadable("The usage limit settings could not be read", why))
}

/// PUT /api/settings/limits
///
/// Answers the settings as they now stand, so the screen redraws from what
/// the server holds rather than from what it hoped it did.
async fn write(
    State(db): State<AppState>,
    Json(asked): Json<LimitSettings>,
) -> Result<Json<LimitSettings>, Refusal> {
    let already = resuming_since(&db)
        .map_err(|why| unreadable("The usage limit settings could not be read", why))?;
    // Turning it on again keeps the time it was first turned on.
    let stored = match (asked.auto_resume, already) {
        (false, _) => None,
        (true, Some(since)) => Some(since.to_rfc3339()),
        (true, None) => Some(Utc::now().to_rfc3339()),
    };
    db.set_setting(AUTO_RESUME, stored.as_deref())
        .map_err(|why| unreadable("The usage limit settings could not be saved", why))?;
    read(State(db)).await
}

fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// The routes, behind the guard the settings next door wear.
pub fn limit_settings_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/limits", get(read).put(write))
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

    async fn ask(db: &AppState, method: Method, body: Option<Value>) -> (StatusCode, Value) {
        let app = Router::new().nest("/api", limit_settings_routes().with_state(Arc::clone(db)));
        let building = Request::builder()
            .method(method)
            .uri("/api/settings/limits")
            .header(header::HOST, "localhost:3008");
        let request = match body {
            Some(json) => building
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json.to_string())),
            None => building.body(Body::empty()),
        }
        .unwrap();
        let answer = app.oneshot(request).await.unwrap();
        let status = answer.status();
        let said = axum::body::to_bytes(answer.into_body(), 64 * 1024).await.unwrap();
        (status, serde_json::from_slice(&said).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn resuming_is_off_until_someone_turns_it_on() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        assert_eq!(ask(&db, Method::GET, None).await.1, json!({"autoResume": false}));
        let (status, answer) = ask(&db, Method::PUT, Some(json!({"autoResume": true}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(answer, json!({"autoResume": true}));
        let since = resuming_since(&db).unwrap().expect("on, since now");
        ask(&db, Method::PUT, Some(json!({"autoResume": true}))).await;
        assert_eq!(resuming_since(&db).unwrap(), Some(since), "saving it on again moved when it was turned on");
        ask(&db, Method::PUT, Some(json!({"autoResume": false}))).await;
        assert_eq!(db.setting(AUTO_RESUME).unwrap(), None);
    }
}
