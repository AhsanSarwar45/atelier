//! Opening, listing and closing a shell from the app.
//!
//! Three ordinary HTTP calls, because a shell existing and a shell being
//! watched are two different lifetimes. The socket that carries what a shell
//! prints — `stream.rs`, mounted on this same router — comes and goes with a
//! tab; the shell itself belongs to the register and outlives every socket that
//! ever attached to it. Mixing the two — opening a shell by connecting to it,
//! closing it by disconnecting — is what makes a terminal that loses your build
//! when the wifi drops.
//!
//! ## Why the guard is laid on here
//!
//! `local_host.rs` explains what it turns away and why it has to be the `Host`
//! header that decides. It is fixed to the router in this module rather than
//! beside the `nest` in `main.rs` so that there is no way to mount these routes
//! without it: whoever wires them up gets the refusal whether they were
//! thinking about it or not.
//!
//! ## The starting folder
//!
//! The browser sends the folder it is showing. Nothing here looks a project up,
//! because the app already knows which one is on screen and this server would
//! only be guessing at the same answer from further away. With no folder named,
//! the shell starts in the person's home directory, which is where a shell
//! opened from anywhere else on this machine would start.
//!
//! A path that is not there, or is there and is not a folder, is refused before
//! a shell is started. The alternative is a spawn that fails somewhere inside
//! the pty crate and reaches the person as a sentence about an error number.
//!
//! Nothing narrower is checked. A shell can `cd` anywhere its owner can the
//! moment it opens, so confining where it begins would keep out nobody who got
//! this far, and what decides who gets this far is the guard above.
//!
//! ## Which shell is started
//!
//! Whichever one the person chose on the settings screen, and this computer's
//! own record when they have chosen none (`settings.rs`, `shell.rs`).
//! The setting is read on every open rather than remembered, which is what
//! makes the promise on the settings screen true: tabs already open keep the
//! shell they started with, because nothing restarts a running shell, and the
//! next tab gets the new choice, because the next tab is the next read.

use crate::db::Database;
use crate::terminal::register::Shells;
use axum::{
    extract::{Extension, Path as FromUrl},
    http::StatusCode,
    middleware,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use directories::UserDirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

/// Where these routes answer, named once so the browser's URLs and the tests'
/// are the same string as the server's.
pub const MOUNTED_AT: &str = "/api/terminal";

/// A refusal in the words the person should see, rather than a code alone.
type Refusal = (StatusCode, String);

/// Every way to a shell, behind the guard that decides who may reach one.
///
/// The socket lives here too, under the same guard and for a reason worth
/// stating: a WebSocket handshake is an ordinary HTTP GET carrying a `Host`
/// header, so this middleware sees it and refuses it like anything else. It is
/// the only thing that does. Handshakes are outside CORS entirely, so the
/// permissive `allow_origin` this server is mounted behind never gets a say
/// over them, and a page on any site at all may open one. What keeps that page
/// out is this and nothing beside it.
pub fn router(shells: Shells) -> Router {
    Router::new()
        .route("/", post(open).get(list))
        .route("/:id", delete(close))
        .route("/:id/stream", get(crate::terminal::stream::watch))
        .layer(Extension(shells))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

/// What the browser asks for when it wants a shell.
#[derive(Deserialize)]
struct Opening {
    /// The folder the app is showing, when it is showing one.
    cwd: Option<String>,
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
struct Opened {
    id: String,
}

/// One shell, said in enough detail for a reloaded page to rebuild its tab.
#[derive(Serialize)]
struct Listed {
    id: String,
    /// Where it was started, which is what a tab has to label itself with
    /// before anyone has typed anything into it.
    cwd: String,
    /// Which tab goes where, without the browser having to remember an order it
    /// may have been reloaded out of.
    started: DateTime<Utc>,
    /// A tab for a shell that has ended is still worth drawing, because it
    /// holds the last of what was printed. It is not worth typing into.
    exited: bool,
}

async fn open(
    Extension(shells): Extension<Shells>,
    Extension(settings): Extension<Arc<Database>>,
    Json(asked): Json<Opening>,
) -> Result<Json<Opened>, Refusal> {
    let cwd = match asked.cwd.as_deref().filter(|named| !named.is_empty()) {
        Some(named) => {
            let named = PathBuf::from(named);
            // Metadata rather than `exists`, because a link to a folder is a
            // folder as far as starting a shell in it goes, and a file is not.
            if !std::fs::metadata(&named).is_ok_and(|what| what.is_dir()) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "A shell cannot start in {}, because there is no folder there.",
                        named.display()
                    ),
                ));
            }
            named
        }
        None => home()?,
    };

    // Read here, at every open, rather than held anywhere: a tab opened after
    // somebody changed the setting should get the new shell, and the tabs
    // already open keep theirs by the simple fact that nothing restarts them.
    let chosen = settings.terminal_shell().map_err(|why| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("The shell chosen in Settings could not be read: {why}"),
        )
    })?;

    let session = shells
        .open(cwd, asked.cols, asked.rows, chosen)
        .map_err(|why| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("The shell would not start: {why}"),
            )
        })?;

    Ok(Json(Opened {
        id: session.id.to_string(),
    }))
}

