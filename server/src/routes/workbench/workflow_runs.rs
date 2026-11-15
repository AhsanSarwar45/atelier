//! Workflow runs (docs/designs/workflows.md): a saved workflow takes an item,
//! such as a ticket, through its stages. Each run gets a worktree on the
//! item's branch and one chat. An agent stage's prompt goes to that chat, and
//! the `Outcome:` line the agent ends its turn with picks the next stage by
//! the workflow's routes. Wait stages rerun their check on each tick, and the
//! stage's Automatic switches answer what the owner would otherwise answer.

use super::tell::tell_chat;
use super::{ApiError, WorkbenchState};
use crate::workbench::protocol::{Command, CommandKind};
use crate::workbench::workflows::{self, Stage, StageKind, TriggerKind, Workflow};
use axum::{
    extract::{Query, State},
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a Wait check, an Items command or a Command stage may run.
const COMMAND_LIMIT: Duration = Duration::from_secs(120);
/// How often the server ticks: Wait checks, and schedules that are due.
const TICK: Duration = Duration::from_secs(60);

/// When each schedule last asked for items, by project folder and workflow.
static POLLED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Ask {
    action: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    workflow: Option<String>,
    #[serde(default)]
    items: Vec<Value>,
    #[serde(default)]
    run: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Listing {
    project_path: String,
}

/// One run, as the table keeps it.
#[derive(Clone, Debug)]
struct Run {
    id: String,
    project_id: String,
    project_path: String,
    workflow: String,
    item: Value,
    stage: String,
    status: String,
    session: Option<String>,
    cwd: Option<String>,
    attempts: Map<String, Value>,
    seen_message: i64,
    note: Option<String>,
}

impl Run {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "projectId": self.project_id, "projectPath": self.project_path,
            "workflow": self.workflow, "item": self.item, "stage": self.stage, "status": self.status,
            "sessionId": self.session, "cwd": self.cwd, "attempts": self.attempts, "note": self.note,
        })
    }
}

const COLUMNS: &str =
    "id, project_id, project_path, workflow_id, item, stage, status, session_id, cwd, attempts, seen_message, note";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Run> {
    let item: String = row.get(4)?;
    let attempts: String = row.get(9)?;
    Ok(Run {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_path: row.get(2)?,
        workflow: row.get(3)?,
        item: serde_json::from_str(&item).unwrap_or(Value::Null),
        stage: row.get(5)?,
        status: row.get(6)?,
        session: row.get(7)?,
        cwd: row.get(8)?,
        attempts: serde_json::from_str(&attempts).unwrap_or_default(),
        seen_message: row.get(10)?,
        note: row.get(11)?,
    })
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn runs_where(state: &WorkbenchState, filter: &'static str, value: String) -> Result<Vec<Run>, String> {
    state
        .database()
        .read_tasks(move |store| {
            let mut statement = store
                .connection()
                .prepare(&format!("SELECT {COLUMNS} FROM workflow_run WHERE {filter} ORDER BY created_at DESC"))?;
            let rows = statement.query_map([value], from_row)?.collect::<rusqlite::Result<Vec<_>>>();
            rows
        })
        .await
}

async fn run_by_id(state: &WorkbenchState, id: &str) -> Result<Option<Run>, String> {
    Ok(runs_where(state, "id = ?1", id.to_string()).await?.into_iter().next())
}

async fn save(state: &WorkbenchState, run: &Run) -> Result<(), String> {
    let run = run.clone();
    state
        .database()
        .write_tasks(move |store| {
            store.connection().execute(
                "UPDATE workflow_run SET stage = ?2, status = ?3, session_id = ?4, cwd = ?5, attempts = ?6,
                   seen_message = ?7, note = ?8, updated_at = ?9 WHERE id = ?1",
                params![
                    run.id, run.stage, run.status, run.session, run.cwd,
                    Value::Object(run.attempts.clone()).to_string(), run.seen_message, run.note, now()
                ],
            )
        })
        .await?
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn data_dir() -> Result<std::path::PathBuf, String> {
    crate::identity::data_dir().ok_or_else(|| "Atelier data directory unavailable".to_string())
}

fn workflow(project_path: &str, id: &str) -> Result<Workflow, String> {
    let file = workflows::read(&data_dir()?, Path::new(project_path))?;
    file.workflows
        .into_iter()
        .find(|workflow| workflow.id == id)
        .ok_or_else(|| format!("No workflow called {id} in this project"))
}

/// `{{item.field}}` filled from the item; a dotted path reaches into objects.
fn fill(text: &str, item: &Value) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = after[..close].trim();
        let value = name.strip_prefix("item.").map(|path| {
            path.split('.').try_fold(item, |value, key| value.get(key))
        });
        match value.flatten() {
            Some(Value::String(text)) => out.push_str(text),
            Some(Value::Null) | None => out.push_str(&rest[open..open + 2 + close + 2]),
            Some(other) => out.push_str(&other.to_string()),
        }
        rest = &after[close + 2..];
    }
    out.push_str(rest);
    out
}

