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

use axum::{extract::State, http::StatusCode, middleware, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};

use crate::reachable::{BIND_HOST_SETTING, PORT_SETTING};
use crate::remote::{self, Standing, SERVING_SETTING};
use crate::routes::projects::AppState;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, Json<Trouble>);

/// What a refused call answers with.
///
/// A sentence, always. And sometimes somewhere to go: the one refusal a
/// reader can act on from this screen is a Tailscale network whose owner has
/// never allowed Serve, and that is put right by visiting a link Tailscale
/// hands back. Flattening it into a sentence with a URL buried in the middle
/// would leave the screen nothing it could make clickable, so the link rides
/// beside the sentence instead of inside it.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Trouble {
    /// What went wrong, in the reader's words. Named `error` because that is
    /// the field every refusal in this app already answers with, and the
    /// browser reads the sentence out of it without being taught this one.
    pub error: String,
    /// Where to go to put it right, when there is such a place.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// A refusal with nothing to click.
fn refused(code: StatusCode, why: impl Into<String>) -> Refusal {
    (code, Json(Trouble { error: why.into(), link: None }))
}

/// A refusal from Tailscale, keeping whatever it left to act on.
fn turned_away(why: remote::Refused) -> Refusal {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(Trouble {
            link: match &why {
                remote::Refused::NeedsConsent { link } => Some(link.clone()),
                remote::Refused::Said(_) => None,
            },
            error: why.said(),
        }),
    )
}

/// Run blocking work somewhere other than the runtime's own threads.
///
/// Everything Tailscale is asked here is a process that has to be started and
/// waited for. Waiting for one on a runtime thread is a thread answering
/// nobody — and while `tailscale serve` could wait forever, that was the whole
/// app going quiet rather than this one call (bw-ar1o).
async fn away<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Refusal> {
    tokio::task::spawn_blocking(work).await.map_err(|e| {
        refused(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("The remote access step could not be run: {e}"),
        )
    })
}

/// What Tailscale says right now: how far along this computer is, and whether
/// this port is on the network. Both readings taken together, once, off the
/// runtime's threads.
async fn from_tailscale(port: u16) -> Result<(Standing, bool), Refusal> {
    away(move || (remote::standing(), remote::serving_now(port))).await
}

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
    /// The address to type on this computer's own network, when it answers
    /// there at all.
    pub home_address: Option<String>,
    /// What the server binds, as stored. `null` for the default.
    pub bind_host: Option<String>,
    /// What this computer binds with nothing stored, so the field can say what
    /// leaving it empty means.
    pub bind_host_default: String,
    /// The port this copy is answering on right now.
    pub port: u16,
    /// The port the next start will take, when that is not this one. The
    /// screen says so rather than drawing an address nothing answers yet.
    pub next_port: Option<u16>,
    /// Whether something saved here is waiting on a restart to take effect.
    pub needs_restart: bool,
    /// Whether this copy can restart itself, so the screen offers a button
    /// rather than a sentence about terminals.
    pub can_restart: bool,
    /// What renames this computer, which is the name half of the home address.
    pub rename_command: &'static str,
}

/// What the screen sends. Every field is optional and absent means unchanged,
/// so the switch can be flipped without the screen having to send back the
/// two text fields it did not touch.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choosing {
    serving: Option<bool>,
    bind_host: Option<String>,
    port: Option<u16>,
}

/// POST /api/settings/remote/restart
///
/// Answers first and stops second, so the browser sees the restart it asked
/// for succeed rather than the connection it was riding on disappear.
async fn restart() -> Result<StatusCode, Refusal> {
    if !crate::handover::can_come_back() {
        return Err(refused(
            StatusCode::CONFLICT,
            format!(
                "This copy was started by hand, so stopping it would leave nothing running.                  Quit it and run `{} run` again.",
                crate::identity::NAME
            ),
        ));
    }
    crate::handover::come_back_now();
    Ok(StatusCode::ACCEPTED)
}

