//! Tasks: work the app owns, tied to the chat session that holds it
//! (docs/tasks.md).
//!
//! Everything that changes a task goes through [`apply`], on the database
//! writer, inside one transaction, and appends one `task_event` row. The
//! route and the CLI only gather what needs the outside world first — which
//! commits exist in the session's repository, which evidence files were
//! uploaded — and hand it in.

pub mod cli;
pub mod types;

use super::store::Store;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS task (
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  created_by TEXT,
  plan TEXT NOT NULL,
  result TEXT,
  shortfalls INTEGER NOT NULL DEFAULT 0,
  blocked TEXT,
  cancel_reason TEXT,
  pending_amend TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (project_id, number)
);
CREATE INDEX IF NOT EXISTS task_by_session ON task(session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_one_in_progress ON task(session_id)
  WHERE status = 'in_progress' AND session_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS task_event (
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT,
  PRIMARY KEY (project_id, number, seq)
);
"#;

pub const AGENT_ACTIONS: &[&str] = &["create", "start", "block", "unblock", "amend", "done", "cancel", "take"];
pub const OWNER_ACTIONS: &[&str] = &["approve", "reopen", "approve_amend", "reject_amend", "cancel", "release"];
pub const STATUSES: &[&str] = &["todo", "in_progress", "blocked", "review", "done", "cancelled"];

/// When a session is deleted its open tasks become unassigned, each with a
/// `released` event. Runs inside the session delete's own transaction.
pub fn release_session(connection: &Connection, session_id: &str, now: i64) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut statement = connection.prepare(
        "SELECT project_id, number FROM task
          WHERE session_id = ?1 AND status NOT IN ('done', 'cancelled')",
    )?;
    let open: Vec<(String, i64)> = statement
        .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(statement);
    for (project, number) in &open {
        connection.execute(
            "UPDATE task SET session_id = NULL, updated_at = ?3 WHERE project_id = ?1 AND number = ?2",
            params![project, number, now],
        )?;
        append_event(connection, project, *number, now, "released", Some(session_id), "owner",
            &json!({"from": session_id, "reason": "session deleted"}))?;
    }
    Ok(open)
}

#[derive(Debug)]
pub enum TaskError {
    /// The caller asked for something the rules refuse (HTTP 400).
    Refused(String),
    /// The database failed.
    Failed(String),
}

impl From<rusqlite::Error> for TaskError {
    fn from(error: rusqlite::Error) -> Self {
        TaskError::Failed(error.to_string())
    }
}

impl From<String> for TaskError {
    fn from(message: String) -> Self {
        TaskError::Refused(message)
    }
}

impl TaskError {
    pub fn message(&self) -> &str {
        match self {
            TaskError::Refused(message) | TaskError::Failed(message) => message,
        }
    }
}

fn refuse<T>(message: impl Into<String>) -> Result<T, TaskError> {
    Err(TaskError::Refused(message.into()))
}