/// What tells one item from another, so a schedule starts it only once.
fn item_key(item: &Value) -> String {
    for key in ["identifier", "id", "key", "branchName", "url"] {
        match item.get(key) {
            Some(Value::String(text)) if !text.is_empty() => return text.clone(),
            Some(Value::Number(number)) => return number.to_string(),
            _ => {}
        }
    }
    item.to_string()
}

fn item_label(item: &Value) -> String {
    let key = item_key(item);
    match item.get("title").and_then(Value::as_str) {
        Some(title) => format!("{key} {title}"),
        None => key,
    }
}

/// The outcomes a stage's routes accept; a stage with none just says done.
fn outcomes(stage: &Stage) -> Vec<String> {
    let listed: Vec<String> = stage.routes.iter().map(|route| route.outcome.clone()).collect();
    if listed.is_empty() { vec!["done".to_string()] } else { listed }
}

fn how_to_report(workflow: &Workflow, stage: &Stage) -> String {
    let lines: Vec<String> = outcomes(stage).iter().map(|outcome| format!("Outcome: {outcome}")).collect();
    format!(
        "This chat is running the workflow \"{}\", stage \"{}\". When this stage is finished, end your reply with one of these lines, exactly as written:\n{}",
        workflow.name, stage.name, lines.join("\n")
    )
}

fn agent_prompt(workflow: &Workflow, stage: &Stage, item: &Value) -> String {
    format!("{}\n\n{}", fill(&stage.prompt, item), how_to_report(workflow, stage))
}

/// The last `Outcome:` line in what the agent said.
fn reported(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(|line| line.trim().trim_matches(|c| c == '*' || c == '`' || c == '_').trim())
        .find_map(|line| line.strip_prefix("Outcome:").map(|rest| rest.trim().trim_matches(|c| c == '*' || c == '`' || c == '.').trim().to_string()))
        .filter(|outcome| !outcome.is_empty())
}

async fn shell(cwd: &str, command: &str) -> Result<(bool, String, String), String> {
    let mut child = tokio::process::Command::new("sh");
    child.arg("-c").arg(command).current_dir(cwd).kill_on_drop(true);
    match tokio::time::timeout(COMMAND_LIMIT, child.output()).await {
        Err(_) => Err(format!("`{command}` took longer than {} seconds", COMMAND_LIMIT.as_secs())),
        Ok(Err(error)) => Err(format!("`{command}` could not run: {error}")),
        Ok(Ok(output)) => Ok((
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        )),
    }
}

/// The items a workflow's Items command prints, as a JSON array.
async fn items(project_path: &str, workflow: &Workflow) -> Result<Vec<Value>, String> {
    let command = workflow
        .trigger
        .items
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or_else(|| "This workflow has no Items command".to_string())?;
    let (ok, out, err) = shell(project_path, command).await?;
    if !ok {
        let said = if err.trim().is_empty() { out.trim() } else { err.trim() };
        return Err(format!("The Items command failed: {said}"));
    }
    match serde_json::from_str::<Value>(out.trim()) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(Value::Object(object)) => match object.get("items").or_else(|| object.get("nodes")) {
            Some(Value::Array(items)) => Ok(items.clone()),
            _ => Err("The Items command must print a JSON list".to_string()),
        },
        _ => Err(format!("The Items command must print a JSON list, not: {}", out.chars().take(200).collect::<String>())),
    }
}

