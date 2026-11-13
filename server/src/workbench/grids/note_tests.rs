//! Notes: the owner or any agent can leave a note on a grid, a row, a
//! column, a cell or a task at any time, and whoever works on that cell or
//! task later sees it.

use super::*;
use crate::workbench::store::Store;
use crate::workbench::tasks;

fn store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("workbench.db")).unwrap();
    store.open_message("s1", "m0", "user", "2026-01-01T00:00:00Z").unwrap();
    store.grow_message("s1", "m0", "@matrix the camera area").unwrap();
    (directory, store)
}

fn request(action: &str, actor: &str, slug: Option<&str>) -> Request {
    Request {
        action: action.into(),
        actor: actor.into(),
        session: (actor == "agent").then(|| "s1".to_string()),
        project: "p".into(),
        slug: slug.map(str::to_string),
        now: 1,
        ..Default::default()
    }
}

fn found(id: &str) -> search::Found {
    search::Found { id: id.into(), name: id.to_uppercase(), paths: vec![format!("camera/{id}.rs")], kind: "feature".into(), of: Vec::new() }
}

/// An approved grid camera: rows glare and sunstar, columns gpu and perf, each with a check.
fn camera(store: &Store) {
    let check = |name: &str| json!([{"name": name, "command": format!("cargo test {{row}}_{name}"), "kind": "test",
        "given": "g", "when": "w", "then": "t", "red": "FAILED|panicked"}]);
    let mut draft = request("draft", "agent", None);
    draft.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": check("gpu")},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark", "checks": check("perf")},
        ],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare"), found("sunstar")], head: Some("h1".into()) }));
    apply(store.connection(), &draft).unwrap();
    apply(store.connection(), &request("approve", "owner", Some("camera"))).unwrap();
}

fn note(store: &Store, actor: &str, row: Option<&str>, col: Option<&str>, text: &str) -> Result<Outcome, TaskError> {
    let mut asked = request("note", actor, Some("camera"));
    asked.row = row.map(str::to_string);
    asked.col = col.map(str::to_string);
    asked.payload = json!({"text": text});
    apply(store.connection(), &asked)
}

fn refused<T>(result: Result<T, TaskError>) -> String {
    match result {
        Err(TaskError::Refused(message)) => message,
        Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
        Ok(_) => panic!("expected a refusal"),
    }
}

fn next(store: &Store) -> Value {
    next_batch(store.connection(), "p", "camera", &Prints::default(), &Scope::First, 2).unwrap()
}

fn cell<'a>(value: &'a Value, row: &str, col: &str) -> &'a Value {
    value["claimable"].as_array().unwrap().iter().find(|cell| cell["row"] == row && cell["col"] == col).unwrap()
}

fn texts(cell: &Value) -> Vec<(String, String)> {
    cell["notes"].as_array().unwrap_or(&Vec::new()).iter().map(|note| (note["scope"].as_str().unwrap_or("").to_string(), note["text"].as_str().unwrap_or("").to_string())).collect()
}

#[test]
fn notes_on_a_grid_row_column_and_cell_reach_the_cells_they_cover() {
    let (_d, store) = store();
    camera(&store);
    note(&store, "agent", Some("glare"), Some("gpu"), "glare's kernel reads iris.wgsl").unwrap();
    note(&store, "owner", Some("glare"), None, "glare is being rewritten in cor-x198").unwrap();
    note(&store, "agent", None, Some("gpu"), "GPU tests need the lavapipe driver on CI").unwrap();
    note(&store, "owner", None, None, "Compare against the reference renderer at 1080p").unwrap();
    let value = next(&store);
    let glare = texts(cell(&value, "glare", "gpu"));
    assert!(glare.contains(&("cell".into(), "glare's kernel reads iris.wgsl".into())), "{glare:?}");
    assert!(glare.contains(&("row".into(), "glare is being rewritten in cor-x198".into())), "{glare:?}");
    assert!(glare.contains(&("column".into(), "GPU tests need the lavapipe driver on CI".into())), "{glare:?}");
    assert!(glare.contains(&("grid".into(), "Compare against the reference renderer at 1080p".into())), "{glare:?}");
    let perf = texts(cell(&value, "glare", "perf"));
    assert!(!perf.iter().any(|(_, text)| text.contains("iris.wgsl") || text.contains("lavapipe")), "another cell's and column's notes stay out: {perf:?}");
    assert!(perf.iter().any(|(_, text)| text.contains("cor-x198")), "the row's note covers every cell in the row: {perf:?}");
}

#[test]
fn grid_next_prints_each_cells_notes() {
    let (_d, store) = store();
    camera(&store);
    note(&store, "agent", Some("glare"), Some("gpu"), "glare's kernel reads iris.wgsl").unwrap();
    let text = cli::next_text(&next(&store));
    assert!(text.contains("glare's kernel reads iris.wgsl"), "{text}");
}

#[test]
fn a_note_needs_text_and_a_target_that_exists() {
    let (_d, store) = store();
    camera(&store);
    assert!(refused(note(&store, "agent", Some("glare"), Some("gpu"), "  ")).contains("text is required"));
    assert!(refused(note(&store, "agent", Some("bloom"), None, "x")).contains("no row \"bloom\""));
    assert!(refused(note(&store, "agent", None, Some("color"), "x")).contains("no column \"color\""));
}

#[test]
fn a_task_takes_notes_from_the_owner_and_any_agent_and_shows_them() {
    let (_d, store) = store();
    store.grow_message("s1", "m0", " @task do it").unwrap();
    let check = json!({"name": "works", "command": "true", "kind": "structure", "given": "g", "when": "w", "then": "t", "red": "x", "files": []});
    let plan = json!({"outcome": "o", "done_when": [{"id": "works", "text": "it works", "checks": [check]}]});
    let created = tasks::apply(&store, &tasks::Request {
        action: "create".into(), actor: "agent".into(), session: Some("s1".into()), project: "p".into(),
        payload: json!({"type": "general", "title": "T", "why": "W", "plan": plan}), gate: Some(tasks::checks::Gate::default()), now: 1, ..Default::default()
    }).unwrap();
    let number = created.task.number;
    let note = |actor: &str, session: Option<&str>, text: &str| tasks::apply(&store, &tasks::Request {
        action: "note".into(), actor: actor.into(), session: session.map(str::to_string), project: "p".into(),
        number: Some(number), payload: json!({"text": text}), now: 2, ..Default::default()
    });
    note("agent", Some("s2"), "the export path also writes thumbnails").unwrap();
    note("owner", None, "keep the old format readable").unwrap();
    let task = tasks::get(store.connection(), "p", number).unwrap().unwrap();
    let shown = tasks::to_json(&store, &task);
    let notes: Vec<(&str, &str)> = shown["notes"].as_array().unwrap().iter().map(|n| (n["actor"].as_str().unwrap(), n["text"].as_str().unwrap())).collect();
    assert_eq!(notes, vec![("agent", "the export path also writes thumbnails"), ("owner", "keep the old format readable")]);
}
