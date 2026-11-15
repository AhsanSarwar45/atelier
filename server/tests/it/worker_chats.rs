//! Worker chats: an orchestrator chat starts and steers ordinary chats on the
//! provider, account and model the owner chose for it
//! (docs/designs/orchestrator-workers.md).
//!
//! The provider is the only thing faked: a factory that writes the chat's row
//! from what it was asked to start, and a driver that records every command it
//! is sent. Everything else is the real router, registry and database.

use atelier::routes::workbench::{router, WorkbenchState};
use atelier::workbench::{
    actor::ChatDb,
    protocol::Command,
    registry::{DriverFuture, LaunchFuture, LaunchedSession, ProviderDriver, RegistryPaths, SessionFactory, WorkbenchRegistry},
    store::{Session, SessionPatch},
};
use axum::body::Body;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Seen = Arc<Mutex<Vec<(String, Value)>>>;

/// What one command asked of the provider: its kind and its fields.
fn seen(command: &Command) -> (String, Value) {
    (format!("{:?}", command.kind), Value::Object(command.fields.clone()))
}

struct Recording {
    seen: Seen,
}

impl ProviderDriver for Recording {
    fn brand(&self) -> &'static str {
        "codex"
    }
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
        self.seen.lock().unwrap().push(seen(command));
        Box::pin(async { Ok(json!({"ok": true, "messageId": "message-1"})) })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async { Ok(json!({"ok": true})) })
    }
}

/// Writes the chat's row from the start command, as a real start does before
/// its process answers, and hands back a recording driver.
struct Provider {
    seen: Seen,
}

