//! What the app has to say about a chat, and who has already heard it.
//!
//! One vocabulary, shared by everything that announces a chat: the tray in the
//! page, and the push that reaches a phone with no page open. They used to
//! answer the same question separately — the page in TypeScript, the watcher in
//! Rust — and the two could drift apart without anything failing (bw-altj).
//!
//! It also answers the question the page could not answer at all. The page knew
//! chats and asked a second endpoint for project names, so a chat pointing at a
//! project that had been deleted, archived, or registered by a test drew a row
//! reading "Unknown project" and no amount of clearing got rid of it. Whether a
//! chat is worth announcing is a fact about both the chat and its project, so
//! it is settled here, where both are in hand, and the page draws what it is
//! given.

use crate::db::Database;
use crate::workbench::actor::ChatDb;
use serde::Serialize;
use std::collections::HashMap;

/// A chat stopped for the owner: the front end's `waitsOnYou`, in Rust.
pub fn waits_on_you(state: &str) -> bool {
    matches!(state, "waiting_permission" | "errored")
}

/// A chat that finished and is worth reading, rather than one merely working.
pub fn is_an_update(state: &str) -> bool {
    matches!(state, "idle" | "stopped")
}

/// Anything worth saying at all, of either kind.
pub fn worth_announcing(state: &str) -> bool {
    waits_on_you(state) || is_an_update(state)
}

/// The words the bell would use, so a phone and the page say the same thing.
pub fn wording(state: &str) -> &'static str {
    match state {
        "waiting_permission" => "permission to use a tool",
        "errored" => "it stopped with an error",
        _ => "Ready to read",
    }
}

/// Percent-encode one id for a query string. The ids are slugs and uuids in
/// practice, but a title-derived id would otherwise break the link.
fn encoded(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn chat_href(project_id: &str, session_id: &str) -> String {
    format!(
        "/project?id={}&tab=chat&chat={}",
        encoded(project_id),
        encoded(session_id)
    )
}

/// One thing the app has to say about one chat.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub title: Option<String>,
    pub project_id: String,
    /// Always a real project's name. A chat whose project cannot be named is
    /// not a row at all, which is why there is no "unknown" to spell here.
    pub project_name: String,
    pub state: String,
    /// What this row says, in the owner's words rather than a state name.
    pub says: String,
    pub href: String,
    /// Whether this belongs under "needs action" rather than "other updates".
    pub needs_action: bool,
}

/// Which projects can be named right now, by id.
///
/// Archived and test projects are left out deliberately, and so — by never
/// having a row — are deleted ones. Each is a project the owner has said he is
/// not working in, and a chat of his that is still sitting in some state is not
/// news. This is the same filter the project list itself applies, so the tray
/// can never name a project the rest of the app is hiding.
fn nameable(projects: &Database, include_test: bool) -> Result<HashMap<String, String>, String> {
    Ok(projects
        .get_projects_filtered(false, include_test)
        .map_err(|why| format!("the projects could not be read: {why}"))?
        .into_iter()
        .map(|project| (project.id, project.name))
        .collect())
}

/// Everything worth saying right now, with what the owner has already read
/// taken out.
///
/// Ordered as the tray reads it: what needs an answer first, then what is
/// merely finished, each newest first.
pub async fn worth_saying(
    chats: &ChatDb,
    projects: &Database,
    include_test: bool,
) -> Result<Vec<Row>, String> {
    let names = nameable(projects, include_test)?;
    let notices = chats.notices().await?;
    let sessions = chats.list_sessions(None).await?;

    let mut rows: Vec<Row> = sessions
        .into_iter()
        .filter(|session| worth_announcing(&session.state))
        // Read already, in the state it is in now. A chat that has since moved
        // on to want something else is not this chat, and says so again.
        .filter(|session| {
            notices
                .get(&session.id)
                .and_then(|notice| notice.read_state.as_deref())
                != Some(session.state.as_str())
        })
        .filter_map(|session| {
            let project_name = names.get(&session.project_id)?.clone();
            Some(Row {
                href: chat_href(&session.project_id, &session.id),
                needs_action: waits_on_you(&session.state),
                says: wording(&session.state).to_string(),
                id: session.id,
                title: session.title,
                project_id: session.project_id,
                project_name,
                state: session.state,
            })
        })
        .collect();

    // `list_sessions` already hands them back newest first; this only lifts the
    // ones wanting an answer above the ones merely finished, without disturbing
    // the order inside either group.
    rows.sort_by_key(|row| !row.needs_action);
    Ok(rows)
}
