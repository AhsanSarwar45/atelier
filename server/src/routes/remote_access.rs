//! Reaching the board from outside the house, as something a person switches
//! on rather than a page of shell commands.
//!
//! The board has no sign-in. Anything that can reach it can write to this
//! computer's home directory, start agents on it and push with its git
//! credentials, so the answer to "open it from away" is never a hole in a
//! router — it is a private network only this person's own devices are on.
//! `docs/remote-access.md` says why at length.
//!
//! Tailscale is what makes that a switch. Installing it needs a password and
//! so stays a command (`atelier remote install`, `remote.rs`); that command
//! hands operation to this user, and every later start and stop — including
//! the two this file does — then needs nothing.
//!
//! ## Why the standing is seven things and not two
//!
//! Installed, daemon running, signed in, named, serving: a screen that only
//! said "not working" would leave the reader to find out which. Each one has
//! its own sentence naming the one thing to do next.
//!
//! ## Why the guard is on these routes
//!
//! A `PUT` here changes what this server puts on a network, and what address
//! it binds the next time it starts. That is the same surface as the terminal
//! settings next door, so it wears the same allowlist (`local_host.rs`) — and
//! that allowlist admits the names this machine answers to on its own
//! network, so the phone in the next room still reaches it.

use axum::{extract::State, http::StatusCode, middleware, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::reachable::{BIND_HOST_SETTING, PUBLIC_URL_SETTING};
use crate::remote::{self, Standing};
use crate::routes::projects::AppState;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

/// Whether the switch was left on. What is actually being served is read from
/// Tailscale and not from here; this is what the app puts back after a
/// restart.
pub const SERVING_SETTING: &str = "remote.serving";

/// Everything the Remote access section draws.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccess {
    /// Which of the steps this computer has reached, as one word the screen
    /// can branch on.
    pub standing: &'static str,
    /// The one thing to do next, or `null` when there is nothing.
    pub wrong: Option<String>,
    /// Whether the board is on the private network right now, read from
    /// Tailscale rather than from what was last asked for.
    pub serving: bool,
    /// The https address a phone opens, once there is one.
    pub address: Option<String>,
    /// What the server binds, as stored. `null` for the default.
    pub bind_host: Option<String>,
    /// What this computer binds with nothing stored, so the field can say what
    /// leaving it empty means.
    pub bind_host_default: String,
    /// The address the app tells people to open, as stored. `null` for none.
    pub public_url: Option<String>,
    /// The address it will actually publish, once the two above are resolved.
    pub publishing: Option<String>,
    /// The port being served, so the screen can say what is being exposed.
    pub port: u16,
}

/// What the screen sends. Every field is optional and absent means unchanged,
/// so the switch can be flipped without the screen having to send back the
/// two text fields it did not touch.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choosing {
    serving: Option<bool>,
    bind_host: Option<String>,
    public_url: Option<String>,
}

/// GET /api/settings/remote
async fn read_remote(State(db): State<AppState>) -> Result<Json<RemoteAccess>, Refusal> {
    Ok(Json(as_it_stands(&db)?))
}

/// PUT /api/settings/remote
///
/// Answers with the section as it now stands, read back from Tailscale, so the
/// switch shows what is true rather than what was asked for.
async fn write_remote(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<RemoteAccess>, Refusal> {
    let port = crate::service::port();

    if let Some(said) = &asked.bind_host {
        let kept = tidied(said);
        if let Some(why) = why_not_a_host(kept.as_deref()) {
            return Err((StatusCode::UNPROCESSABLE_ENTITY, why));
        }
        store(&db, BIND_HOST_SETTING, kept.as_deref())?;
    }
    if let Some(said) = &asked.public_url {
        store(&db, PUBLIC_URL_SETTING, tidied(said).as_deref())?;
    }
    if let Some(on) = asked.serving {
        // Tailscale first. If it refuses, nothing is remembered, because a
        // switch drawn on over a board nobody can reach is worse than a
        // refusal drawn under it.
        remote::set_serving(on, port).map_err(|why| (StatusCode::UNPROCESSABLE_ENTITY, why))?;
        store(&db, SERVING_SETTING, on.then_some("on"))?;
    }

    Ok(Json(as_it_stands(&db)?))
}

/// Everything the section draws, read together.
fn as_it_stands(db: &AppState) -> Result<RemoteAccess, Refusal> {
    let port = crate::service::port();
    let standing = remote::standing();
    let bind_host = read(db, BIND_HOST_SETTING)?;
    let public_url = read(db, PUBLIC_URL_SETTING)?;
    Ok(RemoteAccess {
        standing: named(&standing),
        wrong: standing.wrong(),
        serving: remote::serving_now(port),
        address: match &standing {
            Standing::Ready { address } => Some(address.clone()),
            _ => None,
        },
        publishing: crate::reachable::published_url_from(None, public_url.clone()),
        bind_host,
        bind_host_default: crate::reachable::bind_host_from(None, None),
        public_url,
        port,
    })
}

/// One word for each standing, so the screen can branch without reading
/// English. The words are the steps in the order they are reached.
fn named(standing: &Standing) -> &'static str {
    match standing {
        Standing::NotInstalled => "not-installed",
        Standing::NotAnswering { .. } => "not-answering",
        Standing::NeedsSignIn => "needs-sign-in",
        Standing::Stopped => "stopped",
        Standing::Starting => "starting",
        Standing::Unnamed => "unnamed",
        Standing::Ready { .. } => "ready",
    }
}