impl SessionFactory for Provider {
    fn launch<'a>(&'a self, database: ChatDb, command: &'a Command) -> LaunchFuture<'a> {
        self.seen.lock().unwrap().push(seen(command));
        let seen = self.seen.clone();
        Box::pin(async move {
            let field = |key: &str| command.fields.get(key).cloned().unwrap_or(Value::Null);
            let path = field("projectPath");
            let row = json!({
                "id": field("sessionId"), "brand": field("brand"), "externalId": null,
                "projectId": field("projectId"), "projectPath": path,
                "cwd": if field("cwd").is_null() { path.clone() } else { field("cwd") },
                "model": field("model"), "permissionMode": "default", "effort": field("effort"),
                "collaborationMode": null, "profile": field("profileId"), "title": field("title"),
                "state": "idle", "origin": "app",
                "createdAt": "2026-11-14T00:00:00.000Z", "lastActiveAt": "2026-11-14T00:00:00.000Z",
                "lastSpokeAt": null, "begunBy": "person",
                "parentSessionId": field("parentSessionId"), "workers": field("workers"),
            });
            // Waking a chat that is already kept (a report told to a sleeping
            // orchestrator) reuses its row.
            let kept = match field("sessionId").as_str() {
                Some(id) => database.get_session(id.to_string()).await?,
                None => None,
            };
            let session: Session = match kept {
                Some(session) => session,
                None => {
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
    folder: String,
}

/// A chat row as the database keeps it, with `extra` fields laid over it.
fn chat(id: &str, folder: &str, extra: Value) -> Session {
    let mut row = json!({
        "id": id, "brand": "claude", "externalId": null, "projectId": "project-1",
        "projectPath": folder, "cwd": folder, "model": null, "permissionMode": "default",
        "effort": null, "collaborationMode": null, "profile": null, "title": id,
        "state": "idle", "origin": "app",
        "createdAt": "2026-11-14T00:00:00.000Z", "lastActiveAt": "2026-11-14T00:00:00.000Z",
        "lastSpokeAt": null, "begunBy": "person",
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        row[key] = value;
    }
    serde_json::from_value(row).unwrap()
}

/// The owner's choice for orchestrator chats in these tests.
fn choice() -> Value {
    json!({"workers": {"brand": "codex", "profileId": "work-account", "model": "gpt-test"}})
}

/// Two orchestrators (`orch-a`, `orch-b`) with the owner's choice, and a plain
/// chat (`plain`) without it, all in one folder.
async fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let folder = directory.path().join("project").display().to_string();
    std::fs::create_dir_all(&folder).unwrap();
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
    for (id, extra) in [("orch-a", choice()), ("orch-b", choice()), ("plain", json!({}))] {
        state.database().create_session(chat(id, &folder, extra)).await.unwrap();
    }
    Fixture { _directory: directory, state, seen, folder }
}

/// POST to the worker route as chat `session`; the status and the JSON answer.
async fn ask(fixture: &Fixture, body: Value) -> (u16, Value) {
    let request = axum::http::Request::post("/workers")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let answer = router(fixture.state.clone()).oneshot(request).await.unwrap();
    let status = answer.status().as_u16();
    let bytes = answer.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}));
    (status, json)
}

async fn start(fixture: &Fixture, session: &str, title: &str, brief: &str) -> (u16, Value) {
    ask(fixture, json!({"action": "start", "session": session, "title": title, "text": brief})).await
}

/// Start a worker that must start; its chat ID.
async fn started(fixture: &Fixture, session: &str, title: &str) -> String {
    let (status, answer) = start(fixture, session, title, "Fix the login form.").await;
    assert_eq!(status, 200, "the worker route answered {status}: {answer}");
    answer["workerId"].as_str().unwrap_or_else(|| panic!("no workerId in {answer}")).to_string()
}

/// The commands of `kind` the provider was sent for chat `id`, waiting a
/// little for any sent from a spawned task.
async fn sent(fixture: &Fixture, kind: &str, id: &str) -> Vec<Value> {
    for _ in 0..40 {
        let found: Vec<Value> = fixture
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, fields)| k == kind && fields["sessionId"] == id)
            .map(|(_, fields)| fields.clone())
            .collect();
        if !found.is_empty() {
            return found;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Vec::new()
}

fn error_of(answer: &Value) -> String {
    answer["error"].as_str().unwrap_or_default().to_lowercase()
}

#[tokio::test]
async fn a_chat_keeps_its_workers_choice_and_its_orchestrator() {
    let fixture = fixture().await;
    let worker = chat("worker-1", &fixture.folder, json!({"parentSessionId": "orch-a"}));
    fixture.state.database().create_session(worker).await.unwrap();
    let read = |id: &str| {
        let database = fixture.state.database();
        let id = id.to_string();
        async move { serde_json::to_value(database.get_session(id).await.unwrap().unwrap()).unwrap() }
    };
    let orchestrator = read("orch-a").await;
    assert_eq!(orchestrator["workers"]["brand"], "codex", "the workers choice was not kept: {orchestrator}");
    assert_eq!(orchestrator["workers"]["profileId"], "work-account", "the workers choice was not kept: {orchestrator}");
    assert_eq!(orchestrator["workers"]["model"], "gpt-test", "the workers choice was not kept: {orchestrator}");
    let worker = read("worker-1").await;
    assert_eq!(worker["parentSessionId"], "orch-a", "the worker's orchestrator was not kept: {worker}");
}

#[tokio::test]
async fn a_worker_starts_on_the_owners_chosen_provider_account_and_model() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    let starts = sent(&fixture, "SessionStart", &worker).await;
    let start = starts.first().unwrap_or_else(|| panic!("no chat was started for worker {worker}"));
    assert_eq!(start["brand"], "codex", "the worker did not start on the chosen provider: {start}");
    assert_eq!(start["profileId"], "work-account", "the worker did not start on the chosen account: {start}");
    assert_eq!(start["model"], "gpt-test", "the worker did not start on the chosen model: {start}");
    assert_eq!(start["parentSessionId"], "orch-a", "the worker was not linked to its orchestrator: {start}");
    assert_eq!(start["projectPath"], fixture.folder.as_str(), "the worker did not start in the orchestrator's folder: {start}");
    let row = fixture.state.database().get_session(worker.clone()).await.unwrap().expect("the worker's chat is kept");
    assert_eq!(row.title.as_deref(), Some("login form"), "the worker was not given its title");
}

#[tokio::test]
async fn the_brief_is_the_workers_first_message() {
    let fixture = fixture().await;
    let (status, answer) = start(&fixture, "orch-a", "login form", "Fix the login form: the button does nothing.").await;
    assert_eq!(status, 200, "the worker route answered {status}: {answer}");
    let worker = answer["workerId"].as_str().unwrap_or_default().to_string();
    let prompts = sent(&fixture, "PromptSend", &worker).await;
    assert!(
        prompts.iter().any(|p| p["text"].as_str().unwrap_or_default().contains("the button does nothing")),
        "the brief never reached the worker as a message: {prompts:?}"
    );
}

#[tokio::test]
async fn a_chat_without_the_workers_choice_cannot_start_a_worker() {
    let fixture = fixture().await;
    let (status, answer) = start(&fixture, "plain", "login form", "Fix it.").await;
    assert!(
        (400..500).contains(&status) && error_of(&answer).contains("workers"),
        "a chat without the workers choice was not refused for that reason: {status} {answer}"
    );
    let starts = fixture.seen.lock().unwrap().iter().filter(|(k, _)| k == "SessionStart").count();
    assert_eq!(starts, 0, "a chat was started for a refused worker");
}

#[tokio::test]
async fn an_orchestrator_cannot_steer_another_orchestrators_worker() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    for action in ["send", "read", "stop"] {
        let (status, answer) = ask(&fixture, json!({"action": action, "session": "orch-b", "worker": worker, "text": "Do something else."})).await;
        assert!(
            (400..500).contains(&status) && error_of(&answer).contains("not your worker"),
            "{action} on another orchestrator's worker was not refused for that reason: {status} {answer}"
        );
    }
}

