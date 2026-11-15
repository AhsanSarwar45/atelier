//! Workflow runs: a saved workflow takes an item (a ticket) through its stages.
//! Each run gets a worktree on the item's branch and one chat that hears each
//! agent stage's prompt in turn; the outcome the agent reports picks the next
//! stage by the workflow's routes.
//!
//! The provider is the only thing faked, as in `worker_chats`: a factory that
//! writes the chat's row and a driver that records every command. The git
//! repository, the router, the registry and the database are real.

use atelier::project_manifest::{self, ManifestStorage};
use atelier::routes::workbench::{router, WorkbenchState};
use atelier::workbench::{
    actor::ChatDb,
    protocol::Command,
    registry::{DriverFuture, LaunchFuture, LaunchedSession, ProviderDriver, RegistryPaths, SessionFactory, WorkbenchRegistry},
    store::Session,
    workflows,
};
use axum::body::Body;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::process::Command as Shell;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Seen = Arc<Mutex<Vec<(String, Value)>>>;

struct Recording {
    seen: Seen,
}

impl ProviderDriver for Recording {
    fn brand(&self) -> &'static str {
        "claude"
    }
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
        self.seen.lock().unwrap().push((format!("{:?}", command.kind), Value::Object(command.fields.clone())));
        Box::pin(async { Ok(json!({"ok": true, "messageId": "message-1"})) })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async { Ok(json!({"ok": true})) })
    }
}

struct Provider {
    seen: Seen,
}

impl SessionFactory for Provider {
    fn launch<'a>(&'a self, database: ChatDb, command: &'a Command) -> LaunchFuture<'a> {
        self.seen.lock().unwrap().push((format!("{:?}", command.kind), Value::Object(command.fields.clone())));
        let seen = self.seen.clone();
        Box::pin(async move {
            let field = |key: &str| command.fields.get(key).cloned().unwrap_or(Value::Null);
            let path = field("projectPath");
            let kept = match field("sessionId").as_str() {
                Some(id) => database.get_session(id.to_string()).await?,
                None => None,
            };
            let session: Session = match kept {
                Some(session) => session,
                None => {
                    let row = json!({
                        "id": field("sessionId"), "brand": field("brand"), "externalId": null,
                        "projectId": field("projectId"), "projectPath": path,
                        "cwd": if field("cwd").is_null() { path.clone() } else { field("cwd") },
                        "model": field("model"), "permissionMode": "default", "effort": field("effort"),
                        "collaborationMode": null, "profile": field("profileId"), "title": field("title"),
                        "state": "idle", "origin": "app",
                        "createdAt": "2026-11-15T00:00:00.000Z", "lastActiveAt": "2026-11-15T00:00:00.000Z",
                        "lastSpokeAt": null, "begunBy": "person",
                    });
                    let session: Session = serde_json::from_value(row).map_err(|error| error.to_string())?;
                    database.create_session(session.clone()).await?;
                    session
                }
            };
            Ok(LaunchedSession {
                session_id: session.id.clone(),
                reply: serde_json::to_value(&session).unwrap(),
                driver: Some(Box::new(Recording { seen })),
            })
        })
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    state: WorkbenchState,
    seen: Seen,
    repo: String,
}

fn git(repo: &str, args: &[&str]) -> String {
    let out = Shell::new("git").arg("-C").arg(repo).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A git repository with one commit on `main` and a `staging` branch, set up
/// as an Atelier project that keeps its settings in the repository.
async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let repo = directory.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let repo = repo.display().to_string();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    std::fs::write(format!("{repo}/README.md"), "hello\n").unwrap();
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    git(&repo, &["branch", "staging"]);
    project_manifest::create(std::path::Path::new(&repo), directory.path(), ManifestStorage::Repository,
        &project_manifest::named("Run test")).unwrap();
    let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
    let paths = RegistryPaths {
        home: directory.path().to_path_buf(),
        claude_config: directory.path().join("claude"),
        codex_home: directory.path().join("codex"),
        profiles: directory.path().join("profiles"),
        media: directory.path().join("media"),
    };
    let seen: Seen = Arc::default();
    let registry = WorkbenchRegistry::new(database, paths, Arc::new(Provider { seen: seen.clone() }));
    let state = WorkbenchState::new(registry);
    Fixture { _directory: directory, state, seen, repo }
}

fn off() -> Value {
    json!({"plan": false, "done": false, "questions": false})
}

fn agent(id: &str, prompt: &str, routes: Value) -> Value {
    json!({"id": id, "name": id, "kind": "agent", "prompt": prompt, "routes": routes, "auto": off()})
}

/// Implement, then QA (which may loop on itself twice), then done.
fn ticket_flow() -> Value {
    json!({
        "id": "ticket", "name": "Ticket", "enabled": true,
        "trigger": {"kind": "manual"},
        "agent": {"brand": "claude"},
        "setup": {"branch": "{{item.branchName}}", "base": "staging"},
        "stages": [
            agent("implement", "Work on {{item.identifier}}: {{item.title}}", json!([{"outcome": "done", "to": "qa"}])),
            {"id": "qa", "name": "QA", "kind": "agent", "prompt": "Test {{item.identifier}} in a browser", "max_attempts": 2,
             "routes": [{"outcome": "fail", "to": "qa"}, {"outcome": "pass", "to": "ship"}], "auto": off()},
            agent("ship", "Ship {{item.identifier}}", json!([])),
        ]
    })
}

fn save(fixture: &Fixture, workflow: Value) {
    let root = std::path::Path::new(&fixture.repo);
    let data = fixture._directory.path();
    let current = workflows::read(data, root).unwrap();
    let file: workflows::WorkflowsFile = serde_json::from_value(json!({"workflows": [workflow]})).unwrap();
    workflows::write(data, root, &file, &workflows::revision(&current)).unwrap();
}

fn item(n: u32) -> Value {
    json!({"identifier": format!("KEY-{n}"), "title": "Fix login", "branchName": format!("feature/key-{n}-fix-login")})
}

async fn send(fixture: &Fixture, request: axum::http::Request<Body>) -> (u16, Value) {
    let answer = router(fixture.state.clone()).oneshot(request).await.unwrap();
    let status = answer.status().as_u16();
    let bytes = answer.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}));
    (status, json)
}

