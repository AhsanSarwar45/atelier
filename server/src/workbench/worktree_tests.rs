//! Worktree management: moving a chat to another checkout of its project,
//! listing a project's checkouts with their size and chats, and deleting one.
//!
//! Every case builds a real repository with a real `git worktree` and drives
//! the registry with the browser's own commands, read from JSON. A command the
//! registry does not know fails here as "not a command", not as a build error.

use super::protocol::Command;
use super::registry::{
    DriverFuture, LaunchFuture, LaunchedSession, ProviderDriver, RegistryPaths, SessionFactory,
    WorkbenchRegistry,
};
use super::store::Session;
use super::actor::ChatDb;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn git(at: &Path, args: &[&str]) {
    let done = std::process::Command::new("git")
        .args(["-c", "user.name=Tester", "-c", "user.email=tester@atelier.test", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(at)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git is on the path");
    assert!(done.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&done.stderr));
}

/// A project with one commit and a second checkout, `tree`, on branch `feature`.
struct Project {
    _root: tempfile::TempDir,
    root: PathBuf,
    repo: PathBuf,
    tree: PathBuf,
}

fn a_project() -> Project {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main", "."]);
    std::fs::write(repo.join("README.md"), "hello\n".repeat(200)).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    git(&repo, &["worktree", "add", "-q", "-b", "feature", "../tree"]);
    let tree = root.join("tree");
    Project { _root: dir, root, repo, tree }
}

struct IdleDriver;
impl ProviderDriver for IdleDriver {
    fn brand(&self) -> &'static str {
        "claude"
    }
    fn command<'a>(&'a mut self, _: &'a Command) -> DriverFuture<'a> {
        Box::pin(async { Ok(json!({"ok":true})) })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async { Ok(json!({"ok":true})) })
    }
}

struct IdleFactory;
impl SessionFactory for IdleFactory {
    fn launch<'a>(&'a self, _: ChatDb, command: &'a Command) -> LaunchFuture<'a> {
        let id = command.at("sessionId").as_str().unwrap_or("session-1").to_string();
        Box::pin(async move {
            Ok(LaunchedSession {
                session_id: id.clone(),
                reply: json!({"id":id,"brand":"claude"}),
                driver: Some(Box::new(IdleDriver)),
            })
        })
    }
}

fn command(value: Value) -> Command {
    let kind = value["type"].clone();
    serde_json::from_value(value).unwrap_or_else(|error| panic!("{kind} is not a command: {error}"))
}

fn a_chat(id: &str, project: &Project, cwd: &Path, state: &str) -> Session {
    serde_json::from_value(json!({
        "id": id, "brand": "claude", "externalId": format!("ext-{id}"),
        "projectId": "project", "projectPath": project.repo.display().to_string(),
        "cwd": cwd.display().to_string(), "model": null, "permissionMode": "default",
        "effort": null, "collaborationMode": null, "profile": null, "title": format!("Chat {id}"),
        "state": state, "origin": "app", "createdAt": "2026-11-14T00:00:00Z",
        "lastActiveAt": "2026-11-14T00:00:00Z", "lastSpokeAt": null, "begunBy": "person",
    }))
    .unwrap()
}

async fn a_registry(project: &Project) -> (ChatDb, WorkbenchRegistry) {
    let state = project.root.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let database = ChatDb::open(&state.join("workbench.db")).unwrap();
    let registry = WorkbenchRegistry::new(
        database.clone(),
        RegistryPaths {
            home: state.join("home"),
            claude_config: state.join("claude"),
            codex_home: state.join("codex"),
            profiles: state.join("profiles"),
            media: state.join("media"),
        },
        Arc::new(IdleFactory),
    );
    (database, registry)
}

async fn cwd_of(database: &ChatDb, id: &str) -> String {
    database.get_session(id.into()).await.unwrap().unwrap().cwd
}