#[tokio::test]
async fn send_gives_the_worker_its_next_instruction() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    let (status, answer) = ask(&fixture, json!({"action": "send", "session": "orch-a", "worker": worker, "text": "Also add a test for the empty password."})).await;
    assert_eq!(status, 200, "send answered {status}: {answer}");
    let prompts = sent(&fixture, "PromptSend", &worker).await;
    assert!(
        prompts.iter().any(|p| p["text"].as_str().unwrap_or_default().contains("empty password")),
        "the instruction never reached the worker: {prompts:?}"
    );
}

#[tokio::test]
async fn list_shows_only_this_orchestrators_workers() {
    let fixture = fixture().await;
    let mine = started(&fixture, "orch-a", "login form").await;
    let (status, answer) = ask(&fixture, json!({"action": "send", "session": "orch-a", "worker": mine, "text": "next"})).await;
    assert_eq!(status, 200, "send answered {status}: {answer}");
    let theirs = started(&fixture, "orch-b", "settings page").await;
    let (status, answer) = ask(&fixture, json!({"action": "list", "session": "orch-a"})).await;
    assert_eq!(status, 200, "list answered {status}: {answer}");
    let ids: Vec<&str> = answer["workers"].as_array().into_iter().flatten().filter_map(|w| w["id"].as_str()).collect();
    assert_eq!(ids, vec![mine.as_str()], "list did not show exactly this orchestrator's worker (not {theirs}): {answer}");
    let first = &answer["workers"][0];
    assert_eq!(first["title"], "login form", "list did not name the worker: {answer}");
    assert!(first["state"].is_string(), "list did not give the worker's state: {answer}");
}

#[tokio::test]
async fn read_returns_the_workers_chat_as_text() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    let (status, answer) = ask(&fixture, json!({"action": "read", "session": "orch-a", "worker": worker})).await;
    assert_eq!(status, 200, "read answered {status}: {answer}");
    let text = answer["text"].as_str().unwrap_or_default();
    assert!(text.contains(&worker) && text.contains("login form"), "read did not return the worker's chat: {answer}");
}