async fn post(fixture: &Fixture, uri: &str, body: Value) -> (u16, Value) {
    let request = axum::http::Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send(fixture, request).await
}

async fn act(fixture: &Fixture, body: Value) -> (u16, Value) {
    let mut body = body;
    body["projectId"] = json!("project-1");
    body["projectPath"] = json!(fixture.repo);
    post(fixture, "/workflow-runs", body).await
}

async fn runs(fixture: &Fixture) -> Vec<Value> {
    let uri = format!("/workflow-runs?projectPath={}", urlencoding(&fixture.repo));
    let (status, body) = send(fixture, axum::http::Request::get(uri).body(Body::empty()).unwrap()).await;
    assert_eq!(status, 200, "listing runs failed: {body}");
    body["runs"].as_array().cloned().unwrap_or_default()
}

fn urlencoding(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Starts one run of `workflow` for `item`; its JSON.
async fn start(fixture: &Fixture, workflow: &str, item: Value) -> Value {
    let (status, body) = act(fixture, json!({"action": "start", "workflow": workflow, "items": [item]})).await;
    assert_eq!(status, 200, "starting a run failed: {body}");
    body["runs"][0].clone()
}

/// The prompts chat `id` was sent or has waiting, oldest first.
async fn told(fixture: &Fixture, id: &str) -> Vec<String> {
    let mut found: Vec<String> = fixture
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(kind, fields)| kind == "PromptSend" && fields["sessionId"] == id)
        .filter_map(|(_, fields)| fields["text"].as_str().map(str::to_string))
        .collect();
    for held in fixture.state.database().held_messages(id.to_string()).await.unwrap_or_default() {
        if let Some(text) = held["text"].as_str() {
            found.push(text.to_string());
        }
    }
    found
}

/// Waits up to three seconds for chat `id` to have more than `before` prompts.
async fn told_more(fixture: &Fixture, id: &str, before: usize) -> Vec<String> {
    for _ in 0..60 {
        let now = told(fixture, id).await;
        if now.len() > before {
            return now;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    told(fixture, id).await
}

/// Waits up to three seconds for the run `id` to satisfy `ok`; the run.
async fn run_where(fixture: &Fixture, id: &Value, ok: impl Fn(&Value) -> bool) -> Value {
    let mut last = Value::Null;
    for _ in 0..60 {
        if let Some(run) = runs(fixture).await.into_iter().find(|run| &run["id"] == id) {
            if ok(&run) {
                return run;
            }
            last = run;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    last
}

static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(100);

async fn event(fixture: &Fixture, value: Value) {
    let mut value = value;
    value["seq"] = json!(SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    value["at"] = json!("2026-11-15T00:00:01.000Z");
    let event: atelier::workbench::protocol::Event = serde_json::from_value(value).unwrap();
    fixture.state.database().append(event).await.unwrap();
}

/// The agent in chat `id` takes a turn and ends it with `reply`.
async fn replies(fixture: &Fixture, id: &str, reply: &str) {
    let message = format!("reply-{}", SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    event(fixture, json!({"type": "session.state", "sessionId": id, "state": "thinking"})).await;
    event(fixture, json!({"type": "message.started", "sessionId": id, "messageId": message, "role": "assistant"})).await;
    event(fixture, json!({"type": "text.delta", "sessionId": id, "messageId": message, "text": reply})).await;
    event(fixture, json!({"type": "message.completed", "sessionId": id, "messageId": message, "stopReason": "end_turn"})).await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    event(fixture, json!({"type": "session.state", "sessionId": id, "state": "idle"})).await;
}

fn session(run: &Value) -> String {
    run["sessionId"].as_str().unwrap_or_else(|| panic!("the run has no chat: {run}")).to_string()
}

#[tokio::test]
async fn a_run_opens_a_worktree_chat_on_the_items_branch() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(1)).await;
    let cwd = run["cwd"].as_str().unwrap_or_else(|| panic!("the run has no worktree: {run}"));
    assert_ne!(cwd, fixture.repo, "the run works in the project folder, not a worktree");
    assert_eq!(git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]), "feature/key-1-fix-login", "worktree is not on the item's branch");
    assert_eq!(git(cwd, &["rev-parse", "HEAD"]), git(&fixture.repo, &["rev-parse", "staging"]), "branch does not start from the base");
    let id = session(&run);
    let chat = fixture.state.database().get_session(id.clone()).await.unwrap().expect("the run's chat exists");
    assert_eq!(chat.cwd, cwd, "the chat does not work in the run's worktree");
    let prompts = told_more(&fixture, &id, 0).await;
    let first = prompts.first().unwrap_or_else(|| panic!("the chat was never given the first stage's prompt"));
    assert!(first.contains("Work on KEY-1: Fix login"), "placeholders are not filled in: {first}");
    assert!(first.contains("atelier workflow done done"), "the prompt does not say how to report the outcome: {first}");
    let listed = run_where(&fixture, &run["id"], |run| run["stage"] == "implement").await;
    assert_eq!(listed["status"], "running", "a started run is not running: {listed}");
}

#[tokio::test]
async fn a_reported_outcome_moves_the_run_to_the_routed_stage() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(2)).await;
    let id = session(&run);
    let before = told_more(&fixture, &id, 0).await.len();
    replies(&fixture, &id, "Implemented the fix.\n\nOutcome: done").await;
    let prompts = told_more(&fixture, &id, before).await;
    assert!(prompts.len() > before, "the chat never heard the next stage's prompt");
    assert!(prompts.last().unwrap().contains("Test KEY-2 in a browser"), "the next prompt is not QA's: {prompts:?}");
    let moved = run_where(&fixture, &run["id"], |run| run["stage"] == "qa").await;
    assert_eq!(moved["stage"], "qa", "the run did not move to QA: {moved}");
}