/// One stored task, as read.
#[derive(Clone, Debug)]
pub struct TaskRow {
    pub project_id: String,
    pub number: i64,
    pub kind: String,
    pub title: String,
    pub why: String,
    pub status: String,
    pub session_id: Option<String>,
    pub created_by: Option<String>,
    pub plan: Value,
    pub result: Option<Value>,
    pub shortfalls: bool,
    pub blocked: Option<Value>,
    pub cancel_reason: Option<String>,
    pub pending_amend: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

const COLUMNS: &str = "project_id, number, type, title, why, status, session_id, created_by, plan, result,
    shortfalls, blocked, cancel_reason, pending_amend, created_at, updated_at, started_at, finished_at";

fn json_column(row: &Row, index: usize) -> rusqlite::Result<Option<Value>> {
    Ok(row
        .get::<_, Option<String>>(index)?
        .and_then(|text| serde_json::from_str(&text).ok()))
}

fn task_row(row: &Row) -> rusqlite::Result<TaskRow> {
    Ok(TaskRow {
        project_id: row.get(0)?,
        number: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        why: row.get(4)?,
        status: row.get(5)?,
        session_id: row.get(6)?,
        created_by: row.get(7)?,
        plan: json_column(row, 8)?.unwrap_or(Value::Null),
        result: json_column(row, 9)?,
        shortfalls: row.get::<_, i64>(10)? != 0,
        blocked: json_column(row, 11)?,
        cancel_reason: row.get(12)?,
        pending_amend: json_column(row, 13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        started_at: row.get(16)?,
        finished_at: row.get(17)?,
    })
}

pub fn get(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Option<TaskRow>> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM task WHERE project_id = ?1 AND number = ?2"),
            params![project, number],
            task_row,
        )
        .optional()
}

/// A project's tasks, or one session's, newest first.
pub fn list(connection: &Connection, project: Option<&str>, session: Option<&str>) -> rusqlite::Result<Vec<TaskRow>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM task
          WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR session_id = ?2)
          ORDER BY project_id, number DESC"
    ))?;
    let rows = statement
        .query_map(params![project, session], task_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn events(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT seq, at, kind, session_id, actor, payload FROM task_event
          WHERE project_id = ?1 AND number = ?2 ORDER BY seq",
    )?;
    let rows = statement
        .query_map(params![project, number], |row| {
            Ok(json!({
                "seq": row.get::<_, i64>(0)?,
                "at": row.get::<_, i64>(1)?,
                "kind": row.get::<_, String>(2)?,
                "sessionId": row.get::<_, Option<String>>(3)?,
                "actor": row.get::<_, String>(4)?,
                "payload": json_column(row, 5)?.unwrap_or(Value::Null),
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn append_event(
    connection: &Connection,
    project: &str,
    number: i64,
    at: i64,
    kind: &str,
    session: Option<&str>,
    actor: &str,
    payload: &Value,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO task_event (project_id, number, seq, at, kind, session_id, actor, payload)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_event WHERE project_id = ?1 AND number = ?2),
                 ?3, ?4, ?5, ?6, ?7)",
        params![project, number, at, kind, session, actor, payload.to_string()],
    )?;
    Ok(())
}

fn save(connection: &Connection, task: &TaskRow) -> rusqlite::Result<()> {
    let text = |value: &Option<Value>| value.as_ref().map(Value::to_string);
    connection.execute(
        &format!(
            "INSERT OR REPLACE INTO task ({COLUMNS})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)"
        ),
        params![
            task.project_id, task.number, task.kind, task.title, task.why, task.status,
            task.session_id, task.created_by, task.plan.to_string(), text(&task.result),
            task.shortfalls as i64, text(&task.blocked), task.cancel_reason, text(&task.pending_amend),
            task.created_at, task.updated_at, task.started_at, task.finished_at,
        ],
    )?;
    Ok(())
}

/// The HTTP shape of a task (camelCase), with the holding session's name.
pub fn to_json(store: &Store, task: &TaskRow) -> Value {
    let session_title = task.session_id.as_ref().and_then(|id| {
        store
            .get_session(id)
            .ok()
            .flatten()
            .map(|session| crate::workbench::chat_name::name_session(&session))
    });
    json!({
        "projectId": task.project_id, "number": task.number, "type": task.kind,
        "title": task.title, "why": task.why, "status": task.status,
        "sessionId": task.session_id, "sessionTitle": session_title, "createdBy": task.created_by,
        "plan": task.plan, "result": task.result, "shortfalls": task.shortfalls,
        "blocked": task.blocked, "cancelReason": task.cancel_reason, "pendingAmend": task.pending_amend,
        "createdAt": task.created_at, "updatedAt": task.updated_at,
        "startedAt": task.started_at, "finishedAt": task.finished_at,
    })
}

/// Who is asking, already resolved by the route.
pub struct Request {
    pub action: String,
    /// `agent` or `owner`.
    pub actor: String,
    /// The calling session (agents), with the folder its commits are checked in.
    pub session: Option<String>,
    pub project: String,
    pub number: Option<i64>,
    pub payload: Value,
    /// Commits named in the payload that the session's repository does not
    /// have (worked out before the write, with git).
    pub missing_commits: HashSet<String>,
    /// The session's folder, for messages about missing commits.
    pub cwd: Option<String>,
    pub now: i64,
}

pub struct Outcome {
    pub task: TaskRow,
    pub summary: String,
}

fn payload_text<'a>(payload: &'a Value, key: &str, what: &str) -> Result<&'a str, TaskError> {
    match payload.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(text),
        Some(Value::String(_)) => refuse(format!("{key} is blank: {what}")),
        Some(Value::Null) | None => refuse(format!("{key} is required: {what}")),
        Some(_) => refuse(format!("{key} must be text: {what}")),
    }
}