#[tokio::test]
async fn a_second_worker_waits_while_another_is_working_in_the_same_folder() {
    let fixture = fixture().await;
    let first = started(&fixture, "orch-a", "login form").await;
    let working = SessionPatch { state: Some("thinking".into()), ..Default::default() };
    fixture.state.database().update_session(first.clone(), working, None).await.unwrap();
    let (status, answer) = start(&fixture, "orch-a", "settings page", "Fix the settings page.").await;
    assert!(
        (400..500).contains(&status) && error_of(&answer).contains("still working"),
        "a second worker was not refused while one is working in the folder: {status} {answer}"
    );
    let idle = SessionPatch { state: Some("idle".into()), ..Default::default() };
    fixture.state.database().update_session(first, idle, None).await.unwrap();
    let (status, answer) = start(&fixture, "orch-a", "settings page", "Fix the settings page.").await;
    assert_eq!(status, 200, "a worker was refused although none is working: {status} {answer}");
}

#[tokio::test]
async fn the_worker_tool_is_an_atelier_tool() {
    let outcome = atelier::rules::tool("worker", &["help".to_string()]).await;
    assert_eq!(outcome, Ok(0), "`atelier tool worker help` is not a working tool: {outcome:?}");
}

/// Every message chat `id` was told, sent or held, waiting up to `wait_ms` for
/// one from the background loop.
async fn told(fixture: &Fixture, id: &str, wait_ms: u64) -> Vec<String> {
    let mut found = Vec::new();
    for _ in 0..(wait_ms / 50).max(1) {
        found = fixture
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, fields)| k == "PromptSend" && fields["sessionId"] == id)
            .filter_map(|(_, fields)| fields["text"].as_str().map(str::to_string))
            .collect();
        for held in fixture.state.database().held_messages(id.to_string()).await.unwrap_or_default() {
            if let Some(text) = held["text"].as_str() {
                found.push(text.to_string());
            }
        }
        if !found.is_empty() {
            return found;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    found
}

/// Moves chat `id` through `states`, as its provider reports them: one
/// `session.state` event each.
async fn goes(fixture: &Fixture, id: &str, states: &[&str]) {
    for state in states {
        let event = json!({"type": "session.state", "sessionId": id, "seq": 0, "at": "2026-11-14T00:00:01.000Z", "state": state});
        let event: atelier::workbench::protocol::Event = serde_json::from_value(event).unwrap();
        fixture.state.database().append(event).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_workers_finished_turn_is_reported_to_its_orchestrator() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    let before = told(&fixture, "orch-a", 50).await.len();
    goes(&fixture, &worker, &["thinking", "idle"]).await;
    let reports = told(&fixture, "orch-a", 3000).await;
    let report = reports.iter().skip(before).find(|text| text.contains("Worker \"login form\" finished"));
    let report = report.unwrap_or_else(|| panic!("no report reached the orchestrator: {reports:?}"));
    assert!(report.contains(&worker), "the report does not name the worker's chat: {report}");
}

#[tokio::test]
async fn a_worker_that_errors_is_reported_as_an_error() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    goes(&fixture, &worker, &["thinking", "errored"]).await;
    let reports = told(&fixture, "orch-a", 3000).await;
    assert!(
        reports.iter().any(|text| text.contains("Worker \"login form\" stopped with an error")),
        "no error report reached the orchestrator: {reports:?}"
    );
}

#[tokio::test]
async fn a_report_goes_only_to_the_workers_own_orchestrator() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    goes(&fixture, &worker, &["thinking", "idle"]).await;
    let mine = told(&fixture, "orch-a", 3000).await;
    assert!(mine.iter().any(|text| text.contains("login form")), "no report reached the orchestrator: {mine:?}");
    let theirs = told(&fixture, "orch-b", 200).await;
    assert!(theirs.is_empty(), "another orchestrator was told about the worker: {theirs:?}");
}

