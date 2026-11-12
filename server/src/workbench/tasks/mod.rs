//! Tasks: work the app owns, tied to the chat session that holds it
//! (docs/tasks.md).
//!
//! Everything that changes a task goes through [`apply`], on the database
//! writer, inside one transaction, and appends one `task_event` row. The
//! route and the CLI only gather what needs the outside world first — which
//! commits exist in the session's repository, which evidence files were
//! uploaded — and hand it in.

pub mod cli;
pub mod git;
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
CREATE TABLE IF NOT EXISTS task_proposal (
  project_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  task_number INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS task_proposal_by_session ON task_proposal(session_id, status);
"#;

pub const AGENT_ACTIONS: &[&str] = &["create", "propose", "start", "check", "block", "unblock", "amend", "done", "cancel", "take"];
pub const OWNER_ACTIONS: &[&str] = &["approve", "reopen", "approve_amend", "reject_amend", "cancel", "release", "answer_proposal"];
/// The owner's three answers to a proposal (`propose`).
pub const PROPOSAL_CHOICES: &[&str] = &["create", "just_do_it", "cancel"];
pub const STATUSES: &[&str] = &["todo", "in_progress", "blocked", "review", "done", "cancelled"];

/// Create the task tables, and the column a task keeps its checked plan items
/// in (`atelier task check`), added to a database made before it.
pub fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SCHEMA)?;
    let has_checks = connection
        .prepare("SELECT 1 FROM pragma_table_info('task') WHERE name = 'checks'")?
        .exists([])?;
    if !has_checks {
        connection.execute_batch("ALTER TABLE task ADD COLUMN checks TEXT;")?;
    }
    Ok(())
}

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
    // A proposal waits on the chat that made it; with the chat gone nobody
    // would hear the owner's answer.
    connection.execute(
        "UPDATE task_proposal SET status = 'cancelled', decided_at = ?2 WHERE session_id = ?1 AND status = 'pending'",
        params![session_id, now],
    )?;
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
    /// Plan items checked while the work goes on (`atelier task check`), as a
    /// partial result: `{<result list key>: [entry, …]}` in plan order. `done`
    /// merges them into its result and clears them.
    pub checks: Option<Value>,
}

const COLUMNS: &str = "project_id, number, type, title, why, status, session_id, created_by, plan, result,
    shortfalls, blocked, cancel_reason, pending_amend, created_at, updated_at, started_at, finished_at, checks";

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
        checks: json_column(row, 18)?,
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
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)"
        ),
        params![
            task.project_id, task.number, task.kind, task.title, task.why, task.status,
            task.session_id, task.created_by, task.plan.to_string(), text(&task.result),
            task.shortfalls as i64, text(&task.blocked), task.cancel_reason, text(&task.pending_amend),
            task.created_at, task.updated_at, task.started_at, task.finished_at, text(&task.checks),
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
        "checks": task.checks,
        "cells": super::grids::task_cells(store.connection(), &task.project_id, task.number).unwrap_or_default(),
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
    /// Fingerprints, in the project's folder, of the rows of the grids whose
    /// cells the payload names: a stale proved cell may be claimed.
    pub prints: super::grids::Prints,
    pub now: i64,
}

pub struct Outcome {
    pub task: TaskRow,
    pub summary: String,
    /// The grids whose cells the change claimed or released.
    pub grids: Vec<String>,
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
    if let Some(unknown) = payload.keys().find(|key| !["summary", "commits", "followups", "result", "cells"].contains(&key.as_str())) {
        return refuse(format!("{unknown} is not a done field (allowed: summary, commits, followups, result, cells)"));
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
    let given = payload.get("result").filter(|value| !value.is_null());
    let merged = match (given, &task.checks) {
        (given, Some(checks)) => Some(merge_checks(&task.kind, &task.plan, given.cloned().unwrap_or_else(|| json!({})), checks)),
        (Some(given), None) => Some(given.clone()),
        (None, None) => None,
    };
    let result = merged.as_ref().ok_or_else(|| {
        TaskError::Refused(format!(
            "result is required: the {} result is {} (see `atelier task types {}`)",
            task.kind, kind.result, task.kind
        ))
    })?;
    let unmet = types::check_result(&task.kind, &task.plan, result).map_err(|error| {
        // Name the items still open the way the agent records them.
        if error.contains("does not cover plan id") {
            format!("{error}. Still open: {}", open_items(task, result).join(", "))
        } else {
            error
        }
    })?;
    let mut stored = json!({"summary": summary, "commits": commits, "followups": followups});
    for (key, value) in result.as_object().into_iter().flatten() {
        stored[key] = value.clone();
    }
    Ok((stored, unmet))
}

/// A done result with the entries `atelier task check` recorded added in: an
/// entry the result gives for an item wins over the recorded one. The list
/// is put in plan order. A result whose list is not a list is left for the
/// checks to refuse.
fn merge_checks(kind: &str, plan: &Value, mut result: Value, checks: &Value) -> Value {
    let Some((_, key)) = types::item_lists(kind) else { return result };
    let Some(row) = result.as_object_mut() else { return result };
    let recorded = checks[key].as_array().cloned().unwrap_or_default();
    let mut entries = match row.get(key) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return result,
    };
    let given: HashSet<String> = entries.iter().filter_map(|e| e["id"].as_str().map(str::to_string)).collect();
    entries.extend(recorded.into_iter().filter(|e| e["id"].as_str().is_some_and(|id| !given.contains(id))));
    let order = types::item_ids(kind, plan);
    entries.sort_by_key(|e| e["id"].as_str().and_then(|id| order.iter().position(|o| o == id)).unwrap_or(usize::MAX));
    row.insert(key.to_string(), Value::Array(entries));
    result
}

