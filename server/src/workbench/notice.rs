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

/// The directory's own name, which for a worktree is the worktree's.
pub fn folder_of(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

/// What to call a chat, including one whose title was never written.
///
/// Six screens each wrote `?? 'Untitled chat'` for that case, and in the tray
/// that row sat beside a project name saying nothing anybody could act on —
/// half of what made the notifications read as noise (bw-altj). A chat knows
/// two true things about itself before anything names it: the folder it is
/// working in, which in this app is usually the worktree of the job, and the
/// agent holding it. The folder is the one a reader recognises, and it is the
/// one that tells two untitled chats apart, so it goes first.
///
/// Every list of chats asks this, wherever its rows were built, so the tray,
/// the phone and the rail cannot call the same chat different things.
pub fn naming(title: Option<&str>, folder: Option<&str>, brand: &str) -> String {
    let said = |what: Option<&str>| {
        what.map(str::trim)
            .filter(|what| !what.is_empty())
            .map(str::to_string)
    };
    said(title)
        .or_else(|| said(folder))
        .or_else(|| said(Some(brand)).map(|brand| format!("{} chat", capitalised(&brand))))
        // Not reachable through any row the app builds: a chat always has a
        // brand. Still spelled, because "" in the rail would be worse than a
        // word that at least says what the row is.
        .unwrap_or_else(|| "Chat".to_string())
}

fn capitalised(word: &str) -> String {
    let mut letters = word.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + letters.as_str(),
        None => String::new(),
    }
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
    /// The chat this row opens.
    pub id: String,
    /// What this row is about: the chat's id for a chat's own state, the
    /// item's key for something waiting on the owner (`waiting.rs`). One chat
    /// can have both, so the tray keys its rows by this, not by `id`.
    pub key: String,
    /// The waiting item's key, when this row is one; clearing it is written
    /// against the item rather than the chat.
    pub item: Option<String>,
    /// What to call this chat, already settled: `naming`, never a raw title.
    pub name: String,
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
    /// When this appeared: the moment the chat reached the state being
    /// announced, as the database recorded it (`session_notice.since`).
    ///
    /// A tray row used to say what a chat wanted and never when it started
    /// wanting it, so a chat that stopped a minute ago and one that stopped
    /// last night read exactly alike (bw-zvgc). Falls back to the chat's own
    /// activity clock for a chat that was already sitting in its state before
    /// any of this was written down — the closest true thing, and never empty.
    pub at: String,
}

/// When what the tray has to say about this chat appeared.
///
/// The recorded arrival, but only if it is the arrival of the state being
/// announced now: a chat that has moved on since is timed from the new thing
/// it has to say, not the old one.
fn appeared(notice: Option<&crate::workbench::store::Notice>, state: &str, fallback: &str) -> String {
    notice
        .filter(|notice| notice.since_state.as_deref() == Some(state))
        .and_then(|notice| notice.since.clone())
        .unwrap_or_else(|| fallback.to_string())
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
        .iter()
        .cloned()
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
            let at = appeared(
                notices.get(&session.id),
                &session.state,
                &session.last_active_at,
            );
            Some(Row {
                at,
                href: chat_href(&session.project_id, &session.id),
                needs_action: waits_on_you(&session.state),
                says: wording(&session.state).to_string(),
                name: crate::workbench::chat_name::name_session(&session),
                key: session.id.clone(),
                item: None,
                id: session.id,
                project_id: session.project_id,
                project_name,
                state: session.state,
            })
        })
        .collect();

    // What waits on the owner besides the chats' own questions, newest first
    // among the needs-action rows like everything else, minus what he cleared.
    let mut items = waiting_rows(chats, &names, &sessions, |noticed| !noticed.read).await?;
    items.reverse();
    rows.splice(0..0, items);

    // `list_sessions` already hands them back newest first; this only lifts the
    // ones wanting an answer above the ones merely finished, without disturbing
    // the order inside either group.
    rows.sort_by_key(|row| !row.needs_action);
    Ok(rows)
}