#[tokio::test]
async fn the_last_stage_finishes_the_run() {
    let fixture = fixture().await;
    save(&fixture, json!({
        "id": "one", "name": "One", "enabled": true, "trigger": {"kind": "manual"}, "agent": {"brand": "claude"},
        "setup": {"branch": "{{item.branchName}}", "base": "staging"},
        "stages": [agent("ship", "Ship {{item.identifier}}", json!([]))]
    }));
    let run = start(&fixture, "one", item(3)).await;
    replies(&fixture, &session(&run), "Shipped.\nOutcome: done").await;
    let finished = run_where(&fixture, &run["id"], |run| run["status"] == "done").await;
    assert_eq!(finished["status"], "done", "a run past its last stage is not done: {finished}");
}

#[tokio::test]
async fn a_wait_stage_routes_on_what_its_check_prints() {
    let fixture = fixture().await;
    let status = fixture._directory.path().join("status");
    std::fs::write(&status, "In Tapforce QA\n").unwrap();
    save(&fixture, json!({
        "id": "wait", "name": "Wait", "enabled": true, "trigger": {"kind": "manual"}, "agent": {"brand": "claude"},
        "setup": {"branch": "{{item.branchName}}", "base": "staging"},
        "stages": [
            {"id": "qa-result", "name": "Wait for QA", "kind": "wait", "prompt": format!("cat {}", status.display()),
             "routes": [{"outcome": "Rejected", "to": "fix"}, {"outcome": "Needs merging to staging", "to": "merge"}]},
            agent("fix", "Fix what QA rejected on {{item.identifier}}", json!([])),
            agent("merge", "Merge {{item.identifier}}", json!([])),
        ]
    }));
    let run = start(&fixture, "wait", item(4)).await;
    let (code, body) = act(&fixture, json!({"action": "tick"})).await;
    assert_eq!(code, 200, "tick failed: {body}");
    let waiting = run_where(&fixture, &run["id"], |run| run["status"] == "waiting").await;
    assert_eq!(waiting["stage"], "qa-result", "a status no route names moved the run: {waiting}");
    assert_eq!(waiting["status"], "waiting", "the run is not waiting on its check: {waiting}");

    std::fs::write(&status, "Rejected\n").unwrap();
    act(&fixture, json!({"action": "tick"})).await;
    let moved = run_where(&fixture, &run["id"], |run| run["stage"] == "fix").await;
    assert_eq!(moved["stage"], "fix", "the check printed Rejected but the run did not take that route: {moved}");
    let prompts = told_more(&fixture, &session(&moved), 0).await;
    assert!(prompts.iter().any(|p| p.contains("Fix what QA rejected on KEY-4")), "the fix stage's prompt was not sent: {prompts:?}");
}

#[tokio::test]
async fn an_unknown_outcome_waits_for_the_owner() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(5)).await;
    let id = session(&run);
    let before = told_more(&fixture, &id, 0).await.len();
    replies(&fixture, &id, "Should the button be blue or green?").await;
    let held = run_where(&fixture, &run["id"], |run| run["status"] == "needs_owner").await;
    assert_eq!(held["status"], "needs_owner", "a turn with no outcome did not stop for the owner: {held}");
    assert_eq!(held["stage"], "implement", "the run moved without an outcome: {held}");
    assert_eq!(told(&fixture, &id).await.len(), before, "the chat was sent something without the owner");
}

#[tokio::test]
async fn answer_questions_lets_the_agent_decide_for_itself() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow["stages"][0]["auto"]["questions"] = json!(true);
    save(&fixture, flow);
    let run = start(&fixture, "ticket", item(6)).await;
    let id = session(&run);
    let before = told_more(&fixture, &id, 0).await.len();
    replies(&fixture, &id, "Should the button be blue or green?").await;
    let prompts = told_more(&fixture, &id, before).await;
    assert!(prompts.len() > before, "with Answer questions on, the agent was left waiting");
    assert!(prompts.last().unwrap().contains("best judgment"), "the agent was not told to decide itself: {prompts:?}");
    let still = run_where(&fixture, &run["id"], |run| run["status"] == "running").await;
    assert_eq!(still["status"], "running", "the run stopped for the owner even though Answer questions is on: {still}");
}

#[tokio::test]
async fn max_attempts_hands_a_looping_stage_to_the_owner() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(7)).await;
    let id = session(&run);
    replies(&fixture, &id, "Outcome: done").await;
    run_where(&fixture, &run["id"], |run| run["stage"] == "qa").await;
    replies(&fixture, &id, "Broken.\nOutcome: fail").await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let after_one = runs(&fixture).await.into_iter().find(|r| r["id"] == run["id"]).unwrap();
    assert_eq!(after_one["status"], "running", "QA's second attempt did not run: {after_one}");
    replies(&fixture, &id, "Still broken.\nOutcome: fail").await;
    let held = run_where(&fixture, &run["id"], |run| run["status"] == "needs_owner").await;
    assert_eq!(held["status"], "needs_owner", "QA ran past its 2 attempts: {held}");
}

