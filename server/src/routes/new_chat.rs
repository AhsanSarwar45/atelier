//! What a new chat starts as, before anybody has touched the dialog.
//!
//! Two choices live here: which agent the dialog opens on, and which account
//! of that agent it opens on. Both are stars in the dialog rather than fields
//! in a settings screen, and both mean the same modest thing — *start me here*
//! — which is why neither of them skips the dialog.
//!
//! ## Why the server holds them
//!
//! The provider half used to sit in the browser, under
//! `workbench.new-chat-default`. That made it a different answer on the phone,
//! the laptop and the desk, and it made it behave unlike the star beside it:
//! the model and effort stars already persist outside the browser, in the
//! provider's own configuration. Two stars drawn the same way and remembered
//! in different places is a thing a person finds out about by being surprised.
//! So this holds both, in the same `settings` table the terminal's shell
//! setting uses, and `migration` below carries the old browser value across
//! once.
//!
//! ## Why a stale profile is not refused
//!
//! A profile can be deleted from another tab between this being written and
//! this being read, and the registry that knows which profiles exist is not
//! this database. Rather than have the two disagree, the id is stored as
//! written and the dialog reconciles it against the list it has just fetched:
//! a default naming a profile that is gone simply is not among the profiles
//! offered, and the dialog opens on the system account. The alternative —
//! checking here — would refuse a save for a profile that was deleted a moment
//! later anyway, and would still have to be reconciled on the way out.

use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::routes::projects::AppState;
use crate::workbench::profiles;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

/// Which agent the dialog opens on.
const PROVIDER: &str = "workbench.new-chat.provider";

/// That the browser's old value has already been carried across, so a second
/// browser still holding a copy of it cannot undo a choice made since.
const MIGRATED: &str = "workbench.new-chat.migrated";

/// Which account of `brand` the dialog opens on.
fn profile_key(brand: &str) -> String {
    format!("workbench.new-chat.profile.{brand}")
}

/// The agents a chat can be started with. Spelled here rather than taken from
/// whatever the caller sent, so a typo cannot become a stored default that no
/// dialog can ever clear by pressing the star it does not draw.
const BRANDS: &[&str] = &["claude", "codex", "local"];

/// What a new chat starts as, as the server holds it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewChatDefaults {
    /// The agent to open on, or `null` for none chosen — which is not the same
    /// as none available, and leaves the dialog on the first agent it can use.
    provider: Option<String>,
    /// The account to open on, per agent, for the agents that have accounts.
    /// Only brands with a choice stored appear.
    profiles: BTreeMap<String, String>,
    /// Whether the browser's old value has already been carried across.
    migrated: bool,
}

/// What the dialog sends when a star is pressed.
///
/// Tagged rather than two optional fields, because "set the provider to
/// nothing" and "do not touch the provider" are both `null` in JSON and a
/// reader cannot tell them apart. The tag says which of the two choices this
/// request is about, and the value inside it says what that choice now is.
#[derive(Deserialize)]
#[serde(tag = "set", rename_all = "camelCase")]
enum Choosing {
    /// The agent to open on. `null` clears the choice.
    Provider { brand: Option<String> },
    /// The account to open `brand` on. `null` clears the choice.
    Profile {
        brand: String,
        profile: Option<String>,
    },
}

/// What the browser sends once, carrying `workbench.new-chat-default` across.
#[derive(Deserialize)]
struct Carrying {
    /// The old value verbatim: a brand, or `ask` for the person having said
    /// they wanted to be asked every time.
    provider: String,
}

/// GET /api/settings/new-chat
async fn read(State(db): State<AppState>) -> Result<Json<NewChatDefaults>, Refusal> {
    Ok(Json(as_it_stands(&db)?))
}

/// PUT /api/settings/new-chat
///
/// Answers the defaults as they now stand, so the dialog redraws its stars
/// from what the server holds rather than from what it hoped it did.
async fn write(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<NewChatDefaults>, Refusal> {
    match asked {
        Choosing::Provider { brand } => {
            let chosen = trimmed(brand.as_deref());
            if let Some(named) = chosen {
                if !BRANDS.contains(&named) {
                    return Err(unknown_brand(named));
                }
            }
            save(&db, PROVIDER, chosen)?;
        }
        Choosing::Profile { brand, profile } => {
            let brand = brand.trim();
            // The brands with accounts are the brands with a directory to point
            // at, which is one list and it lives in `profiles`. `local` runs
            // nothing that signs in, so a default account for it would be a
            // setting no screen could ever show.
            if profiles::variable(brand).is_none() {
                return Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!("{brand} does not sign in, so there is no account to start it on."),
                ));
            }
            save(&db, &profile_key(brand), trimmed(profile.as_deref()))?;
        }
    }

    Ok(Json(as_it_stands(&db)?))
}

