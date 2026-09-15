//! How the AI search runs: which agent, on which account, with which model,
//! how hard it thinks, and how long it may take.
//!
//! Held by the server, in the same `settings` table the terminal's shell and
//! the new-chat defaults use, because the server is what starts the agent and
//! the app is opened from more than one device — a choice kept in one
//! browser would be a different search on the phone.
//!
//! Nothing chosen is a state of its own: the search then runs on the first
//! agent it can use, on that agent's own default model and effort.

use axum::{extract::State, http::StatusCode, middleware, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::routes::projects::AppState;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

const PROVIDER: &str = "workbench.search.provider";
const PROFILE: &str = "workbench.search.profile";
const MODEL: &str = "workbench.search.model";
const EFFORT: &str = "workbench.search.effort";
const TIME_LIMIT: &str = "workbench.search.time-limit";

/// The agents a search can run on.
const BRANDS: &[&str] = &["claude", "codex", "local"];

/// How long a search may run when nobody has said.
pub const DEFAULT_TIME_LIMIT: u32 = 120;
/// The shortest and longest a search may be given, in seconds: shorter than
/// the first is too little for an agent to read anything, longer than the
/// second is a search nobody is still waiting on.
const SHORTEST: u32 = 15;
const LONGEST: u32 = 900;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    pub provider: Option<String>,
    pub profile: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub time_limit_seconds: u32,
}

/// What the screen sends: every field it draws, as it now stands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choosing {
    provider: Option<String>,
    profile: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    time_limit_seconds: Option<u32>,
}

/// The settings as stored, for the search itself as well as for the screen.
pub fn search_settings(db: &AppState) -> Result<SearchSettings, String> {
    let read = |key: &str| db.setting(key).map_err(|why| why.to_string());
    Ok(SearchSettings {
        provider: read(PROVIDER)?,
        profile: read(PROFILE)?,
        model: read(MODEL)?,
        effort: read(EFFORT)?,
        time_limit_seconds: read(TIME_LIMIT)?
            .and_then(|seconds| seconds.parse().ok())
            .unwrap_or(DEFAULT_TIME_LIMIT),
    })
}

/// GET /api/settings/search
async fn read(State(db): State<AppState>) -> Result<Json<SearchSettings>, Refusal> {
    search_settings(&db)
        .map(Json)
        .map_err(|why| unreadable("The search settings could not be read", why))
}

/// PUT /api/settings/search
///
/// Answers the settings as they now stand, so the screen redraws from what the
/// server holds rather than from what it hoped it did.
async fn write(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<SearchSettings>, Refusal> {
    let provider = trimmed(asked.provider.as_deref());
    if let Some(named) = provider {
        if !BRANDS.contains(&named) {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("There is no agent called {named} to search with."),
            ));
        }
    }
    let seconds = asked.time_limit_seconds.unwrap_or(DEFAULT_TIME_LIMIT);
    if !(SHORTEST..=LONGEST).contains(&seconds) {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "A search can be given between {SHORTEST} and {LONGEST} seconds, not {seconds}."
            ),
        ));
    }
    let seconds = seconds.to_string();
    for (key, value) in [
        (PROVIDER, provider),
        (PROFILE, trimmed(asked.profile.as_deref())),
        (MODEL, trimmed(asked.model.as_deref())),
        (EFFORT, trimmed(asked.effort.as_deref())),
        (TIME_LIMIT, Some(seconds.as_str())),
    ] {
        db.set_setting(key, value)
            .map_err(|why| unreadable("The search settings could not be saved", why))?;
    }
    read(State(db)).await
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// The routes, behind the guard the settings next door wear.
pub fn search_settings_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/search", get(read).put(write))
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
    const WHERE: &str = "/api/settings/search";

    fn browser(db: &AppState) -> Router {
        Router::new().nest("/api", search_settings_routes().with_state(Arc::clone(db)))
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
    async fn nothing_chosen_runs_on_the_defaults() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        let (status, answer) = ask(&browser(&db), Method::GET, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            answer,
            json!({"provider":null,"profile":null,"model":null,"effort":null,"timeLimitSeconds":120})
        );
    }

    #[tokio::test]
    async fn what_is_chosen_is_what_the_next_browser_reads() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        let chosen = json!({"provider":"codex","profile":"work","model":"gpt-5.5","effort":"low","timeLimitSeconds":60});
        let (status, answer) = ask(&browser(&db), Method::PUT, Some(chosen.clone())).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(answer, chosen);
        // A reload is a fresh router over the same database.
        let (_, again) = ask(&browser(&db), Method::GET, None).await;
        assert_eq!(again, chosen);

        // Choosing the default again forgets the choice rather than storing "".
        let cleared = json!({"provider":"codex","profile":null,"model":"","effort":null,"timeLimitSeconds":60});
        let (_, answer) = ask(&browser(&db), Method::PUT, Some(cleared)).await;
        assert_eq!(answer["model"], Value::Null);
        assert_eq!(answer["profile"], Value::Null);
    }

    #[tokio::test]
    async fn an_unknown_agent_or_an_unreasonable_limit_is_refused_and_nothing_is_saved() {
        let db: AppState = Arc::new(Database::new_in_memory().unwrap());
        let (status, said) = ask(
            &browser(&db),
            Method::PUT,
            Some(json!({"provider":"gemini"})),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        let (status, said) = ask(
            &browser(&db),
            Method::PUT,
            Some(json!({"provider":"claude","timeLimitSeconds":3})),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        let (_, answer) = ask(&browser(&db), Method::GET, None).await;
        assert_eq!(answer["provider"], Value::Null);
    }
}