/// POST a chat command, as the chat bar does; the status and the JSON answer.
async fn command(fixture: &Fixture, body: Value) -> (u16, Value) {
    let request = axum::http::Request::post("/command")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let answer = router(fixture.state.clone()).oneshot(request).await.unwrap();
    let status = answer.status().as_u16();
    let bytes = answer.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}));
    (status, json)
}

/// The chat's workers choice as the database keeps it.
async fn workers_of(fixture: &Fixture, id: &str) -> Value {
    let session = fixture.state.database().get_session(id.to_string()).await.unwrap().unwrap();
    serde_json::to_value(&session.workers).unwrap()
}

#[tokio::test]
async fn workers_can_be_turned_on_in_a_chat_already_going() {
    let fixture = fixture().await;
    let (status, answer) = command(
        &fixture,
        json!({"type": "session.workers", "sessionId": "plain", "workers": {"brand": "codex", "profileId": "work-account"}}),
    )
    .await;
    assert_eq!(status, 200, "the workers choice was not saved: the command answered {status}: {answer}");
    let workers = workers_of(&fixture, "plain").await;
    assert_eq!(workers["brand"], "codex", "the workers choice was not saved: {workers}");
    assert_eq!(workers["profileId"], "work-account", "the workers choice was not saved: {workers}");
    // And the chat can now start workers on that choice.
    let worker = started(&fixture, "plain", "login form").await;
    let starts = sent(&fixture, "SessionStart", &worker).await;
    let start = starts.first().unwrap_or_else(|| panic!("no chat was started for worker {worker}"));
    assert_eq!(start["profileId"], "work-account", "the worker did not start on the account chosen in the chat: {start}");
}

#[tokio::test]
async fn workers_can_be_turned_off_with_none() {
    let fixture = fixture().await;
    let (status, answer) = command(&fixture, json!({"type": "session.workers", "sessionId": "orch-a", "workers": null})).await;
    assert_eq!(status, 200, "workers were not turned off: the command answered {status}: {answer}");
    let workers = workers_of(&fixture, "orch-a").await;
    assert!(workers.is_null(), "workers were not turned off: {workers}");
    let (status, answer) = start(&fixture, "orch-a", "login form", "Fix it.").await;
    assert!(
        (400..500).contains(&status) && error_of(&answer).contains("workers"),
        "a chat with workers turned off could still start one: {status} {answer}"
    );
}

#[tokio::test]
async fn workers_on_an_unknown_provider_are_refused() {
    let fixture = fixture().await;
    let (status, answer) = command(
        &fixture,
        json!({"type": "session.workers", "sessionId": "plain", "workers": {"brand": "nobody", "profileId": "system"}}),
    )
    .await;
    assert!(
        (400..500).contains(&status) && error_of(&answer).contains("nobody"),
        "workers on an unknown provider were not refused for that reason: {status} {answer}"
    );
    let workers = workers_of(&fixture, "plain").await;
    assert!(workers.is_null(), "workers on an unknown provider were saved anyway: {workers}");
}

/// Mark chat `id` as in the middle of a turn, as a running reply does.
async fn mid_turn(fixture: &Fixture, id: &str) {
    let patch = SessionPatch { state: Some("streaming".into()), ..Default::default() };
    fixture.state.database().update_session(id.to_string(), patch, None).await.unwrap();
}

#[tokio::test]
async fn send_now_interrupts_a_worker_mid_turn() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    mid_turn(&fixture, &worker).await;
    let (status, answer) = ask(&fixture, json!({"action": "send", "session": "orch-a", "worker": worker, "text": "Stop, use the other form.", "now": true})).await;
    assert_eq!(status, 200, "send --now answered {status}: {answer}");
    assert_eq!(answer["delivery"], "interrupted", "send --now did not say it interrupted the worker: {answer}");
    let interrupts = sent(&fixture, "SessionInterrupt", &worker).await;
    assert!(!interrupts.is_empty(), "send --now did not interrupt the worker's turn");
}