#[tokio::test]
async fn an_approval_stage_waits_until_the_owner_continues() {
    let fixture = fixture().await;
    save(&fixture, json!({
        "id": "ask", "name": "Ask", "enabled": true, "trigger": {"kind": "manual"}, "agent": {"brand": "claude"},
        "setup": {"branch": "{{item.branchName}}", "base": "staging"},
        "stages": [
            agent("implement", "Work on {{item.identifier}}", json!([{"outcome": "done", "to": "check"}])),
            {"id": "check", "name": "Check", "kind": "approval", "prompt": "Ship {{item.identifier}}?", "routes": [{"outcome": "done", "to": "ship"}]},
            agent("ship", "Ship {{item.identifier}}", json!([])),
        ]
    }));
    let run = start(&fixture, "ask", item(8)).await;
    let id = session(&run);
    replies(&fixture, &id, "Outcome: done").await;
    let held = run_where(&fixture, &run["id"], |run| run["stage"] == "check").await;
    assert_eq!(held["status"], "needs_owner", "an approval stage did not wait for the owner: {held}");
    let before = told(&fixture, &id).await.len();
    let (code, body) = act(&fixture, json!({"action": "continue", "run": run["id"]})).await;
    assert_eq!(code, 200, "continue failed: {body}");
    let prompts = told_more(&fixture, &id, before).await;
    assert!(prompts.last().map_or(false, |p| p.contains("Ship KEY-8")), "continuing did not start the next stage: {prompts:?}");
}

#[tokio::test]
async fn a_schedule_starts_one_run_per_new_item() {
    let fixture = fixture().await;
    let items = fixture._directory.path().join("items.json");
    std::fs::write(&items, json!([item(9), item(10)]).to_string()).unwrap();
    let mut flow = ticket_flow();
    flow["trigger"] = json!({"kind": "schedule", "every_minutes": 5, "items": format!("cat {}", items.display())});
    save(&fixture, flow.clone());
    act(&fixture, json!({"action": "tick"})).await;
    act(&fixture, json!({"action": "tick"})).await;
    let started: Vec<Value> = runs(&fixture).await;
    let mut names: Vec<String> = started.iter().map(|r| r["item"]["identifier"].as_str().unwrap_or("").to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["KEY-10", "KEY-9"], "a schedule should start exactly one run per item: {started:?}");
}

#[tokio::test]
async fn a_disabled_or_manual_workflow_starts_nothing_on_its_own() {
    let fixture = fixture().await;
    let items = fixture._directory.path().join("items.json");
    std::fs::write(&items, json!([item(11)]).to_string()).unwrap();
    let mut flow = ticket_flow();
    flow["enabled"] = json!(false);
    flow["trigger"] = json!({"kind": "schedule", "every_minutes": 5, "items": format!("cat {}", items.display())});
    save(&fixture, flow.clone());
    act(&fixture, json!({"action": "tick"})).await;
    flow["enabled"] = json!(true);
    flow["trigger"] = json!({"kind": "manual", "items": format!("cat {}", items.display())});
    save(&fixture, flow);
    act(&fixture, json!({"action": "tick"})).await;
    assert!(runs(&fixture).await.is_empty(), "a disabled schedule or a manual workflow started a run by itself");
}

#[tokio::test]
async fn the_items_command_lists_items_and_reports_its_failure() {
    let fixture = fixture().await;
    let items = fixture._directory.path().join("items.json");
    std::fs::write(&items, json!([item(12)]).to_string()).unwrap();
    let mut flow = ticket_flow();
    flow["trigger"]["items"] = json!(format!("cat {}", items.display()));
    save(&fixture, flow.clone());
    let (code, body) = act(&fixture, json!({"action": "items", "workflow": "ticket"})).await;
    assert_eq!(code, 200, "listing items failed: {body}");
    assert_eq!(body["items"][0]["identifier"], "KEY-12", "the items command's output was not returned: {body}");

    flow["trigger"]["items"] = json!("echo nope >&2; exit 3");
    save(&fixture, flow);
    let (code, body) = act(&fixture, json!({"action": "items", "workflow": "ticket"})).await;
    assert!(code >= 400, "a failing items command was not refused: {code} {body}");
    assert!(body.to_string().contains("nope"), "the refusal does not say what the command printed: {body}");
}

#[tokio::test]
async fn a_run_can_be_stopped() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(13)).await;
    let id = session(&run);
    let (code, body) = act(&fixture, json!({"action": "stop", "run": run["id"]})).await;
    assert_eq!(code, 200, "stop failed: {body}");
    let before = told(&fixture, &id).await.len();
    replies(&fixture, &id, "Outcome: done").await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let stopped = runs(&fixture).await.into_iter().find(|r| r["id"] == run["id"]).unwrap();
    assert_eq!(stopped["status"], "stopped", "the run is not stopped: {stopped}");
    assert_eq!(told(&fixture, &id).await.len(), before, "a stopped run still moved its chat on");
}

const TYPES: &[&str] = &["bug", "feature", "ui_change", "ui_feature", "ui_bug", "render_change", "render_feature",
    "render_bug", "optimization", "plan", "investigation", "refactor", "tests", "review", "qa", "docs", "chore", "general"];

/// A plan task whose one check passes once `made.txt` exists in the chat's
/// folder. Plan tasks wait for the owner's approval when they are done.
fn plan_task() -> Value {
    let decisions: serde_json::Map<String, Value> = TYPES.iter().map(|t| (t.to_string(), json!("not this kind of work"))).collect();
    json!({
        "type": "plan", "title": "Decide the login fix", "why": "The ticket needs a plan",
        "decisions": decisions,
        "plan": {"question": "How to fix login?", "scope": "Login", "constraints": [],
            "checks": [{"name": "made", "kind": "structure", "command": "test -f made.txt && echo made || { echo missing; exit 1; }",
                "given": "the worktree", "when": "the plan is written", "then": "made.txt exists", "red": "missing", "files": []}],
            "requirements": [{"id": "options-weighed", "text": "The options considered are listed", "declined": "one option"}]}
    })
}

/// A task request from the agent in chat `session`.
async fn task(fixture: &Fixture, session: &str, action: &str, number: Option<i64>, payload: Value) -> (u16, Value) {
    let mut body = json!({"action": action, "actor": "agent", "session": session, "payload": payload});
    if let Some(number) = number {
        body["number"] = json!(number);
    }
    post(fixture, "/task", body).await
}

