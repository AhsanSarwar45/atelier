//! Workflow runs (docs/designs/workflows.md): a saved workflow takes an item,
//! such as a ticket, through its stages. Each run gets a worktree on the
//! item's branch and one chat. An agent stage's prompt goes to that chat, and
//! the outcome the agent reports with `atelier workflow done` (or, failing
//! that, an `Outcome:` line ending its turn) picks the next stage by the
//! workflow's routes. Wait stages rerun their check on each tick, and the
//! stage's Automatic switches answer what the owner would otherwise answer.

use super::tell::tell_chat;
use super::{ApiError, WorkbenchState};
use crate::workbench::protocol::{Command, CommandKind};
use crate::workbench::workflows::{self, Agent, Stage, StageKind, TriggerKind, Workflow};
use axum::{
    extract::{Query, State},
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a Wait check, an Items command or a Command stage may run.
const COMMAND_LIMIT: Duration = Duration::from_secs(120);
/// How often the server ticks: Wait checks, and schedules that are due.
const TICK: Duration = Duration::from_secs(60);

/// The longest `atelier workflow wait`. Anything longer is outside the stage:
/// the agent finishes it and a Wait stage after it checks.
const MAX_WAIT_MINUTES: i64 = 60;

/// Reminders a stage's agent gets in a row for turns that end without a
/// report before the run goes to the owner.
const REMINDERS: i64 = 2;

/// When each schedule last asked for items, by project folder and workflow.
static POLLED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
/// The runs whose Command stage is running in this process. A run that says
/// it is running a command but is not here lost it when the app stopped.
static COMMANDS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn command_running(run: &str, running: Option<bool>) -> bool {
    let mut held = COMMANDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let held = held.get_or_insert_with(HashSet::new);
    match running {
        Some(true) => held.insert(run.to_string()),
        Some(false) => held.remove(run),
        None => held.contains(run),
    }
}

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
    /// A manual run's own agent, instead of the workflow's.
    #[serde(default)]
    agent: Option<Agent>,
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
    /// Reminders sent in a row for turns that ended without a report.
    reminders: i64,
    note: Option<String>,
    agent: Option<Value>,
    /// What the agent reported for the current stage with `atelier workflow`:
    /// `{"outcome": …}`, `{"needs": …}` or `{"wake": ms, "for": …}`, acted on
    /// when its turn ends. A wait stays here while the run waits.
    report: Option<Value>,
}

impl Run {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "projectId": self.project_id, "projectPath": self.project_path,
            "workflow": self.workflow, "item": self.item, "stage": self.stage, "status": self.status,
            "sessionId": self.session, "cwd": self.cwd, "attempts": self.attempts, "note": self.note, "agent": self.agent,
        })
    }
}