#[tokio::test]
async fn a_message_to_a_worker_mid_turn_is_queued_and_says_so() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    mid_turn(&fixture, &worker).await;
    let (status, answer) = ask(&fixture, json!({"action": "send", "session": "orch-a", "worker": worker, "text": "Also add a test."})).await;
    assert_eq!(status, 200, "send answered {status}: {answer}");
    assert_eq!(answer["delivery"], "queued", "send did not say the message was queued: {answer}");
    assert!(
        answer["note"].as_str().unwrap_or_default().contains("--now"),
        "send did not say how to interrupt instead: {answer}"
    );
    assert!(sent(&fixture, "SessionInterrupt", &worker).await.is_empty(), "a queued message interrupted the worker");
}

#[tokio::test]
async fn worker_models_are_what_that_account_offered_last() {
    let fixture = fixture().await;
    let database = fixture.state.database();
    database
        .create_session(chat("codex-chat", &fixture.folder, json!({"brand": "codex", "profile": "work-account"})))
        .await
        .unwrap();
    let menu = serde_json::from_value(json!({
        "type": "session.menu", "sessionId": "codex-chat", "at": "2026-11-14T00:00:00.000Z",
        "models": [{"value": "gpt-a", "label": "GPT A"}, {"value": "gpt-b", "label": "GPT B"}],
        "efforts": [{"value": "low", "label": "Low"}, {"value": "high", "label": "High"}],
    }))
    .unwrap();
    database.append(menu).await.unwrap();
    let (status, answer) = command(
        &fixture,
        json!({"type": "workers.models", "sessionId": "orch-a", "brand": "codex", "profileId": "work-account"}),
    )
    .await;
    assert_eq!(status, 200, "the worker models were not offered: the command answered {status}: {answer}");
    let models: Vec<&str> = answer["models"].as_array().into_iter().flatten().filter_map(|m| m["value"].as_str()).collect();
    assert_eq!(models, ["gpt-a", "gpt-b"], "the worker models were not offered: {answer}");
    let efforts: Vec<&str> = answer["efforts"].as_array().into_iter().flatten().filter_map(|m| m["value"].as_str()).collect();
    assert_eq!(efforts, ["low", "high"], "the worker efforts were not offered: {answer}");
}

#[tokio::test]
async fn a_worker_starts_on_the_model_and_effort_chosen_in_the_chat_bar() {
    let fixture = fixture().await;
    let (status, answer) = command(
        &fixture,
        json!({"type": "session.workers", "sessionId": "plain", "workers": {"brand": "codex", "profileId": "work-account", "model": "gpt-b", "effort": "high"}}),
    )
    .await;
    assert_eq!(status, 200, "the workers choice was not saved: {status} {answer}");
    let worker = started(&fixture, "plain", "login form").await;
    let starts = sent(&fixture, "SessionStart", &worker).await;
    let start = starts.first().unwrap_or_else(|| panic!("no chat was started for worker {worker}"));
    assert_eq!(start["model"], "gpt-b", "the worker did not start on the chosen model: {start}");
    assert_eq!(start["effort"], "high", "the worker did not start at the chosen effort: {start}");
}

#[tokio::test]
async fn send_now_to_an_idle_worker_just_sends() {
    let fixture = fixture().await;
    let worker = started(&fixture, "orch-a", "login form").await;
    let (status, answer) = ask(&fixture, json!({"action": "send", "session": "orch-a", "worker": worker, "text": "Next, the signup form.", "now": true})).await;
    assert_eq!(status, 200, "send --now answered {status}: {answer}");
    assert_eq!(answer["delivery"], "sent", "send --now to an idle worker did not say it was sent: {answer}");
    assert!(sent(&fixture, "SessionInterrupt", &worker).await.is_empty(), "an idle worker was interrupted");
}