/// Task `number` of the run's project, as the task route shows it.
async fn shown(fixture: &Fixture, _session: &str, number: i64) -> Value {
    let uri = format!("/tasks/project-1/{number}");
    let (_, body) = send(fixture, axum::http::Request::get(uri).body(Body::empty()).unwrap()).await;
    body["task"].clone()
}

/// The run's agent proposes a plan task and ends its turn; the proposal.
async fn proposes(fixture: &Fixture, session: &str) -> Value {
    let (code, body) = task(fixture, session, "propose", None, plan_task()).await;
    assert_eq!(code, 200, "propose failed: {body}");
    replies(fixture, session, "Proposed a task. Waiting for the owner.").await;
    body["proposal"].clone()
}

/// Waits up to three seconds for `read` to give something `ok` accepts.
async fn until<F, Fut>(read: F, ok: impl Fn(&Value) -> bool) -> Value
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Value>,
{
    let mut last = Value::Null;
    for _ in 0..60 {
        last = read().await;
        if ok(&last) {
            return last;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    last
}

#[tokio::test]
async fn approve_plan_creates_the_task_the_agent_proposes() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow["stages"][0]["auto"]["plan"] = json!(true);
    save(&fixture, flow);
    let run = start(&fixture, "ticket", item(14)).await;
    let id = session(&run);
    proposes(&fixture, &id).await;
    let created = until(|| shown(&fixture, &id, 1), |task| task["status"] == "todo").await;
    assert_eq!(created["status"], "todo", "with Approve plan on, the proposal did not become a task: {created}");
    let prompts = told(&fixture, &id).await;
    assert!(prompts.iter().any(|p| p.contains("Create task")), "the agent was not told its task was created: {prompts:?}");
    let still = run_where(&fixture, &run["id"], |run| run["status"] == "running").await;
    assert_eq!(still["status"], "running", "the run stopped for the owner: {still}");
}

#[tokio::test]
async fn without_approve_plan_a_proposal_waits_for_the_owner() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(15)).await;
    let id = session(&run);
    proposes(&fixture, &id).await;
    let held = run_where(&fixture, &run["id"], |run| run["status"] == "needs_owner").await;
    assert_eq!(held["status"], "needs_owner", "the run did not wait for the owner's answer: {held}");
    let made = shown(&fixture, &id, 1).await;
    assert!(made.is_null(), "a task was created without the owner: {made}");
}

#[tokio::test]
async fn approve_finished_work_approves_a_task_waiting_for_review() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow["stages"][0]["auto"]["plan"] = json!(true);
    flow["stages"][0]["auto"]["done"] = json!(true);
    save(&fixture, flow);
    let run = start(&fixture, "ticket", item(16)).await;
    let id = session(&run);
    proposes(&fixture, &id).await;
    until(|| shown(&fixture, &id, 1), |task| task["status"] == "todo").await;
    let (code, body) = task(&fixture, &id, "start", Some(1), json!({})).await;
    assert_eq!(code, 200, "start failed: {body}");
    std::fs::write(format!("{}/made.txt", run["cwd"].as_str().unwrap()), "x").unwrap();
    let (code, body) = task(&fixture, &id, "done", Some(1), json!({"summary": "done", "commits": [], "followups": [],
        "result": {"document": "# Plan", "decisions": [], "open_questions": [], "proposed_tasks": []}})).await;
    assert_eq!(code, 200, "done failed: {body}");
    assert_eq!(body["task"]["status"], "review", "a plan task should wait for review: {body}");
    replies(&fixture, &id, "Finished; waiting for approval.").await;
    let approved = until(|| shown(&fixture, &id, 1), |task| task["status"] == "done").await;
    assert_eq!(approved["status"], "done", "with Approve finished work on, the task was not approved: {approved}");
}

// --- Each workflow's agent, and how many of its runs work at once ---

/// What every `session.start` so far asked for, oldest first.
fn chats_started(fixture: &Fixture) -> Vec<Value> {
    fixture.seen.lock().unwrap().iter().filter(|(kind, _)| kind == "SessionStart").map(|(_, fields)| fields.clone()).collect()
}

/// One agent stage that finishes the run, at most `limit` runs at once.
fn single(limit: u32) -> Value {
    json!({
        "id": "single", "name": "Single", "enabled": true, "trigger": {"kind": "manual"},
        "agent": {"brand": "claude"}, "max_concurrent": limit,
        "setup": {"branch": "{{item.branchName}}", "base": "main"},
        "stages": [agent("work", "Work on {{item.identifier}}", json!([]))],
    })
}

#[tokio::test]
async fn a_run_starts_its_chat_with_the_workflows_agent() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow["agent"] = json!({"brand": "claude", "profile_id": "work", "model": "opus", "effort": "high"});
    save(&fixture, flow);
    start(&fixture, "ticket", item(30)).await;
    let started = chats_started(&fixture);
    let chat = started.last().unwrap_or_else(|| panic!("no chat was started"));
    for (key, want) in [("brand", "claude"), ("profileId", "work"), ("model", "opus"), ("effort", "high")] {
        assert_eq!(chat[key], want, "the chat did not start with the workflow's {key}: {chat}");
    }
}

#[tokio::test]
async fn a_manual_run_can_choose_another_agent() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow["agent"] = json!({"brand": "claude", "profile_id": "work", "model": "opus", "effort": "high"});
    save(&fixture, flow);
    let (code, body) = act(&fixture, json!({"action": "start", "workflow": "ticket", "items": [item(31)],
        "agent": {"brand": "claude", "profile_id": "personal", "model": "sonnet", "effort": "low"}})).await;
    assert_eq!(code, 200, "starting with another agent failed: {body}");
    let started = chats_started(&fixture);
    let chat = started.last().unwrap_or_else(|| panic!("no chat was started"));
    for (key, want) in [("brand", "claude"), ("profileId", "personal"), ("model", "sonnet"), ("effort", "low")] {
        assert_eq!(chat[key], want, "the run's own choice of {key} was not used: {chat}");
    }
}