/// Claude keeps a conversation under its folder's path with every character
/// that is not a letter or digit written as `-`.
fn claude_folder(config: &Path, cwd: &Path) -> PathBuf {
    let name: String = cwd
        .display()
        .to_string()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    config.join("projects").join(name)
}

#[tokio::test]
async fn an_idle_chat_moves_to_another_worktree_of_its_project() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    database.create_session(a_chat("chat-1", &project, &project.repo, "idle")).await.unwrap();
    registry
        .execute(&command(json!({"type":"session.start","sessionId":"chat-1","brand":"claude"})))
        .await
        .unwrap();
    assert!(registry.has_driver("chat-1").await, "the chat's agent never started");

    registry
        .execute(&command(json!({"type":"session.move","sessionId":"chat-1","cwd":project.tree.display().to_string()})))
        .await
        .expect("the move was refused");

    assert_eq!(cwd_of(&database, "chat-1").await, project.tree.display().to_string());
    assert!(
        !registry.has_driver("chat-1").await,
        "the agent still runs in the old folder; the next message must start it in the new one"
    );
    let said = serde_json::to_string(&database.events_since("chat-1".into(), 0).await.unwrap()).unwrap();
    assert!(said.contains("Moved to tree"), "the chat was not told where it moved: {said}");
}

#[tokio::test]
async fn a_move_carries_the_claude_conversation_to_the_new_folder() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    database.create_session(a_chat("chat-1", &project, &project.repo, "idle")).await.unwrap();
    let config = project.root.join("state").join("claude");
    let old = claude_folder(&config, &project.repo);
    std::fs::create_dir_all(&old).unwrap();
    let record = "{\"type\":\"user\",\"cwd\":\"repo\"}\n";
    std::fs::write(old.join("ext-chat-1.jsonl"), record).unwrap();

    registry
        .execute(&command(json!({"type":"session.move","sessionId":"chat-1","cwd":project.tree.display().to_string()})))
        .await
        .expect("the move was refused");

    let carried = claude_folder(&config, &project.tree).join("ext-chat-1.jsonl");
    assert_eq!(
        std::fs::read_to_string(&carried).ok().as_deref(),
        Some(record),
        "Claude resumes by folder, and the conversation is not under the new one: {}",
        carried.display()
    );
}

#[tokio::test]
async fn a_chat_cannot_move_outside_its_project_or_while_it_works() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    database.create_session(a_chat("chat-1", &project, &project.repo, "idle")).await.unwrap();
    let elsewhere = project.root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();

    let refused = registry
        .execute(&command(json!({"type":"session.move","sessionId":"chat-1","cwd":elsewhere.display().to_string()})))
        .await;
    assert!(refused.is_err(), "a folder outside the project was taken: {refused:?}");
    assert_eq!(cwd_of(&database, "chat-1").await, project.repo.display().to_string());

    database.create_session(a_chat("chat-2", &project, &project.repo, "thinking")).await.unwrap();
    let refused = registry
        .execute(&command(json!({"type":"session.move","sessionId":"chat-2","cwd":project.tree.display().to_string()})))
        .await;
    assert!(refused.is_err(), "a working chat was moved mid-turn: {refused:?}");
    assert_eq!(cwd_of(&database, "chat-2").await, project.repo.display().to_string());
}

#[tokio::test]
async fn a_moved_chat_stays_moved_when_the_records_are_read_again() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    database.create_session(a_chat("chat-1", &project, &project.repo, "idle")).await.unwrap();
    registry
        .execute(&command(json!({"type":"session.move","sessionId":"chat-1","cwd":project.tree.display().to_string()})))
        .await
        .expect("the move was refused");

    // The provider's record still says the chat began in the project folder.
    database
        .correct_folders(vec![("claude".into(), "ext-chat-1".into(), project.repo.display().to_string())])
        .await
        .unwrap();
    assert_eq!(
        cwd_of(&database, "chat-1").await,
        project.tree.display().to_string(),
        "reading the provider's records put the chat back where it began"
    );
}