fn held_by(task: &TaskRow, session: &str) -> Result<(), TaskError> {
    match task.session_id.as_deref() {
        Some(holder) if holder == session => Ok(()),
        Some(holder) => refuse(format!(
            "#{} is held by session {holder}, not this one; run `atelier task take {}` to move it here",
            task.number, task.number
        )),
        None => refuse(format!(
            "#{} is unassigned; run `atelier task take {}` to move it to this session",
            task.number, task.number
        )),
    }
}

fn status_is(task: &TaskRow, allowed: &[&str], action: &str) -> Result<(), TaskError> {
    if allowed.contains(&task.status.as_str()) {
        return Ok(());
    }
    refuse(format!(
        "#{} is {}; {action} needs a task that is {}",
        task.number,
        task.status,
        allowed.join(" or ")
    ))
}

fn in_progress_elsewhere(connection: &Connection, session: &str, task: &TaskRow) -> rusqlite::Result<Option<i64>> {
    connection
        .query_row(
            "SELECT number FROM task WHERE session_id = ?1 AND status = 'in_progress'
               AND NOT (project_id = ?2 AND number = ?3)",
            params![session, task.project_id, task.number],
            |row| row.get(0),
        )
        .optional()
}

fn one_in_progress(connection: &Connection, session: &str, task: &TaskRow) -> Result<(), TaskError> {
    if let Some(other) = in_progress_elsewhere(connection, session, task)? {
        return refuse(format!(
            "this session already has #{other} in progress; a session holds one in-progress task at a time. Finish, block or cancel #{other} first"
        ));
    }
    Ok(())
}

/// The shared done fields plus the type's result, checked.
fn check_done(task: &TaskRow, request: &Request) -> Result<(Value, Vec<String>), TaskError> {
    let payload = request
        .payload
        .as_object()
        .ok_or_else(|| TaskError::Refused("the done payload must be an object: {summary, commits?, followups?, result}".into()))?;
    if let Some(unknown) = payload.keys().find(|key| !["summary", "commits", "followups", "result"].contains(&key.as_str())) {
        return refuse(format!("{unknown} is not a done field (allowed: summary, commits, followups, result)"));
    }
    let summary = payload_text(&request.payload, "summary", "say in a sentence or two what was done")?;
    let kind = types::find(&task.kind).ok_or_else(|| TaskError::Refused(format!("unknown type {}", task.kind)))?;
    let commits: Vec<String> = match payload.get("commits") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                item.as_str()
                    .map(|sha| sha.trim().to_ascii_lowercase())
                    .ok_or_else(|| TaskError::Refused(format!("commits[{index}] must be a commit SHA (text)")))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return refuse("commits must be a list of commit SHAs"),
    };
    if kind.code && commits.is_empty() {
        return refuse(format!(
            "commits is required for a {} task: list the SHAs of the commits that make this change (git log --format=%H)",
            task.kind
        ));
    }
    for (index, sha) in commits.iter().enumerate() {
        if !(7..=40).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return refuse(format!("commits[{index}] \"{sha}\" is not a commit SHA (7 to 40 hex characters)"));
        }
        if request.missing_commits.contains(sha) {
            return refuse(format!(
                "commits[{index}] \"{sha}\" is not a commit in the session's repository ({}); commit the work first",
                request.cwd.as_deref().unwrap_or("unknown folder")
            ));
        }
    }
    let followups = match payload.get("followups") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return refuse("followups must be a list of {type, title, why}"),
    };
    for (index, item) in followups.iter().enumerate() {
        types::check_suggestion(item, &format!("followups[{index}]"))?;
    }
    let result = payload.get("result").filter(|value| !value.is_null()).ok_or_else(|| {
        TaskError::Refused(format!(
            "result is required: the {} result is {} (see `atelier task types {}`)",
            task.kind, kind.result, task.kind
        ))
    })?;
    let unmet = types::check_result(&task.kind, &task.plan, result)?;
    let mut stored = json!({"summary": summary, "commits": commits, "followups": followups});
    for (key, value) in result.as_object().into_iter().flatten() {
        stored[key] = value.clone();
    }
    Ok((stored, unmet))
}

/// Apply one action. Runs inside a transaction; nothing is written on refusal.
pub fn apply(store: &Store, request: &Request) -> Result<Outcome, TaskError> {
    let connection = store.connection();
    let transaction = connection.unchecked_transaction()?;
    let outcome = apply_in(&transaction, request)?;
    transaction.commit()?;
    Ok(outcome)
}