/// A field as typed, with the spaces a paste brings along taken off, and
/// emptiness read as "nothing chosen" rather than as a choice.
fn tidied(said: &str) -> Option<&str> {
    Some(said.trim()).filter(|said| !said.is_empty())
}

/// Why this cannot be what the server binds, in one sentence, or `None`.
///
/// Refusing here matters more than it looks: a host the computer cannot bind
/// is not found out until the next start, by which time the app does not come
/// up at all and the screen that could have said so is unreachable.
fn why_not_a_host(said: Option<&str>) -> Option<String> {
    let said = said?;
    if said.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(format!(
        "{said} is not an address this computer can listen on. Use 0.0.0.0 to answer on every \
         network, or 127.0.0.1 to answer only on this computer."
    ))
}

/// One setting, read.
fn read(db: &AppState, key: &str) -> Result<Option<String>, Refusal> {
    db.setting(key)
        .map_err(|why| unreadable("The remote access settings could not be read", why))
}

/// One setting, written. `None` puts it back to the default.
fn store(db: &AppState, key: &str, value: Option<&str>) -> Result<(), Refusal> {
    db.set_setting(key, value)
        .map_err(|why| unreadable("The remote access settings could not be saved", why))
}

/// The database refusing to answer, which is not the person's doing and is not
/// written as though it were.
fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// The routes, behind the guard that decides who may reach them.
pub fn remote_access_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/remote", get(read_remote).put(write_remote))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every standing has its own word, and no two share one.
    ///
    /// The screen branches on these. Two standings sharing a word would draw
    /// the wrong next step for one of them, which is the whole reason the
    /// standing is seven things (bw-hdor.3).
    #[test]
    fn each_step_the_screen_draws_has_its_own_word() {
        let all = [
            Standing::NotInstalled,
            Standing::NotAnswering { said: String::new() },
            Standing::NeedsSignIn,
            Standing::Stopped,
            Standing::Starting,
            Standing::Unnamed,
            Standing::Ready { address: String::new() },
        ];
        let mut words: Vec<&str> = all.iter().map(named).collect();
        let counted = words.len();
        words.sort_unstable();
        words.dedup();
        assert_eq!(words.len(), counted, "two standings answer to the same word");
    }

    /// A host the computer could not bind is refused while the screen is still
    /// there to show the refusal.
    ///
    /// Storing one would be found out at the next start, with the app not
    /// coming up and the settings screen that could have undone it gone with
    /// it (bw-hdor.3).
    #[test]
    fn a_host_this_computer_cannot_listen_on_is_refused_rather_than_stored() {
        assert_eq!(why_not_a_host(Some("0.0.0.0")), None);
        assert_eq!(why_not_a_host(Some("127.0.0.1")), None);
        assert_eq!(why_not_a_host(Some("::1")), None);
        assert_eq!(why_not_a_host(None), None, "clearing it is not a bad host");

        let said = why_not_a_host(Some("my-desk")).expect("a name is not an address to bind");
        assert!(said.contains("my-desk"), "the refusal does not name it: {said}");
        assert!(said.contains("127.0.0.1"), "the refusal offers no way out: {said}");
    }

    /// Spaces a paste brings along are not a setting, and neither is nothing.
    #[test]
    fn an_emptied_field_clears_the_setting_rather_than_storing_a_blank() {
        assert_eq!(tidied("  https://desk.ts.net "), Some("https://desk.ts.net"));
        assert_eq!(tidied("   "), None);
        assert_eq!(tidied(""), None);
    }
}