/// The plan ids a result (or the recorded checks) has no entry for yet.
fn open_items(task: &TaskRow, result: &Value) -> Vec<String> {
    let Some((_, key)) = types::item_lists(&task.kind) else { return Vec::new() };
    let have: HashSet<&str> = result[key].as_array().into_iter().flatten().filter_map(|e| e["id"].as_str()).collect();
    types::item_ids(&task.kind, &task.plan)
        .into_iter()
        .filter(|id| !have.contains(id.as_str()))
        .map(|id| format!("\"{id}\""))
        .collect()
}

/// Record one checked item in a task's checks, replacing an earlier entry
/// for it, in plan order. Returns how many items are recorded.
fn record_check(task: &mut TaskRow, entry: Value) -> usize {
    let Some((_, key)) = types::item_lists(&task.kind) else { return 0 };
    let id = entry["id"].as_str().unwrap_or_default().to_string();
    let mut entries: Vec<Value> = task
        .checks
        .as_ref()
        .and_then(|checks| checks[key].as_array().cloned())
        .unwrap_or_default();
    entries.retain(|e| e["id"].as_str() != Some(id.as_str()));
    entries.push(entry);
    let order = types::item_ids(&task.kind, &task.plan);
    entries.sort_by_key(|e| e["id"].as_str().and_then(|id| order.iter().position(|o| o == id)).unwrap_or(usize::MAX));
    let count = entries.len();
    task.checks = Some(json!({ key: entries }));
    count
}

/// Drop checked entries for items an approved plan no longer has.
fn prune_checks(task: &mut TaskRow) {
    let Some((_, key)) = types::item_lists(&task.kind) else {
        task.checks = None;
        return;
    };
    let ids = types::item_ids(&task.kind, &task.plan);
    let kept: Vec<Value> = task
        .checks
        .as_ref()
        .and_then(|checks| checks[key].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e["id"].as_str().is_some_and(|id| ids.iter().any(|i| i == id)))
        .collect();
    task.checks = (!kept.is_empty()).then(|| json!({ key: kept }));
}

/// A checked `{type, title, why, plan, cells?}`: what `create` and `propose` take.
pub struct Draft {
    pub kind: String,
    pub title: String,
    pub why: String,
    pub plan: Value,
    /// Grid cells the task works on, claimed when it is created.
    pub cells: Vec<super::grids::CellRef>,
}

fn check_draft(payload: &Value, action: &str) -> Result<Draft, TaskError> {
    let object = payload.as_object().ok_or_else(|| {
        TaskError::Refused(format!("the {action} payload must be an object: {{type, title, why, plan}}"))
    })?;
    if let Some(unknown) = object.keys().find(|key| !["type", "title", "why", "plan", "cells"].contains(&key.as_str())) {
        return refuse(format!("{unknown} is not a {action} field (allowed: type, title, why, plan, cells)"));
    }
    let kind = payload_text(payload, "type", &format!("one of {}", types::names()))?;
    if types::find(kind).is_none() {
        return refuse(format!("type \"{kind}\" is not a task type (types: {})", types::names()));
    }
    let title = payload_text(payload, "title", "a short title, up to 120 characters")?;
    types::check_title(title, "title")?;
    let why = payload_text(payload, "why", "one line, up to 300 characters")?;
    types::check_why(why, "why")?;
    let plan = object.get("plan").filter(|v| !v.is_null()).ok_or_else(|| {
        TaskError::Refused(format!(
            "plan is required: the {kind} plan is {} (see `atelier task types {kind}`)",
            types::find(kind).unwrap().plan
        ))
    })?;
    types::check_plan(kind, plan)?;
    let cells = super::grids::parse_cells(object.get("cells"), false)?;
    Ok(Draft { kind: kind.to_string(), title: title.trim().to_string(), why: why.trim().to_string(), plan: plan.clone(), cells })
}

fn insert_task(
    connection: &Connection,
    project: &str,
    session: Option<&str>,
    draft: &Draft,
    now: i64,
    actor: &str,
    mut payload: Value,
) -> Result<TaskRow, TaskError> {
    let number: i64 = connection.query_row(
        "SELECT COALESCE(MAX(number), 0) + 1 FROM task WHERE project_id = ?1",
        [project],
        |row| row.get(0),
    )?;
    let task = TaskRow {
        project_id: project.to_string(),
        number,
        kind: draft.kind.clone(),
        title: draft.title.clone(),
        why: draft.why.clone(),
        status: "todo".into(),
        session_id: session.map(str::to_string),
        created_by: session.map(str::to_string),
        plan: draft.plan.clone(),
        result: None,
        shortfalls: false,
        blocked: None,
        cancel_reason: None,
        pending_amend: None,
        created_at: now,
        updated_at: now,
        started_at: None,
        finished_at: None,
        checks: None,
    };
    save(connection, &task)?;
    payload["type"] = json!(task.kind);
    payload["title"] = json!(task.title);
    if !draft.cells.is_empty() {
        payload["cells"] = json!(draft.cells.iter().map(super::grids::CellRef::to_json).collect::<Vec<_>>());
    }
    append_event(connection, project, number, now, "created", session, actor, &payload)?;
    Ok(task)
}