fn apply_in(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let action = request.action.as_str();
    let now = request.now;
    let owner = match request.actor.as_str() {
        "agent" => {
            if !AGENT_ACTIONS.contains(&action) {
                return refuse(format!("{action} is not an agent action (agent actions: {})", AGENT_ACTIONS.join(", ")));
            }
            false
        }
        "owner" => {
            if !OWNER_ACTIONS.contains(&action) {
                return refuse(format!("{action} is not an owner action (owner actions: {})", OWNER_ACTIONS.join(", ")));
            }
            true
        }
        other => return refuse(format!("actor must be agent or owner, not \"{other}\"")),
    };
    let caller = request.session.as_deref();
    if !owner && caller.is_none() {
        return refuse("session is required for agent actions");
    }
    let actor = request.actor.as_str();

    if action == "create" {
        let payload = request.payload.as_object().ok_or_else(|| {
            TaskError::Refused("the create payload must be an object: {type, title, why, plan}".into())
        })?;
        if let Some(unknown) = payload.keys().find(|key| !["type", "title", "why", "plan"].contains(&key.as_str())) {
            return refuse(format!("{unknown} is not a create field (allowed: type, title, why, plan)"));
        }
        let kind = payload_text(&request.payload, "type", &format!("one of {}", types::names()))?;
        if types::find(kind).is_none() {
            return refuse(format!("type \"{kind}\" is not a task type (types: {})", types::names()));
        }
        let title = payload_text(&request.payload, "title", "a short title, up to 120 characters")?;
        types::check_title(title, "title")?;
        let why = payload_text(&request.payload, "why", "one line, up to 300 characters")?;
        types::check_why(why, "why")?;
        let plan = payload.get("plan").filter(|v| !v.is_null()).ok_or_else(|| {
            TaskError::Refused(format!(
                "plan is required: the {kind} plan is {} (see `atelier task types {kind}`)",
                types::find(kind).unwrap().plan
            ))
        })?;
        types::check_plan(kind, plan)?;
        let number: i64 = connection.query_row(
            "SELECT COALESCE(MAX(number), 0) + 1 FROM task WHERE project_id = ?1",
            [&request.project],
            |row| row.get(0),
        )?;
        let task = TaskRow {
            project_id: request.project.clone(),
            number,
            kind: kind.to_string(),
            title: title.trim().to_string(),
            why: why.trim().to_string(),
            status: "todo".into(),
            session_id: caller.map(str::to_string),
            created_by: caller.map(str::to_string),
            plan: plan.clone(),
            result: None,
            shortfalls: false,
            blocked: None,
            cancel_reason: None,
            pending_amend: None,
            created_at: now,
            updated_at: now,
            started_at: None,
            finished_at: None,
        };
        save(connection, &task)?;
        append_event(connection, &task.project_id, number, now, "created", caller, actor,
            &json!({"type": task.kind, "title": task.title}))?;
        let summary = format!(
            "Created #{number} ({}): {} — todo. Start it with `atelier task start {number}`.",
            task.kind, task.title
        );
        return Ok(Outcome { task, summary });
    }

    let number = request
        .number
        .ok_or_else(|| TaskError::Refused(format!("number is required for {action}")))?;
    let mut task = get(connection, &request.project, number)?
        .ok_or_else(|| TaskError::Refused(format!("there is no task #{number} in this project")))?;
    let before_session = task.session_id.clone();
    let event_session = |task: &TaskRow| caller.map(str::to_string).or_else(|| task.session_id.clone());
    let (kind, payload, summary): (&str, Value, String) = match (owner, action) {
        (false, "start") => {
            let session = caller.unwrap();
            held_by(&task, session)?;
            if task.status == "in_progress" {
                return refuse(format!("#{number} is already in progress"));
            }
            if task.status == "blocked" {
                return refuse(format!("#{number} is blocked; run `atelier task unblock {number}` once the cause is resolved"));
            }
            status_is(&task, &["todo"], "start")?;
            one_in_progress(connection, session, &task)?;
            task.status = "in_progress".into();
            task.started_at.get_or_insert(now);
            ("started", json!({}), format!("#{number} is in progress."))
        }
        (false, "block") => {
            held_by(&task, caller.unwrap())?;
            status_is(&task, &["in_progress"], "block")?;
            let cause = payload_text(&request.payload, "cause", "what outside your control stops the work (--cause)")?;
            let needed = payload_text(&request.payload, "needed_to_resume", "what has to happen before work can resume (--needs)")?;
            let blocked = json!({"cause": cause, "needed_to_resume": needed});
            task.status = "blocked".into();
            task.blocked = Some(blocked.clone());
            ("blocked", blocked, format!("#{number} is blocked: {cause}"))
        }
        (false, "unblock") => {
            let session = caller.unwrap();
            held_by(&task, session)?;
            status_is(&task, &["blocked"], "unblock")?;
            one_in_progress(connection, session, &task)?;
            task.status = "in_progress".into();
            task.blocked = None;
            ("unblocked", json!({}), format!("#{number} is unblocked and in progress."))
        }
        (false, "amend") => {
            held_by(&task, caller.unwrap())?;
            status_is(&task, &["todo", "in_progress", "blocked"], "amend")?;
            let plan = request.payload.get("plan").filter(|v| !v.is_null()).ok_or_else(|| {
                TaskError::Refused("plan is required: amend takes {plan} with the whole new plan".into())
            })?;
            types::check_plan(&task.kind, plan)?;
            if *plan == task.plan {
                return refuse(format!("the proposed plan is the same as #{number}'s current plan"));
            }
            task.pending_amend = Some(plan.clone());
            ("amend_proposed", json!({"plan": plan}),
                format!("#{number}: plan amendment proposed; the owner approves or rejects it. `done` is checked against the approved plan."))
        }
        (false, "done") => {
            held_by(&task, caller.unwrap())?;
            status_is(&task, &["in_progress"], "done")?;
            let (result, unmet) = check_done(&task, request)?;
            let review = types::find(&task.kind).is_some_and(|kind| kind.review);
            let dropped = task.pending_amend.take();
            task.result = Some(result);
            task.shortfalls = !unmet.is_empty();
            let mut payload = json!({"unmet": unmet});
            if let Some(plan) = dropped {
                payload["droppedAmend"] = plan;
            }
            if review {
                task.status = "review".into();
                ("submitted", payload, format!("#{number} is submitted for review; the owner approves it or reopens it with a note."))
            } else {
                task.status = "done".into();
                task.finished_at = Some(now);
                let summary = if unmet.is_empty() {
                    format!("#{number} is done.")
                } else {
                    format!("#{number} is done with shortfalls: {}", unmet.join("; "))
                };
                ("done", payload, summary)
            }
        }
        (_, "cancel") => {
            if !owner {
                if let Some(holder) = task.session_id.as_deref() {
                    if Some(holder) != caller {
                        held_by(&task, caller.unwrap())?;
                    }
                }
            }
            status_is(&task, &["todo", "in_progress", "blocked", "review"], "cancel")?;
            let reason = payload_text(&request.payload, "reason", "why the task is cancelled (--reason)")?;
            task.status = "cancelled".into();
            task.cancel_reason = Some(reason.to_string());
            task.finished_at = Some(now);
            task.pending_amend = None;
            ("cancelled", json!({"reason": reason}), format!("#{number} is cancelled: {reason}"))
        }
        (false, "take") => {
            let session = caller.unwrap();
            if task.session_id.as_deref() == Some(session) {
                return refuse(format!("#{number} is already held by this session"));
            }
            status_is(&task, &["todo", "in_progress", "blocked", "review"], "take")?;
            let was = task.status.clone();
            if task.status == "in_progress" {
                task.status = "todo".into();
            }
            task.session_id = Some(session.to_string());
            let from = before_session.clone();
            let note = if was == "in_progress" { " It was in progress elsewhere and is now todo." } else { "" };
            ("taken", json!({"from": from}), format!("#{number} is now held by this session ({}).{note}", task.status))
        }
        (true, "approve") => {
            status_is(&task, &["review"], "approve")?;
            task.status = "done".into();
            task.finished_at = Some(now);
            ("approved", json!({}), format!("#{number} is approved and done."))
        }
        (true, "reopen") => {
            status_is(&task, &["review"], "reopen")?;
            let note = payload_text(&request.payload, "note", "what needs to change")?;
            // In progress again for its session, unless that session is gone or
            // already has another task in progress; then it waits as todo.
            let free = match task.session_id.as_deref() {
                Some(session) => in_progress_elsewhere(connection, session, &task)?.is_none(),
                None => false,
            };
            task.status = if free { "in_progress" } else { "todo" }.into();
            task.finished_at = None;
            ("reopened", json!({"note": note}), format!("#{number} is reopened ({}): {note}", task.status))
        }
        (true, "approve_amend") => {
            let plan = task.pending_amend.take().ok_or_else(|| {
                TaskError::Refused(format!("#{number} has no plan amendment waiting"))
            })?;
            task.plan = plan.clone();
            ("amend_approved", json!({"plan": plan}), format!("#{number}: the amended plan is approved."))
        }
        (true, "reject_amend") => {
            let plan = task.pending_amend.take().ok_or_else(|| {
                TaskError::Refused(format!("#{number} has no plan amendment waiting"))
            })?;
            let note = request.payload.get("note").and_then(Value::as_str).unwrap_or("");
            ("amend_rejected", json!({"plan": plan, "note": note}), format!("#{number}: the plan amendment is rejected."))
        }
        (true, "release") => {
            status_is(&task, &["todo", "in_progress", "blocked", "review"], "release")?;
            if task.session_id.is_none() {
                return refuse(format!("#{number} is already unassigned"));
            }
            if task.status == "in_progress" {
                task.status = "todo".into();
            }
            task.session_id = None;
            ("released", json!({"from": before_session}), format!("#{number} is unassigned."))
        }
        _ => return refuse(format!("{action} is not a task action")),
    };
    task.updated_at = now;
    let session = event_session(&task).or(before_session);
    save(connection, &task).map_err(|error| match error {
        rusqlite::Error::SqliteFailure(failure, _) if failure.code == rusqlite::ErrorCode::ConstraintViolation => {
            TaskError::Refused("this session already has a task in progress; a session holds one at a time".into())
        }
        other => other.into(),
    })?;
    append_event(connection, &task.project_id, number, now, kind, session.as_deref(), actor, &payload)?;
    Ok(Outcome { task, summary })
}