#[tokio::test]
async fn a_workflow_without_an_agent_does_not_start() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow.as_object_mut().unwrap().remove("agent");
    save(&fixture, flow);
    let (code, body) = act(&fixture, json!({"action": "start", "workflow": "ticket", "items": [item(32)]})).await;
    assert!(code >= 400, "a run started with no agent chosen: {code} {body}");
    assert!(body.to_string().to_lowercase().contains("agent"), "the refusal does not say an agent is missing: {body}");
    assert!(chats_started(&fixture).is_empty(), "a chat was started with no agent chosen");
}

#[tokio::test]
async fn runs_past_the_limit_wait_in_a_queue() {
    let fixture = fixture().await;
    save(&fixture, single(1));
    let (code, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(33), item(34)]})).await;
    assert_eq!(code, 200, "starting two runs failed: {body}");
    assert_eq!(body["runs"][0]["status"], "running", "the first run did not start: {body}");
    assert_eq!(body["runs"][1]["status"], "queued", "the second run did not wait its turn: {body}");
    assert!(body["runs"][1]["sessionId"].is_null(), "a queued run already has a chat: {body}");
    assert_eq!(chats_started(&fixture).len(), 1, "more chats started than the limit allows");
}

#[tokio::test]
async fn a_queued_run_starts_when_a_run_finishes() {
    let fixture = fixture().await;
    save(&fixture, single(1));
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(35), item(36)]})).await;
    assert_eq!(body["runs"][1]["status"], "queued", "the second run did not wait its turn: {body}");
    let first = session(&body["runs"][0]);
    replies(&fixture, &first, "Outcome: done").await;
    let next = run_where(&fixture, &body["runs"][1]["id"], |run| run["status"] == "running").await;
    assert_eq!(next["status"], "running", "the queued run did not start after the first finished: {next}");
    let prompts = told_more(&fixture, &session(&next), 0).await;
    assert!(prompts.iter().any(|p| p.contains("Work on KEY-36")), "the queued run's chat got no prompt: {prompts:?}");
}

#[tokio::test]
async fn a_run_waiting_on_a_check_frees_its_slot() {
    let fixture = fixture().await;
    let state = fixture._directory.path().join("state.txt");
    std::fs::write(&state, "In QA\n").unwrap();
    let mut flow = single(1);
    flow["stages"] = json!([
        agent("work", "Work on {{item.identifier}}", json!([{"outcome": "done", "to": "check"}])),
        {"id": "check", "name": "Check", "kind": "wait", "prompt": format!("cat {}", state.display()),
         "routes": [{"outcome": "Rejected", "to": "work"}], "auto": off()},
    ]);
    save(&fixture, flow);
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(37), item(38)]})).await;
    assert_eq!(body["runs"][1]["status"], "queued", "the second run did not wait its turn: {body}");
    replies(&fixture, &session(&body["runs"][0]), "Outcome: done").await;
    let next = run_where(&fixture, &body["runs"][1]["id"], |run| run["status"] == "running").await;
    assert_eq!(next["status"], "running", "a run waiting on its check still held the only slot: {next}");
}

#[tokio::test]
async fn stopping_a_run_starts_the_next_queued_one() {
    let fixture = fixture().await;
    save(&fixture, single(1));
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(39), item(40)]})).await;
    assert_eq!(body["runs"][1]["status"], "queued", "the second run did not wait its turn: {body}");
    act(&fixture, json!({"action": "stop", "run": body["runs"][0]["id"]})).await;
    let next = run_where(&fixture, &body["runs"][1]["id"], |run| run["status"] == "running").await;
    assert_eq!(next["status"], "running", "stopping a run did not start the queued one: {next}");
}

#[tokio::test]
async fn without_a_limit_runs_go_one_at_a_time() {
    let fixture = fixture().await;
    let mut flow = single(1);
    flow.as_object_mut().unwrap().remove("max_concurrent");
    save(&fixture, flow);
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(41), item(42)]})).await;
    assert_eq!(body["runs"][1]["status"], "queued", "with no limit set, two runs worked at once: {body}");
}

#[tokio::test]
async fn a_higher_limit_runs_that_many_at_once() {
    let fixture = fixture().await;
    save(&fixture, single(2));
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(43), item(44), item(45)]})).await;
    let statuses: Vec<&str> = body["runs"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap_or("")).collect();
    assert_eq!(statuses, vec!["running", "running", "queued"], "a limit of 2 did not run exactly two: {body}");
}

#[test]
fn an_older_run_table_gains_the_agent_column() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    connection.execute_batch(
        "CREATE TABLE workflow_run (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_path TEXT NOT NULL,
           workflow_id TEXT NOT NULL, item TEXT NOT NULL, item_key TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
           session_id TEXT, cwd TEXT, attempts TEXT NOT NULL DEFAULT '{}', seen_message INTEGER NOT NULL DEFAULT 0,
           note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         INSERT INTO workflow_run VALUES ('r', 'p', '/x', 'w', '{}', 'k', 's', 'done', NULL, NULL, '{}', 0, NULL, 1, 1);",
    ).unwrap();
    workflows::ensure_schema(&connection).unwrap();
    workflows::ensure_schema(&connection).unwrap();
    let columns: Vec<String> = connection.prepare("SELECT name FROM pragma_table_info('workflow_run')").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert!(columns.iter().any(|c| c == "agent"), "the run table from 0.25.9 did not gain the agent column: {columns:?}");
    let kept: i64 = connection.query_row("SELECT count(*) FROM workflow_run", [], |row| row.get(0)).unwrap();
    assert_eq!(kept, 1, "upgrading the run table lost a run");
}

