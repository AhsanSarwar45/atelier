//! What the app itself was told to do, as opposed to what it was told about.
//!
//! One setting so far: which shell the terminal opens. It is here and not in
//! the browser because the server is what spawns the shell, and because the app
//! is opened from more than one machine in a house — a choice kept in local
//! storage would be a different choice on the phone, the laptop and the desk,
//! and only one of those three would be right.
//!
//! ## Why this lives beside the terminal and not beside the other settings
//!
//! There is no other settings module yet, and every neighbour this one has is
//! in here: it reads `/etc/shells` through `shell.rs`, it answers with the
//! default that `shell.rs` computes for the spawn, and it wears the same guard
//! as the routes next door. `src/lib.rs`, which exists so integration tests can
//! reach the crate, carries `routes` but not `terminal`; a settings module put
//! under `routes` would have dragged the whole pty stack in behind it and run
//! every shell test twice.
//!
//! ## Why the guard is on these routes too
//!
//! A `PUT` here names the program this server will run as a login shell the
//! next time anybody opens a tab. That is the same surface as the terminal
//! itself, so it is behind the same allowlist (`local_host.rs`) and for the
//! same reason — and the allowlist admits the names this machine answers to on
//! its own network, so the phone at the other end of the house still reaches
//! it.
//!
//! ## Why a refusal here is a sentence and not a code
//!
//! It is drawn straight under the field the person typed into. A `422` with a
//! JSON body would have to be translated into English by the browser, in words
//! that would then say what this file believes rather than what it checked. So
//! this answers a plain sentence naming the path, the way the terminal's own
//! refusals do, and the form shows it as it was written.

use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::routes::projects::AppState;
use crate::terminal::shell;

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

/// The terminal's shell setting, and everything the screen needs to draw it.
#[derive(Serialize)]
struct TerminalShell {
    /// What was chosen, or `null` for nobody having chosen.
    shell: Option<String>,
    /// What this computer would open with nothing chosen, so the field can say
    /// what leaving it empty means instead of leaving the reader to guess.
    default: String,
    /// What there is to choose from. A suggestion and not a limit: a shell that
    /// is installed but unlisted is still a shell, and typing its path works.
    available: Vec<String>,
}

/// What the screen sends when somebody presses Save.
#[derive(Deserialize)]
struct Choosing {
    /// The path chosen, or `null` to go back to what this computer records.
    shell: Option<String>,
}

/// GET /api/settings/terminal
async fn read_terminal(State(db): State<AppState>) -> Result<Json<TerminalShell>, Refusal> {
    Ok(Json(as_it_stands(&db)?))
}

/// PUT /api/settings/terminal
///
/// Answers with the setting as it now stands, so the screen redraws from what
/// the server holds rather than from what was typed into it.
async fn write_terminal(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<TerminalShell>, Refusal> {
    // An empty field and an absent one both mean "no choice". Trimmed first,
    // because a path pasted out of a terminal brings a space with it and a
    // trailing space is not something a person can see to remove.
    let chosen = asked
        .shell
        .as_deref()
        .map(str::trim)
        .filter(|named| !named.is_empty());

    if let Some(named) = chosen {
        if let Some(why) = why_not(named) {
            // Nothing is written on this path. A setting half-saved is the one
            // outcome worse than a refusal: the screen says it failed and the
            // next tab opens the shell it says it did not save.
            return Err((StatusCode::UNPROCESSABLE_ENTITY, why));
        }
    }

    db.set_terminal_shell(chosen.map(Path::new))
        .map_err(|why| unreadable("The chosen shell could not be saved", why))?;

    Ok(Json(as_it_stands(&db)?))
}

/// The setting, the default, and the list, read together.
fn as_it_stands(db: &AppState) -> Result<TerminalShell, Refusal> {
    let chosen = db
        .terminal_shell()
        .map_err(|why| unreadable("The chosen shell could not be read", why))?;

    let default = shell::system_default();
    let mut available = shell::listed();
    // The default belongs on the list whether or not this computer lists it.
    // `/etc/shells` is a package manager's file, and a shell built by hand or
    // installed into a home directory is missing from it — including, on the
    // machine this was written on, the one the person actually uses.
    if !available.contains(&default) {
        available.push(default.clone());
    }

    Ok(TerminalShell {
        shell: chosen.map(said),
        default: said(default),
        available: available.into_iter().map(said).collect(),
    })
}

/// Why this path cannot be a shell, in one sentence, or `None` if it can.
///
/// Each answer names the path back, because a person who typed one path and
/// pasted another needs to see which of the two is being refused.
fn why_not(named: &str) -> Option<String> {
    let path = Path::new(named);
    if !path.is_absolute() {
        return Some(format!(
            "A shell has to be named by its whole path from the root, and {named} is not."
        ));
    }
    match std::fs::metadata(path) {
        Err(_) => Some(format!("There is nothing at {named} to open a shell from.")),
        Ok(what) if !what.is_file() => {
            Some(format!("{named} is not a file, so there is no shell there to open."))
        }
        Ok(_) if !shell::runnable(path) => Some(format!(
            "{named} is not something this computer will run, so no shell could start from it."
        )),
        Ok(_) => None,
    }
}

/// A path as the screen shows it. Lossy, and it can only be lossy in a place
/// this cannot reach: every path here arrived as JSON text or came out of
/// `/etc/shells`, and both of those are already valid text.
fn said(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// The database refusing to answer, which is not the person's doing and is not
/// written as though it were.
fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("{what}: {why}"),
    )
}