/// The worktree a run works in: the one already on the item's branch, or a
/// new one, starting the branch from the workflow's base when it is new.
async fn worktree(project_path: &str, branch: &str, base: Option<&str>) -> Result<String, String> {
    let repo = Path::new(project_path);
    if let Some(path) = crate::routes::git::tree_on_branch(repo, branch).await {
        return Ok(path);
    }
    let exists = |reference: String| async move {
        crate::routes::git::run_git(repo, &["rev-parse", "--verify", "--quiet", &reference])
            .await
            .is_ok_and(|output| output.status.success())
    };
    let known = exists(format!("refs/heads/{branch}")).await || exists(format!("refs/remotes/origin/{branch}")).await;
    let request = crate::routes::git::NewTreeRequest {
        path: project_path.to_string(),
        name: branch.to_string(),
        branch: branch.to_string(),
        create: !known,
        base: base.map(str::to_string),
    };
    crate::routes::git::add_tree(repo, &request)
        .await
        .map(|entry| entry.path)
        .map_err(|refused| format!("Could not make the worktree for {branch}: {}", refused.said()))
}

async fn start_one(state: &WorkbenchState, project_id: &str, project_path: &str, flow: &Workflow, item: Value) -> Result<Run, String> {
    let first = flow.stages.first().ok_or_else(|| format!("{} has no stages", flow.name))?;
    let key = item_key(&item);
    let branch = fill(flow.setup.branch.as_deref().unwrap_or(""), &item);
    let branch = if branch.trim().is_empty() || branch.contains("{{") {
        format!("workflow/{}-{}", flow.id, key.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-"))
    } else {
        branch.trim().to_string()
    };
    let cwd = worktree(project_path, &branch, flow.setup.base.as_deref()).await?;
    let session = uuid::Uuid::new_v4().to_string();
    let title = item_label(&item);
    let fields = Map::from_iter([
        ("sessionId".into(), json!(session)),
        ("projectId".into(), json!(project_id)),
        ("projectPath".into(), json!(project_path)),
        ("brand".into(), json!("claude")),
        ("title".into(), json!(title)),
        ("cwd".into(), json!(cwd)),
    ]);
    let reply = state
        .registry
        .execute(&Command { kind: CommandKind::SessionStart, fields })
        .await
        .map_err(|error| format!("The chat for {title} could not be started: {error}"))?;
    state.publish_holds().await;
    if reply["id"].as_str() != Some(session.as_str()) {
        return Err(format!("The chat for {title} came back without its id: {reply}"));
    }
    let rename = Map::from_iter([("sessionId".into(), json!(session)), ("title".into(), json!(title))]);
    if let Err(error) = state.registry.execute(&Command { kind: CommandKind::SessionRename, fields: rename }).await {
        tracing::warn!(chat = session, %error, "a workflow run's chat could not be named");
    }
    let run = Run {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        project_path: project_path.to_string(),
        workflow: flow.id.clone(),
        item: item.clone(),
        stage: first.id.clone(),
        status: "running".into(),
        session: Some(session),
        cwd: Some(cwd),
        attempts: Map::new(),
        seen_message: 0,
        note: None,
    };
    let inserted = run.clone();
    state
        .database()
        .write_tasks(move |store| {
            store.connection().execute(
                &format!("INSERT INTO workflow_run ({COLUMNS}, item_key, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'{{}}',0,NULL,?10,?11,?11)"),
                params![
                    inserted.id, inserted.project_id, inserted.project_path, inserted.workflow,
                    inserted.item.to_string(), inserted.stage, inserted.status, inserted.session, inserted.cwd,
                    key, now()
                ],
            )
        })
        .await?
        .map_err(|error| error.to_string())?;
    let mut run = run;
    enter(state, flow, &mut run, &first.id.clone()).await?;
    Ok(run)
}

/// Move `run` into stage `id` and do what that kind of stage does first.
fn enter<'a>(
    state: &'a WorkbenchState,
    flow: &'a Workflow,
    run: &'a mut Run,
    id: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let Some(stage) = flow.stages.iter().find(|stage| stage.id == id) else {
            return hold(state, run, format!("The workflow has no stage {id}")).await;
        };
        let tries = run.attempts.get(id).and_then(Value::as_u64).unwrap_or(0) + 1;
        run.attempts.insert(id.to_string(), json!(tries));
        run.stage = id.to_string();
        run.note = None;
        if let Some(limit) = stage.max_attempts.filter(|limit| *limit > 0) {
            if tries > u64::from(limit) {
                return hold(state, run, format!("{} ran {limit} times without getting through", stage.name)).await;
            }
        }
        match stage.kind {
            StageKind::Agent => {
                run.status = "running".into();
                save(state, run).await?;
                if let Some(session) = run.session.clone() {
                    tell_chat(state, &session, agent_prompt(flow, stage, &run.item)).await;
                }
                Ok(())
            }
            StageKind::Approval => {
                let message = fill(&stage.prompt, &run.item);
                hold(state, run, if message.trim().is_empty() { format!("{} needs your approval", stage.name) } else { message }).await
            }
            StageKind::Wait => {
                run.status = "waiting".into();
                save(state, run).await?;
                check(state, flow, run).await
            }
            StageKind::Command => {
                run.status = "running".into();
                save(state, run).await?;
                let cwd = run.cwd.clone().unwrap_or_else(|| run.project_path.clone());
                match shell(&cwd, &fill(&stage.prompt, &run.item)).await {
                    Ok((true, _, _)) => follow(state, flow, run, "done").await,
                    Ok((false, out, err)) => {
                        let said = if err.trim().is_empty() { out } else { err };
                        if stage.routes.iter().any(|route| route.outcome.eq_ignore_ascii_case("failed")) {
                            follow(state, flow, run, "failed").await
                        } else {
                            hold(state, run, format!("{} failed: {}", stage.name, said.trim().chars().take(300).collect::<String>())).await
                        }
                    }
                    Err(error) => hold(state, run, error).await,
                }
            }
        }
    })
}

