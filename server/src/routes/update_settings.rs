//! What the person has said about updates.
//!
//! One thing, for now: the version they asked not to be told about again.
//!
//! Held by the server rather than in a browser, for the same reason the search
//! settings are. Atelier answers the whole network, so the board opens on a
//! phone as readily as on the computer running it. A skip kept in one browser
//! would silence the notice on the desktop and leave it showing on the phone,
//! which is not what anybody means by skipping a version.
//!
//! Skipping is never a one-way door. The About section shows what was skipped
//! and takes it back, and a newer release notifies again regardless — a skip
//! names one version, not the idea of updating.

use axum::{extract::State, http::StatusCode, middleware, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::routes::projects::AppState;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

/// The version the person asked not to be told about again.
pub const SKIPPED: &str = "workbench.update.skipped-version";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    /// `None` means nothing is skipped — the row is deleted rather than set to
    /// an empty string, so "nothing skipped" has one spelling.
    pub skipped_version: Option<String>,
}

/// What the screen sends.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choosing {
    skipped_version: Option<String>,
}

/// The settings as stored, for the version check as well as for the screen.
pub fn update_settings(db: &AppState) -> Result<UpdateSettings, String> {
    let skipped_version = db
        .setting(SKIPPED)
        .map_err(|why| why.to_string())?
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    Ok(UpdateSettings { skipped_version })
}

async fn read(State(db): State<AppState>) -> Result<Json<UpdateSettings>, Refusal> {
    update_settings(&db)
        .map(Json)
        .map_err(|why| unreadable("The update settings could not be read", why))
}

async fn write(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<UpdateSettings>, Refusal> {
    let skipping = asked
        .skipped_version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());

    // A version is skipped by name. Storing anything that is not a version
    // would leave a row nothing can ever match, and so a notice that never
    // comes back — a silent, permanent off switch nobody asked for.
    if let Some(version) = skipping {
        if !looks_like_a_version(version) {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("A version to skip looks like 0.22.12, not {version:?}."),
            ));
        }
    }

    db.set_setting(SKIPPED, skipping)
        .map_err(|why| unreadable("The update settings could not be saved", why))?;

    read(State(db)).await
}

/// Whether a string is shaped like one of our versions: dotted numbers, with
/// an optional leading `v` because that is how the tags are written.
fn looks_like_a_version(version: &str) -> bool {
    let bare = version.strip_prefix('v').unwrap_or(version);
    !bare.is_empty()
        && bare.split('.').count() >= 2
        && bare
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// The routes, behind the guard the settings next door wear.
pub fn update_settings_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/update", get(read).put(write))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_dotted_numbers() {
        for good in ["0.22.12", "v0.22.12", "1.0", "10.20.30"] {
            assert!(looks_like_a_version(good), "{good} is a version");
        }
    }

    /// Each of these, stored, would be a row no release can ever match — a
    /// notice switched off for good rather than one version skipped.
    #[test]
    fn anything_that_is_not_a_version_is_refused() {
        for bad in ["", "latest", "0.22.12-rc1", "v", "..", "0..1", "22"] {
            assert!(!looks_like_a_version(bad), "{bad:?} is not a version");
        }
    }
}