// --- The agent reports its stage with `atelier workflow` ---

/// A workflow request from the agent in chat `session`, as the CLI sends it.
async fn report(fixture: &Fixture, session: &str, action: &str, fields: Value) -> (u16, Value) {
    let mut body = fields;
    body["action"] = json!(action);
    body["session"] = json!(session);
    post(fixture, "/workflow-run", body).await
}

#[tokio::test]
async fn workflow_done_moves_the_run_by_the_outcome_it_names() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(40)).await;
    let id = session(&run);
    let (code, body) = report(&fixture, &id, "done", json!({"outcome": "done"})).await;
    assert_eq!(code, 200, "workflow done was refused: {body}");
    replies(&fixture, &id, "Finished the work.").await;
    let moved = run_where(&fixture, &run["id"], |run| run["stage"] == "qa").await;
    assert_eq!(moved["stage"], "qa", "workflow done did not move the run on: {moved}");
}

#[tokio::test]
async fn workflow_done_refuses_an_outcome_the_stage_has_no_route_for() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(41)).await;
    let id = session(&run);
    let (code, body) = report(&fixture, &id, "done", json!({"outcome": "shipped"})).await;
    assert_eq!(code, 400, "workflow done took an outcome the stage has no route for: {body}");
    let said = body.to_string();
    assert!(said.contains("\"done\"") || said.contains("done"), "the refusal does not list the stage's outcomes: {said}");
    let still = run_where(&fixture, &run["id"], |run| run["stage"] == "implement").await;
    assert_eq!(still["stage"], "implement", "a refused outcome moved the run: {still}");
}

#[tokio::test]
async fn workflow_block_holds_the_run_for_the_owner_with_its_reason() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(42)).await;
    let id = session(&run);
    let (code, body) = report(&fixture, &id, "block", json!({"needs": "Which staging database should I use?"})).await;
    assert_eq!(code, 200, "workflow block was refused: {body}");
    replies(&fixture, &id, "I need the owner.").await;
    let held = run_where(&fixture, &run["id"], |run| run["status"] == "needs_owner" && run["note"] == "Which staging database should I use?").await;
    assert_eq!(held["status"], "needs_owner", "workflow block did not hold the run: {held}");
    assert_eq!(held["note"], "Which staging database should I use?", "the run does not show what the agent needs: {held}");
}

#[tokio::test]
async fn workflow_show_lists_every_stage_and_the_current_one() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(43)).await;
    let id = session(&run);
    let (code, body) = report(&fixture, &id, "show", json!({})).await;
    assert_eq!(code, 200, "workflow show was refused: {body}");
    let stages: Vec<&str> = body["stages"].as_array().map(|s| s.iter().filter_map(|s| s["id"].as_str()).collect()).unwrap_or_default();
    assert_eq!(stages, ["implement", "qa", "ship"], "workflow show does not list the stages: {body}");
    assert_eq!(body["current"], "implement", "workflow show does not name the current stage: {body}");
    assert_eq!(body["outcomes"], json!(["done"]), "workflow show does not list the current stage's outcomes: {body}");
}

#[tokio::test]
async fn the_stage_prompt_tells_the_agent_to_report_with_the_command() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(44)).await;
    let prompts = told_more(&fixture, &session(&run), 0).await;
    let first = prompts.first().cloned().unwrap_or_default();
    assert!(first.contains("atelier workflow done done"), "the prompt does not say to run atelier workflow done: {first}");
    assert!(first.contains("atelier workflow show"), "the prompt does not point at atelier workflow show: {first}");
    assert!(first.contains("atelier workflow block"), "the prompt does not say how to ask for the owner: {first}");
}

#[tokio::test]
async fn workflow_done_is_refused_while_the_stage_task_is_in_progress() {
    let fixture = fixture().await;
    let mut flow = ticket_flow();
    flow["stages"][0]["auto"]["plan"] = json!(true);
    save(&fixture, flow);
    let run = start(&fixture, "ticket", item(45)).await;
    let id = session(&run);
    proposes(&fixture, &id).await;
    until(|| shown(&fixture, &id, 1), |task| task["status"] == "todo").await;
    let (code, body) = task(&fixture, &id, "start", Some(1), json!({})).await;
    assert_eq!(code, 200, "start failed: {body}");
    let (code, body) = report(&fixture, &id, "done", json!({"outcome": "done"})).await;
    assert_eq!(code, 409, "workflow done was taken while task #1 is in progress: {body}");
    assert!(body.to_string().contains("#1"), "the refusal does not name the unfinished task: {body}");
}

/// The run's agent finishes its plan task (which then waits for review) and
/// reports `done` in the same turn, in its reply.
async fn finishes_task_and_stage(fixture: &Fixture, run: &Value) {
    let id = session(run);
    proposes(fixture, &id).await;
    until(|| shown(fixture, &id, 1), |task| task["status"] == "todo").await;
    let (code, body) = task(fixture, &id, "start", Some(1), json!({})).await;
    assert_eq!(code, 200, "start failed: {body}");
    std::fs::write(format!("{}/made.txt", run["cwd"].as_str().unwrap()), "x").unwrap();
    let (code, body) = task(fixture, &id, "done", Some(1), json!({"summary": "done", "commits": [], "followups": [],
        "result": {"document": "# Plan", "decisions": [], "open_questions": [], "proposed_tasks": []}})).await;
    assert_eq!(code, 200, "done failed: {body}");
    replies(fixture, &id, "Finished; the task is in review.\n\nOutcome: done").await;
}

fn auto_plan_and_done() -> Value {
    let mut flow = ticket_flow();
    flow["stages"][0]["auto"]["plan"] = json!(true);
    flow["stages"][0]["auto"]["done"] = json!(true);
    flow
}

