//! Shared set-up for the check-gap tests (grid column checks, grid next,
//! lock scope, proof dependencies): a store in a temporary folder,
//! a real git repository, and requests applied directly.
#![allow(dead_code)]

use std::path::Path;
use std::process::Command;

use atelier::workbench::grids::{self, search, Outcome, Request};
use atelier::workbench::store::Store;
use atelier::workbench::tasks::{self, checks::{Gate, Run}, TaskError};
use serde_json::{json, Value};

/// The app's store, and a second connection to its database for the grid
/// functions that take one (`Store::connection` is crate-private).
pub struct Db {
    pub store: Store,
    connection: rusqlite::Connection,
}

impl Db {
    pub fn connection(&self) -> &rusqlite::Connection {
        &self.connection
    }
}

pub fn store() -> (tempfile::TempDir, Db) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workbench.db");
    let store = Store::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
    (directory, Db { store, connection })
}

pub fn owner_says(store: &Db, session: &str, text: &str) {
    let count: i64 = store.connection().query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0)).unwrap();
    let id = format!("m{count}");
    store.store.open_message(session, &id, "user", &format!("2026-01-01T00:{:02}:{:02}Z", count / 60, count % 60)).unwrap();
    store.store.grow_message(session, &id, text).unwrap();
}

pub fn request(action: &str, actor: &str, session: Option<&str>, slug: &str) -> Request {
    Request {
        action: action.into(),
        actor: actor.into(),
        session: session.map(str::to_string),
        project: "p".into(),
        slug: Some(slug.into()),
        now: 1,
        ..Default::default()
    }
}

pub fn on(mut request: Request, row: &str, col: &str) -> Request {
    request.row = Some(row.into());
    request.col = Some(col.into());
    request
}

pub fn refused<T>(result: Result<T, TaskError>) -> String {
    match result {
        Err(TaskError::Refused(message)) => message,
        Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
        Ok(_) => panic!("expected a refusal, but it was accepted"),
    }
}

pub fn found(id: &str, paths: &[&str]) -> search::Found {
    search::Found { id: id.into(), name: id.to_uppercase(), paths: paths.iter().map(|p| p.to_string()).collect(), kind: "feature".into(), of: Vec::new() }
}

pub fn template(name: &str, command: &str, files: &[&str]) -> Value {
    json!({"name": name, "command": command, "kind": "test", "given": "the {row} pass", "when": "it runs", "then": "it works",
        "red": "FAILED|panicked", "files": files})
}

/// A grid approved before checks existed: columns gpu and perf with no
/// check templates, rows glare and sunstar.
pub fn grid_without_checks(store: &Db, slug: &str) {
    owner_says(store, "s1", &format!("@matrix the {slug} area"));
    let mut draft = request("draft", "agent", Some("s1"), "");
    draft.slug = None;
    draft.payload = json!({
        "slug": slug, "title": format!("Grid {slug}"), "area": "An area.",
        "row_search": {"command": "scripts/rows.sh", "watch": [format!("{slug}/")]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test"},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark"},
        ],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare", &["camera/glare.rs"]), found("sunstar", &["camera/sunstar.rs"])], head: Some("h1".into()) }));
    grids::apply(store.connection(), &draft).unwrap();
    grids::apply(store.connection(), &request("approve", "owner", None, slug)).unwrap();
}

pub fn apply(store: &Db, request: &Request) -> Result<Outcome, TaskError> {
    grids::apply(store.connection(), request)
}

// ---- git ----

pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q", "-b", "main"]);
    root
}

/// Writes `file` and commits it; returns HEAD.
pub fn commit(dir: &Path, file: &str, body: &str) -> String {
    let path = dir.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, body).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", file]);
    git(dir, &["rev-parse", "HEAD"])
}

// ---- tasks ----

/// A store whose chat s1 has the owner's `@task`, so `create` is allowed.
pub fn task_store() -> (tempfile::TempDir, Db) {
    let (directory, store) = store();
    owner_says(&store, "s1", "@task do it");
    (directory, store)
}