/// POST /api/settings/new-chat/migration
///
/// The browser's `workbench.new-chat-default`, handed over once. Does nothing
/// the second time: a person who set a default here and then opened a browser
/// that still holds the old value should keep the choice they made, not have
/// it quietly replaced by the one they made before this setting moved.
async fn migrate(
    State(db): State<AppState>,
    Json(carried): Json<Carrying>,
) -> Result<Json<NewChatDefaults>, Refusal> {
    let already = db
        .setting(MIGRATED)
        .map_err(|why| unreadable("The new-chat defaults could not be read", why))?
        .is_some();

    if !already {
        // `ask` was the old spelling of "no default", and it arrives here as a
        // value like any other. It is carried across as nothing chosen, which
        // is what it always meant.
        let chosen = trimmed(Some(carried.provider.as_str())).filter(|named| *named != "ask");
        if let Some(named) = chosen {
            if !BRANDS.contains(&named) {
                return Err(unknown_brand(named));
            }
        }
        save(&db, PROVIDER, chosen)?;
        save(&db, MIGRATED, Some("yes"))?;
    }

    Ok(Json(as_it_stands(&db)?))
}

/// The defaults, read together.
fn as_it_stands(db: &AppState) -> Result<NewChatDefaults, Refusal> {
    let read = |key: &str| {
        db.setting(key)
            .map_err(|why| unreadable("The new-chat defaults could not be read", why))
    };

    let mut profiles_chosen = BTreeMap::new();
    for brand in BRANDS {
        if profiles::variable(brand).is_none() {
            continue;
        }
        if let Some(chosen) = read(&profile_key(brand))? {
            profiles_chosen.insert((*brand).to_string(), chosen);
        }
    }

    Ok(NewChatDefaults {
        provider: read(PROVIDER)?,
        profiles: profiles_chosen,
        migrated: read(MIGRATED)?.is_some(),
    })
}

/// A value as stored, with the two spellings of "nothing" folded into one.
fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn save(db: &AppState, key: &str, value: Option<&str>) -> Result<(), Refusal> {
    db.set_setting(key, value)
        .map_err(|why| unreadable("The new-chat defaults could not be saved", why))
}

fn unknown_brand(named: &str) -> Refusal {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        format!("There is no agent called {named} to start a chat with."),
    )
}