/// The settings routes, behind the guard that decides who may reach them.
///
/// Fixed to this router rather than laid on beside the `nest` in `main.rs`, for
/// the reason `terminal/routes.rs` gives: whoever mounts these gets the refusal
/// whether they were thinking about it or not.
pub fn settings_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/terminal", get(read_terminal).put(write_terminal))
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

    /// This machine, as a browser sitting in front of it names it. The guard
    /// on these routes is the terminal's, and it wants a `Host` it knows.
    const OURS: &str = "localhost:3008";

    /// Where these routes answer, spelled once.
    const WHERE: &str = "/api/settings/terminal";

    /// The database and the server over it, assembled the way `main.rs` does.
    fn served() -> (AppState, Router) {
        let db: AppState = Arc::new(Database::new_in_memory().expect("an empty settings database"));
        let app = Router::new().nest("/api", settings_routes().with_state(Arc::clone(&db)));
        (db, app)
    }

    async fn ask(app: &Router, method: Method, body: Option<Value>) -> (StatusCode, String) {
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
    async fn the_default_is_among_the_shells_offered() {
        let (_db, app) = served();
        let (status, said) = ask(&app, Method::GET, None).await;
        assert_eq!(status, StatusCode::OK, "{said}");

        let answer = as_json(&said);
        let default = answer["default"].as_str().expect("a default shell");
        let available: Vec<&str> = answer["available"]
            .as_array()
            .expect("a list of shells")
            .iter()
            .map(|named| named.as_str().expect("a path"))
            .collect();

        assert!(
            available.contains(&default),
            "the screen offers {available:?} and calls {default:?} the default, \
             so the one thing a person is told they already have is not on the list"
        );
        assert!(
            answer["shell"].is_null(),
            "nothing has been chosen, and the answer says {}",
            answer["shell"]
        );
    }

    #[tokio::test]
    async fn a_path_this_computer_cannot_run_is_refused_and_nothing_is_saved() {
        let (db, app) = served();

        // Something saved first, so what the refusal must leave alone is a real
        // value and not the absence of one.
        let (status, said) = ask(&app, Method::PUT, Some(json!({ "shell": "/bin/sh" }))).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(db.terminal_shell().unwrap().as_deref(), Some(Path::new("/bin/sh")));

        // A file that is there and is not a program: the exact mistake a person
        // makes by pointing the setting at a config file or a README.
        let folder = tempfile::tempdir().expect("a scratch folder");
        let not_a_program = folder.path().join("fish");
        std::fs::write(&not_a_program, b"#!/bin/sh\necho hello\n").expect("a file to be written");
        let mut how = std::fs::metadata(&not_a_program).unwrap().permissions();
        {
            use std::os::unix::fs::PermissionsExt;
            how.set_mode(0o644);
        }
        std::fs::set_permissions(&not_a_program, how).expect("the bits to be settable");

        let named = not_a_program.display().to_string();
        let (status, why) = ask(&app, Method::PUT, Some(json!({ "shell": named }))).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "a shell that cannot be run should be refused, and the answer was {why}"
        );
        assert!(
            why.contains(&named),
            "the refusal should name the path it is refusing, and says {why:?}"
        );

        assert_eq!(
            db.terminal_shell().unwrap().as_deref(),
            Some(Path::new("/bin/sh")),
            "a refused save changed the setting anyway, which is the one outcome \
             worse than refusing: the screen says it failed and the next tab disagrees"
        );
    }

    #[tokio::test]
    async fn a_path_that_is_not_a_whole_path_is_refused() {
        let (db, app) = served();
        let (status, why) = ask(&app, Method::PUT, Some(json!({ "shell": "fish" }))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{why}");
        assert!(why.contains("fish"), "{why:?}");
        assert_eq!(db.terminal_shell().unwrap(), None);
    }

    #[tokio::test]
    async fn nothing_chosen_is_one_state_and_the_answer_says_so() {
        let (db, app) = served();
        ask(&app, Method::PUT, Some(json!({ "shell": "/bin/sh" }))).await;

        // Both spellings of "no choice", because the screen sends one and a
        // person emptying the field sends the other.
        for cleared in [json!({ "shell": Value::Null }), json!({ "shell": "   " })] {
            ask(&app, Method::PUT, Some(json!({ "shell": "/bin/sh" }))).await;
            let (status, said) = ask(&app, Method::PUT, Some(cleared)).await;
            assert_eq!(status, StatusCode::OK, "{said}");
            assert_eq!(db.terminal_shell().unwrap(), None);
            assert!(as_json(&said)["shell"].is_null(), "{said}");
        }
    }

    #[tokio::test]
    async fn a_shell_that_can_be_run_is_saved_and_read_back() {
        let (_db, app) = served();
        let (status, said) = ask(&app, Method::PUT, Some(json!({ "shell": "/bin/sh" }))).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(as_json(&said)["shell"], json!("/bin/sh"));

        let (status, said) = ask(&app, Method::GET, None).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(
            as_json(&said)["shell"],
            json!("/bin/sh"),
            "what was saved should be what the screen finds next time it is opened"
        );
    }
}