/// The tray's row for each item waiting on the owner (`waiting.rs`) in a
/// project that can be named, oldest first, keeping those `keep` lets through.
///
/// The row opens the chat the answer goes back to, and is named by it; an item
/// no chat is waiting for (a proposal's chat was deleted, say) opens the
/// project's Tasks tab and is named by the project.
async fn waiting_rows(
    chats: &ChatDb,
    names: &HashMap<String, String>,
    sessions: &[crate::workbench::store::Session],
    keep: impl Fn(&crate::workbench::waiting::Noticed) -> bool,
) -> Result<Vec<Row>, String> {
    let (items, noticed) = chats
        .read_tasks(|store| {
            let connection = store.connection();
            Ok((
                crate::workbench::waiting::list(connection, None)?,
                crate::workbench::waiting::noticed(connection)?,
            ))
        })
        .await?;
    let sessions: HashMap<&str, &crate::workbench::store::Session> =
        sessions.iter().map(|session| (session.id.as_str(), session)).collect();
    Ok(items
        .into_iter()
        .filter(|item| keep(&noticed.get(&item.key).cloned().unwrap_or_default()))
        .filter_map(|item| {
            let project_name = names.get(&item.project_id)?.clone();
            let chat = item.session_id.as_deref().and_then(|id| sessions.get(id).copied());
            let (id, name, href) = match chat {
                Some(chat) => (
                    chat.id.clone(),
                    crate::workbench::chat_name::name_session(chat),
                    chat_href(&item.project_id, &chat.id),
                ),
                None => (
                    String::new(),
                    project_name.clone(),
                    format!("/project?id={}&tab=tasks", encoded(&item.project_id)),
                ),
            };
            Some(Row {
                id,
                key: item.key.clone(),
                item: Some(item.key),
                name,
                project_id: item.project_id,
                project_name,
                state: "waiting".into(),
                says: item.short,
                href,
                needs_action: true,
                at: chrono::DateTime::from_timestamp_millis(item.since)
                    .unwrap_or_default()
                    .to_rfc3339(),
            })
        })
        .collect())
}

/// The items waiting on the owner that no device has been told about and he
/// has not already read, each as the row a push is made from.
///
/// The watcher asks this whenever a task or grid changes. An item is said
/// once: the watcher writes it down as announced before it sends, and an item
/// that comes back as a new occurrence (a task handed in for review again) has
/// a new key, so it is news again.
pub async fn waiting_worth_pushing(chats: &ChatDb, projects: &Database) -> Result<Vec<Row>, String> {
    let names = nameable(projects, false)?;
    let sessions = chats.list_sessions(None).await?;
    waiting_rows(chats, &names, &sessions, |noticed| !noticed.read && !noticed.announced).await
}