const COLUMNS: &str =
    "id, project_id, project_path, workflow_id, item, stage, status, session_id, cwd, attempts, reminders, note, agent, report";

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
        reminders: row.get(10)?,
        note: row.get(11)?,
        agent: row.get::<_, Option<String>>(12)?.and_then(|text| serde_json::from_str(&text).ok()),
        report: row.get::<_, Option<String>>(13)?.and_then(|text| serde_json::from_str(&text).ok()),
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
                .prepare(&format!("SELECT {COLUMNS} FROM workflow_run WHERE {filter} ORDER BY created_at DESC, rowid DESC"))?;
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
                   reminders = ?7, note = ?8, updated_at = ?9, report = ?10 WHERE id = ?1",
                params![
                    run.id, run.stage, run.status, run.session, run.cwd,
                    Value::Object(run.attempts.clone()).to_string(), run.reminders, run.note, now(),
                    run.report.as_ref().map(Value::to_string)
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

/// A word the shell passes through as one argument.
fn quoted(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn how_to_report(workflow: &Workflow, stage: &Stage) -> String {
    let at = workflow.stages.iter().position(|s| s.id == stage.id).map_or(0, |at| at + 1);
    let lines: Vec<String> = outcomes(stage).iter().map(|outcome| format!("atelier workflow done {}", quoted(outcome))).collect();
    format!(
        "This chat is running the workflow \"{}\", stage \"{}\" ({at} of {}). Run `atelier workflow show` to see every stage and where each outcome leads.\n\
         Every turn must end with one of these commands. When this stage is finished, run one of these, then end your reply:\n{}\n\
         To wait for something that takes minutes, such as a review bot or CI, run `atelier workflow wait --minutes N --for \"what you wait for\"` (at most {MAX_WAIT_MINUTES}) and end your reply; you are told to check again when the time is up.\n\
         If you cannot finish without the owner, run `atelier workflow block --needs \"what you need\"` and end your reply.",
        workflow.name, stage.name, workflow.stages.len(), lines.join("\n")
    )
}

fn agent_prompt(workflow: &Workflow, stage: &Stage, item: &Value) -> String {
    format!("{}\n\n{}", fill(&stage.prompt, item), how_to_report(workflow, stage))
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

/// The agent a run uses: its own choice, else the workflow's.
fn agent_for(flow: &Workflow, chosen: Option<&Agent>) -> Result<Agent, String> {
    chosen
        .or(flow.agent.as_ref())
        .filter(|agent| !agent.brand.trim().is_empty())
        .cloned()
        .ok_or_else(|| format!("Choose an agent for {} before running it", flow.name))
}

/// Add a run for `item` to the workflow's queue; `promote` starts it when a
/// slot is free.
async fn queue(state: &WorkbenchState, project_id: &str, project_path: &str, flow: &Workflow, item: Value, agent: &Agent) -> Result<String, String> {
    let first = flow.stages.first().ok_or_else(|| format!("{} has no stages", flow.name))?;
    let id = uuid::Uuid::new_v4().to_string();
    let row = (
        id.clone(), project_id.to_string(), project_path.to_string(), flow.id.clone(), item.to_string(), item_key(&item),
        first.id.clone(), serde_json::to_string(agent).map_err(|error| error.to_string())?,
    );
    state
        .database()
        .write_tasks(move |store| {
            store.connection().execute(
                "INSERT INTO workflow_run (id, project_id, project_path, workflow_id, item, item_key, stage, status, agent, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?9)",
                params![row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, now()],
            )
        })
        .await?
        .map_err(|error| error.to_string())?;
    Ok(id)
}

/// Runs that hold one of the workflow's slots: they have a chat and are
/// working. A run waiting for the owner or on a check holds none.
fn holds_a_slot(run: &Run) -> bool {
    run.session.is_some() && run.status == "running"
}

/// One `resume` at a time.
static RESUMING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One `promote` at a time, so two never fill the same free slot.
static PROMOTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Start the workflow's queued runs, oldest first, while it has free slots.
async fn promote(state: &WorkbenchState, project_path: &str, workflow_id: &str) {
    let _one = PROMOTING.lock().await;
    let Ok(flow) = workflow(project_path, workflow_id) else { return };
    let limit = flow.max_concurrent.unwrap_or(1).max(1) as usize;
    loop {
        let Ok(mut runs) = runs_where(state, "project_path = ?1", project_path.to_string()).await else { return };
        runs.retain(|run| run.workflow == flow.id);
        if runs.iter().filter(|run| holds_a_slot(run)).count() >= limit {
            return;
        }
        // An agent whose wait is due goes first: its work is furthest along.
        if let Some(mut due) = runs.iter().rev().find(|run| wait_is_due(&flow, run)).cloned() {
            if let Err(error) = wake(state, &flow, &mut due).await {
                tracing::warn!(run = due.id, %error, "a waiting workflow run could not wake");
                let _ = hold(state, &mut due, error).await;
            }
            continue;
        }
        // Newest first from the table; the queue goes oldest first, and a run
        // the owner continued (it has its chat already) goes before new items.
        let queued: Vec<Run> = runs.into_iter().rev().filter(|run| run.status == "queued").collect();
        let Some(mut next) = queued.iter().find(|run| run.session.is_some()).or_else(|| queued.first()).cloned() else { return };
        if next.session.is_some() {
            let at = next.stage.clone();
            if let Err(error) = enter(state, &flow, &mut next, &at).await {
                tracing::warn!(run = next.id, %error, "a continued workflow run could not resume");
                let _ = hold(state, &mut next, error).await;
            }
            continue;
        }
        if let Err(error) = begin(state, &flow, &mut next).await {
            tracing::warn!(run = next.id, %error, "a queued workflow run could not start");
            next.session = None;
            let _ = hold(state, &mut next, error).await;
        }
    }
}

/// A run whose agent asked to wait with `atelier workflow wait`, and when.
fn wait_of(run: &Run) -> Option<(i64, String)> {
    let report = run.report.as_ref()?;
    let wake = report["wake"].as_i64()?;
    Some((wake, report["for"].as_str().unwrap_or_default().to_string()))
}

/// The run waits inside an agent stage and its time is up.
fn wait_is_due(flow: &Workflow, run: &Run) -> bool {
    run.status == "waiting"
        && flow.stages.iter().any(|stage| stage.id == run.stage && stage.kind == StageKind::Agent)
        && wait_of(run).is_some_and(|(wake, _)| wake <= now())
}

/// Wake an agent whose wait is due: tell its chat what to check, or send the
/// stage again when the chat is gone, as after a restart.
async fn wake(state: &WorkbenchState, flow: &Workflow, run: &mut Run) -> Result<(), String> {
    let Some(stage) = flow.stages.iter().find(|stage| stage.id == run.stage).cloned() else {
        return hold(state, run, format!("The workflow no longer has a stage {}", run.stage)).await;
    };
    let waited_for = wait_of(run).map(|(_, what)| what).unwrap_or_default();
    let session = match run.session.clone() {
        Some(session) if state.registry.has_driver(&session).await => session,
        _ => {
            let at = run.stage.clone();
            return enter(state, flow, run, &at).await;
        }
    };
    run.status = "running".into();
    run.note = None;
    run.report = None;
    save(state, run).await?;
    let text = format!("The wait is over. Check again: {waited_for}\n\n{}", how_to_report(flow, &stage));
    tell_chat(state, &session, text).await;
    Ok(())
}

/// Give a queued run its worktree and chat, and enter its first stage.
async fn begin(state: &WorkbenchState, flow: &Workflow, run: &mut Run) -> Result<(), String> {
    let first = flow.stages.first().ok_or_else(|| format!("{} has no stages", flow.name))?.id.clone();
    let agent: Agent = run
        .agent
        .clone()
        .and_then(|agent| serde_json::from_value(agent).ok())
        .map_or_else(|| agent_for(flow, None), Ok)?;
    let item = run.item.clone();
    let key = item_key(&item);
    let branch = fill(flow.setup.branch.as_deref().unwrap_or(""), &item);
    let branch = if branch.trim().is_empty() || branch.contains("{{") {
        format!("workflow/{}-{}", flow.id, key.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-"))
    } else {
        branch.trim().to_string()
    };
    let cwd = worktree(&run.project_path, &branch, flow.setup.base.as_deref()).await?;
    let session = uuid::Uuid::new_v4().to_string();
    let title = item_label(&item);
    let mut fields = Map::from_iter([
        ("sessionId".into(), json!(session)),
        ("projectId".into(), json!(run.project_id)),
        ("projectPath".into(), json!(run.project_path)),
        ("brand".into(), json!(agent.brand)),
        ("title".into(), json!(title)),
        ("cwd".into(), json!(cwd)),
    ]);
    for (key, value) in [("profileId", &agent.profile_id), ("model", &agent.model), ("effort", &agent.effort)] {
        if let Some(value) = value.as_deref().filter(|value| !value.is_empty()) {
            fields.insert(key.into(), json!(value));
        }
    }
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
    run.session = Some(session);
    run.cwd = Some(cwd);
    run.attempts = Map::new();
    run.status = "running".into();
    enter(state, flow, run, &first).await
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
        run.report = None;
        run.reminders = 0;
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
                // Marked before the row says Running, so a tick in between
                // does not take the command for lost.
                command_running(&run.id, Some(true));
                run.status = "running".into();
                if let Err(error) = save(state, run).await {
                    command_running(&run.id, Some(false));
                    return Err(error);
                }
                let cwd = run.cwd.clone().unwrap_or_else(|| run.project_path.clone());
                let ran = shell(&cwd, &fill(&stage.prompt, &run.item)).await;
                command_running(&run.id, Some(false));
                match ran {
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
    let request = json!({"action": action, "actor": "owner", "project": project, "number": number, "payload": payload, "by_workflow": true});
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
        promote(state, &run.project_path, &run.workflow).await;
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
    // A turn cut off, as when the app shuts down and stops its agents, is
    // left to the next tick: it starts a stage whose agent is gone again and
    // hands one whose agent is still there to the owner. The owner's own Stop
    // has already handed the run to them. An agent waiting on its own
    // subagents is still working: its turn ends for real later.
    if ["errored", "stopped", "waiting_for_agents"].contains(&ended_in) {
        return Ok(());
    }
    // Only what the agent reported with `atelier workflow` moves the run;
    // nothing is read from its reply.
    let report = run.report.take();
    if let Some(needs) = report.as_ref().and_then(|report| report["needs"].as_str()) {
        run.reminders = 0;
        return hold(state, run, needs.to_string()).await;
    }
    let outcome = report.as_ref().and_then(|report| report["outcome"].as_str().map(str::to_string));
    let waits = report.as_ref().filter(|report| report["wake"].is_i64()).cloned();
    let (proposal, review) = waiting_task_work(state, &run.project_id, session).await;
    if let Some(id) = proposal {
        if !stage.auto.plan {
            return hold(state, run, "The agent proposed a task and waits for your answer".into()).await;
        }
        run.status = "running".into();
        run.note = None;
        run.reminders = 0;
        run.report = report;
        save(state, run).await?;
        return as_owner(state, &run.project_id, "answer_proposal", id, json!({"choice": "create"})).await;
    }
    if let Some(number) = review {
        if !stage.auto.done {
            return hold(state, run, format!("Task #{number} is finished and waits for your review")).await;
        }
        run.status = "running".into();
        run.note = None;
        run.reminders = 0;
        save(state, run).await?;
        as_owner(state, &run.project_id, "approve", number, json!({})).await?;
        // A report made in the same turn still moves the run on.
        if let Some(waits) = waits {
            return wait(state, run, waits).await;
        }
        let Some(outcome) = outcome else { return Ok(()) };
        return follow(state, &flow, run, &outcome).await;
    }
    if let Some(waits) = waits {
        return wait(state, run, waits).await;
    }
    if let Some(outcome) = outcome {
        run.reminders = 0;
        return follow(state, &flow, run, &outcome).await;
    }
    if run.reminders >= REMINDERS {
        return hold(state, run, format!("The agent ended its turn {} times in a row without reporting the stage", REMINDERS + 1)).await;
    }
    run.reminders += 1;
    run.status = "running".into();
    run.note = None;
    save(state, run).await?;
    let decide = if stage.auto.questions {
        "The owner is not answering questions in this stage. Use your best judgment: pick the answer that fits the ticket and the codebase, say what you chose and why, and continue.\n\n"
    } else {
        "If you need the owner to answer a question, ask it with `atelier workflow block --needs`.\n\n"
    };
    let text = format!(
        "This chat ended its turn without reporting stage \"{}\" (reminder {} of {REMINDERS}). {decide}{}",
        stage.name, run.reminders, how_to_report(&flow, &stage)
    );
    tell_chat(state, session, text).await;
    Ok(())
}

/// The agent asked to wait inside its stage: the run waits without a slot
/// until the tick finds its time is up.
async fn wait(state: &WorkbenchState, run: &mut Run, waits: Value) -> Result<(), String> {
    let at = waits["wake"].as_i64().unwrap_or_else(now);
    let until = chrono::DateTime::from_timestamp_millis(at)
        .map(|time| time.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default();
    run.status = "waiting".into();
    run.note = Some(format!("Checks again at {until}: {}", waits["for"].as_str().unwrap_or_default()));
    run.reminders = 0;
    run.report = Some(waits);
    save(state, run).await
}

/// A run that says it is working on a stage whose agent or command is gone,
/// as after the app or the computer restarts. It follows an outcome the agent
/// reported before it stopped, or enters the stage again, which counts as an
/// attempt, so a stage that keeps dying goes to the owner.
async fn resume(state: &WorkbenchState, run: &mut Run) -> Result<(), String> {
    // One at a time, reading the run afresh: two ticks at once would both
    // find the agent gone while the first one's chat is still starting.
    let _one = RESUMING.lock().await;
    match run_by_id(state, &run.id).await? {
        Some(now) if now.status == "running" => *run = now,
        _ => return Ok(()),
    }
    let flow = workflow(&run.project_path, &run.workflow)?;
    let Some(stage) = flow.stages.iter().find(|stage| stage.id == run.stage).cloned() else { return Ok(()) };
    let gone = match stage.kind {
        StageKind::Agent => {
            let Some(session) = run.session.clone() else { return Ok(()) };
            if state.registry.has_driver(&session).await {
                // The agent is there; a turn it ended on an error or a stop
                // waits for the owner.
                let ended = state.database().get_session(session).await?.map(|chat| chat.state).unwrap_or_default();
                return match ended.as_str() {
                    "errored" => hold(state, run, "The chat stopped with an error".into()).await,
                    "stopped" => hold(state, run, "The chat was stopped".into()).await,
                    _ => Ok(()),
                };
            }
            true
        }
        StageKind::Command => !command_running(&run.id, None),
        StageKind::Wait | StageKind::Approval => false,
    };
    if !gone {
        return Ok(());
    }
    if let Some(outcome) = run.report.as_ref().and_then(|report| report["outcome"].as_str()).map(str::to_string) {
        return follow(state, &flow, run, &outcome).await;
    }
    let at = run.stage.clone();
    enter(state, &flow, run, &at).await
}

/// The owner stopped chat `session` by hand: a run working in it waits for
/// them instead of being started again.
pub(super) async fn stopped_by_owner(state: &WorkbenchState, session: &str) {
    let Ok(runs) = runs_where(state, "session_id = ?1", session.to_string()).await else { return };
    for mut run in runs.into_iter().filter(|run| run.status == "running") {
        let _ = hold(state, &mut run, "You stopped the chat".into()).await;
        promote(state, &run.project_path, &run.workflow).await;
    }
}

/// Rerun every waiting run's check, and start runs for new items of every
/// enabled schedule that is due, in one project.
async fn tick(state: &WorkbenchState, project_id: &str, project_path: &str, force: bool) -> Result<(), String> {
    for mut run in runs_where(state, "project_path = ?1", project_path.to_string()).await? {
        if run.status == "running" {
            if let Err(error) = resume(state, &mut run).await {
                tracing::warn!(run = run.id, %error, "a workflow run could not resume");
                let _ = hold(state, &mut run, error).await;
            }
            continue;
        }
        if run.status != "waiting" {
            continue;
        }
        let Ok(flow) = workflow(&run.project_path, &run.workflow) else { continue };
        // An agent waiting inside its stage is woken by `promote` below, once
        // its time is up and a slot is free.
        if wait_of(&run).is_some() {
            continue;
        }
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
        let agent = match agent_for(flow, None) {
            Ok(agent) => agent,
            Err(error) => {
                tracing::warn!(workflow = flow.id, %error, "a workflow schedule has no agent");
                continue;
            }
        };
        for item in found.into_iter().filter(|item| !started.contains(&item_key(item))) {
            if let Err(error) = queue(state, project_id, project_path, flow, item, &agent).await {
                tracing::warn!(workflow = flow.id, %error, "a scheduled workflow run could not be queued");
            }
        }
    }
    // Slots freed by checks above, or new runs from a schedule.
    for flow in &file.workflows {
        promote(state, project_path, &flow.id).await;
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

/// GET /api/workbench/workflow-stages — the stage each workflow chat is on, by
/// chat, for the badge a chat shows. Only runs still going: a chat whose run is
/// done or stopped is an ordinary chat again.
pub(super) async fn stages(State(state): State<WorkbenchState>) -> Result<Json<Value>, ApiError> {
    let runs = runs_where(&state, "status NOT IN ('done', 'stopped') AND session_id IS NOT NULL AND ?1 = ?1", String::new())
        .await
        .map_err(ApiError::from)?;
    let mut flows: HashMap<(String, String), Option<Workflow>> = HashMap::new();
    let mut chats = serde_json::Map::new();
    // Newest first, so a chat keeps its latest run's stage.
    for run in runs {
        let Some(session) = run.session.clone() else { continue };
        if chats.contains_key(&session) {
            continue;
        }
        let key = (run.project_path.clone(), run.workflow.clone());
        let flow = flows.entry(key).or_insert_with(|| workflow(&run.project_path, &run.workflow).ok());
        let (name, stage, step, steps) = match flow {
            Some(flow) => {
                let at = flow.stages.iter().position(|stage| stage.id == run.stage);
                let stage = at.map(|i| flow.stages[i].name.clone()).filter(|name| !name.trim().is_empty()).unwrap_or_else(|| run.stage.clone());
                (flow.name.clone(), stage, at.map(|i| i + 1), flow.stages.len())
            }
            None => (run.workflow.clone(), run.stage.clone(), None, 0),
        };
        chats.insert(session, json!({"run": run.id, "workflow": name, "stage": stage, "step": step, "steps": steps, "status": run.status}));
    }
    Ok(Json(json!({"chats": chats})))
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
            let agent = agent_for(&flow, ask.agent.as_ref())?;
            let mut ids = Vec::new();
            for item in ask.items {
                ids.push(queue(&state, &project, &path, &flow, item, &agent).await?);
            }
            promote(&state, &path, &flow.id).await;
            let mut runs = Vec::new();
            for id in ids {
                if let Some(run) = run_by_id(&state, &id).await? {
                    runs.push(run.to_json());
                }
            }
            Ok(Json(json!({"runs": runs})))
        }
        "continue" | "stop" => {
            let id = needs(&ask.run, "run")?;
            let mut run = run_by_id(&state, id).await?.ok_or_else(|| ApiError::not_found(format!("No run {id}")))?;
            if ask.action == "stop" {
                run.status = "stopped".into();
                run.note = None;
                save(&state, &mut run).await?;
            } else if run.status == "needs_owner" && run.session.is_none() {
                // It never got its chat: back in the queue.
                run.status = "queued".into();
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
                    // Any other stage starts again from its prompt, once a slot
                    // is free: a run waiting for the owner gave its slot up.
                    _ => {
                        let at = run.stage.clone();
                        if let Some(tries) = run.attempts.get_mut(&at) {
                            *tries = json!(0);
                        }
                        let limit = flow.max_concurrent.unwrap_or(1).max(1) as usize;
                        let working = runs_where(&state, "project_path = ?1", run.project_path.clone())
                            .await?
                            .iter()
                            .filter(|other| other.workflow == flow.id && other.id != run.id && holds_a_slot(other))
                            .count();
                        if working >= limit {
                            run.status = "queued".into();
                            run.note = None;
                            save(&state, &run).await?;
                        } else {
                            enter(&state, &flow, &mut run, &at).await?
                        }
                    }
                }
            }
            promote(&state, &run.project_path, &run.workflow).await;
            let run = run_by_id(&state, &run.id).await?.unwrap_or(run);
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

#[derive(Deserialize)]
pub(super) struct Report {
    action: String,
    session: String,
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default)]
    needs: Option<String>,
    #[serde(default)]
    minutes: Option<i64>,
    #[serde(default, rename = "for")]
    waiting_for: Option<String>,
}

fn refused(status: axum::http::StatusCode, message: String) -> ApiError {
    ApiError { status, message }
}

/// The task chat `session` is still working on, if any.
async fn task_in_progress(state: &WorkbenchState, project: &str, session: &str) -> Option<i64> {
    let (project, session) = (project.to_string(), session.to_string());
    state
        .database()
        .read_tasks(move |store| {
            store
                .connection()
                .query_row(
                    "SELECT number FROM task WHERE project_id = ?1 AND session_id = ?2 AND status = 'in_progress' ORDER BY number LIMIT 1",
                    params![project, session],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
        })
        .await
        .ok()
        .flatten()
}

/// POST /api/workbench/workflow-run — what `atelier workflow` sends from a
/// run's chat: `show` the workflow, `done` with an outcome, `wait` some
/// minutes inside the stage, or `block` for the owner. `done` and `wait` are
/// acted on when the chat's turn ends.
pub(super) async fn report(State(state): State<WorkbenchState>, Json(ask): Json<Report>) -> Result<Json<Value>, ApiError> {
    let runs = runs_where(&state, "session_id = ?1", ask.session.clone()).await.map_err(ApiError::from)?;
    let mut run = runs
        .into_iter()
        .find(|run| run.status == "running" || run.status == "needs_owner")
        .ok_or_else(|| ApiError::not_found("This chat is not running a workflow stage".to_string()))?;
    let flow = workflow(&run.project_path, &run.workflow)?;
    let stage = flow
        .stages
        .iter()
        .find(|stage| stage.id == run.stage)
        .cloned()
        .ok_or_else(|| ApiError::from(format!("The workflow no longer has a stage {}", run.stage)))?;
    match ask.action.as_str() {
        "show" => Ok(Json(json!({
            "workflow": flow.name,
            "item": run.item,
            "current": stage.id,
            "outcomes": outcomes(&stage),
            "status": run.status,
            "stages": flow.stages.iter().map(|stage| json!({
                "id": stage.id, "name": stage.name, "kind": stage.kind,
                "routes": stage.routes.iter().map(|route| json!({"outcome": route.outcome, "to": route.to})).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        }))),
        "done" => {
            let typed = needs(&ask.outcome, "outcome")?;
            let offered = outcomes(&stage);
            let Some(outcome) = offered.iter().find(|outcome| outcome.trim().eq_ignore_ascii_case(typed.trim())).cloned() else {
                let listed = offered.iter().map(|outcome| format!("\"{outcome}\"")).collect::<Vec<_>>().join(", ");
                return Err(refused(
                    axum::http::StatusCode::BAD_REQUEST,
                    format!("\"{typed}\" is not an outcome of stage {}. Use one of: {listed}", stage.name),
                ));
            };
            if let Some(number) = task_in_progress(&state, &run.project_id, &ask.session).await {
                return Err(refused(
                    axum::http::StatusCode::CONFLICT,
                    format!("Task #{number} is still in progress. Finish it with `atelier task done {number}` first."),
                ));
            }
            run.report = Some(json!({"outcome": outcome}));
            save(&state, &run).await?;
            Ok(Json(json!({"summary": format!("Stage {} reported \"{outcome}\". End your reply; the workflow moves on when it ends.", stage.name)})))
        }
        "wait" => {
            let minutes = ask.minutes.ok_or_else(|| ApiError::from("--minutes is required".to_string()))?;
            if !(1..=MAX_WAIT_MINUTES).contains(&minutes) {
                return Err(refused(
                    axum::http::StatusCode::BAD_REQUEST,
                    format!(
                        "Wait between 1 and {MAX_WAIT_MINUTES} minutes. For something that takes longer, such as QA testing the ticket, \
                         finish the stage with `atelier workflow done …`; a Wait stage after it checks for it. \
                         If you cannot go on without the owner, run `atelier workflow block --needs \"…\"`."
                    ),
                ));
            }
            let what = needs(&ask.waiting_for, "--for")?.trim().to_string();
            run.report = Some(json!({"wake": now() + minutes * 60_000, "for": what}));
            save(&state, &run).await?;
            Ok(Json(json!({"summary": format!(
                "The run waits {minutes} minutes for {what}. End your reply; you are told to check again when the time is up."
            )})))
        }
        "block" => {
            let why = needs(&ask.needs, "--needs")?.trim().to_string();
            run.report = Some(json!({"needs": why}));
            run.status = "needs_owner".into();
            run.note = Some(why);
            save(&state, &run).await?;
            promote(&state, &run.project_path, &run.workflow).await;
            Ok(Json(json!({"summary": "The run waits for the owner. End your reply."})))
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