#[tokio::test]
async fn the_worktree_list_gives_each_checkout_its_size_branch_and_chats() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    database.create_session(a_chat("chat-1", &project, &project.tree, "idle")).await.unwrap();

    let listed = registry
        .execute(&command(json!({"type":"worktrees.list","projectPath":project.repo.display().to_string()})))
        .await
        .expect("the list was refused");
    let trees = listed["trees"].as_array().unwrap_or_else(|| panic!("no trees in {listed}"));
    let main = trees.iter().find(|tree| tree["isMain"] == json!(true)).unwrap_or_else(|| panic!("no main checkout in {listed}"));
    let feature = trees.iter().find(|tree| tree["branch"] == json!("feature")).unwrap_or_else(|| panic!("no feature checkout in {listed}"));
    assert_eq!(main["path"], json!(project.repo.display().to_string()));
    assert_eq!(feature["path"], json!(project.tree.display().to_string()));
    for tree in [main, feature] {
        assert!(tree["bytes"].as_u64().is_some_and(|bytes| bytes >= 1200), "no size for {tree}");
    }
    let chats: Vec<&str> = feature["chats"].as_array().into_iter().flatten().filter_map(|chat| chat["sessionId"].as_str()).collect();
    assert_eq!(chats, vec!["chat-1"], "the chat in the worktree is not listed with it: {feature}");
    assert!(main["chats"].as_array().is_some_and(Vec::is_empty), "{main}");
}

#[tokio::test]
async fn deleting_a_worktree_moves_its_chats_home_and_keeps_the_branch() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    database.create_session(a_chat("chat-1", &project, &project.tree, "idle")).await.unwrap();

    registry
        .execute(&command(json!({"type":"worktree.delete","projectPath":project.repo.display().to_string(),"path":project.tree.display().to_string()})))
        .await
        .expect("the delete was refused");

    assert!(!project.tree.exists(), "the worktree folder is still there");
    assert_eq!(
        cwd_of(&database, "chat-1").await,
        project.repo.display().to_string(),
        "the chat was left pointing at a folder that is gone"
    );
    let branches = std::process::Command::new("git")
        .args(["branch", "--list", "feature"])
        .current_dir(&project.repo)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&branches.stdout).contains("feature"), "the branch went with the worktree");
}

#[tokio::test]
async fn a_worktree_with_changes_is_deleted_only_when_forced() {
    let project = a_project();
    let (_database, registry) = a_registry(&project).await;
    std::fs::write(project.tree.join("draft.txt"), "unsaved work").unwrap();
    let delete = |force: bool| {
        command(json!({"type":"worktree.delete","projectPath":project.repo.display().to_string(),
            "path":project.tree.display().to_string(),"force":force}))
    };

    let refused = registry.execute(&delete(false)).await;
    assert!(refused.is_err(), "a worktree with uncommitted work was deleted without asking: {refused:?}");
    assert!(project.tree.join("draft.txt").exists());

    registry.execute(&delete(true)).await.expect("a forced delete was refused");
    assert!(!project.tree.exists(), "the forced delete left the worktree");
}

#[tokio::test]
async fn the_project_folder_and_a_worktree_with_a_working_chat_are_not_deleted() {
    let project = a_project();
    let (database, registry) = a_registry(&project).await;
    let repo = project.repo.display().to_string();

    let refused = registry
        .execute(&command(json!({"type":"worktree.delete","projectPath":repo,"path":repo,"force":true})))
        .await;
    assert!(refused.is_err(), "the project's own folder was deleted: {refused:?}");
    assert!(project.repo.join("README.md").exists());

    database.create_session(a_chat("chat-1", &project, &project.tree, "thinking")).await.unwrap();
    let refused = registry
        .execute(&command(json!({"type":"worktree.delete","projectPath":repo,"path":project.tree.display().to_string(),"force":true})))
        .await;
    assert!(refused.is_err(), "a worktree was deleted under a working chat: {refused:?}");
    assert!(project.tree.exists());
}
