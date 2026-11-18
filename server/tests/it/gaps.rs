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
        "files": files})
}

/// A grid made before checks existed: columns gpu and perf with no check
/// templates, rows glare and sunstar.
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
    approve_cases(store, slug);
}

/// Marks every cell of grid `slug` still at the cases steps as reviewed,
/// ready to prove, for tests of the steps after cases.
pub fn approve_cases(store: &Db, slug: &str) {
    // Rows and columns with no order get their drawn place.
    store.connection().execute_batch(&format!(
        "UPDATE grid_row SET order_seq = rowid, order_reason = 'set by the test' WHERE project_id = 'p' AND slug = '{slug}' AND order_seq IS NULL;
         UPDATE grid_column SET order_seq = position, order_reason = 'set by the test' WHERE project_id = 'p' AND slug = '{slug}' AND order_seq IS NULL;"
    )).unwrap();
    store.connection().execute(
        "UPDATE grid_cell SET case_step = 'reviewed', cases_approved = 1, step = 'reviewed',
           next = 'atelier grid prove ' || slug || ' ' || row || ' ' || col
         WHERE project_id = 'p' AND slug = ?1 AND step IN ('order', 'cases', 'reviewed')",
        rusqlite::params![slug],
    ).unwrap();
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

/// A started task of chat s1 that references a cell, its plan the cell's
/// checks (every one red). The cell itself does not change.
pub fn hold(store: &Db, slug: &str, row: &str, col: &str) -> i64 {
    owner_says(store, "s1", "@task prove the cell");
    let loaded = grids::load(store.connection(), "p", slug).unwrap().unwrap();
    let checks = loaded.cell_checks(row, col);
    let steps: Vec<Value> = checks
        .iter()
        .enumerate()
        .map(|(index, check)| json!({"id": format!("c{index}"), "text": "Prove the cell", "checks": [check]}))
        .collect();
    let mut red = Gate::default();
    for (index, check) in checks.iter().enumerate() {
        let output = match check["case"].as_str() {
            Some(case) => format!("CASE {case} FAIL - -"),
            None => "test FAILED".into(),
        };
        let run = Run { command: check["command"].as_str().unwrap_or_default().into(), exit: 101, output: output.clone(),
            output_tail: output, ..Default::default() };
        red.runs.entry(format!("c{index}")).or_default().insert(check["name"].as_str().unwrap_or_default().into(), run);
    }
    let payload = json!({"type": "chore", "title": "Cell", "why": "Coverage", "plan": {"steps": steps},
        "cells": [{"grid": slug, "row": row, "col": col}]});
    let number = ask(store, "create", None, payload, None).unwrap().task.number;
    ask(store, "start", Some(number), json!({}), Some(red)).unwrap();
    number
}

/// Proves a cell with its checks, from chat s1.
pub fn prove_held(store: &Db, slug: &str, row: &str, col: &str, print: &str) {
    let mut prove = on(request("prove", "agent", Some("s1"), slug), row, col);
    prove.payload = json!({"summary": "s"});
    prove.checks = vec![grids::proof::CheckResult { name: col.into(), exit: 0, ms: 1, tail: format!("CASE {slug}/{row}/{col}/{col} PASS - -") }];
    prove.fingerprint = Some(print.into());
    apply(store, &prove).unwrap();
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