/// The `atelier-widget` block for a task card.
pub fn widget(event: &str, task: &Value) -> Result<String, String> {
    super::media::widget_block(&json!({"type": "task", "event": event, "task": task}))
}

/// Every string in a result that names an image or video, depth first.
pub fn media_strings(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) if types::looks_like_media(text) => found.push(text.trim().to_string()),
        Value::Array(items) => items.iter().for_each(|item| media_strings(item, found)),
        Value::Object(row) => row.values().for_each(|item| media_strings(item, found)),
        _ => {}
    }
}

/// Replace uploaded paths in a result with their served addresses.
pub fn replace_strings(value: &mut Value, stored: &std::collections::HashMap<String, String>) {
    match value {
        Value::String(text) => {
            if let Some(served) = stored.get(text.trim()) {
                *text = served.clone();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| replace_strings(item, stored)),
        Value::Object(row) => row.values_mut().for_each(|item| replace_strings(item, stored)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        (directory, store)
    }

    fn ask(store: &Store, actor: &str, session: Option<&str>, action: &str, number: Option<i64>, payload: Value) -> Result<Outcome, TaskError> {
        apply(store, &Request {
            action: action.into(),
            actor: actor.into(),
            session: session.map(str::to_string),
            project: "p".into(),
            number,
            payload,
            missing_commits: HashSet::new(),
            cwd: Some("/repo".into()),
            now: 1,
        })
    }

    fn agent(store: &Store, session: &str, action: &str, number: Option<i64>, payload: Value) -> Result<Outcome, TaskError> {
        ask(store, "agent", Some(session), action, number, payload)
    }

    fn owner(store: &Store, action: &str, number: i64, payload: Value) -> Result<Outcome, TaskError> {
        ask(store, "owner", None, action, Some(number), payload)
    }

    fn refused(result: Result<Outcome, TaskError>) -> String {
        match result {
            Err(TaskError::Refused(message)) => message,
            Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
            Ok(outcome) => panic!("accepted: {}", outcome.summary),
        }
    }

    fn create(store: &Store, session: &str, kind: &str) -> i64 {
        let plan = types::example(kind).unwrap()["create"]["plan"].clone();
        agent(store, session, "create", None, json!({"type": kind, "title": "T", "why": "W", "plan": plan}))
            .unwrap()
            .task
            .number
    }

    fn done_payload(kind: &str) -> Value {
        let mut done = types::example(kind).unwrap()["done"].clone();
        if done.get("commits").is_some() {
            done["commits"] = json!(["abcdef1"]);
        }
        done
    }

    #[test]
    fn numbers_count_from_one_per_project_and_every_change_is_an_event() {
        let (_d, store) = store();
        assert_eq!(create(&store, "s1", "chore"), 1);
        assert_eq!(create(&store, "s1", "chore"), 2);
        agent(&store, "s1", "start", Some(1), json!({})).unwrap();
        agent(&store, "s1", "done", Some(1), done_payload("chore")).unwrap();
        let kinds: Vec<String> = events(store.connection(), "p", 1).unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, vec!["created", "started", "done"]);
        let task = get(store.connection(), "p", 1).unwrap().unwrap();
        assert_eq!(task.status, "done");
        assert_eq!(task.result.as_ref().unwrap()["summary"], done_payload("chore")["summary"]);
        assert_eq!(task.result.as_ref().unwrap()["steps"][0]["id"], "deps");
    }

    #[test]
    fn a_session_holds_one_task_in_progress() {
        let (_d, store) = store();
        let one = create(&store, "s1", "chore");
        let two = create(&store, "s1", "chore");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let message = refused(agent(&store, "s1", "start", Some(two), json!({})));
        assert!(message.contains("already has #1 in progress"), "{message}");
        agent(&store, "s1", "block", Some(one), json!({"cause": "c", "needed_to_resume": "n"})).unwrap();
        agent(&store, "s1", "start", Some(two), json!({})).unwrap();
        let message = refused(agent(&store, "s1", "unblock", Some(one), json!({})));
        assert!(message.contains("already has #2 in progress"), "{message}");
        // Another session is not limited by this one.
        let three = create(&store, "s2", "chore");
        agent(&store, "s2", "start", Some(three), json!({})).unwrap();
    }

    #[test]
    fn transitions_are_checked() {
        let (_d, store) = store();
        let one = create(&store, "s1", "chore");
        assert!(refused(agent(&store, "s1", "done", Some(one), done_payload("chore"))).contains("#1 is todo; done needs a task that is in_progress"));
        assert!(refused(agent(&store, "s1", "block", Some(one), json!({"cause": "c", "needed_to_resume": "n"}))).contains("block needs"));
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        assert_eq!(refused(agent(&store, "s1", "block", Some(one), json!({"cause": "c"}))),
            "needed_to_resume is required: what has to happen before work can resume (--needs)");
        assert!(refused(agent(&store, "s2", "start", Some(one), json!({}))).contains("is held by session s1"));
        assert!(refused(owner(&store, "approve", one, json!({}))).contains("approve needs a task that is review"));
        assert!(refused(agent(&store, "s1", "approve", Some(one), json!({}))).contains("not an agent action"));
        assert!(refused(owner(&store, "start", one, json!({}))).contains("not an owner action"));
        agent(&store, "s1", "cancel", Some(one), json!({"reason": "r"})).unwrap();
        assert!(refused(agent(&store, "s1", "cancel", Some(one), json!({"reason": "r"}))).contains("cancel needs"));
        let two = create(&store, "s1", "chore");
        agent(&store, "s1", "start", Some(two), json!({})).unwrap();
        agent(&store, "s1", "done", Some(two), done_payload("chore")).unwrap();
        assert!(refused(owner(&store, "cancel", two, json!({"reason": "r"}))).contains("#2 is done"));
    }

    #[test]
    fn code_types_need_commits_that_exist() {
        let (_d, store) = store();
        let one = create(&store, "s1", "feature");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let mut done = done_payload("feature");
        done.as_object_mut().unwrap().remove("commits");
        assert!(refused(agent(&store, "s1", "done", Some(one), done.clone())).starts_with("commits is required for a feature task"));
        done["commits"] = json!(["xyz"]);
        assert!(refused(agent(&store, "s1", "done", Some(one), done.clone())).contains("is not a commit SHA"));
        let mut request = Request {
            action: "done".into(), actor: "agent".into(), session: Some("s1".into()), project: "p".into(),
            number: Some(one), payload: done_payload("feature"), missing_commits: HashSet::from(["abcdef1".to_string()]),
            cwd: Some("/repo".into()), now: 2,
        };
        assert!(refused(apply(&store, &request)).contains("\"abcdef1\" is not a commit in the session's repository (/repo)"));
        request.missing_commits.clear();
        let outcome = apply(&store, &request).unwrap();
        assert_eq!(outcome.task.status, "done");
        assert!(outcome.task.shortfalls, "the example misses one criterion");
        assert!(outcome.summary.contains("done with shortfalls"));
    }

    #[test]
    fn review_types_go_to_review_and_the_owner_decides() {
        let (_d, store) = store();
        let one = create(&store, "s1", "plan");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let outcome = agent(&store, "s1", "done", Some(one), done_payload("plan")).unwrap();
        assert_eq!(outcome.task.status, "review");
        assert_eq!(refused(owner(&store, "reopen", one, json!({}))), "note is required: what needs to change");
        let outcome = owner(&store, "reopen", one, json!({"note": "more detail"})).unwrap();
        assert_eq!(outcome.task.status, "in_progress");
        agent(&store, "s1", "done", Some(one), done_payload("plan")).unwrap();
        let outcome = owner(&store, "approve", one, json!({})).unwrap();
        assert_eq!(outcome.task.status, "done");
        assert!(outcome.task.finished_at.is_some());
    }

    #[test]
    fn amend_waits_for_the_owner_and_done_uses_the_approved_plan() {
        let (_d, store) = store();
        let one = create(&store, "s1", "general");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let plan = json!({"outcome": "o", "done_when": [{"id": "posted", "text": "t"}, {"id": "shared", "text": "u"}]});
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        assert!(refused(owner(&store, "approve_amend", 99, json!({}))).contains("no task #99"));
        owner(&store, "reject_amend", one, json!({"note": "no"})).unwrap();
        assert!(refused(owner(&store, "approve_amend", one, json!({}))).contains("no plan amendment waiting"));
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        owner(&store, "approve_amend", one, json!({})).unwrap();
        let message = refused(agent(&store, "s1", "done", Some(one), done_payload("general")));
        assert_eq!(message, "result.done_when does not cover plan id \"shared\": every plan id needs exactly one entry");
        assert!(refused(agent(&store, "s1", "amend", Some(one), json!({"plan": {"outcome": "o"}}))).contains("done_when is required"));
    }

    #[test]
    fn take_moves_a_task_and_an_in_progress_one_becomes_todo() {
        let (_d, store) = store();
        let one = create(&store, "s1", "chore");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let outcome = agent(&store, "s2", "take", Some(one), json!({})).unwrap();
        assert_eq!(outcome.task.status, "todo");
        assert_eq!(outcome.task.session_id.as_deref(), Some("s2"));
        assert!(refused(agent(&store, "s1", "done", Some(one), done_payload("chore"))).contains("held by session s2"));
        let outcome = owner(&store, "release", one, json!({})).unwrap();
        assert_eq!(outcome.task.session_id, None);
        assert!(refused(agent(&store, "s1", "start", Some(one), json!({}))).contains("is unassigned"));
    }

    #[test]
    fn deleting_a_session_unassigns_its_open_tasks() {
        let (_d, mut store) = store();
        let one = create(&store, "s1", "chore");
        let two = create(&store, "s1", "chore");
        agent(&store, "s1", "cancel", Some(two), json!({"reason": "r"})).unwrap();
        store.delete_session("s1").unwrap();
        assert_eq!(get(store.connection(), "p", one).unwrap().unwrap().session_id, None);
        assert_eq!(get(store.connection(), "p", two).unwrap().unwrap().session_id.as_deref(), Some("s1"));
        let last = events(store.connection(), "p", one).unwrap().pop().unwrap();
        assert_eq!(last["kind"], "released");
    }

    #[test]
    fn create_checks_its_fields() {
        let (_d, store) = store();
        assert!(refused(agent(&store, "s1", "create", None, json!({"type": "epic", "title": "t", "why": "w", "plan": {}}))).contains("\"epic\" is not a task type"));
        assert!(refused(agent(&store, "s1", "create", None, json!({"type": "chore", "title": "x".repeat(121), "why": "w", "plan": {}}))).contains("title is 121 characters"));
        assert!(refused(agent(&store, "s1", "create", None, json!({"type": "chore", "title": "t", "why": "a\nb", "plan": {}}))).contains("why must be one line"));
        assert!(refused(agent(&store, "s1", "create", None, json!({"type": "chore", "title": "t", "why": "w"}))).starts_with("plan is required"));
        assert_eq!(refused(agent(&store, "s1", "create", None, json!({"type": "chore", "title": "t", "why": "w", "plan": {"steps": [{"id": "a"}]}}))),
            "plan.steps[0] (id \"a\"): text is required (text)");
    }

    #[test]
    fn the_task_widget_is_a_valid_block() {
        let (_d, store) = store();
        let one = create(&store, "s1", "chore");
        let task = to_json(&store, &get(store.connection(), "p", one).unwrap().unwrap());
        let block = widget("create", &task).unwrap();
        let specs = super::super::media::widget_specs(&block);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0]["task"]["number"], 1);
    }
}