#[tokio::test]
async fn an_auto_approved_task_still_lets_the_reported_outcome_move_the_run() {
    let fixture = fixture().await;
    save(&fixture, auto_plan_and_done());
    let run = start(&fixture, "ticket", item(46)).await;
    let id = session(&run);
    finishes_task_and_stage(&fixture, &run).await;
    let approved = until(|| shown(&fixture, &id, 1), |task| task["status"] == "done").await;
    assert_eq!(approved["status"], "done", "the task was not approved: {approved}");
    let moved = run_where(&fixture, &run["id"], |run| run["stage"] == "qa").await;
    assert_eq!(moved["stage"], "qa", "the outcome reported with the task in review was dropped: {moved}");
}

#[tokio::test]
async fn a_task_the_workflow_approves_does_not_ask_the_agent_about_merging() {
    let fixture = fixture().await;
    save(&fixture, auto_plan_and_done());
    let run = start(&fixture, "ticket", item(47)).await;
    let id = session(&run);
    finishes_task_and_stage(&fixture, &run).await;
    until(|| shown(&fixture, &id, 1), |task| task["status"] == "done").await;
    let prompts = until(
        || async { json!(told(&fixture, &id).await) },
        |p| p.as_array().is_some_and(|p| p.iter().any(|p| p.as_str().is_some_and(|p| p.contains("approved")))),
    ).await;
    let approval = prompts.as_array().and_then(|p| p.iter().filter_map(Value::as_str).find(|p| p.contains("approved")).map(str::to_string));
    let approval = approval.unwrap_or_else(|| panic!("the agent was not told its task was approved: {prompts}"));
    assert!(!approval.to_lowercase().contains("merge"), "the approval asks the agent about merging: {approval}");
}

/// Serves the router on a free port, as the app does, for the real CLI.
async fn serve(fixture: &Fixture) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new().nest("/api/workbench", router(fixture.state.clone()));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn the_atelier_workflow_cli_reports_the_stage_from_the_chat() {
    let fixture = fixture().await;
    save(&fixture, ticket_flow());
    let run = start(&fixture, "ticket", item(48)).await;
    let id = session(&run);
    let port = serve(&fixture).await;
    let cli = |args: &[&str]| {
        Shell::new(env!("CARGO_BIN_EXE_atelier"))
            .args(args)
            .current_dir(run["cwd"].as_str().unwrap())
            .env("ATELIER_DATA_DIR", fixture._directory.path())
            .env("ATELIER_CHAT_SESSION_ID", &id)
            .env("ATELIER_PORT", port.to_string())
            .output()
            .unwrap()
    };
    let shown = cli(&["workflow", "show"]);
    let said = format!("{}{}", String::from_utf8_lossy(&shown.stdout), String::from_utf8_lossy(&shown.stderr));
    assert!(shown.status.success() && said.contains("implement") && said.contains("qa"), "atelier workflow show did not list the stages: {said}");
    let wrong = cli(&["workflow", "done", "shipped"]);
    assert!(!wrong.status.success(), "atelier workflow done took an unknown outcome");
    let done = cli(&["workflow", "done", "done"]);
    let said = format!("{}{}", String::from_utf8_lossy(&done.stdout), String::from_utf8_lossy(&done.stderr));
    assert!(done.status.success(), "atelier workflow done failed: {said}");
    replies(&fixture, &id, "Finished the work.").await;
    let moved = run_where(&fixture, &run["id"], |run| run["stage"] == "qa").await;
    assert_eq!(moved["stage"], "qa", "the CLI's outcome did not move the run: {moved}");
}

#[tokio::test]
async fn a_run_waiting_for_the_owner_frees_its_slot() {
    let fixture = fixture().await;
    save(&fixture, single(1));
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(49), item(50)]})).await;
    assert_eq!(body["runs"][1]["status"], "queued", "the second run did not wait its turn: {body}");
    replies(&fixture, &session(&body["runs"][0]), "Which login page do you mean?").await;
    let held = run_where(&fixture, &body["runs"][0]["id"], |run| run["status"] == "needs_owner").await;
    assert_eq!(held["status"], "needs_owner", "the first run did not wait for the owner: {held}");
    let next = run_where(&fixture, &body["runs"][1]["id"], |run| run["status"] == "running").await;
    assert_eq!(next["status"], "running", "a run waiting for the owner still held the only slot: {next}");
}

#[tokio::test]
async fn a_continued_run_waits_for_a_free_slot_ahead_of_new_items() {
    let fixture = fixture().await;
    save(&fixture, single(1));
    let (_, body) = act(&fixture, json!({"action": "start", "workflow": "single", "items": [item(51), item(52), item(53)]})).await;
    let first = body["runs"][0].clone();
    replies(&fixture, &session(&first), "Which login page do you mean?").await;
    let second = run_where(&fixture, &body["runs"][1]["id"], |run| run["status"] == "running").await;
    assert_eq!(second["status"], "running", "a run waiting for the owner still held the only slot: {second}");
    let (code, answer) = act(&fixture, json!({"action": "continue", "run": first["id"]})).await;
    assert_eq!(code, 200, "continue failed: {answer}");
    let waiting = run_where(&fixture, &first["id"], |run| run["status"] == "queued").await;
    assert_eq!(waiting["status"], "queued", "a continued run went past the limit instead of waiting for a slot: {waiting}");
    replies(&fixture, &session(&second), "Outcome: done").await;
    let resumed = run_where(&fixture, &first["id"], |run| run["status"] == "running").await;
    assert_eq!(resumed["status"], "running", "the continued run did not take the freed slot first: {resumed}");
    let third = run_where(&fixture, &body["runs"][2]["id"], |run| run["status"] == "queued").await;
    assert_eq!(third["status"], "queued", "a new item went ahead of the continued run: {third}");
}