/// The database refusing to answer, which is not the person's doing and is not
/// written as though it were.
fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// The routes, behind the guard the settings next door wear.
pub fn new_chat_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/new-chat", get(read).put(write))
        .route("/settings/new-chat/migration", post(migrate))
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

    /// This machine, as a browser sitting in front of it names it.
    const OURS: &str = "localhost:3008";
    const WHERE: &str = "/api/settings/new-chat";

    /// One database, and a fresh router over it for each browser that asks —
    /// which is the whole point of the setting being here.
    fn served() -> (AppState, Router) {
        let db: AppState = Arc::new(Database::new_in_memory().expect("an empty settings database"));
        let app = Router::new().nest("/api", new_chat_routes().with_state(Arc::clone(&db)));
        (db, app)
    }

    fn another_browser(db: &AppState) -> Router {
        Router::new().nest("/api", new_chat_routes().with_state(Arc::clone(db)))
    }

    async fn ask(app: &Router, method: Method, path: &str, body: Option<Value>) -> (StatusCode, String) {
        let building = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, OURS);
        let request = match body {
            Some(json) => building
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json.to_string())),
            None => building.body(Body::empty()),
        }
        .expect("a request a browser could have sent");

        let answer = app
            .clone()
            .oneshot(request)
            .await
            .expect("the router should answer every request");
        let status = answer.status();
        let said = axum::body::to_bytes(answer.into_body(), 256 * 1024)
            .await
            .expect("an answer the whole of which arrives");
        (status, String::from_utf8_lossy(&said).into_owned())
    }

    fn as_json(said: &str) -> Value {
        serde_json::from_str(said).expect("an answer in JSON")
    }

    #[tokio::test]
    async fn nothing_chosen_is_one_state_and_the_answer_says_so() {
        let (_db, app) = served();
        let (status, said) = ask(&app, Method::GET, WHERE, None).await;
        assert_eq!(status, StatusCode::OK, "{said}");

        let answer = as_json(&said);
        assert!(answer["provider"].is_null(), "{said}");
        assert_eq!(answer["profiles"], json!({}), "{said}");
        assert_eq!(answer["migrated"], json!(false), "{said}");
    }

    #[tokio::test]
    async fn a_default_set_in_one_browser_is_read_back_in_another() {
        let (db, app) = served();
        let (status, said) = ask(
            &app,
            Method::PUT,
            WHERE,
            Some(json!({ "set": "provider", "brand": "codex" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{said}");

        let (status, said) = ask(
            &app,
            Method::PUT,
            WHERE,
            Some(json!({ "set": "profile", "brand": "codex", "profile": "work" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{said}");

        // A second browser, which has never seen either request and holds
        // nothing of its own.
        let (status, said) = ask(&another_browser(&db), Method::GET, WHERE, None).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        let answer = as_json(&said);
        assert_eq!(answer["provider"], json!("codex"), "{said}");
        assert_eq!(answer["profiles"]["codex"], json!("work"), "{said}");
    }

    #[tokio::test]
    async fn a_star_pressed_again_clears_the_choice() {
        let (_db, app) = served();
        ask(&app, Method::PUT, WHERE, Some(json!({ "set": "provider", "brand": "claude" }))).await;
        let (status, said) = ask(
            &app,
            Method::PUT,
            WHERE,
            Some(json!({ "set": "provider", "brand": Value::Null })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert!(
            as_json(&said)["provider"].is_null(),
            "a star pressed a second time should leave nothing chosen, and the answer says {said}"
        );
    }

    #[tokio::test]
    async fn an_agent_this_app_does_not_have_is_refused() {
        let (db, app) = served();
        let (status, why) = ask(
            &app,
            Method::PUT,
            WHERE,
            Some(json!({ "set": "provider", "brand": "gemini" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{why}");
        assert!(why.contains("gemini"), "{why:?}");
        assert_eq!(db.setting(PROVIDER).unwrap(), None);
    }

    #[tokio::test]
    async fn an_agent_that_never_signs_in_has_no_account_to_start_on() {
        let (db, app) = served();
        let (status, why) = ask(
            &app,
            Method::PUT,
            WHERE,
            Some(json!({ "set": "profile", "brand": "local", "profile": "work" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{why}");
        assert!(why.contains("local"), "{why:?}");
        assert_eq!(db.setting(&profile_key("local")).unwrap(), None);
    }

    #[tokio::test]
    async fn the_browsers_old_value_is_carried_across_once() {
        let (db, app) = served();
        let migration = format!("{WHERE}/migration");

        let (status, said) = ask(&app, Method::POST, &migration, Some(json!({ "provider": "claude" }))).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(as_json(&said)["provider"], json!("claude"), "{said}");
        assert_eq!(as_json(&said)["migrated"], json!(true), "{said}");

        // The choice changes here, and then a second browser turns up still
        // holding the value it stored before this setting moved.
        ask(&app, Method::PUT, WHERE, Some(json!({ "set": "provider", "brand": "codex" }))).await;
        let (status, said) = ask(
            &another_browser(&db),
            Method::POST,
            &migration,
            Some(json!({ "provider": "claude" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(
            as_json(&said)["provider"],
            json!("codex"),
            "a second browser's stale copy undid a choice made since, and the answer is {said}"
        );
    }

    #[tokio::test]
    async fn ask_every_time_was_the_old_spelling_of_no_default() {
        let (db, app) = served();
        let migration = format!("{WHERE}/migration");
        let (status, said) = ask(&app, Method::POST, &migration, Some(json!({ "provider": "ask" }))).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert!(as_json(&said)["provider"].is_null(), "{said}");
        assert_eq!(
            db.setting(MIGRATED).unwrap().is_some(),
            true,
            "carrying nothing across is still carrying it across, or the next browser does it again"
        );
    }
}