pub fn ask(store: &Db, action: &str, number: Option<i64>, payload: Value, gate: Option<Gate>) -> Result<tasks::Outcome, TaskError> {
    tasks::apply(&store.store, &tasks::Request {
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        number,
        payload: decided(payload),
        gate,
        now: 1,
        ..Default::default()
    })
}

/// A draft with a reason for every built-in type, for tests about something
/// else (task_types.rs tests the reasons themselves).
pub fn decided(mut payload: Value) -> Value {
    if let (Some(kind), Some(row)) = (payload["type"].as_str().map(str::to_string), payload.as_object_mut()) {
        if !row.contains_key("decisions") {
            let reasons: serde_json::Map<String, Value> = tasks::types::TYPES
                .iter()
                .map(|other| (other.name.to_string(), json!(if other.name == kind { "the work is this kind" } else { "the work is not this kind" })))
                .collect();
            row.insert("decisions".into(), Value::Object(reasons));
        }
    }
    payload
}

pub fn shell_check(name: &str, command: &str, red: &str, files: &[&str]) -> Value {
    json!({"name": name, "command": command, "kind": "test", "given": "g", "when": "w", "then": "t", "red": red, "files": files})
}

// ---- cell steps ----

/// Claims a cell with approved checks for a new task of chat s1 and starts
/// it (every check red), so the cell is at step work and may be proved.
pub fn hold(store: &Db, slug: &str, row: &str, col: &str) -> i64 {
    owner_says(store, "s1", "@task prove the cell");
    let cell = grids::CellRef { grid: slug.into(), row: row.into(), col: col.into(), reason: None };
    let checks = grids::approved_cell_checks(store.connection(), "p", &[cell]).unwrap();
    let steps: Vec<Value> = checks
        .iter()
        .enumerate()
        .map(|(index, check)| json!({"id": format!("c{index}"), "text": "Prove the cell", "checks": [check]}))
        .collect();
    let mut red = Gate::default();
    for (index, check) in checks.iter().enumerate() {
        let run = Run { command: check["command"].as_str().unwrap_or_default().into(), exit: 101, output: "test FAILED".into(),
            output_tail: "test FAILED".into(), ..Default::default() };
        red.runs.entry(format!("c{index}")).or_default().insert(check["name"].as_str().unwrap_or_default().into(), run);
    }
    let payload = json!({"type": "chore", "title": "Cell", "why": "Coverage", "plan": {"steps": steps},
        "cells": [{"grid": slug, "row": row, "col": col}]});
    let number = ask(store, "create", None, payload, None).unwrap().task.number;
    ask(store, "start", Some(number), json!({}), Some(red)).unwrap();
    number
}

/// Proves a cell with approved checks the way an agent must: claimed and
/// started first; the task is cancelled after, which keeps the proof and
/// frees the chat.
pub fn prove_held(store: &Db, slug: &str, row: &str, col: &str, print: &str) {
    let number = hold(store, slug, row, col);
    let mut prove = on(request("prove", "agent", Some("s1"), slug), row, col);
    prove.payload = json!({"summary": "s"});
    prove.checks = vec![grids::proof::CheckResult { name: col.into(), exit: 0, ms: 1, tail: String::new() }];
    prove.fingerprint = Some(print.into());
    apply(store, &prove).unwrap();
    ask(store, "cancel", Some(number), json!({"reason": "proved"}), None).unwrap();
}

/// A proof made before checks existed, with the agent's own check: kept in
/// the database as it was, at step proved.
pub fn old_proof(store: &Db, slug: &str, row: &str, col: &str, print: &str) {
    let proof = json!({"summary": "s", "checks": [{"name": "unit", "command": format!("cargo test {row}")}]});
    store.connection().execute(
        "UPDATE grid_cell SET state = 'proved', fingerprint = ?1, proof = ?2, proved_by = 's1', proved_at = 1, step = 'proved', next = 'atelier grid next ' || ?3
         WHERE project_id = 'p' AND slug = ?3 AND row = ?4 AND col = ?5",
        rusqlite::params![print, proof.to_string(), slug, row, col],
    ).unwrap();
}