/// GET /api/settings/remote
async fn read_remote(State(db): State<AppState>) -> Result<Json<RemoteAccess>, Refusal> {
    let (standing, serving) = from_tailscale(crate::service::port()).await?;
    Ok(Json(as_it_stands(&db, standing, serving).await?))
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
        if let Some(why) = why_not_a_host(kept) {
            return Err(refused(StatusCode::UNPROCESSABLE_ENTITY, why));
        }
        store(&db, BIND_HOST_SETTING, kept)?;
    }
    if let Some(wanted) = asked.port {
        if !crate::reachable::usable_port(wanted) {
            return Err(refused(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("{wanted} is below 1024, which this app is not allowed to take. Pick 1024 or higher."),
            ));
        }
        let host = crate::service::running_host();
        if wanted != crate::service::running_port()
            && !crate::reachable::port_is_free(&host, wanted)
        {
            return Err(refused(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Port {wanted} is already in use by something else. Pick another one."),
            ));
        }
        store(&db, PORT_SETTING, Some(wanted.to_string().as_str()))?;
    }
    if let Some(on) = asked.serving {
        // Tailscale first. If it refuses, nothing is remembered, because a
        // switch drawn on over a board nobody can reach is worse than a
        // refusal drawn under it.
        away(move || remote::set_serving(on, port))
            .await?
            .map_err(turned_away)?;
        store(&db, SERVING_SETTING, on.then_some("on"))?;
    }

    let (standing, serving) = from_tailscale(port).await?;
    Ok(Json(as_it_stands(&db, standing, serving).await?))
}

/// Everything the section draws, put together out of what the settings hold
/// and what Tailscale was just asked.
async fn as_it_stands(
    db: &AppState,
    standing: Standing,
    serving: bool,
) -> Result<RemoteAccess, Refusal> {
    let port = crate::service::port();
    let bind_host = read(db, BIND_HOST_SETTING)?;
    let next_port = read(db, PORT_SETTING)?.and_then(|said| said.parse::<u16>().ok());
    // Asking the network what this computer is called shells out to
    // `hostname` and then waits up to 1200ms on a multicast answer. Both are
    // blocking, and an async worker parked on them is a worker not serving
    // anyone else, so they are handed to a thread that is allowed to wait.
    let (network, name) = tokio::task::spawn_blocking(|| {
        let network = crate::reachable::on_this_network();
        let name = crate::reachable::name_on_this_network(network);
        (network, name)
    })
    .await
    .unwrap_or((None, None));
    Ok(RemoteAccess {
        standing: named(&standing),
        wrong: standing.wrong(),
        serving,
        address: match &standing {
            Standing::Ready { address } => Some(address.clone()),
            _ => None,
        },
        // Built from what this copy actually bound, not from what is stored.
        // The port beside it already comes from the running process, and an
        // address made half of one and half of the other is an address that
        // answers nowhere. What is stored but not yet bound is the restart's
        // business, not this line's.
        home_address: crate::reachable::home_address(
            &crate::service::running_host(),
            port,
            network,
            name.as_deref(),
        ),
        bind_host,
        bind_host_default: crate::reachable::bind_host_from(None, None),
        port,
        next_port: next_port.filter(|&wanted| wanted != port),
        needs_restart: next_port.is_some_and(|wanted| wanted != port)
            || crate::reachable::bind_host() != crate::service::running_host(),
        can_restart: crate::handover::can_come_back(),
        rename_command: crate::reachable::rename_command(),
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
    refused(StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// The routes, behind the guard that decides who may reach them.
pub fn remote_access_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/remote", get(read_remote).put(write_remote))
        .route("/settings/remote/restart", post(restart))
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

    /// A refusal the reader can act on keeps the thing to act on.
    ///
    /// The sentence alone would have the link buried in the middle of it,
    /// where a browser cannot make it clickable and a reader has to select a
    /// URL out of a line of prose to get anywhere (bw-ar1o).
    #[test]
    fn a_refusal_with_somewhere_to_go_hands_the_screen_the_link() {
        let link = "https://login.tailscale.com/f/serve?node=abc";
        let (code, Json(trouble)) = turned_away(remote::Refused::NeedsConsent {
            link: link.to_string(),
        });
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(trouble.link.as_deref(), Some(link));
        // The screen draws the link as a link, so the sentence beside it does
        // not spell the same address out again.
        assert!(!trouble.error.contains("https://"), "{}", trouble.error);
        assert!(trouble.error.contains("has not turned on Serve"));
    }

    /// Every other refusal is a sentence and nothing more, so the screen is
    /// never left offering a button that goes nowhere.
    #[test]
    fn a_refusal_with_nowhere_to_go_offers_nothing_to_click() {
        let (_, Json(trouble)) =
            turned_away(remote::Refused::Said("Tailscale is off.".to_string()));
        assert_eq!(trouble.link, None);
        assert_eq!(trouble.error, "Tailscale is off.");
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