/// Stop for the owner, saying why.
async fn hold(state: &WorkbenchState, run: &mut Run, why: String) -> Result<(), String> {
    run.status = "needs_owner".into();
    run.note = Some(why);
    save(state, run).await
}

/// Take the route for `outcome` from the run's stage; a stage with no routes
/// finishes the run.
async fn follow(state: &WorkbenchState, flow: &Workflow, run: &mut Run, outcome: &str) -> Result<(), String> {
    let Some(stage) = flow.stages.iter().find(|stage| stage.id == run.stage) else {
        return hold(state, run, format!("The workflow has no stage {}", run.stage)).await;
    };
    if stage.routes.is_empty() {
        run.status = "done".into();
        run.note = None;
        return save(state, run).await;
    }
    match stage.routes.iter().find(|route| route.outcome.trim().eq_ignore_ascii_case(outcome.trim())) {
        Some(route) => {
            let to = route.to.clone();
            enter(state, flow, run, &to).await
        }
        None => hold(state, run, format!("{} reported \"{outcome}\", which no route takes", stage.name)).await,
    }
}

/// Run a Wait stage's check and take the route whose outcome it printed.
async fn check(state: &WorkbenchState, flow: &Workflow, run: &mut Run) -> Result<(), String> {
    let Some(stage) = flow.stages.iter().find(|stage| stage.id == run.stage) else { return Ok(()) };
    let cwd = run.cwd.clone().unwrap_or_else(|| run.project_path.clone());
    let printed = match shell(&cwd, &fill(&stage.prompt, &run.item)).await {
        Ok((_, out, _)) => out,
        Err(error) => {
            run.note = Some(error);
            return save(state, run).await;
        }
    };
    let lines: Vec<&str> = printed.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let matched = stage
        .routes
        .iter()
        .find(|route| lines.iter().any(|line| line.eq_ignore_ascii_case(route.outcome.trim())))
        .map(|route| route.outcome.clone());
    match matched {
        Some(outcome) => follow(state, flow, run, &outcome).await,
        None => {
            run.note = lines.last().map(|line| format!("Last check: {line}"));
            save(state, run).await
        }
    }
}