/// Whether the owner's latest message in this chat asks for a task with a
/// bare `@task`. Only then may an agent create one; otherwise it proposes.
pub fn owner_asked_for_a_task(connection: &Connection, session: &str) -> rusqlite::Result<bool> {
    let latest: Option<String> = connection
        .query_row(
            "SELECT text FROM message WHERE session_id = ?1 AND role = 'user'
              ORDER BY at DESC, rowid DESC LIMIT 1",
            [session],
            |row| row.get(0),
        )
        .optional()?;
    Ok(latest.is_some_and(|text| {
        let words = super::metadata::persons_words(&text);
        super::references::find(&words)
            .iter()
            .any(|found| found.kind == super::references::Kind::Task && found.id.is_empty() && !found.run)
    }))
}

/* ------------------------------------------------------------------ proposals */

/// A task an agent asked the owner about (`atelier task propose`). It is not a
/// task: it has no number and is in no list until the owner says Create task.
#[derive(Clone, Debug)]
pub struct ProposalRow {
    pub project_id: String,
    pub id: i64,
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub why: String,
    pub plan: Value,
    /// `pending`, then `created`, `just_do_it` or `cancelled`.
    pub status: String,
    pub task_number: Option<i64>,
    pub created_at: i64,
    pub decided_at: Option<i64>,
    /// `[{grid, row, col}]`: the cells the task would claim.
    pub cells: Value,
}

const PROPOSAL_COLUMNS: &str =
    "project_id, id, session_id, type, title, why, plan, status, task_number, created_at, decided_at";
/// The columns read: the stored ones plus the cells.
const PROPOSAL_READ: &str =
    "project_id, id, session_id, type, title, why, plan, status, task_number, created_at, decided_at, cells";

fn proposal_row(row: &Row) -> rusqlite::Result<ProposalRow> {
    Ok(ProposalRow {
        project_id: row.get(0)?,
        id: row.get(1)?,
        session_id: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        why: row.get(5)?,
        plan: json_column(row, 6)?.unwrap_or(Value::Null),
        status: row.get(7)?,
        task_number: row.get(8)?,
        created_at: row.get(9)?,
        decided_at: row.get(10)?,
        cells: json_column(row, 11)?.unwrap_or_else(|| json!([])),
    })
}

pub fn get_proposal(connection: &Connection, project: &str, id: i64) -> rusqlite::Result<Option<ProposalRow>> {
    connection
        .query_row(
            &format!("SELECT {PROPOSAL_READ} FROM task_proposal WHERE project_id = ?1 AND id = ?2"),
            params![project, id],
            proposal_row,
        )
        .optional()
}