/// Whether this one chat, in the state it has just reached, is worth telling a
/// device about — and nothing about whether any device is listening.
///
/// The same three questions `worth_saying` asks of the whole board, asked of
/// one chat, so a phone and the page can never disagree about what is news:
/// is this state worth a word at all, has the owner already been told it, and
/// is the chat in a project he is still working in.
///
/// "Already told" is two separate facts, and they are kept apart on purpose.
/// A chat the owner READ in this state needs no push — he has seen it. A chat
/// a device was already TOLD about in this state needs no second push — and
/// that is what makes a restart quiet, because it is written down rather than
/// held in the watcher's memory.
pub async fn worth_pushing(
    chats: &ChatDb,
    projects: &Database,
    session_id: &str,
    state: &str,
) -> Result<Option<Row>, String> {
    // First and cheapest: most events a chat emits are it working, and working
    // is not news. Nothing is read for those.
    if !worth_announcing(state) {
        return Ok(None);
    }

    let notices = chats.notices().await?;
    if let Some(notice) = notices.get(session_id) {
        if notice.read_state.as_deref() == Some(state)
            || notice.announced_state.as_deref() == Some(state)
        {
            return Ok(None);
        }
    }

    let Some(session) = chats.get_session(session_id.to_string()).await? else {
        return Ok(None);
    };
    let names = nameable(projects, false)?;
    let Some(project_name) = names.get(&session.project_id).cloned() else {
        return Ok(None);
    };

    Ok(Some(Row {
        at: appeared(notices.get(session_id), state, &session.last_active_at),
        href: chat_href(&session.project_id, session_id),
        needs_action: waits_on_you(state),
        says: wording(state).to_string(),
        id: session_id.to_string(),
        key: session_id.to_string(),
        item: None,
        name: crate::workbench::chat_name::name_session(&session),
        project_id: session.project_id,
        project_name,
        state: state.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::store::Session;

    /// A chat database on a real file, so a case can close it and open it
    /// again — which is the only way to prove what survives a restart.
    fn a_board(directory: &std::path::Path) -> ChatDb {
        ChatDb::open(&directory.join("workbench.db")).expect("the board should open")
    }

    fn a_project(projects: &Database, name: &str, is_test: bool) -> String {
        projects
            .create_project(crate::db::CreateProjectInput {
                name: name.to_string(),
                path: format!("/work/{name}"),
                local_path: None,
                is_test,
            })
            .unwrap()
            .id
    }

    fn a_chat(id: &str, project_id: &str, state: &str) -> Session {
        Session {
            id: id.into(),
            brand: "codex".into(),
            external_id: None,
            project_id: project_id.into(),
            project_path: "/work/project".into(),
            cwd: "/work/project".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: Some(format!("Chat {id}")),
            state: state.into(),
            origin: "app".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            last_active_at: "2026-01-01T00:00:00Z".into(),
            last_spoke_at: None,
            begun_by: None,
            named_by_owner: false,
            auto_approve: false,
        }
    }

    const WHEN: &str = "2026-01-01T00:00:01Z";

    /// The vocabulary itself, which the route cases cannot exercise.
    ///
    /// A chat waiting on permission is an ACTIVE state (`status::ACTIVE_STATES`),
    /// so a fixture holding one is reconciled to `dormant` within five seconds
    /// by a registry with no driver attached. That is right for the app and
    /// wrong for a test bed, so what each state means is settled here instead,
    /// where no clock can reach it.
    #[test]
    fn what_each_state_is_worth_saying_about() {
        for state in ["waiting_permission", "errored"] {
            assert!(waits_on_you(state), "{state} did not read as waiting on the owner");
            assert!(worth_announcing(state));
            assert!(!is_an_update(state));
        }
        for state in ["idle", "stopped"] {
            assert!(is_an_update(state), "{state} did not read as finished");
            assert!(worth_announcing(state));
            assert!(!waits_on_you(state));
        }
        // Working is not news, and neither is asleep.
        for state in ["thinking", "streaming", "running_tool", "starting", "dormant"] {
            assert!(!worth_announcing(state), "{state} was announced while nothing waited");
        }

        assert_eq!(wording("waiting_permission"), "permission to use a tool");
        assert_eq!(wording("errored"), "it stopped with an error");
        assert_eq!(wording("idle"), "Ready to read");
    }

    /// What a chat is called when nothing has named it.
    ///
    /// One rule, asked by everything that draws a chat — the tray, the rail and
    /// the push that reaches a phone — so the same chat cannot be three
    /// different things depending on which screen the owner is looking at.
    #[test]
    fn a_chat_is_named_by_whatever_is_known_about_it() {
        // A title, when there is one, and nothing else gets a say.
        assert_eq!(
            naming(Some("Rebuild the tray"), Some("bw-altj"), "claude"),
            "Rebuild the tray"
        );
        // Otherwise the folder it is working in, which for this app is usually
        // the worktree of the job — and which tells two nameless chats apart.
        assert_eq!(naming(None, Some("bw-altj"), "claude"), "bw-altj");
        // A title of spaces is not a title. This is what a chat renamed to
        // nothing used to leave on the rail.
        assert_eq!(naming(Some("   "), Some("bw-altj"), "claude"), "bw-altj");
        // Otherwise who is holding it, which is the last true thing left.
        assert_eq!(naming(None, None, "claude"), "Claude chat");
        assert_eq!(naming(None, Some(""), "codex"), "Codex chat");
        // And never nothing at all.
        assert_eq!(naming(None, None, ""), "Chat");
    }

    /// The folder is the directory's own name, so a worktree is the worktree.
    #[test]
    fn the_folder_is_the_directory_it_is_working_in() {
        assert_eq!(folder_of("/work/project/worktrees/bw-altj").as_deref(), Some("bw-altj"));
        assert_eq!(folder_of("/").as_deref(), None);
    }

    /// A link a chat can actually be opened by, whatever its id is made of.
    #[test]
    fn the_link_survives_an_id_that_is_not_a_slug() {
        assert_eq!(
            chat_href("project one", "chat/1"),
            "/project?id=project%20one&tab=chat&chat=chat%2F1"
        );
    }

    /// The whole point of writing an announcement down.
    ///
    /// The watcher used to keep this in a `HashMap` it filled at startup by
    /// reading the board. That made the record only as durable as the process
    /// and only as correct as that one read: a restart after a failed read
    /// announced every chat on the board a second time, which is exactly the
    /// complaint (bw-altj). There is no seeding read now — this closes the
    /// board and opens it again, which is a harsher restart than a failed read,
    /// and nothing is said twice.
    #[tokio::test]
    async fn a_restart_does_not_announce_what_was_already_announced() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);

        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "errored")).await.unwrap();

        let first = worth_pushing(&board, &projects, "chat-1", "errored").await.unwrap();
        assert!(first.is_some(), "a chat that stopped with an error was never announced");
        board
            .mark_announced("chat-1".into(), "errored".into(), WHEN.into())
            .await
            .unwrap();
        drop(board);

        let after = a_board(directory.path());
        assert!(
            worth_pushing(&after, &projects, "chat-1", "errored")
                .await
                .unwrap()
                .is_none(),
            "a restart announced a chat that had already been announced"
        );

        // And the moment it goes on to do something else, it is news again:
        // what is written down is a standing, not a silence.
        assert!(
            worth_pushing(&after, &projects, "chat-1", "idle")
                .await
                .unwrap()
                .is_some(),
            "a chat that moved on after being announced stayed silent"
        );
    }

    /// A chat the owner has already read needs no push. He has seen it — on
    /// the page, or on the phone that cleared the tray.
    #[tokio::test]
    async fn a_chat_already_read_in_this_state_is_not_pushed() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "errored")).await.unwrap();

        board
            .mark_read(vec![("chat-1".into(), "errored".into())], WHEN.into())
            .await
            .unwrap();

        assert!(
            worth_pushing(&board, &projects, "chat-1", "errored")
                .await
                .unwrap()
                .is_none(),
            "a chat the owner had already read was pushed to his phone"
        );
    }

    /// The three ways a project stops being one the owner is working in. A
    /// chat left sitting in any of them is not news, and cannot be: there is
    /// no name to put on the notification.
    #[tokio::test]
    async fn a_chat_in_a_project_that_is_gone_archived_or_a_fixture_is_never_pushed() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let board = a_board(directory.path());

        let archived = a_project(&projects, "archived", false);
        projects.archive_project(&archived).unwrap();
        let fixture = a_project(&projects, "fixture", true);

        board.create_session(a_chat("orphan", "a-project-deleted-long-ago", "errored")).await.unwrap();
        board.create_session(a_chat("shelved", &archived, "errored")).await.unwrap();
        board.create_session(a_chat("in-a-fixture", &fixture, "errored")).await.unwrap();

        for chat in ["orphan", "shelved", "in-a-fixture"] {
            assert!(
                worth_pushing(&board, &projects, chat, "errored")
                    .await
                    .unwrap()
                    .is_none(),
                "{chat} was pushed to a phone although its project is not one being worked in"
            );
        }
    }

    /// Working is not news, and a chat that is not on the board at all is not
    /// news either — a state event can outlive the chat it is about.
    #[tokio::test]
    async fn nothing_is_pushed_about_a_chat_that_is_working_or_gone() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "thinking")).await.unwrap();

        assert!(
            worth_pushing(&board, &projects, "chat-1", "thinking").await.unwrap().is_none(),
            "a chat merely working was pushed"
        );
        assert!(
            worth_pushing(&board, &projects, "never-existed", "errored").await.unwrap().is_none(),
            "a chat that is not on the board was pushed"
        );
    }

    /// A row says when it appeared, and says it from the record.
    ///
    /// The time is the moment the chat reached the state being announced, not
    /// the moment the page asked. A tray that timed itself from the asking
    /// would reset on every reload, and two tabs open at once would disagree
    /// about when the same chat stopped (bw-zvgc).
    #[tokio::test]
    async fn a_row_says_when_the_chat_reached_the_state_it_is_announcing() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        // Working, so there is nothing to say and nothing to time yet.
        board
            .create_session(a_chat("chat-1", &project, "streaming"))
            .await
            .unwrap();

        board
            .update_session(
                "chat-1".to_string(),
                crate::workbench::store::SessionPatch {
                    state: Some("errored".to_string()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let rows = worth_saying(&board, &projects, false).await.unwrap();
        let recorded = board.notices().await.unwrap()["chat-1"]
            .since
            .clone()
            .expect("the arrival was not written down");
        assert_eq!(rows[0].at, recorded, "the row did not say the recorded time");
        assert_ne!(
            rows[0].at, "2026-01-01T00:00:00Z",
            "the row fell back to the chat's own clock when a real arrival was on record"
        );
    }

    /// A chat that was already sitting in its state before any of this was
    /// written down still says when — the closest true thing it has.
    #[tokio::test]
    async fn a_chat_from_before_the_record_falls_back_to_its_own_clock() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        // Straight into the database in the state it is in, the way a chat
        // that stopped before this column existed sits there now.
        board
            .create_session(a_chat("chat-1", &project, "errored"))
            .await
            .unwrap();

        let rows = worth_saying(&board, &projects, false).await.unwrap();
        assert_eq!(rows[0].at, "2026-01-01T00:00:00Z");
    }

    /// What the push says is what the tray says, because it is the same row.
    #[tokio::test]
    async fn a_push_says_what_the_tray_would_have_said() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "waiting_permission")).await.unwrap();

        let row = worth_pushing(&board, &projects, "chat-1", "waiting_permission")
            .await
            .unwrap()
            .expect("a chat waiting on the owner is worth a push");
        assert_eq!(row.says, "permission to use a tool");
        assert_eq!(row.project_name, "keystone");
        assert!(row.needs_action);
        assert_eq!(row.href, chat_href(&project, "chat-1"));
    }

    /// Put one of each thing that waits on the owner into the board's task
    /// and grid tables, as the task and grid commands leave them, all held by
    /// `chat-1`: #1 in review, #2 with a plan change, proposal 1, the draft
    /// of grid "data", and an N/A request on grid "io"'s import × bench cell.
    async fn one_of_each_waiting(board: &ChatDb, project: &str) {
        let project = project.to_string();
        board
            .write_tasks(move |store| {
                store.connection().execute_batch(&format!(
                    "INSERT INTO task (project_id, number, type, title, why, status, session_id, plan, pending_amend, created_at, updated_at)
                       VALUES ('{p}', 1, 'chore', 'Tidy settings', 'w', 'review', 'chat-1', '{{}}', NULL, 1, 1000),
                              ('{p}', 2, 'chore', 'Refresh deps', 'w', 'in_progress', 'chat-1', '{{}}', '{{}}', 1, 2000);
                     INSERT INTO task_event (project_id, number, seq, at, kind, session_id, actor)
                       VALUES ('{p}', 1, 3, 1000, 'submitted', 'chat-1', 'agent'),
                              ('{p}', 2, 4, 2000, 'amend_proposed', 'chat-1', 'agent');
                     INSERT INTO task_proposal (project_id, id, session_id, type, title, why, plan, status, created_at)
                       VALUES ('{p}', 1, 'chat-1', 'chore', 'Search filters', 'w', '{{}}', 'pending', 3000);
                     INSERT INTO grid (project_id, slug, title, area, status, row_search, pending, created_at, updated_at)
                       VALUES ('{p}', 'data', 'Data', 'a', 'draft', '{{}}',
                               '{{\"title\":\"Data coverage\",\"draftedBy\":\"chat-1\",\"draftedAt\":4000}}', 4000, 4000),
                              ('{p}', 'io', 'IO', 'a', 'approved', '{{}}', NULL, 1, 1);
                     INSERT INTO grid_row (project_id, slug, id, name, kind, source, added_at)
                       VALUES ('{p}', 'io', 'import', 'Import', 'feature', 'manual', 1);
                     INSERT INTO grid_column (project_id, slug, id, name, proof_rule, position)
                       VALUES ('{p}', 'io', 'bench', 'Benchmark', 'r', 0);
                     INSERT INTO grid_cell (project_id, slug, row, col, state)
                       VALUES ('{p}', 'io', 'import', 'bench', 'na_pending');
                     INSERT INTO grid_event (project_id, slug, seq, at, kind, row, col, session_id, actor)
                       VALUES ('{p}', 'io', 7, 5000, 'na_asked', 'import', 'bench', 'chat-1', 'agent');",
                    p = project
                ))
            })
            .await
            .unwrap()
            .unwrap();
    }

    /// Each kind of thing waiting on the owner is a needs-action row in the
    /// tray, saying what waits beside the chat it waits in, and opening it.
    #[tokio::test]
    async fn each_thing_waiting_on_the_owner_is_a_needs_action_row() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "thinking")).await.unwrap();
        one_of_each_waiting(&board, &project).await;

        let rows = worth_saying(&board, &projects, false).await.unwrap();
        let said: Vec<&str> = rows.iter().map(|row| row.says.as_str()).collect();
        // Newest first, like every other needs-action row.
        assert_eq!(
            said,
            vec!["N/A request waiting", "Grid draft waiting", "Proposal waiting", "Plan change for #2", "#1 ready for review"]
        );
        for row in &rows {
            assert!(row.needs_action, "{} was not under needs action", row.says);
            assert_eq!(row.name, "Chat chat-1");
            assert_eq!(row.href, chat_href(&project, "chat-1"));
            assert_eq!(row.item.as_deref(), Some(row.key.as_str()));
        }
        assert_eq!(rows[4].key, format!("review:{project}:1:3"));
        assert_eq!(rows[4].at, "1970-01-01T00:00:01+00:00", "a review is timed from when it was handed in");

        // What the composer bar and the Tasks tab draw, in their longer words.
        let items = board
            .read_tasks(|store| crate::workbench::waiting::list(store.connection(), None))
            .await
            .unwrap();
        let says: Vec<&str> = items.iter().map(|item| item.says.as_str()).collect();
        assert_eq!(
            says,
            vec![
                "#1 is ready for review",
                "Plan change for #2",
                "Proposal: Search filters",
                "Grid draft: Data coverage",
                "N/A request: Import × Benchmark"
            ]
        );
    }

    /// Clearing an item in the tray clears that item, not the chat, and not
    /// the next time the same task is handed in.
    #[tokio::test]
    async fn a_waiting_item_read_in_the_tray_stays_read_until_it_comes_back() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "errored")).await.unwrap();
        one_of_each_waiting(&board, &project).await;

        let review = format!("review:{project}:1:3");
        let key = review.clone();
        board
            .write_tasks(move |store| crate::workbench::waiting::mark_read(store.connection(), &[key], WHEN))
            .await
            .unwrap()
            .unwrap();
        let rows = worth_saying(&board, &projects, false).await.unwrap();
        assert!(rows.iter().all(|row| row.key != review), "a review the owner cleared came back");
        assert!(rows.iter().any(|row| row.key == "chat-1" && row.state == "errored"), "clearing an item cleared its chat");

        // Sent back and handed in again: a new review, so news again.
        let p = project.clone();
        board
            .write_tasks(move |store| {
                store.connection().execute(
                    "INSERT INTO task_event (project_id, number, seq, at, kind, session_id, actor)
                       VALUES (?1, 1, 9, 9000, 'submitted', 'chat-1', 'agent')",
                    [&p],
                )
            })
            .await
            .unwrap()
            .unwrap();
        let rows = worth_saying(&board, &projects, false).await.unwrap();
        assert!(rows.iter().any(|row| row.key == format!("review:{project}:1:9")));
    }

    /// Each waiting item is pushed once, like a permission question: after
    /// the watcher writes it down, it is not pushed again, and neither is an
    /// item the owner already read.
    #[tokio::test]
    async fn each_waiting_item_is_pushed_once() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "thinking")).await.unwrap();
        one_of_each_waiting(&board, &project).await;

        let first = waiting_worth_pushing(&board, &projects).await.unwrap();
        let kinds: Vec<&str> = first.iter().map(|row| row.key.split(':').next().unwrap()).collect();
        assert_eq!(kinds, vec!["review", "amend", "proposal", "grid_draft", "na"]);
        let note = crate::push::waiting_note(first[0].clone());
        assert_eq!(note.title, "Chat chat-1");
        assert_eq!(note.body, "#1 ready for review");
        assert!(note.needs_action, "a review would not reach a phone that asked for needs-action alerts");

        // The owner read one; the watcher announces the rest.
        let read = first[1].key.clone();
        board
            .write_tasks(move |store| crate::workbench::waiting::mark_read(store.connection(), &[read], WHEN))
            .await
            .unwrap()
            .unwrap();
        let second = waiting_worth_pushing(&board, &projects).await.unwrap();
        assert_eq!(second.len(), 4, "an item the owner read was still pushed");
        for row in second {
            let key = row.key.clone();
            board
                .write_tasks(move |store| crate::workbench::waiting::mark_announced(store.connection(), &key, WHEN))
                .await
                .unwrap()
                .unwrap();
        }
        drop(board);

        // Across a restart, too.
        let after = a_board(directory.path());
        assert!(
            waiting_worth_pushing(&after, &projects).await.unwrap().is_empty(),
            "a waiting item was pushed twice"
        );
    }

    /// An item in a project the owner is not working in is neither a row nor
    /// a push, like a chat in one.
    #[tokio::test]
    async fn a_waiting_item_in_an_archived_project_is_not_said() {
        let directory = tempfile::tempdir().unwrap();
        let projects = Database::new_in_memory().unwrap();
        let project = a_project(&projects, "keystone", false);
        projects.archive_project(&project).unwrap();
        let board = a_board(directory.path());
        board.create_session(a_chat("chat-1", &project, "thinking")).await.unwrap();
        one_of_each_waiting(&board, &project).await;

        assert!(worth_saying(&board, &projects, false).await.unwrap().is_empty());
        assert!(waiting_worth_pushing(&board, &projects).await.unwrap().is_empty());
    }
}