async fn list(Extension(shells): Extension<Shells>) -> Json<Vec<Listed>> {
    Json(
        shells
            .list()
            .into_iter()
            .map(|session| Listed {
                id: session.id.to_string(),
                cwd: session.cwd.display().to_string(),
                started: session.started,
                exited: session.ended().is_some(),
            })
            .collect(),
    )
}

async fn close(
    Extension(shells): Extension<Shells>,
    FromUrl(id): FromUrl<String>,
) -> Result<StatusCode, Refusal> {
    // An id that is not an id names no shell, which is the same answer as an id
    // that is one and names nothing. The id is not repeated back: it came from
    // the caller, and an answer that echoes what it was sent is a habit worth
    // not having on the one surface that hands out a shell.
    let gone = Uuid::parse_str(&id).is_ok_and(|named| shells.close(named));
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((
            StatusCode::NOT_FOUND,
            "There is no shell by that name.".to_string(),
        ))
    }
}

/// Where a shell starts when no project is on screen.
fn home() -> Result<PathBuf, Refusal> {
    UserDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "This computer will not say where your home folder is, so a shell \
                 with no folder named has nowhere to start."
                    .to_string(),
            )
        })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::terminal::register::{Register, Session};
    use axum::body::Body;
    use axum::http::{header, Method, Request};
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};
    use tower::ServiceExt;

    /// This machine, as a browser sitting in front of it names it.
    pub(crate) const OURS: &str = "localhost:3008";

    /// The rebinding case `local_host.rs` exists for: a name its owner can
    /// point at this machine, sent by a browser that believes it.
    pub(crate) const THEIRS: &str = "rebind.evil.com";

    /// The server as `main.rs` assembles it, so the URLs under test are the
    /// URLs a browser types and the guard under test is the one that ships.
    fn served_by(shells: &Shells) -> Router {
        // The settings database, laid on here as `main.rs` lays the real one on
        // the whole server: `open` reads the chosen shell out of it. Empty and
        // in memory, so every case below opens whatever this computer records,
        // which is what they were all written against.
        let settings = Arc::new(Database::new_in_memory().expect("an empty settings database"));
        Router::new()
            .nest(MOUNTED_AT, router(Arc::clone(shells)))
            .layer(Extension(settings))
    }

    pub(crate) fn a_register() -> (Shells, Router) {
        let shells: Shells = Arc::default();
        let app = served_by(&shells);
        (shells, app)
    }

    /// One call into the router, as a browser would make it.
    async fn ask(
        app: &Router,
        method: Method,
        path: &str,
        host: &str,
        body: Option<Value>,
    ) -> (StatusCode, String) {
        let building = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, host);
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

    /// Opens one shell and gives back its id.
    pub(crate) async fn open_one(app: &Router, cwd: Option<&str>) -> String {
        let mut asking = json!({ "cols": 80, "rows": 24 });
        if let Some(cwd) = cwd {
            asking["cwd"] = json!(cwd);
        }
        let (status, said) = ask(app, Method::POST, MOUNTED_AT, OURS, Some(asking)).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "opening a shell should have worked, and answered {status}: {said}"
        );
        serde_json::from_str::<Value>(&said).expect("an answer in JSON")["id"]
            .as_str()
            .expect("an opened shell should be named by an id")
            .to_string()
    }

    async fn listed(app: &Router) -> Vec<Value> {
        let (status, said) = ask(app, Method::GET, MOUNTED_AT, OURS, None).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "listing shells should have worked, and answered {status}: {said}"
        );
        serde_json::from_str::<Vec<Value>>(&said).expect("a list in JSON")
    }

    /// Lists until the listing is what the case is waiting for, or gives up.
    ///
    /// A shell ends when the operating system gets round to it, not when the
    /// person typing `exit` presses return, so anything asking about an ended
    /// shell has to be allowed to ask twice. The giving up is the assertion:
    /// the caller is left holding a listing that failed the test rather than a
    /// case that hangs.
    async fn listed_until(app: &Router, enough: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let giving_up = Instant::now() + Duration::from_secs(10);
        loop {
            let all = listed(app).await;
            if enough(&all) || Instant::now() > giving_up {
                return all;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Everything a shell printed, read to the end of its output.
    async fn everything_printed(session: &Session) -> String {
        let (mut said, mut live) = session.pump.attach();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), live.recv()).await {
                Ok(Some(more)) => said.extend_from_slice(&more),
                Ok(None) => break,
                Err(_) => panic!("the shell ended but its output never did"),
            }
        }
        String::from_utf8_lossy(&said).into_owned()
    }

    /// What the shell printed between `name[` and `]`, taking the last one.
    ///
    /// A terminal echoes what is typed at it, so the command asking the question
    /// appears in the output ahead of the answer. The first match is the
    /// question; the last is the answer.
    pub(crate) fn answered(said: &str, name: &str) -> String {
        said.rsplit_once(&format!("{name}["))
            .and_then(|(_, rest)| rest.split(']').next())
            .unwrap_or_default()
            .to_string()
    }

    /// Waits for a shell to end, and says whether it did.
    async fn ended_within(session: &Session, patience: Duration) -> bool {
        let giving_up = Instant::now() + patience;
        while Instant::now() < giving_up {
            if session.ended().is_some() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_is_opened_then_listed_then_closed_and_listed_no_more() {
        let folder = tempfile::tempdir().expect("a folder to open a shell in");
        let (_shells, app) = a_register();

        let id = open_one(&app, folder.path().to_str()).await;

        let all = listed(&app).await;
        assert_eq!(
            all.len(),
            1,
            "the shell that was just opened should be on the list, and the list is {all:?}"
        );
        assert_eq!(
            all[0]["id"],
            id.as_str(),
            "the listed shell should be the one that was opened"
        );
        assert_eq!(
            all[0]["cwd"],
            folder.path().display().to_string().as_str(),
            "a restored tab has nothing to label itself with but this"
        );
        assert_eq!(
            all[0]["exited"], false,
            "a shell nobody has closed is still running"
        );
        assert!(
            all[0]["started"].is_string(),
            "a tab needs to know when its shell started to come back in the right order, and the list is {all:?}"
        );

        let (status, said) = ask(
            &app,
            Method::DELETE,
            &format!("{MOUNTED_AT}/{id}"),
            OURS,
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "closing a shell should have worked, and answered {status}: {said}"
        );

        assert!(
            listed(&app).await.is_empty(),
            "a shell that was closed is still being offered a tab"
        );

        let (again, _) = ask(
            &app,
            Method::DELETE,
            &format!("{MOUNTED_AT}/{id}"),
            OURS,
            None,
        )
        .await;
        assert_eq!(
            again,
            StatusCode::NOT_FOUND,
            "closing the same shell twice should say there is no such shell"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_one_of_the_three_refuses_a_caller_naming_a_host_this_machine_is_not() {
        let (_shells, app) = a_register();
        let id = open_one(&app, None).await;

        // Deleting last, so the shell it names is still there to be deleted.
        let calls = [
            (
                Method::POST,
                MOUNTED_AT.to_string(),
                Some(json!({ "cols": 80, "rows": 24 })),
            ),
            (Method::GET, MOUNTED_AT.to_string(), None),
            (Method::DELETE, format!("{MOUNTED_AT}/{id}"), None),
        ];

        for (method, path, body) in calls {
            let (refused, said) = ask(&app, method.clone(), &path, THEIRS, body.clone()).await;
            assert_eq!(
                refused,
                StatusCode::FORBIDDEN,
                "{method} {path} answered {refused} to a page on {THEIRS}, so a site \
                 anyone can host just reached a shell on this machine: {said}"
            );

            let (served, said) = ask(&app, method.clone(), &path, OURS, body.clone()).await;
            assert!(
                served.is_success(),
                "{method} {path} should still be served to a browser on this machine, \
                 and answered {served}: {said}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_starts_in_the_folder_the_browser_asked_for() {
        let folder = tempfile::tempdir().expect("a folder to open a shell in");
        let (shells, app) = a_register();
        open_one(&app, folder.path().to_str()).await;

        // Asked rather than assumed. The only answer worth anything here is the
        // shell's own, because the shell is what a person is about to type in.
        let session = shells.list().pop().expect("the shell that was just opened");
        session
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'CWD[%s]\\n' \"$PWD\"; exit\n")
            .expect("a shell that just started should take keystrokes");
        let said = everything_printed(&session).await;

        let reported = answered(&said, "CWD");
        assert_eq!(
            std::fs::canonicalize(&reported).ok(),
            std::fs::canonicalize(folder.path()).ok(),
            "the shell should have started in the folder the browser named, and says \
             it is in {reported:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_opened_with_no_folder_starts_in_the_home_folder() {
        let (shells, app) = a_register();
        open_one(&app, None).await;

        let session = shells.list().pop().expect("the shell that was just opened");
        session
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'CWD[%s]\\n' \"$PWD\"; exit\n")
            .expect("a shell that just started should take keystrokes");
        let said = everything_printed(&session).await;

        let home = UserDirs::new()
            .map(|dirs| dirs.home_dir().to_path_buf())
            .expect("this computer should know where home is");
        let reported = answered(&said, "CWD");
        assert_eq!(
            std::fs::canonicalize(&reported).ok(),
            std::fs::canonicalize(&home).ok(),
            "a shell opened with no project on screen should start at home, and says \
             it is in {reported:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_that_is_not_one_is_refused_and_leaves_no_shell_behind() {
        let folder = tempfile::tempdir().expect("somewhere to put a file that is not a folder");
        let a_file = folder.path().join("this-is-a-file");
        std::fs::write(&a_file, "not a folder").expect("a file to point at");
        let (shells, app) = a_register();

        for asked in [
            folder.path().join("nothing-is-here").display().to_string(),
            a_file.display().to_string(),
        ] {
            let (status, said) = ask(
                &app,
                Method::POST,
                MOUNTED_AT,
                OURS,
                Some(json!({ "cwd": asked, "cols": 80, "rows": 24 })),
            )
            .await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "starting a shell in {asked:?} should have been refused plainly, and \
                 the answer was {status}: {said}"
            );
        }

        assert!(
            shells.list().is_empty(),
            "a request that was refused still left a shell running"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_shells_are_two_shells_and_neither_hears_what_is_typed_at_the_other() {
        let (shells, app) = a_register();
        let first = open_one(&app, None).await;
        let second = open_one(&app, None).await;
        assert_ne!(first, second, "two shells should not be handed the same id");

        let open_now = shells.list();
        assert_eq!(
            open_now.len(),
            2,
            "two shells were opened and the register holds {}",
            open_now.len()
        );
        assert_eq!(
            open_now[0].id.to_string(),
            first,
            "the list should be in the order they were opened"
        );
        assert_eq!(open_now[1].id.to_string(), second);

        open_now[0]
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'WHO[first]\\n'; exit\n")
            .unwrap();
        open_now[1]
            .shell
            .lock()
            .unwrap()
            .type_into(b"printf 'WHO[second]\\n'; exit\n")
            .unwrap();

        let said_by_first = everything_printed(&open_now[0]).await;
        let said_by_second = everything_printed(&open_now[1]).await;

        assert_eq!(
            answered(&said_by_first, "WHO"),
            "first",
            "the first shell should have answered for itself, and said: {said_by_first:?}"
        );
        assert!(
            !said_by_first.contains("WHO[second]"),
            "what was typed into the second shell came out of the first, so the two ids \
             are one shell: {said_by_first:?}"
        );
        assert_eq!(
            answered(&said_by_second, "WHO"),
            "second",
            "the second shell should have answered for itself, and said: {said_by_second:?}"
        );
        assert!(
            !said_by_second.contains("WHO[first]"),
            "what was typed into the first shell came out of the second, so the two ids \
             are one shell: {said_by_second:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_a_shell_ends_it_and_leaves_the_others_running() {
        let (shells, app) = a_register();
        let doomed = open_one(&app, None).await;
        let spared = open_one(&app, None).await;

        // A share of each session, held across the closing. While these exist
        // nothing has dropped a session, so nothing has ended a shell by
        // letting go of it — only a deliberate kill can have.
        let held = shells.list();
        let doomed_session = Arc::clone(&held[0]);
        let spared_session = Arc::clone(&held[1]);
        assert_eq!(doomed_session.id.to_string(), doomed);
        assert_eq!(spared_session.id.to_string(), spared);
        drop(held);

        let (status, said) = ask(
            &app,
            Method::DELETE,
            &format!("{MOUNTED_AT}/{doomed}"),
            OURS,
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::NO_CONTENT,
            "closing a shell should have worked, and answered {status}: {said}"
        );

        assert!(
            ended_within(&doomed_session, Duration::from_secs(10)).await,
            "the shell was taken off the list but its process is still running, so \
             closing a tab leaves a shell nobody can reach and nobody can stop"
        );
        assert!(
            spared_session.ended().is_none(),
            "closing one shell ended another"
        );

        let all = listed(&app).await;
        assert_eq!(
            all.len(),
            1,
            "one of two shells was closed, and the list is {all:?}"
        );
        assert_eq!(
            all[0]["id"],
            spared.as_str(),
            "the wrong shell was forgotten"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_that_ended_by_itself_is_still_listed_and_says_it_has() {
        let (shells, app) = a_register();
        open_one(&app, None).await;

        let session = shells.list().pop().expect("the shell that was just opened");
        session.shell.lock().unwrap().type_into(b"exit\n").unwrap();
        everything_printed(&session).await;
        drop(session);

        let all = listed_until(&app, |all| {
            all.first().is_some_and(|it| it["exited"] == true)
        })
        .await;
        assert_eq!(
            all.len(),
            1,
            "a shell that ended a moment ago should still have a tab, so the page that \
             comes back can show the last of it: {all:?}"
        );
        assert_eq!(
            all[0]["exited"], true,
            "the browser has no other way to tell a tab it can type into from one it \
             cannot: {all:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_that_ended_long_enough_ago_is_forgotten_by_the_next_call_alone() {
        // Nothing kept at all, so what a real register does after five minutes
        // happens on the next call and the sweeping can be proved rather than
        // waited out.
        let shells: Shells = Arc::new(Register::forgetting_after(Duration::ZERO));
        let app = served_by(&shells);
        open_one(&app, None).await;

        let session = shells.list().pop().expect("the shell that was just opened");
        session.shell.lock().unwrap().type_into(b"exit\n").unwrap();
        everything_printed(&session).await;
        drop(session);

        let all = listed_until(&app, |all| all.is_empty()).await;
        assert!(
            all.is_empty(),
            "an ended shell is still held with nothing but the next call to sweep it, \
             so a register left alone would grow for ever: {all:?}"
        );
    }
}