/// A chat's proposals still waiting for the owner, oldest first.
pub fn pending_proposals(connection: &Connection, session: &str) -> rusqlite::Result<Vec<ProposalRow>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {PROPOSAL_READ} FROM task_proposal WHERE session_id = ?1 AND status = 'pending' ORDER BY id"
    ))?;
    let rows = statement.query_map([session], proposal_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn proposal_json(proposal: &ProposalRow) -> Value {
    json!({
        "cells": proposal.cells,
        "projectId": proposal.project_id, "id": proposal.id, "sessionId": proposal.session_id,
        "type": proposal.kind, "title": proposal.title, "why": proposal.why, "plan": proposal.plan,
        "status": proposal.status, "taskNumber": proposal.task_number,
        "createdAt": proposal.created_at, "decidedAt": proposal.decided_at,
    })
}

/// The card `atelier task propose` prints: the draft and the owner's three buttons.
pub fn proposal_widget(proposal: &Value) -> Result<String, String> {
    super::media::widget_block(&json!({"type": "task", "event": "propose", "proposal": proposal}))
}

/// Store a proposal. The same checks as `create`; nothing else changes.
pub fn propose(
    store: &Store,
    project: &str,
    session: &str,
    payload: &Value,
    prints: &super::grids::Prints,
    now: i64,
) -> Result<(ProposalRow, String), TaskError> {
    let draft = check_draft(payload, "propose")?;
    let connection = store.connection();
    super::grids::check_claimable(connection, project, &draft.cells, prints)?;
    let cells = (!draft.cells.is_empty())
        .then(|| json!(draft.cells.iter().map(super::grids::CellRef::to_json).collect::<Vec<_>>()).to_string());
    let id: i64 = connection.query_row(
        "SELECT COALESCE(MAX(id), 0) + 1 FROM task_proposal WHERE project_id = ?1",
        [project],
        |row| row.get(0),
    )?;
    let proposal = ProposalRow {
        project_id: project.to_string(),
        id,
        session_id: session.to_string(),
        kind: draft.kind,
        title: draft.title,
        why: draft.why,
        plan: draft.plan,
        status: "pending".into(),
        task_number: None,
        created_at: now,
        decided_at: None,
        cells: json!(draft.cells.iter().map(super::grids::CellRef::to_json).collect::<Vec<_>>()),
    };
    connection.execute(
        &format!("INSERT INTO task_proposal ({PROPOSAL_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"),
        params![
            proposal.project_id, proposal.id, proposal.session_id, proposal.kind, proposal.title,
            proposal.why, proposal.plan.to_string(), proposal.status, proposal.task_number,
            proposal.created_at, proposal.decided_at,
        ],
    )?;
    connection.execute(
        "UPDATE task_proposal SET cells = ?3 WHERE project_id = ?1 AND id = ?2",
        params![proposal.project_id, proposal.id, cells],
    )?;
    let summary = "Proposed a task; the owner answers on the card with Create task, Just do it or Cancel. \
        Stop here and end your turn without starting the work. The owner's answer arrives as your next message."
        .to_string();
    Ok((proposal, summary))
}

/// The owner's answer to a proposal. `create` makes it a todo task in the
/// chat that proposed it; `just_do_it` and `cancel` discard it.
pub fn answer_proposal(
    store: &Store,
    project: &str,
    id: i64,
    choice: &str,
    prints: &super::grids::Prints,
    now: i64,
) -> Result<(ProposalRow, Option<TaskRow>, Vec<String>), TaskError> {
    if !PROPOSAL_CHOICES.contains(&choice) {
        return refuse(format!("choice must be one of {}, not \"{choice}\"", PROPOSAL_CHOICES.join(", ")));
    }
    let connection = store.connection();
    let transaction = connection.unchecked_transaction()?;
    let mut proposal = get_proposal(&transaction, project, id)?
        .ok_or_else(|| TaskError::Refused(format!("there is no proposal {id} in this project")))?;
    if proposal.status != "pending" {
        return refuse(format!("this proposal is already answered ({})", proposal.status.replace('_', " ")));
    }
    let mut grids = Vec::new();
    let task = if choice == "create" {
        let draft = Draft {
            kind: proposal.kind.clone(),
            title: proposal.title.clone(),
            why: proposal.why.clone(),
            plan: proposal.plan.clone(),
            cells: super::grids::parse_cells(Some(&proposal.cells), false)?,
        };
        // A cell may have been taken since the proposal was made.
        super::grids::check_claimable(&transaction, project, &draft.cells, prints).map_err(|error| match error {
            TaskError::Refused(why) => TaskError::Refused(format!("the task cannot be created: {why}")),
            other => other,
        })?;
        let task = insert_task(&transaction, project, Some(&proposal.session_id), &draft, now, "owner",
            json!({"proposal": id}))?;
        grids = super::grids::claim(&transaction, project, task.number, &draft.cells, prints, Some(&proposal.session_id), "owner", now)?;
        proposal.task_number = Some(task.number);
        proposal.status = "created".into();
        Some(task)
    } else {
        proposal.status = if choice == "cancel" { "cancelled" } else { "just_do_it" }.into();
        None
    };
    proposal.decided_at = Some(now);
    transaction.execute(
        "UPDATE task_proposal SET status = ?3, task_number = ?4, decided_at = ?5 WHERE project_id = ?1 AND id = ?2",
        params![project, id, proposal.status, proposal.task_number, proposal.decided_at],
    )?;
    transaction.commit()?;
    Ok((proposal, task, grids))
}

/// What the proposing chat's agent is told of the owner's answer.
pub fn answer_prompt(proposal: &ProposalRow) -> String {
    match (proposal.status.as_str(), proposal.task_number) {
        ("created", Some(number)) => format!(
            "Owner chose Create task for proposal \"{}\": task #{number} created. Start it with `atelier task start {number}` and do the work.",
            proposal.title
        ),
        ("just_do_it", _) => format!(
            "Owner chose Just do it for proposal \"{}\": do the work without a task.",
            proposal.title
        ),
        _ => format!("Owner chose Cancel for proposal \"{}\": don't do this work.", proposal.title),
    }
}

/// What a chat is told of its open tasks when its agent is connected: one line
/// each, or nothing when there are none.
pub fn open_section(connection: &Connection, session: &str) -> rusqlite::Result<String> {
    let mut lines = Vec::new();
    for task in list(connection, None, Some(session))?.iter().rev() {
        if ["todo", "in_progress", "blocked", "review"].contains(&task.status.as_str()) {
            lines.push(format!("#{} [{}] {}: {}", task.number, task.status, task.kind, task.title));
        }
    }
    for proposal in pending_proposals(connection, session)? {
        lines.push(format!("proposal [awaiting the owner's answer] {}: {}", proposal.kind, proposal.title));
    }
    let grid_lines = super::grids::open_lines(connection, session)?;
    let mut sections = Vec::new();
    if !lines.is_empty() {
        sections.push(format!("Your open tasks in this chat:\n{}", lines.join("\n")));
    }
    if !grid_lines.is_empty() {
        sections.push(grid_lines.join("\n"));
    }
    Ok(sections.join("\n"))
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
        let draft = check_draft(&request.payload, "create")?;
        if !owner && !owner_asked_for_a_task(connection, caller.unwrap())? {
            return refuse(
                "the owner has not asked for a task: their latest message has no @task. Do not create one yourself. \
                 Run `atelier task propose` with this same payload and stop; the owner answers Create task, Just do it or \
                 Cancel, and the answer comes back to you as a message",
            );
        }
        super::grids::check_claimable(connection, &request.project, &draft.cells, &request.prints)?;
        let task = insert_task(connection, &request.project, caller, &draft, now, actor, json!({}))?;
        let number = task.number;
        let grids =
            super::grids::claim(connection, &request.project, number, &draft.cells, &request.prints, caller, actor, now)?;
        let mut summary = format!(
            "Created #{number} ({}): {} — todo. Start it with `atelier task start {number}`.",
            task.kind, task.title
        );
        if !draft.cells.is_empty() {
            summary.push_str(&format!(
                " It claims {} grid cell{}; prove each with `atelier grid prove`, ask for N/A, or give a reason in `cells` when done.",
                draft.cells.len(),
                if draft.cells.len() == 1 { "" } else { "s" }
            ));
        }
        return Ok(Outcome { task, summary, grids });
    }
    if action == "propose" || action == "answer_proposal" {
        return refuse(format!("{action} is answered by its own route, not as a task change"));
    }

    let number = request
        .number
        .ok_or_else(|| TaskError::Refused(format!("number is required for {action}")))?;
    let mut task = get(connection, &request.project, number)?
        .ok_or_else(|| TaskError::Refused(format!("there is no task #{number} in this project")))?;
    let before_session = task.session_id.clone();
    let mut grids = Vec::new();
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
        (false, "check") => {
            held_by(&task, caller.unwrap())?;
            if task.status == "blocked" {
                return refuse(format!(
                    "#{number} is blocked; run `atelier task unblock {number}` once the cause is resolved, then check items as you meet them"
                ));
            }
            status_is(&task, &["in_progress"], "check")?;
            let item = payload_text(&request.payload, "item", "the plan item's id (atelier task check N ITEM)")?.trim().to_string();
            let given = request.payload.get("entry").filter(|v| !v.is_null()).ok_or_else(|| {
                TaskError::Refused(format!(
                    "entry is required: the item's result entry as JSON on stdin (see `atelier task types {}`)",
                    task.kind
                ))
            })?;
            let (entry, reason) = types::check_one(&task.kind, &task.plan, &item, given)?;
            let recorded = record_check(&mut task, entry.clone());
            let ids = types::item_ids(&task.kind, &task.plan);
            let have: HashSet<String> = task
                .checks
                .as_ref()
                .and_then(|checks| types::item_lists(&task.kind).and_then(|(_, key)| checks[key].as_array().cloned()))
                .unwrap_or_default()
                .iter()
                .filter_map(|e| e["id"].as_str().map(str::to_string))
                .collect();
            let open: Vec<String> = ids.iter().filter(|id| !have.contains(*id)).map(|id| format!("\"{id}\"")).collect();
            let state = match &reason {
                None => "met".to_string(),
                Some(why) => format!("not met ({why})"),
            };
            let rest = if open.is_empty() {
                format!(" All {} items are recorded; finish with `atelier task done {number}`.", ids.len())
            } else {
                format!(" {recorded} of {} recorded; still open: {}.", ids.len(), open.join(", "))
            };
            let mut payload = json!({"item": item, "met": reason.is_none(), "entry": entry});
            if let Some(why) = &reason {
                payload["reason"] = json!(why);
            }
            ("checked", payload, format!("#{number}: \"{item}\" is {state}.{rest}"))
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
            let (mut result, unmet) = check_done(&task, request)?;
            let cells = super::grids::parse_cells(request.payload.get("cells"), true)?;
            super::grids::check_done_cells(connection, &request.project, number, &cells)?;
            grids = super::grids::finish(connection, &request.project, number, &cells, caller, actor, now)?;
            if !cells.is_empty() {
                result["cells"] = json!(cells.iter().map(super::grids::CellRef::to_json).collect::<Vec<_>>());
            }
            let review = types::find(&task.kind).is_some_and(|kind| kind.review);
            let dropped = task.pending_amend.take();
            task.result = Some(result);
            task.checks = None;
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
            grids = super::grids::cancel(connection, &request.project, number, caller, actor, now)?;
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
            prune_checks(&mut task);
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
    Ok(Outcome { task, summary, grids })
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
            prints: Default::default(),
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

    /// The owner sends a message in a chat.
    fn owner_says(store: &Store, session: &str, text: &str) {
        let count: i64 = store.connection().query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0)).unwrap();
        let id = format!("m{count}");
        store.open_message(session, &id, "user", &format!("2026-01-01T00:{:02}:{:02}Z", count / 60, count % 60)).unwrap();
        store.grow_message(session, &id, text).unwrap();
    }

    fn draft(kind: &str) -> Value {
        let plan = types::example(kind).unwrap()["create"]["plan"].clone();
        json!({"type": kind, "title": "T", "why": "W", "plan": plan})
    }

    fn create(store: &Store, session: &str, kind: &str) -> i64 {
        owner_says(store, session, "@task do it");
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
            cwd: Some("/repo".into()), prints: Default::default(), now: 2,
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
        assert!(message.starts_with("result.done_when does not cover plan id \"shared\": every plan id needs exactly one entry"), "{message}");
        assert!(message.ends_with("Still open: \"shared\""), "{message}");
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
    fn an_agent_creates_a_task_only_when_the_owners_latest_message_says_task() {
        let (_d, store) = store();
        let message = refused(agent(&store, "s1", "create", None, draft("chore")));
        assert!(message.contains("atelier task propose") && message.contains("@task"), "{message}");
        owner_says(&store, "s1", "please fix the login, it loops");
        assert!(refused(agent(&store, "s1", "create", None, draft("chore"))).contains("atelier task propose"));
        owner_says(&store, "s1", "write `@task` in code, it is not a request");
        assert!(refused(agent(&store, "s1", "create", None, draft("chore"))).contains("atelier task propose"));
        owner_says(&store, "s1", "@task fix the login loop");
        agent(&store, "s1", "create", None, draft("chore")).unwrap();
        // Only the latest message counts, and only in this chat.
        assert!(refused(agent(&store, "s2", "create", None, draft("chore"))).contains("atelier task propose"));
        owner_says(&store, "s1", "thanks, now the other thing");
        assert!(refused(agent(&store, "s1", "create", None, draft("chore"))).contains("atelier task propose"));
        // What Atelier added after the owner's words is not the owner asking.
        owner_says(&store, "s1", &format!("hello{}", crate::workbench::metadata::added_by_atelier(
            crate::workbench::metadata::REFERENCES, "@task — The owner asks you to create a task")));
        assert!(refused(agent(&store, "s1", "create", None, draft("chore"))).contains("atelier task propose"));
    }

    #[test]
    fn a_proposal_waits_for_the_owner_and_create_makes_it_a_task_in_that_chat() {
        let (_d, store) = store();
        assert!(refused_proposal(propose(&store, "p", "s1", &json!({"type": "epic"}), &Default::default(), 1)).contains("not a task type"));
        let (proposal, summary) = propose(&store, "p", "s1", &draft("feature"), &Default::default(), 1).unwrap();
        assert_eq!((proposal.id, proposal.status.as_str()), (1, "pending"));
        assert!(summary.contains("Stop here"), "{summary}");
        assert!(list(store.connection(), Some("p"), None).unwrap().is_empty(), "a proposal is not a task");
        let block = proposal_widget(&proposal_json(&proposal)).unwrap();
        assert_eq!(super::super::media::widget_specs(&block)[0]["proposal"]["id"], 1);

        let (answered, task, _) = answer_proposal(&store, "p", 1, "create", &Default::default(), 2).unwrap();
        let task = task.unwrap();
        assert_eq!((task.number, task.status.as_str(), task.session_id.as_deref()), (1, "todo", Some("s1")));
        assert_eq!((answered.status.as_str(), answered.task_number), ("created", Some(1)));
        assert!(answer_prompt(&answered).starts_with("Owner chose Create task for proposal \"T\": task #1 created"));
        assert_eq!(events(store.connection(), "p", 1).unwrap()[0]["actor"], "owner");
        assert!(refused_proposal(answer_proposal(&store, "p", 1, "cancel", &Default::default(), 3)).contains("already answered"));
        // The new task is the chat's like any other.
        agent(&store, "s1", "start", Some(1), json!({})).unwrap();
    }

    #[test]
    fn just_do_it_and_cancel_discard_a_proposal() {
        let (_d, store) = store();
        propose(&store, "p", "s1", &draft("chore"), &Default::default(), 1).unwrap();
        propose(&store, "p", "s1", &draft("chore"), &Default::default(), 1).unwrap();
        assert!(refused_proposal(answer_proposal(&store, "p", 1, "maybe", &Default::default(), 2)).contains("choice must be one of"));
        let (one, task, _) = answer_proposal(&store, "p", 1, "just_do_it", &Default::default(), 2).unwrap();
        assert!(task.is_none());
        assert_eq!(answer_prompt(&one), "Owner chose Just do it for proposal \"T\": do the work without a task.");
        let (two, task, _) = answer_proposal(&store, "p", 2, "cancel", &Default::default(), 2).unwrap();
        assert!(task.is_none());
        assert_eq!(answer_prompt(&two), "Owner chose Cancel for proposal \"T\": don't do this work.");
        assert!(list(store.connection(), Some("p"), None).unwrap().is_empty());
        assert!(pending_proposals(store.connection(), "s1").unwrap().is_empty());
        assert!(refused_proposal(answer_proposal(&store, "p", 9, "create", &Default::default(), 2)).contains("no proposal 9"));
    }

    #[test]
    fn a_reconnected_chat_is_told_its_open_tasks_and_pending_proposals() {
        let (_d, store) = store();
        assert_eq!(open_section(store.connection(), "s1").unwrap(), "");
        let one = create(&store, "s1", "chore");
        let two = create(&store, "s1", "bug");
        let three = create(&store, "s1", "chore");
        create(&store, "s2", "chore");
        agent(&store, "s1", "start", Some(two), json!({})).unwrap();
        agent(&store, "s1", "cancel", Some(three), json!({"reason": "r"})).unwrap();
        propose(&store, "p", "s1", &draft("docs"), &Default::default(), 1).unwrap();
        let section = open_section(store.connection(), "s1").unwrap();
        assert_eq!(
            section,
            format!("Your open tasks in this chat:\n#{one} [todo] chore: T\n#{two} [in_progress] bug: T\nproposal [awaiting the owner's answer] docs: T")
        );
        let guidance = crate::workbench::session_policy::with_open_tasks("RULES".into(), &section);
        assert!(guidance.starts_with("RULES\n\nYour open tasks in this chat:"), "{guidance}");
        assert_eq!(crate::workbench::session_policy::with_open_tasks("RULES".into(), ""), "RULES");
    }

    fn check(store: &Store, session: &str, number: i64, item: &str, entry: Value) -> Result<Outcome, TaskError> {
        agent(store, session, "check", Some(number), json!({"item": item, "entry": entry}))
    }

    fn checks_of(store: &Store, number: i64) -> Option<Value> {
        get(store.connection(), "p", number).unwrap().unwrap().checks
    }

    #[test]
    fn check_records_one_item_and_a_rerun_replaces_it() {
        let (_d, store) = store();
        let one = create(&store, "s1", "feature");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let outcome = check(&store, "s1", one, "images", json!({"met": true, "evidence": "e2e images.spec.ts"})).unwrap();
        assert_eq!(outcome.summary, "#1: \"images\" is met. 1 of 2 recorded; still open: \"export\".");
        assert_eq!(outcome.task.status, "in_progress");
        assert!(outcome.task.result.is_none(), "a check is not a result");
        let outcome = check(&store, "s1", one, "export", json!({"id": "export", "met": false, "evidence": "no button yet", "reason": "Menu is being redrawn"})).unwrap();
        assert!(outcome.summary.contains("\"export\" is not met (Menu is being redrawn). All 2 items are recorded; finish with `atelier task done 1`"), "{}", outcome.summary);
        // Kept in plan order, whatever order they were checked in.
        let ids: Vec<String> = checks_of(&store, one).unwrap()["criteria"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["export", "images"]);
        // Running it again replaces the entry.
        check(&store, "s1", one, "export", json!({"met": true, "evidence": "chat-export.spec.ts"})).unwrap();
        let checks = checks_of(&store, one).unwrap();
        assert_eq!(checks["criteria"].as_array().unwrap().len(), 2);
        assert_eq!(checks["criteria"][0], json!({"id": "export", "met": true, "evidence": "chat-export.spec.ts"}));
        // Each check is in the history, and the HTTP shape carries the checks.
        let history = events(store.connection(), "p", one).unwrap();
        let checked: Vec<&Value> = history.iter().filter(|e| e["kind"] == "checked").collect();
        assert_eq!(checked.len(), 3);
        assert_eq!(checked[1]["payload"]["item"], "export");
        assert_eq!(checked[1]["payload"]["met"], false);
        assert_eq!(checked[1]["payload"]["reason"], "Menu is being redrawn");
        let shown = to_json(&store, &get(store.connection(), "p", one).unwrap().unwrap());
        assert_eq!(shown["checks"]["criteria"][1]["id"], "images");
        let block = widget("check", &shown).unwrap();
        assert_eq!(super::super::media::widget_specs(&block)[0]["event"], "check");
    }

    #[test]
    fn check_uses_the_types_own_entry_checks() {
        let (_d, store) = store();
        let one = create(&store, "s1", "feature");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        assert_eq!(refused(check(&store, "s1", one, "images", json!({"met": false, "evidence": "e"}))),
            "criteria entry (id \"images\"): reason is required because met is false");
        assert_eq!(refused(check(&store, "s1", one, "nope", json!({"met": true, "evidence": "e"}))),
            "\"nope\" is not an item in the plan (plan criteria ids: export, images)");
        assert!(refused(check(&store, "s1", one, "images", json!({"met": true, "evidence": "e", "extra": 1}))).contains("extra is not a field here"));
        assert!(refused(check(&store, "s1", one, "images", json!({"id": "export", "met": true, "evidence": "e"}))).contains("the command names \"images\""));
        assert!(refused(check(&store, "s1", one, "images", json!(null))).starts_with("entry is required"));
        assert!(checks_of(&store, one).is_none(), "nothing is written on refusal");
    }

    #[test]
    fn check_works_for_every_type_with_plan_items() {
        let (_d, store) = store();
        for (index, kind) in types::TYPES.iter().enumerate() {
            let session = format!("s{index}");
            let number = create(&store, &session, kind.name);
            agent(&store, &session, "start", Some(number), json!({})).unwrap();
            let example = types::example(kind.name).unwrap();
            match types::item_lists(kind.name) {
                Some((_, key)) => {
                    let mut entry = example["done"]["result"][key][0].clone();
                    if kind.name == "ui_change" {
                        entry["before"] = json!(format!("{}{}.png", types::SERVED, "a".repeat(64)));
                        entry["after"] = json!(format!("{}{}.png", types::SERVED, "b".repeat(64)));
                    }
                    let id = entry["id"].as_str().unwrap().to_string();
                    assert_eq!(example["check"]["command"], format!("atelier task check N {id}"), "{}", kind.name);
                    check(&store, &session, number, &id, entry).unwrap_or_else(|e| panic!("{}: {}", kind.name, e.message()));
                    assert_eq!(checks_of(&store, number).unwrap()[key][0]["id"], json!(id), "{}", kind.name);
                }
                None => {
                    let message = refused(check(&store, &session, number, "x", json!({})));
                    assert!(message.contains("has no plan items to check"), "{}: {message}", kind.name);
                }
            }
        }
    }

    #[test]
    fn ui_change_checks_need_stored_images() {
        let (_d, store) = store();
        let one = create(&store, "s1", "ui_change");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let message = refused(check(&store, "s1", one, "settings", json!({"before": "a.png", "after": "b.png"})));
        assert!(message.starts_with("screens entry (id \"settings\"): before must be a path to a PNG"), "{message}");
    }

    #[test]
    fn optimization_checks_work_out_met_from_the_target() {
        let (_d, store) = store();
        let one = create(&store, "s1", "optimization");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        assert_eq!(refused(check(&store, "s1", one, "p95", json!({"before": 140, "after": 120, "runs": 50}))),
            "targets entry (id \"p95\"): failure_reason is required because after 120 does not meet target 100");
        let outcome = check(&store, "s1", one, "p95", json!({"before": 140, "after": 120, "runs": 50, "failure_reason": "IO bound"})).unwrap();
        assert!(outcome.summary.contains("not met (IO bound)"), "{}", outcome.summary);
    }

    #[test]
    fn check_is_only_for_the_holding_chat_while_in_progress() {
        let (_d, store) = store();
        let one = create(&store, "s1", "chore");
        let entry = json!({"done": true, "output": "ok"});
        assert_eq!(refused(check(&store, "s1", one, "deps", entry.clone())), "#1 is todo; check needs a task that is in_progress");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        assert!(refused(check(&store, "s2", one, "deps", entry.clone())).contains("is held by session s1"));
        assert!(refused(ask(&store, "owner", None, "check", Some(one), json!({"item": "deps", "entry": entry}))).contains("not an owner action"));
        agent(&store, "s1", "block", Some(one), json!({"cause": "c", "needed_to_resume": "n"})).unwrap();
        assert!(refused(check(&store, "s1", one, "deps", entry.clone())).contains("is blocked; run `atelier task unblock 1`"));
        agent(&store, "s1", "unblock", Some(one), json!({})).unwrap();
        check(&store, "s1", one, "deps", entry.clone()).unwrap();
        agent(&store, "s1", "done", Some(one), json!({"summary": "s", "commits": ["abcdef1"]})).unwrap();
        assert!(refused(check(&store, "s1", one, "deps", entry)).contains("#1 is done; check needs"));
    }

    #[test]
    fn done_merges_checked_items_and_its_own_entries_win() {
        let (_d, store) = store();
        let one = create(&store, "s1", "feature");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        check(&store, "s1", one, "export", json!({"met": false, "evidence": "e", "reason": "later"})).unwrap();
        check(&store, "s1", one, "images", json!({"met": true, "evidence": "linked.spec.ts"})).unwrap();
        // The payload's entry for "export" wins; "images" comes from the check.
        let outcome = agent(&store, "s1", "done", Some(one), json!({"summary": "s", "commits": ["abcdef1"],
            "result": {"criteria": [{"id": "export", "met": true, "evidence": "chat-export.spec.ts"}]}})).unwrap();
        let result = outcome.task.result.unwrap();
        assert_eq!(result["criteria"], json!([
            {"id": "export", "met": true, "evidence": "chat-export.spec.ts"},
            {"id": "images", "met": true, "evidence": "linked.spec.ts"}]));
        assert!(!outcome.task.shortfalls);
        assert!(outcome.task.checks.is_none(), "the result holds them now");

        // With every item checked, done needs no result at all; a missed one is a shortfall.
        let two = create(&store, "s1", "general");
        agent(&store, "s1", "start", Some(two), json!({})).unwrap();
        check(&store, "s1", two, "posted", json!({"met": false, "evidence": "e", "reason": "site down"})).unwrap();
        let outcome = agent(&store, "s1", "done", Some(two), json!({"summary": "s"})).unwrap();
        assert!(outcome.task.shortfalls);
        assert_eq!(outcome.summary, "#2 is done with shortfalls: posted: site down");
    }

    #[test]
    fn done_is_refused_while_an_item_has_no_entry_and_names_it() {
        let (_d, store) = store();
        let one = create(&store, "s1", "general");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        let plan = json!({"outcome": "o", "done_when": [{"id": "posted", "text": "t"}, {"id": "shared", "text": "u"}, {"id": "linked", "text": "v"}]});
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        owner(&store, "approve_amend", one, json!({})).unwrap();
        check(&store, "s1", one, "shared", json!({"met": true, "evidence": "e"})).unwrap();
        let message = refused(agent(&store, "s1", "done", Some(one), json!({"summary": "s"})));
        assert!(message.contains("does not cover plan ids \"posted\", \"linked\""), "{message}");
        assert!(message.ends_with("Still open: \"posted\", \"linked\""), "{message}");
        assert!(checks_of(&store, one).is_some(), "a refused done keeps the checks");
        // A type with an item list and other fields still needs those.
        let two = create(&store, "s1", "optimization");
        agent(&store, "s1", "block", Some(one), json!({"cause": "c", "needed_to_resume": "n"})).unwrap();
        agent(&store, "s1", "start", Some(two), json!({})).unwrap();
        check(&store, "s1", two, "p95", json!({"before": 140, "after": 90, "runs": 50, "why_faster": "cached"})).unwrap();
        assert_eq!(refused(agent(&store, "s1", "done", Some(two), json!({"summary": "s", "commits": ["abcdef1"]}))),
            "result: method is required (text)");
        agent(&store, "s1", "done", Some(two), json!({"summary": "s", "commits": ["abcdef1"], "result": {"method": "Cached the fold"}})).unwrap();
    }

    #[test]
    fn an_approved_amend_drops_checks_for_removed_items_and_keeps_the_rest() {
        let (_d, store) = store();
        let one = create(&store, "s1", "general");
        agent(&store, "s1", "start", Some(one), json!({})).unwrap();
        check(&store, "s1", one, "posted", json!({"met": true, "evidence": "e"})).unwrap();
        // Proposed but not approved: nothing is dropped yet.
        let plan = json!({"outcome": "o", "done_when": [{"id": "shared", "text": "u"}]});
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        owner(&store, "reject_amend", one, json!({})).unwrap();
        assert!(checks_of(&store, one).is_some());
        let plan = json!({"outcome": "o", "done_when": [{"id": "posted", "text": "t"}, {"id": "shared", "text": "u"}]});
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        owner(&store, "approve_amend", one, json!({})).unwrap();
        assert_eq!(checks_of(&store, one).unwrap()["done_when"][0]["id"], "posted", "kept");
        let plan = json!({"outcome": "o", "done_when": [{"id": "shared", "text": "u"}]});
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        owner(&store, "approve_amend", one, json!({})).unwrap();
        assert!(checks_of(&store, one).is_none(), "posted is no longer in the plan");
        check(&store, "s1", one, "shared", json!({"met": true, "evidence": "e"})).unwrap();
        assert!(refused(owner(&store, "approve_amend", one, json!({}))).contains("no plan amendment waiting"));
        let plan = json!({"outcome": "o", "done_when": [{"id": "shared", "text": "u"}, {"id": "new", "text": "w"}]});
        agent(&store, "s1", "amend", Some(one), json!({"plan": plan})).unwrap();
        owner(&store, "approve_amend", one, json!({})).unwrap();
        assert_eq!(checks_of(&store, one).unwrap()["done_when"], json!([{"id": "shared", "met": true, "evidence": "e"}]));
    }

    fn refused_proposal<T>(result: Result<T, TaskError>) -> String {
        match result {
            Err(TaskError::Refused(message)) => message,
            Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
            Ok(_) => panic!("accepted"),
        }
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