/// The agent's messages in `session` since `after`: the newest's text and
/// the newest's row.
async fn said_since(state: &WorkbenchState, session: &str, after: i64) -> (Option<String>, i64) {
    let session = session.to_string();
    state
        .database()
        .read_tasks(move |store| {
            store
                .connection()
                .query_row(
                    "SELECT text, rowid FROM message WHERE session_id = ?1 AND role = 'assistant' AND text <> '' AND rowid > ?2
                     ORDER BY rowid DESC LIMIT 1",
                    params![session, after],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
        })
        .await
        .ok()
        .flatten()
        .map_or((None, after), |(text, row)| (Some(text), row))
}

/// A task proposal of `session` still waiting for an answer, and a task it
/// holds that waits for review.
async fn waiting_task_work(state: &WorkbenchState, project: &str, session: &str) -> (Option<i64>, Option<i64>) {
    let (project, session) = (project.to_string(), session.to_string());
    state
        .database()
        .read_tasks(move |store| {
            let connection = store.connection();
            let proposal = connection
                .query_row(
                    "SELECT id FROM task_proposal WHERE project_id = ?1 AND session_id = ?2 AND status = 'pending' ORDER BY id DESC LIMIT 1",
                    params![project, session],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            let review = connection
                .query_row(
                    "SELECT number FROM task WHERE project_id = ?1 AND session_id = ?2 AND status = 'review' ORDER BY number DESC LIMIT 1",
                    params![project, session],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            Ok((proposal, review))
        })
        .await
        .unwrap_or((None, None))
}

/// Answer for the owner through the task route, as the owner's own click does.
async fn as_owner(state: &WorkbenchState, project: &str, action: &str, number: i64, payload: Value) -> Result<(), String> {
    let request = json!({"action": action, "actor": "owner", "project": project, "number": number, "payload": payload});
    let request = serde_json::from_value(request).map_err(|error| error.to_string())?;
    super::tasks::act(State(state.clone()), Json(request))
        .await
        .map(|_| ())
        .map_err(|error| error.message)
}

/// A run's chat ended a turn: answer what the stage's switches allow, follow
/// the outcome it reported, or stop for the owner.
async fn turn_ended(state: &WorkbenchState, session: &str, ended_in: &str) {
    let runs = match runs_where(state, "session_id = ?1", session.to_string()).await {
        Ok(runs) => runs,
        Err(error) => return tracing::warn!(chat = session, %error, "workflow runs could not be read"),
    };
    for mut run in runs.into_iter().filter(|run| run.status == "running" || run.status == "needs_owner") {
        if let Err(error) = advance(state, &mut run, session, ended_in).await {
            tracing::warn!(run = run.id, %error, "a workflow run could not move on");
            let _ = hold(state, &mut run, error).await;
        }
    }
}

async fn advance(state: &WorkbenchState, run: &mut Run, session: &str, ended_in: &str) -> Result<(), String> {
    let flow = workflow(&run.project_path, &run.workflow)?;
    let Some(stage) = flow.stages.iter().find(|stage| stage.id == run.stage).cloned() else {
        return hold(state, run, format!("The workflow no longer has a stage {}", run.stage)).await;
    };
    if stage.kind != StageKind::Agent {
        return Ok(());
    }
    let (said, newest) = said_since(state, session, run.seen_message).await;
    run.seen_message = newest;
    if ended_in == "errored" {
        return hold(state, run, "The chat stopped with an error".into()).await;
    }
    if ended_in == "stopped" {
        return hold(state, run, "The chat was stopped".into()).await;
    }
    let (proposal, review) = waiting_task_work(state, &run.project_id, session).await;
    if let Some(id) = proposal {
        if !stage.auto.plan {
            return hold(state, run, "The agent proposed a task and waits for your answer".into()).await;
        }
        run.status = "running".into();
        run.note = None;
        save(state, run).await?;
        return as_owner(state, &run.project_id, "answer_proposal", id, json!({"choice": "create"})).await;
    }
    if let Some(number) = review {
        if !stage.auto.done {
            return hold(state, run, format!("Task #{number} is finished and waits for your review")).await;
        }
        run.status = "running".into();
        run.note = None;
        save(state, run).await?;
        return as_owner(state, &run.project_id, "approve", number, json!({})).await;
    }
    if let Some(outcome) = said.as_deref().and_then(reported) {
        return follow(state, &flow, run, &outcome).await;
    }
    if stage.auto.questions {
        run.status = "running".into();
        run.note = None;
        save(state, run).await?;
        let text = format!(
            "The owner is not answering questions in this stage. Use your best judgment: pick the answer that fits the ticket and the codebase, say what you chose and why, and continue.\n\n{}",
            how_to_report(&flow, &stage)
        );
        tell_chat(state, session, text).await;
        return Ok(());
    }
    hold(state, run, "The agent stopped without an outcome; it may be asking you something".into()).await
}

/// Rerun every waiting run's check, and start runs for new items of every
/// enabled schedule that is due, in one project.
async fn tick(state: &WorkbenchState, project_id: &str, project_path: &str, force: bool) -> Result<(), String> {
    for mut run in runs_where(state, "project_path = ?1", project_path.to_string()).await? {
        if run.status != "waiting" {
            continue;
        }
        let Ok(flow) = workflow(&run.project_path, &run.workflow) else { continue };
        if let Err(error) = check(state, &flow, &mut run).await {
            tracing::warn!(run = run.id, %error, "a workflow run's check failed");
        }
    }
    let Ok(data) = data_dir() else { return Ok(()) };
    let Ok(file) = workflows::read(&data, Path::new(project_path)) else { return Ok(()) };
    for flow in file.workflows.iter().filter(|flow| flow.enabled && flow.trigger.kind == TriggerKind::Schedule) {
        let key = format!("{project_path}\u{0}{}", flow.id);
        let every = Duration::from_secs(u64::from(flow.trigger.every_minutes.unwrap_or(10)) * 60);
        {
            let mut polled = POLLED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let polled = polled.get_or_insert_with(HashMap::new);
            if !force || polled.contains_key(&key) {
                if polled.get(&key).is_some_and(|last| last.elapsed() < every) {
                    continue;
                }
            }
            polled.insert(key, Instant::now());
        }
        let found = match items(project_path, flow).await {
            Ok(found) => found,
            Err(error) => {
                tracing::warn!(workflow = flow.id, %error, "a workflow schedule could not list its items");
                continue;
            }
        };
        let started: Vec<String> = runs_where(state, "project_path = ?1", project_path.to_string())
            .await?
            .into_iter()
            .filter(|run| run.workflow == flow.id)
            .map(|run| item_key(&run.item))
            .collect();
        for item in found.into_iter().filter(|item| !started.contains(&item_key(item))) {
            if let Err(error) = start_one(state, project_id, project_path, flow, item).await {
                tracing::warn!(workflow = flow.id, %error, "a scheduled workflow run could not start");
            }
        }
    }
    Ok(())
}

fn needs<'a>(value: &'a Option<String>, what: &str) -> Result<&'a str, ApiError> {
    value.as_deref().filter(|text| !text.trim().is_empty()).ok_or_else(|| ApiError::from(format!("{what} is required")))
}

/// GET /api/workbench/workflow-runs?projectPath=
pub(super) async fn list(State(state): State<WorkbenchState>, Query(listing): Query<Listing>) -> Result<Json<Value>, ApiError> {
    let runs = runs_where(&state, "project_path = ?1", listing.project_path).await.map_err(ApiError::from)?;
    Ok(Json(json!({"runs": runs.iter().map(Run::to_json).collect::<Vec<_>>()})))
}

/// POST /api/workbench/workflow-runs — `items`, `start`, `continue`, `stop`, `tick`.
pub(super) async fn act(State(state): State<WorkbenchState>, Json(ask): Json<Ask>) -> Result<Json<Value>, ApiError> {
    match ask.action.as_str() {
        "items" => {
            let path = needs(&ask.project_path, "projectPath")?;
            let flow = workflow(path, needs(&ask.workflow, "workflow")?)?;
            let found = items(path, &flow).await.map_err(|message| ApiError { status: axum::http::StatusCode::UNPROCESSABLE_ENTITY, message })?;
            Ok(Json(json!({"items": found})))
        }
        "start" => {
            let path = needs(&ask.project_path, "projectPath")?.to_string();
            let project = needs(&ask.project_id, "projectId")?.to_string();
            let flow = workflow(&path, needs(&ask.workflow, "workflow")?)?;
            if ask.items.is_empty() {
                return Err("Pick at least one item to run".to_string().into());
            }
            let mut started = Vec::new();
            for item in ask.items {
                started.push(start_one(&state, &project, &path, &flow, item).await?.to_json());
            }
            Ok(Json(json!({"runs": started})))
        }
        "continue" | "stop" => {
            let id = needs(&ask.run, "run")?;
            let mut run = run_by_id(&state, id).await?.ok_or_else(|| ApiError::not_found(format!("No run {id}")))?;
            if ask.action == "stop" {
                run.status = "stopped".into();
                run.note = None;
                save(&state, &mut run).await?;
            } else {
                if run.status != "needs_owner" {
                    return Err(format!("This run is {}, not waiting for you", run.status).into());
                }
                let flow = workflow(&run.project_path, &run.workflow)?;
                let stage = flow.stages.iter().find(|stage| stage.id == run.stage).cloned();
                match stage.map(|stage| stage.kind) {
                    Some(StageKind::Approval) => follow(&state, &flow, &mut run, "done").await?,
                    // Any other stage starts again from its prompt.
                    _ => {
                        let at = run.stage.clone();
                        if let Some(tries) = run.attempts.get_mut(&at) {
                            *tries = json!(0);
                        }
                        enter(&state, &flow, &mut run, &at).await?
                    }
                }
            }
            Ok(Json(json!({"run": run.to_json()})))
        }
        "tick" => {
            let path = needs(&ask.project_path, "projectPath")?;
            tick(&state, ask.project_id.as_deref().unwrap_or_default(), path, true).await?;
            Ok(Json(json!({"ok": true})))
        }
        other => Err(format!("Unknown action {other}").into()),
    }
}

/// Follow every run's chat: when one ends a turn, move its run on.
pub(super) fn follow_turns(state: WorkbenchState) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let mut updates = state.database().subscribe_all();
    handle.spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        let mut last = HashMap::<String, String>::new();
        loop {
            let update = match updates.recv().await {
                Ok(update) => update,
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("workflow runs fell {missed} events behind");
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            if update.event.kind != crate::workbench::protocol::EventKind::SessionState {
                continue;
            }
            let Some(now) = update.event.fields.get("state").and_then(Value::as_str) else { continue };
            let before = last.insert(update.session_id.clone(), now.to_string());
            let ended = before.as_deref().is_some_and(crate::workbench::status::is_mid_turn)
                && ["idle", "waiting_for_agents", "errored", "stopped"].contains(&now);
            if !ended {
                continue;
            }
            let moving = state.clone();
            let (session, now) = (update.session_id.clone(), now.to_string());
            tokio::spawn(async move { turn_ended(&moving, &session, &now).await });
        }
    });
}

/// Tick every registered project once a minute: Wait checks, and schedules
/// that are due.
pub fn watch(state: WorkbenchState) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(TICK);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            let projects = match state.projects() {
                Some(database) => database.get_projects_filtered(false, false).unwrap_or_default(),
                None => continue,
            };
            for project in projects {
                if let Err(error) = tick(&state, &project.id, &project.path, false).await {
                    tracing::warn!(project = project.path, %error, "workflow runs could not tick");
                }
            }
        }
    });
}
