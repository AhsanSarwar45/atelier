//! The grid model's rules (docs/grids.md, "Tests"), in the style of the
//! tasks tests: a store in a temporary folder, requests applied directly.

use super::proof::tests::{commit_file, repository};
use super::*;
use crate::workbench::store::Store;
use crate::workbench::tasks;

fn store() -> (tempfile::TempDir, Store) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(&directory.path().join("workbench.db")).unwrap();
    (directory, store)
}

fn owner_says(store: &Store, session: &str, text: &str) {
    let count: i64 = store.connection().query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0)).unwrap();
    let id = format!("m{count}");
    store.open_message(session, &id, "user", &format!("2026-01-01T00:{:02}:{:02}Z", count / 60, count % 60)).unwrap();
    store.grow_message(session, &id, text).unwrap();
}

fn request(action: &str, actor: &str, session: Option<&str>, slug: &str) -> Request {
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

fn on(mut request: Request, row: &str, col: &str) -> Request {
    request.row = Some(row.into());
    request.col = Some(col.into());
    request
}

fn refused(result: Result<Outcome, TaskError>) -> String {
    match result {
        Err(TaskError::Refused(message)) => message,
        Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
        Ok(outcome) => panic!("expected a refusal, got: {}", outcome.summary),
    }
}

fn found(id: &str, paths: &[&str]) -> search::Found {
    search::Found {
        id: id.into(),
        name: id.to_uppercase(),
        paths: paths.iter().map(|p| p.to_string()).collect(),
        kind: "feature".into(),
        of: Vec::new(),
    }
}

fn ran(rows: Vec<search::Found>) -> Option<Result<search::Run, String>> {
    Some(Ok(search::Run { rows, head: Some("h1".into()) }))
}

fn draft_payload(slug: &str) -> Value {
    json!({
        "slug": slug, "title": format!("Grid {slug}"), "area": "An area.",
        "row_search": {"command": "scripts/rows.sh", "watch": [format!("{slug}/")]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": [{"name": "gpu", "command": "cargo test {row}_on_gpu", "kind": "test",
                "given": "the {row} pass", "when": "it renders", "then": "it ran on the GPU", "red": "FAILED|panicked"}]},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark check", "checks": [{"name": "perf", "command": "cargo test {row}_in_budget", "kind": "test",
                "given": "the {row} pass", "when": "it renders", "then": "it is within budget", "red": "FAILED|panicked"}]},
        ],
    })
}

fn draft(store: &Store, session: &str, payload: Value, rows: Vec<search::Found>) -> Result<Outcome, TaskError> {
    let mut asked = request("draft", "agent", Some(session), "");
    asked.slug = None;
    asked.payload = payload;
    asked.search = ran(rows);
    apply(store.connection(), &asked)
}

/// An approved grid `slug` with rows glare and sunstar (or those given) and columns gpu and perf.
fn approved(store: &Store, session: &str, slug: &str, rows: Vec<search::Found>) {
    owner_says(store, session, &format!("@matrix the {slug} area"));
    draft(store, session, draft_payload(slug), rows).unwrap();
    apply(store.connection(), &request("approve", "owner", None, slug)).unwrap();
}

fn camera(store: &Store) {
    approved(store, "s1", "camera", vec![found("glare", &["camera/glare.rs"]), found("sunstar", &["camera/sunstar.rs"])]);
}

fn state(store: &Store, slug: &str, row: &str, col: &str) -> Cell {
    get_cell(store.connection(), "p", slug, row, col).unwrap().unwrap()
}

fn passing() -> Vec<proof::CheckResult> {
    vec![proof::CheckResult { name: "unit".into(), exit: 0, ms: 5, tail: String::new() }]
}

fn proof_payload() -> Value {
    json!({"summary": "glare matches the reference", "checks": [{"name": "unit", "command": "true"}]})
}

fn prove(store: &Store, session: &str, slug: &str, row: &str, col: &str, print: &str) -> Result<Outcome, TaskError> {
    let mut asked = on(request("prove", "agent", Some(session), slug), row, col);
    asked.payload = proof_payload();
    asked.checks = passing();
    asked.fingerprint = Some(print.into());
    asked.head = Some("h1".into());
    apply(store.connection(), &asked)
}

fn task_create(store: &Store, session: &str, cells: Value, prints: Prints) -> Result<tasks::Outcome, TaskError> {
    owner_says(store, session, "@task do these cells");
    let plan = cell_plan(store, &cells);
    tasks::apply(store, &tasks::Request {
        gate: None,
        action: "create".into(),
        actor: "agent".into(),
        session: Some(session.into()),
        project: "p".into(),
        number: None,
        payload: json!({"type": "chore", "title": "Cells", "why": "Coverage", "plan": plan, "cells": cells}),
        missing_commits: Default::default(),
        cwd: Some("/repo".into()),
        visual_files: Vec::new(),
        prints,
        now: 2,
    })
}

fn task(store: &Store, session: Option<&str>, actor: &str, action: &str, number: i64, payload: Value) -> Result<tasks::Outcome, TaskError> {
    tasks::apply(store, &tasks::Request {
        gate: None,
        action: action.into(),
        actor: actor.into(),
        session: session.map(str::to_string),
        project: "p".into(),
        number: Some(number),
        payload,
        missing_commits: Default::default(),
        cwd: Some("/repo".into()),
        visual_files: Vec::new(),
        prints: Default::default(),
        now: 3,
    })
}

fn task_refused<T>(result: Result<T, TaskError>) -> String {
    match result {
        Err(error) => error.message().to_string(),
        Ok(_) => panic!("expected a refusal"),
    }
}

/// A chore plan with the cells' own approved checks, one step each, as
/// `grid next` gives them.
fn cell_plan(store: &Store, cells: &Value) -> Value {
    let picked = parse_cells(Some(cells), false).unwrap_or_default();
    let approved = approved_cell_checks(store.connection(), "p", &picked).unwrap_or_default();
    let mut steps: Vec<Value> = approved
        .iter()
        .enumerate()
        .map(|(index, check)| json!({"id": format!("c{index}"), "text": "Prove the cell", "checks": [check]}))
        .collect();
    if steps.is_empty() {
        steps.push(json!({"id": "c0", "text": "Prove the cells", "checks": [crate::workbench::tasks::checks::tests::sample("c0")]}));
    }
    json!({"steps": steps})
}

fn chore_done(cells: Value) -> Value {
    let mut done = tasks::types::example("chore").unwrap()["done"].clone();
    done["commits"] = json!(["abcdef1"]);
    done["cells"] = cells;
    done
}

#[test]
fn a_draft_is_what_the_row_search_prints_plus_manual_rows() {
    let (_d, store) = store();
    owner_says(&store, "s1", "@matrix the camera");
    let mut payload = draft_payload("camera");
    payload["rows"] = json!([
        {"id": "glare_x_sunstar", "name": "Glare × sunstar", "kind": "combination", "of": ["glare", "sunstar"]},
    ]);
    let outcome = draft(&store, "s1", payload.clone(), vec![found("glare", &["camera/glare.rs"]), found("sunstar", &["camera/sunstar.rs"])]).unwrap();
    assert_eq!(outcome.widget, Some("draft"));
    let grid = get_grid(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(grid.status, "draft");
    let pending = grid.pending.unwrap();
    let ids: Vec<_> = pending["rows"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().to_string(), r["source"].as_str().unwrap().to_string())).collect();
    assert_eq!(ids, [("glare".into(), "search".into()), ("sunstar".into(), "search".into()), ("glare_x_sunstar".into(), "manual".into())]);
    // A manual id the search also prints is refused, and so is a failed search.
    payload["rows"] = json!([{"id": "glare", "name": "Glare"}]);
    assert!(refused(draft(&store, "s1", payload.clone(), vec![found("glare", &[])])).contains("which the row search also prints"));
    let mut asked = request("draft", "agent", Some("s1"), "");
    asked.payload = draft_payload("camera");
    asked.search = Some(Err("the row search exited 2".into()));
    assert!(refused(apply(store.connection(), &asked)).contains("row_search failed"));
    // A combination naming a row that is not there.
    payload["rows"] = json!([{"id": "combo", "name": "C", "kind": "combination", "of": ["glare", "ghost"]}]);
    assert!(refused(draft(&store, "s1", payload, vec![found("glare", &[])])).contains("not another row of this draft"));
    // No columns at all.
    let mut bare = draft_payload("camera");
    bare["columns"] = json!([]);
    assert!(refused(draft(&store, "s1", bare, vec![found("glare", &[])])).contains("no columns"));
}

#[test]
fn a_new_grid_may_be_drafted_without_matrix_but_not_over_another_chats_draft() {
    let (_d, store) = store();
    owner_says(&store, "s1", "make a grid of the camera please");
    draft(&store, "s1", draft_payload("camera"), vec![found("glare", &[])]).unwrap();
    // Redrafting its own draft is fine; another chat may not take it, and is told what to do.
    owner_says(&store, "s1", "add sunstar too");
    draft(&store, "s1", draft_payload("camera"), vec![found("glare", &[]), found("sunstar", &[])]).unwrap();
    let refusal = refused(draft(&store, "s2", draft_payload("camera"), vec![found("glare", &[])]));
    assert!(refusal.contains("draft by another chat") && refusal.contains("Pick another slug"), "{refusal}");
    assert!(may_draft(store.connection(), "p", "s2", "camera").is_err());
    // A discarded draft's slug can be drafted again, by any chat.
    apply(store.connection(), &request("discard", "owner", None, "camera")).unwrap();
    assert_eq!(get_grid(store.connection(), "p", "camera").unwrap().unwrap().status, "discarded");
    draft(&store, "s2", draft_payload("camera"), vec![found("glare", &[])]).unwrap();
}

#[test]
fn approving_writes_rows_columns_and_unchecked_cells() {
    let (_d, store) = store();
    owner_says(&store, "s1", "@matrix camera");
    draft(&store, "s1", draft_payload("camera"), vec![found("glare", &["camera/glare.rs"]), found("sunstar", &[])]).unwrap();
    let outcome = apply(store.connection(), &request("approve", "owner", None, "camera")).unwrap();
    assert_eq!(outcome.tell[0].0, "s1");
    assert!(outcome.tell[0].1.contains("Owner approved grid \"camera\" (2 rows × 2 columns)"), "{}", outcome.tell[0].1);
    assert!(outcome.tell[0].1.contains("Run `atelier grid next camera`") && outcome.tell[0].1.contains("press Create task"), "{}", outcome.tell[0].1);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(loaded.grid.status, "approved");
    assert!(loaded.grid.pending.is_none());
    assert_eq!(loaded.columns.len(), 2);
    assert_eq!(loaded.rows.len(), 2);
    assert_eq!(loaded.cells.len(), 4);
    assert!(loaded.cells.iter().all(|cell| cell.state == "unchecked"));
    let summary = summary(&loaded, &Prints::new());
    assert_eq!((summary["percent"].as_i64(), summary["counts"]["counted"].as_i64()), (Some(0), Some(4)));
    assert!(refused(apply(store.connection(), &request("approve", "owner", None, "camera"))).contains("no draft waiting"));
}

#[test]
fn a_feature_belongs_to_one_grid_and_a_reference_reads_the_owners_cells() {
    let (_d, store) = store();
    camera(&store);
    owner_says(&store, "s2", "@matrix the lens");
    let refusal = refused(draft(&store, "s2", draft_payload("lens"), vec![found("glare", &[])]));
    assert!(refusal.contains("belongs to grid \"camera\"") && refusal.contains("reference"), "{refusal}");
    let mut payload = draft_payload("lens");
    payload["rows"] = json!([{"id": "glare", "name": "Glare", "kind": "reference", "ref": {"grid": "camera", "row": "glare"}}]);
    draft(&store, "s2", payload.clone(), vec![found("bokeh", &[])]).unwrap();
    payload["rows"] = json!([{"id": "glare", "name": "Glare", "kind": "reference", "ref": {"grid": "camera", "row": "nope"}}]);
    assert!(refused(draft(&store, "s2", payload, vec![found("bokeh", &[])])).contains("not a row of an approved grid"));
    let mut payload = draft_payload("lens");
    payload["rows"] = json!([{"id": "glare", "name": "Glare", "kind": "reference", "ref": {"grid": "camera", "row": "glare"}}]);
    draft(&store, "s2", payload, vec![found("bokeh", &[])]).unwrap();
    apply(store.connection(), &request("approve", "owner", None, "lens")).unwrap();
    let lens = load(store.connection(), "p", "lens").unwrap().unwrap();
    // The reference row has no cells of its own and does not count.
    assert!(lens.cells.iter().all(|cell| cell.row == "bokeh"));
    assert_eq!(counts(&lens, &Prints::new())["counted"], 2);
    // Its cells are the owner's; working on them goes to the owner's grid.
    let refusal = refused(apply(store.connection(), &on(request("na", "agent", Some("s2"), "lens"), "glare", "gpu")));
    assert!(refusal.contains("reference row") && refusal.contains("camera.glare"), "{refusal}");
}

#[test]
fn an_edit_to_an_approved_grid_waits_for_the_owner() {
    let (_d, store) = store();
    camera(&store);
    let mut payload = draft_payload("camera");
    payload["columns"] = json!([{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test"}]);
    // No @matrix needed for an edit of an approved grid.
    owner_says(&store, "s1", "drop perf and add ghosts");
    draft(&store, "s1", payload, vec![found("glare", &["camera/glare.rs"]), found("ghosts", &[])]).unwrap();
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let pending = loaded.grid.pending.clone().unwrap();
    assert_eq!(pending["edit"], true);
    assert_eq!(pending["diff"]["rowsAdded"], json!(["ghosts"]));
    assert_eq!(pending["diff"]["rowsMissing"], json!(["sunstar"]));
    assert_eq!(pending["diff"]["columnsRetired"], json!(["perf"]));
    // The live grid is unchanged until approval.
    assert_eq!(loaded.cells.len(), 4);
    assert!(loaded.rows.iter().all(|r| r.missing_since.is_none()));
    apply(store.connection(), &request("approve", "owner", None, "camera")).unwrap();
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(loaded.column("perf").unwrap().retired_at.is_some());
    assert!(loaded.row("sunstar").unwrap().missing_since.is_some());
    assert_eq!(state(&store, "camera", "ghosts", "gpu").state, "unchecked");
    // Counted: glare and ghosts, in gpu only.
    assert_eq!(counts(&loaded, &Prints::new())["counted"], 2);
}

#[test]
fn a_template_change_adds_unchecked_cells_and_retires_removed_columns() {
    let (_d, store) = store();
    let mut set = request("template_set", "agent", Some("s1"), "physics");
    set.payload = json!({"columns": [{"id": "energy", "name": "Conserves energy", "proof_rule": "an energy test"}]});
    let outcome = apply(store.connection(), &set).unwrap();
    assert_eq!(outcome.widget, Some("template"));
    assert_eq!(outcome.template.as_ref().unwrap()["projectId"], "p");
    // Not usable until approved.
    owner_says(&store, "s1", "@matrix camera");
    let mut payload = draft_payload("camera");
    payload["template"] = json!("physics");
    assert!(refused(draft(&store, "s1", payload.clone(), vec![found("glare", &[])])).contains("no approved columns"));
    apply(store.connection(), &request("approve_template", "owner", None, "physics")).unwrap();
    draft(&store, "s1", payload, vec![found("glare", &[])]).unwrap();
    apply(store.connection(), &request("approve", "owner", None, "camera")).unwrap();
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(loaded.column("energy").unwrap().from_template);
    assert_eq!(loaded.cells.len(), 3);
    // A change: energy out, momentum in, and gpu clashes with the grid's own column.
    set.payload = json!({"columns": [
        {"id": "momentum", "name": "Conserves momentum", "proof_rule": "a momentum test"},
        {"id": "gpu", "name": "GPU", "proof_rule": "x"},
    ]});
    let outcome = apply(store.connection(), &set).unwrap();
    let change = &outcome.template.unwrap()["change"];
    assert_eq!(change["affects"], json!(["camera"]));
    assert_eq!(change["clashes"], json!([{"grid": "camera", "column": "gpu"}]));
    let outcome = apply(store.connection(), &request("approve_template", "owner", None, "physics")).unwrap();
    assert_eq!(outcome.grids, ["camera"]);
    assert!(outcome.summary.contains("@audit camera"), "{}", outcome.summary);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(loaded.column("energy").unwrap().retired_at.is_some());
    assert_eq!(state(&store, "camera", "glare", "momentum").state, "unchecked");
    // The grid's own gpu column is kept as it was.
    assert!(!loaded.column("gpu").unwrap().from_template);
    assert_eq!(loaded.column("gpu").unwrap().proof_rule, "a GPU test");
}

fn discover(store: &Store, slug: &str, rows: Option<Result<search::Run, String>>) -> Result<Outcome, TaskError> {
    let mut asked = request("discover", "owner", None, slug);
    asked.search = rows;
    apply(store.connection(), &asked)
}

#[test]
fn discovery_adds_new_rows_marks_missing_and_skips_owned_ids() {
    let (_d, store) = store();
    camera(&store);
    approved(&store, "s2", "lens", vec![found("bokeh", &[])]);
    let outcome = discover(&store, "camera", ran(vec![found("glare", &["camera/glare2.rs"]), found("ghosts", &[]), found("bokeh", &[])])).unwrap();
    assert!(outcome.summary.contains("1 added, 1 missing"), "{}", outcome.summary);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(loaded.row("glare").unwrap().paths, ["camera/glare2.rs"]);
    assert!(loaded.row("sunstar").unwrap().missing_since.is_some());
    assert_eq!(state(&store, "camera", "ghosts", "perf").state, "unchecked");
    assert!(loaded.row("bokeh").is_none());
    assert_eq!(loaded.grid.discovery.as_ref().unwrap()["skipped"], json!([{"id": "bokeh", "owner": "lens"}]));
    // A missing row that comes back is cleared.
    let outcome = discover(&store, "camera", ran(vec![found("glare", &[]), found("ghosts", &[]), found("sunstar", &[])])).unwrap();
    assert!(outcome.summary.contains("1 back"), "{}", outcome.summary);
    assert!(load(store.connection(), "p", "camera").unwrap().unwrap().row("sunstar").unwrap().missing_since.is_none());
}

#[test]
fn a_failing_or_bad_row_search_changes_nothing() {
    let (_d, store) = store();
    camera(&store);
    let before = load(store.connection(), "p", "camera").unwrap().unwrap();
    let outcome = discover(&store, "camera", Some(Err("line 2 is not valid JSON".into()))).unwrap();
    assert!(outcome.failed.is_some());
    let after = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!((before.rows, before.cells), (after.rows.clone(), after.cells.clone()));
    let discovery = after.grid.discovery.unwrap();
    assert_eq!((discovery["ok"].as_bool(), discovery["error"].as_str()), (Some(false), Some("line 2 is not valid JSON")));
    // And search::parse is what refuses the bad output in the first place.
    assert!(search::parse("{\"id\":\"a\",\"name\":\"A\"}\nnope").is_err());
}

#[test]
fn prove_needs_a_passing_check_budgets_met_and_existing_commits() {
    let (_d, store) = store();
    camera(&store);
    let mut asked = on(request("prove", "agent", Some("s1"), "camera"), "glare", "gpu");
    asked.payload = proof_payload();
    asked.checks = vec![proof::CheckResult { name: "unit".into(), exit: 3, ms: 1, tail: "assertion failed".into() }];
    asked.fingerprint = Some("f1".into());
    let refusal = refused(apply(store.connection(), &asked));
    assert!(refusal.contains("check \"unit\" failed (exit 3)") && refusal.contains("assertion failed"), "{refusal}");
    asked.payload["benchmarks"] = json!([{"name": "pass", "value": 2.0, "budget": 1.0, "unit": "ms"}]);
    assert!(refused(apply(store.connection(), &asked)).contains("misses its budget"));
    asked.payload = proof_payload();
    asked.payload["commits"] = json!(["abcdef1"]);
    asked.missing_commits = HashSet::from(["abcdef1".to_string()]);
    asked.checks = passing();
    assert!(refused(apply(store.connection(), &asked)).contains("\"abcdef1\", which is not a commit"));
    asked.missing_commits.clear();
    let outcome = apply(store.connection(), &asked).unwrap();
    assert_eq!(outcome.widget, Some("prove"));
    let cell = state(&store, "camera", "glare", "gpu");
    assert_eq!((cell.state.as_str(), cell.fingerprint.as_deref(), cell.proved_by.as_deref()), ("proved", Some("f1"), Some("s1")));
    assert_eq!(cell.last_check.unwrap()["passed"], true);
}

#[tokio::test]
async fn prove_is_refused_while_the_covered_paths_are_dirty() {
    let repo = repository();
    commit_file(repo.path(), "camera/glare.rs", "fn glare() {}");
    std::fs::write(repo.path().join("camera/glare.rs"), "fn glare() { changed }").unwrap();
    let dirty = proof::dirty(repo.path(), &["camera/".into()]).await.unwrap();
    assert_eq!(dirty, ["camera/glare.rs"]);
    assert!(proof::dirty(repo.path(), &["other/".into()]).await.unwrap().is_empty());
    let (_d, store) = store();
    camera(&store);
    let mut asked = on(request("prove", "agent", Some("s1"), "camera"), "glare", "gpu");
    asked.payload = proof_payload();
    asked.dirty = dirty;
    asked.cwd = Some(repo.path().display().to_string());
    let refusal = refused(apply(store.connection(), &asked));
    assert!(refusal.contains("commit the covered code first") && refusal.contains("camera/glare.rs"), "{refusal}");
}

#[tokio::test]
async fn a_commit_to_covered_code_makes_a_proof_stale_and_a_recheck_freshens_it() {
    let repo = repository();
    let first = commit_file(repo.path(), "camera/glare.rs", "fn glare() {}");
    commit_file(repo.path(), "other.rs", "x");
    let paths = vec!["camera/glare.rs".to_string()];
    let then = proof::fingerprint(repo.path(), &first, &paths).await.unwrap();
    let (_d, store) = store();
    camera(&store);
    prove(&store, "s1", "camera", "glare", "gpu", &then).unwrap();
    // A commit elsewhere changes nothing.
    let head = proof::head(repo.path()).await.unwrap();
    let same = proof::fingerprint(repo.path(), &head, &paths).await.unwrap();
    assert_eq!(same, then);
    // A commit to the covered file makes it stale.
    let moved = commit_file(repo.path(), "camera/glare.rs", "fn glare() { better }");
    let now = proof::fingerprint(repo.path(), &moved, &paths).await.unwrap();
    assert_ne!(now, then);
    let prints: Prints = HashMap::from([(("camera".to_string(), "glare".to_string()), now.clone())]);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(is_stale("camera", loaded.cell("glare", "gpu").unwrap(), &prints));
    assert_eq!(counts(&loaded, &prints)["stale"], 1);
    assert_eq!(verify_targets(&loaded, &prints, true), [("glare".to_string(), "gpu".to_string())]);
    // A passing re-check takes the fingerprint again.
    let mut asked = on(request("verify", "owner", None, "camera"), "glare", "gpu");
    asked.checks = passing();
    asked.fingerprint = Some(now.clone());
    asked.prints = prints.clone();
    let outcome = apply(store.connection(), &asked).unwrap();
    assert!(outcome.summary.contains("fresh again"), "{}", outcome.summary);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert!(!is_stale("camera", loaded.cell("glare", "gpu").unwrap(), &prints));
    // Deleting the covered code is a change too.
    std::fs::remove_file(repo.path().join("camera/glare.rs")).unwrap();
    super::proof::tests::git_run(repo.path(), &["commit", "-qam", "rm"]);
    let gone = proof::head(repo.path()).await.unwrap();
    assert_ne!(proof::fingerprint(repo.path(), &gone, &paths).await.unwrap(), now);
}

#[test]
fn a_failed_recheck_reopens_the_cell() {
    let (_d, store) = store();
    camera(&store);
    prove(&store, "s1", "camera", "glare", "gpu", "f1").unwrap();
    let mut asked = on(request("verify", "owner", None, "camera"), "glare", "gpu");
    asked.checks = vec![proof::CheckResult { name: "unit".into(), exit: 1, ms: 1, tail: "boom".into() }];
    let outcome = apply(store.connection(), &asked).unwrap();
    assert!(outcome.failed.is_some());
    let cell = state(&store, "camera", "glare", "gpu");
    assert_eq!(cell.state, "gap");
    assert_eq!(cell.reason.as_deref(), Some("check \"unit\" failed on re-check (exit 1)"));
    assert!(cell.proof.is_some(), "the proof is kept");
    assert!(refused(apply(store.connection(), &asked)).contains("only a proved cell is re-checked"));
}

#[test]
fn percent_counts_fresh_proof_over_live_cells_without_na() {
    let (_d, store) = store();
    approved(&store, "s1", "camera", vec![found("glare", &[]), found("sunstar", &[]), found("ghosts", &[])]);
    // 6 cells; one proved, one stale, one N/A.
    prove(&store, "s1", "camera", "glare", "gpu", "f1").unwrap();
    prove(&store, "s1", "camera", "glare", "perf", "f1").unwrap();
    let mut na = on(request("na", "agent", Some("s1"), "camera"), "ghosts", "perf");
    na.payload = json!({"reason": "no perf budget for ghosts"});
    apply(store.connection(), &na).unwrap();
    apply(store.connection(), &on(request("approve_na", "owner", None, "camera"), "ghosts", "perf")).unwrap();
    let mut prints = Prints::new();
    prints.insert(("camera".into(), "glare".into()), "f1".into());
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let c = counts(&loaded, &prints);
    assert_eq!((c["counted"].as_i64(), c["proved"].as_i64(), c["na"].as_i64()), (Some(5), Some(2), Some(1)));
    assert_eq!(percent(&loaded, &c), Some(40));
    // glare's code moved: both its proofs are stale and the percent drops.
    prints.insert(("camera".into(), "glare".into()), "f2".into());
    let c = counts(&loaded, &prints);
    assert_eq!((c["stale"].as_i64(), percent(&loaded, &c)), (Some(2), Some(0)));
    // A draft has no percent.
    owner_says(&store, "s1", "@matrix lens");
    draft(&store, "s1", draft_payload("lens"), vec![found("bokeh", &[])]).unwrap();
    let lens = load(store.connection(), "p", "lens").unwrap().unwrap();
    assert_eq!(summary(&lens, &Prints::new())["percent"], Value::Null);
}

#[test]
fn a_task_claims_its_cells_and_a_second_claim_is_refused() {
    let (_d, store) = store();
    camera(&store);
    store.connection().execute("INSERT INTO session (id, brand, project_id, project_path, cwd, permission_mode, title, state, origin, created_at, last_active_at)
        VALUES ('s1', 'claude', 'p', '/p', '/p', 'default', 'Glare GPU', 'idle', 'app', '2026', '2026')", []).ok();
    let cells = json!([{"grid": "camera", "row": "glare", "col": "gpu"}, {"grid": "camera", "row": "sunstar", "col": "gpu"}]);
    let outcome = task_create(&store, "s1", cells, Prints::new()).unwrap();
    let number = outcome.task.number;
    assert_eq!(outcome.grids, ["camera"]);
    let cell = state(&store, "camera", "glare", "gpu");
    assert_eq!((cell.state.as_str(), cell.claimed_task, cell.claimed_from.as_deref()), ("in_progress", Some(number), Some("unchecked")));
    let refusal = task_refused(task_create(&store, "s2", json!([{"grid": "camera", "row": "glare", "col": "gpu"}]), Prints::new()));
    assert!(refusal.starts_with(&format!("camera.glare.gpu is claimed by #{number} in chat")), "{refusal}");
    // Nothing of the refused create was written.
    assert!(tasks::get(store.connection(), "p", number + 1).unwrap().is_none());
    // A fresh proof is not claimable; a stale one is.
    prove(&store, "s3", "camera", "glare", "perf", "f1").unwrap();
    let fresh: Prints = HashMap::from([(("camera".to_string(), "glare".to_string()), "f1".to_string())]);
    let cell = json!([{"grid": "camera", "row": "glare", "col": "perf"}]);
    assert!(task_refused(task_create(&store, "s3", cell.clone(), fresh)).contains("fresh"));
    let stale: Prints = HashMap::from([(("camera".to_string(), "glare".to_string()), "f2".to_string())]);
    task_create(&store, "s3", cell, stale).unwrap();
    // Only the chat holding the claiming task proves it.
    assert!(refused(prove(&store, "s2", "camera", "glare", "gpu", "f1")).contains("only the chat holding that task"));
    prove(&store, "s1", "camera", "glare", "gpu", "f1").unwrap();
    // The task card lists its cells.
    let json = tasks::to_json(&store, &tasks::get(store.connection(), "p", number).unwrap().unwrap());
    assert_eq!(json["cells"].as_array().unwrap().len(), 2);
    // And the reconnect section names them.
    let section = tasks::open_section(store.connection(), "s1").unwrap();
    assert!(section.contains(&format!("Cells claimed by your tasks: #{number} → camera.glare.gpu [proved], camera.sunstar.gpu [in_progress]")), "{section}");
}

#[test]
fn task_done_needs_proof_or_a_reason_for_every_claimed_cell() {
    let (_d, store) = store();
    camera(&store);
    let cells = json!([{"grid": "camera", "row": "glare", "col": "gpu"}, {"grid": "camera", "row": "sunstar", "col": "gpu"}]);
    let number = task_create(&store, "s1", cells, Prints::new()).unwrap().task.number;
    task(&store, Some("s1"), "agent", "start", number, json!({})).unwrap();
    prove(&store, "s1", "camera", "glare", "gpu", "f1").unwrap();
    let refusal = task_refused(task(&store, Some("s1"), "agent", "done", number, chore_done(json!([]))));
    assert!(refusal.contains("camera.sunstar.gpu is still in progress"), "{refusal}");
    let refusal = task_refused(task(&store, Some("s1"), "agent", "done", number,
        chore_done(json!([{"grid": "camera", "row": "sunstar", "col": "gpu"}]))));
    assert!(refusal.contains("needs a reason"), "{refusal}");
    let refusal = task_refused(task(&store, Some("s1"), "agent", "done", number,
        chore_done(json!([{"grid": "camera", "row": "glare", "col": "perf", "reason": "x"}]))));
    assert!(refusal.contains("does not claim"), "{refusal}");
    let outcome = task(&store, Some("s1"), "agent", "done", number,
        chore_done(json!([{"grid": "camera", "row": "sunstar", "col": "gpu", "reason": "no GPU path yet"}]))).unwrap();
    assert_eq!(outcome.grids, ["camera"]);
    let gap = state(&store, "camera", "sunstar", "gpu");
    assert_eq!((gap.state.as_str(), gap.reason.as_deref(), gap.claimed_task), ("gap", Some("no GPU path yet"), None));
    let proved = state(&store, "camera", "glare", "gpu");
    assert_eq!((proved.state.as_str(), proved.claimed_task), ("proved", None));
    assert_eq!(outcome.task.result.unwrap()["cells"][0]["reason"], "no GPU path yet");
}

#[test]
fn cancel_restores_the_cells_it_claimed() {
    let (_d, store) = store();
    camera(&store);
    let mut asked = on(request("verify", "owner", None, "camera"), "sunstar", "gpu");
    prove(&store, "s1", "camera", "sunstar", "gpu", "f1").unwrap();
    asked.checks = vec![proof::CheckResult { name: "unit".into(), exit: 1, ms: 1, tail: String::new() }];
    apply(store.connection(), &asked).unwrap();
    let cells = json!([{"grid": "camera", "row": "glare", "col": "gpu"}, {"grid": "camera", "row": "sunstar", "col": "gpu"}]);
    let number = task_create(&store, "s1", cells, Prints::new()).unwrap().task.number;
    task(&store, Some("s1"), "agent", "cancel", number, json!({"reason": "not now"})).unwrap();
    let glare = state(&store, "camera", "glare", "gpu");
    let sunstar = state(&store, "camera", "sunstar", "gpu");
    assert_eq!((glare.state.as_str(), glare.claimed_task), ("unchecked", None));
    assert_eq!((sunstar.state.as_str(), sunstar.claimed_task), ("gap", None));
    // Free again for another task.
    task_create(&store, "s2", json!([{"grid": "camera", "row": "glare", "col": "gpu"}]), Prints::new()).unwrap();
}

#[test]
fn na_waits_for_the_owner() {
    let (_d, store) = store();
    camera(&store);
    let mut na = on(request("na", "agent", Some("s1"), "camera"), "glare", "perf");
    assert!(refused(apply(store.connection(), &na)).contains("reason is required"));
    na.payload = json!({"reason": "glare has no perf budget"});
    let outcome = apply(store.connection(), &na).unwrap();
    assert_eq!(outcome.widget, Some("na"));
    assert_eq!(state(&store, "camera", "glare", "perf").state, "na_pending");
    assert!(tasks::open_section(store.connection(), "s1").unwrap().contains("N/A awaiting the owner: camera.glare.perf"));
    // Only the owner moves it to N/A.
    assert!(refused(apply(store.connection(), &on(request("approve_na", "agent", Some("s1"), "camera"), "glare", "perf"))).contains("not an agent action"));
    let mut reject = on(request("reject_na", "owner", None, "camera"), "glare", "perf");
    reject.payload = json!({"note": "it has one: 1 ms"});
    let outcome = apply(store.connection(), &reject).unwrap();
    assert_eq!(outcome.tell, [("s1".to_string(), outcome.summary.clone())]);
    let cell = state(&store, "camera", "glare", "perf");
    assert_eq!((cell.state.as_str(), cell.reason.as_deref()), ("gap", Some("it has one: 1 ms")));
    apply(store.connection(), &na).unwrap();
    let outcome = apply(store.connection(), &on(request("approve_na", "owner", None, "camera"), "glare", "perf")).unwrap();
    assert_eq!(outcome.tell[0].0, "s1");
    assert_eq!(state(&store, "camera", "glare", "perf").state, "na");
    // The owner may reopen an N/A cell.
    let mut reopen = on(request("reopen", "owner", None, "camera"), "glare", "perf");
    reopen.payload = json!({"reason": "it applies after all"});
    apply(store.connection(), &reopen).unwrap();
    assert_eq!(state(&store, "camera", "glare", "perf").state, "gap");
}

#[test]
fn an_audit_verdict_from_the_proving_chat_is_refused() {
    let (_d, store) = store();
    camera(&store);
    prove(&store, "s1", "camera", "glare", "gpu", "f1").unwrap();
    owner_says(&store, "s1", "@audit camera");
    let pass = on(request("pass", "agent", Some("s1"), "camera"), "glare", "gpu");
    assert!(refused(apply(store.connection(), &pass)).contains("proved by this chat"));
    owner_says(&store, "s9", "@audit camera");
    let mut pass = on(request("pass", "agent", Some("s9"), "camera"), "glare", "gpu");
    pass.prints = HashMap::from([(("camera".to_string(), "glare".to_string()), "f2".to_string())]);
    assert!(refused(apply(store.connection(), &pass)).contains("Re-check or re-prove first"));
    pass.prints.clear();
    let outcome = apply(store.connection(), &pass).unwrap();
    assert_eq!(outcome.widget, Some("pass"));
    assert_eq!(state(&store, "camera", "glare", "gpu").audited_by.as_deref(), Some("s9"));
}

#[test]
fn audit_verdicts_need_the_owners_audit() {
    let (_d, store) = store();
    camera(&store);
    prove(&store, "s1", "camera", "glare", "gpu", "f1").unwrap();
    prove(&store, "s1", "camera", "sunstar", "gpu", "f1").unwrap();
    owner_says(&store, "s9", "please look at the camera grid");
    let mut reopen = on(request("reopen", "agent", Some("s9"), "camera"), "glare", "gpu");
    reopen.payload = json!({"reason": "the check compares the kernel with itself"});
    assert!(refused(apply(store.connection(), &reopen)).contains("@audit camera"));
    owner_says(&store, "s9", "@audit lens");
    assert!(refused(apply(store.connection(), &reopen)).contains("@audit camera"));
    owner_says(&store, "s9", "@audit camera");
    let outcome = apply(store.connection(), &reopen).unwrap();
    assert_eq!(outcome.widget, Some("reopen"));
    let cell = state(&store, "camera", "glare", "gpu");
    assert_eq!((cell.state.as_str(), cell.proof.is_some()), ("gap", true));
    apply(store.connection(), &on(request("pass", "agent", Some("s9"), "camera"), "sunstar", "gpu")).unwrap();
    let done = apply(store.connection(), &request("audit_done", "agent", Some("s9"), "camera")).unwrap();
    let audit = done.audit.unwrap();
    assert_eq!((audit["passed"].as_i64(), audit["reopened"].as_i64()), (Some(1), Some(1)));
    assert_eq!(audit["cells"][0]["reason"], "the check compares the kernel with itself");
}

#[test]
fn a_grid_selection_is_described_cell_by_cell() {
    let (_d, store) = store();
    camera(&store);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    assert_eq!(Selection::parse("camera.glare+sunstar.*").unwrap().cells, Some((Some(vec!["glare".into(), "sunstar".into()]), None)));
    assert!(Selection::parse("camera.glare").is_none());
    let text = describe("camera.glare.*", Some(&loaded), &Prints::new(), true);
    for want in ["camera.glare.gpu", "camera.glare.perf", "proof rule: a GPU test", "state unchecked", "give them as `cells`"] {
        assert!(text.contains(want), "{want} missing from {text}");
    }
    assert!(!text.contains("sunstar"));
    assert!(describe("nope", None, &Prints::new(), false).contains("no grid \"nope\""));
}

fn chat(store: &Store, id: &str, title: &str) {
    store
        .connection()
        .execute(
            "INSERT INTO session (id, brand, project_id, project_path, cwd, permission_mode, title, state, origin, created_at, last_active_at)
             VALUES (?1, 'claude', 'p', '/p', '/p', 'default', ?2, 'idle', 'app', '2026', '2026')",
            rusqlite::params![id, title],
        )
        .unwrap();
}

fn agent_create(store: &Store, session: &str, cells: Value) -> Result<tasks::Outcome, TaskError> {
    let plan = cell_plan(store, &cells);
    tasks::apply(store, &tasks::Request {
        gate: None,
        action: "create".into(),
        actor: "agent".into(),
        session: Some(session.into()),
        project: "p".into(),
        number: None,
        payload: json!({"type": "chore", "title": "Cells", "why": "Coverage", "plan": plan, "cells": cells}),
        missing_commits: Default::default(),
        cwd: Some("/repo".into()),
        visual_files: Vec::new(),
        prints: Prints::new(),
        now: 2,
    })
}

#[test]
fn an_agent_creates_a_task_for_approved_grid_cells_without_task() {
    let (_d, store) = store();
    camera(&store);
    owner_says(&store, "s1", "keep going on the camera grid");
    let outcome = agent_create(&store, "s1", json!([{"grid": "camera", "row": "glare", "col": "gpu"}])).unwrap();
    assert_eq!(state(&store, "camera", "glare", "gpu").claimed_task, Some(outcome.task.number));
    // A task with no cells still needs @task.
    assert!(task_refused(agent_create(&store, "s1", json!([]))).contains("no @task"));
    // So do cells of a grid still waiting for the owner.
    owner_says(&store, "s2", "draft the lens grid");
    draft(&store, "s2", draft_payload("lens"), vec![found("bokeh", &[])]).unwrap();
    let refusal = task_refused(agent_create(&store, "s2", json!([{"grid": "lens", "row": "bokeh", "col": "gpu"}])));
    assert!(refusal.contains("no @task") && refusal.contains("approved grids"), "{refusal}");
    // And a mix of an approved and a draft grid.
    let refusal = task_refused(agent_create(&store, "s2", json!([
        {"grid": "camera", "row": "sunstar", "col": "gpu"}, {"grid": "lens", "row": "bokeh", "col": "gpu"}
    ])));
    assert!(refusal.contains("no @task"), "{refusal}");
    assert!(all_in_approved(store.connection(), "p", &parse_cells(Some(&json!([{"grid": "camera", "row": "glare", "col": "perf"}])), false).unwrap()).unwrap());
}

#[test]
fn next_lists_one_row_and_names_the_chats_holding_taken_cells() {
    let (_d, store) = store();
    camera(&store);
    chat(&store, "s1", "Glare GPU");
    let none = Prints::new();
    // The first row with free cells: glare, both columns.
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::First).unwrap();
    assert_eq!(next["scope"], json!({"kind": "row", "id": "glare", "name": "GLARE"}));
    assert_eq!(next["claimable"].as_array().unwrap().len(), 2);
    assert_eq!(next["left"], 4);
    assert_eq!(next["claimable"][0]["proofRule"], "a GPU test");
    let create = &next["create"];
    assert_eq!(create["type"], "general");
    assert_eq!(create["title"], "camera: GLARE row");
    assert_eq!(create["plan"]["done_when"][0]["id"], "glare.gpu");
    assert_eq!(create["plan"]["done_when"][0]["text"], "GLARE × Runs on the GPU: a GPU test");
    // The cell's check, its column's template filled in for the row.
    assert_eq!(create["plan"]["done_when"][0]["checks"][0]["command"], "cargo test glare_on_gpu");
    assert_eq!(create["cells"].as_array().unwrap().len(), 2);
    // The payload is one an agent can create without @task.
    owner_says(&store, "s1", "next");
    let created = tasks::apply(&store, &tasks::Request {
        gate: None,
        action: "create".into(), actor: "agent".into(), session: Some("s1".into()), project: "p".into(), number: None,
        payload: json!({"type": "general", "title": "x", "why": "y", "cells": [create["cells"][0]],
            "plan": {"outcome": create["plan"]["outcome"], "done_when": [create["plan"]["done_when"][0]]}}),
        missing_commits: Default::default(), cwd: None, visual_files: Vec::new(), prints: Prints::new(), now: 2,
    }).unwrap();
    let number = created.task.number;
    // Glare still has a free cell; its taken one names the task and chat.
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::First).unwrap();
    assert_eq!(next["scope"]["id"], "glare");
    assert_eq!(next["claimable"].as_array().unwrap().len(), 1);
    assert_eq!(next["taken"], json!([{"row": "glare", "col": "gpu", "task": number, "chat": {"id": "s1", "title": "Glare GPU"}}]));
    assert_eq!(next["left"], 3);
    // A column scope, and a fully worked row moves on to the next.
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::Col("gpu".into())).unwrap();
    assert_eq!(next["claimable"][0]["row"], "sunstar");
    prove(&store, "s3", "camera", "glare", "perf", "f1").unwrap();
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::First).unwrap();
    assert_eq!(next["scope"]["id"], "sunstar");
    assert!(task_refused(next_cells(store.connection(), "p", "camera", &none, &Scope::Row("nope".into()))).contains("no row \"nope\""));
    // With every cell settled or taken, there is no scope, and the text says so.
    for col in ["gpu", "perf"] {
        prove(&store, "s3", "camera", "sunstar", col, "f1").unwrap();
    }
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::First).unwrap();
    assert!(next["scope"].is_null());
    assert_eq!((next["left"].as_i64(), next["takenInGrid"].as_i64()), (Some(0), Some(1)));
    assert!(cli::next_text(&next).starts_with("No free cells left in camera: 1 is claimed"), "{}", cli::next_text(&next));
    task(&store, Some("s1"), "agent", "cancel", number, json!({"reason": "done elsewhere"})).unwrap();
    prove(&store, "s3", "camera", "glare", "gpu", "f1").unwrap();
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::First).unwrap();
    assert_eq!(cli::next_text(&next), "No gaps left in camera. Every cell is proved or N/A.\n");
}

#[test]
fn the_owner_creates_a_task_from_a_selection_and_its_cells_are_claimed() {
    let (_d, store) = store();
    camera(&store);
    chat(&store, "s1", "Glare GPU");
    chat(&store, "s2", "Camera work");
    let none = Prints::new();
    // glare.perf is proved, sunstar.gpu is claimed by another task: a row pick keeps the rest.
    prove(&store, "s3", "camera", "glare", "perf", "f1").unwrap();
    let held = agent_create(&store, "s1", json!([{"grid": "camera", "row": "sunstar", "col": "gpu"}])).unwrap().task.number;
    let pick = Pick::parse(&json!({"slug": "camera", "rows": ["glare"], "cols": "*", "onlyGaps": false})).unwrap();
    let (task, grids, prompt) = tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 5).unwrap();
    assert_eq!(grids, ["camera"]);
    assert_eq!((task.status.as_str(), task.session_id.as_deref(), task.kind.as_str()), ("todo", Some("s2"), "general"));
    assert_eq!(task.title, "camera: GLARE × Runs on the GPU");
    let cell = state(&store, "camera", "glare", "gpu");
    assert_eq!((cell.state.as_str(), cell.claimed_task), ("in_progress", Some(task.number)));
    assert!(prompt.starts_with(&format!("The owner created task #{} from the camera grid (GLARE × Runs on the GPU).", task.number)), "{prompt}");
    assert!(prompt.contains(&format!("`atelier task start {}`", task.number)), "{prompt}");
    // The card's shape: the whole glare row, since its other cell is proved.
    let json = tasks::to_json(&store, &task);
    assert_eq!(json["claimShape"], json!({"grid": "camera", "kind": "row", "id": "glare", "name": "GLARE", "count": 1}));
    // The other task's cell is not a whole row or column (sunstar.perf is open).
    assert!(tasks::to_json(&store, &tasks::get(store.connection(), "p", held).unwrap().unwrap())["claimShape"].is_null());
    // A column pick: only sunstar.perf is free; glare.perf is proved.
    let pick = Pick::parse(&json!({"slug": "camera", "rows": "*", "cols": ["perf"], "onlyGaps": true})).unwrap();
    let (task, _, prompt) = tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 6).unwrap();
    assert_eq!(task.title, "camera: SUNSTAR × Within budget");
    assert!(prompt.contains("(SUNSTAR × Within budget)"), "{prompt}");
    // Nothing left to pick is refused and writes nothing.
    let pick = Pick::parse(&json!({"slug": "camera", "rows": "*", "cols": "*", "onlyGaps": false})).unwrap();
    let refusal = task_refused(tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 7));
    assert!(refusal.contains("none of the selected cells needs a task"), "{refusal}");
    assert!(tasks::get(store.connection(), "p", task.number + 1).unwrap().is_none());
    // Bad picks.
    assert!(Pick::parse(&json!({"slug": "camera", "rows": ["Bad Id"]})).unwrap_err().contains("not a valid id"));
    let pick = Pick::parse(&json!({"slug": "camera", "rows": ["nope"], "cols": "*"})).unwrap();
    assert!(task_refused(tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 8)).contains("no row \"nope\""));
    // A claimed cell in the grid's detail names its chat.
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let mut cells: Vec<Value> = loaded.cells.iter().map(|cell| cell_json(cell, false, false)).collect();
    with_claim_chats(store.connection(), "p", &mut cells).unwrap();
    let sunstar = cells.iter().find(|c| c["row"] == "sunstar" && c["col"] == "gpu").unwrap();
    assert_eq!(sunstar["claimedChat"], json!({"id": "s1", "title": "Glare GPU"}));
    assert!(cells.iter().find(|c| c["row"] == "glare" && c["col"] == "perf").unwrap().get("claimedChat").is_none());
}

#[test]
fn a_task_for_several_rows_of_every_open_cell_is_the_whole_grid_and_a_row_pick_is_titled_by_its_row() {
    let (_d, store) = store();
    camera(&store);
    chat(&store, "s2", "Camera work");
    let none = Prints::new();
    let pick = Pick::parse(&json!({"slug": "camera", "rows": ["sunstar"], "cols": "*", "onlyGaps": true})).unwrap();
    let (task, _, prompt) = tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 5).unwrap();
    // A whole row: the card names its shape and count, so the title has no count.
    assert_eq!(task.title, "camera: SUNSTAR row");
    assert!(prompt.contains("(SUNSTAR row, 2 gaps)"), "{prompt}");
    assert_eq!(task.plan["done_when"].as_array().unwrap().len(), 2);
    // Every open cell left is the glare row: titled by that row, as its card is.
    let pick = Pick::parse(&json!({"slug": "camera", "rows": "*", "cols": "*"})).unwrap();
    let (task, _, _) = tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 6).unwrap();
    assert_eq!(task.title, "camera: GLARE row");
    assert_eq!(tasks::to_json(&store, &task)["claimShape"]["kind"], "row");
}

#[test]
fn a_whole_grid_is_titled_without_a_count_and_an_irregular_pick_keeps_it() {
    let (_d, store) = store();
    camera(&store);
    chat(&store, "s2", "Camera work");
    let none = Prints::new();
    let pick = Pick::parse(&json!({"slug": "camera", "rows": "*", "cols": "*", "onlyGaps": true})).unwrap();
    let (task, _, prompt) = tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 5).unwrap();
    assert_eq!(task.title, "camera: whole grid");
    assert!(prompt.contains("(whole grid, 4 gaps)"), "{prompt}");
    assert_eq!(tasks::to_json(&store, &task)["claimShape"]["kind"], "grid");
}

#[test]
fn part_of_a_row_and_an_irregular_pick_keep_their_count() {
    let (_d, store) = store();
    camera(&store);
    chat(&store, "s2", "Camera work");
    let none = Prints::new();
    // glare.gpu is held by another task, so the glare row is not whole.
    agent_create(&store, "s2", json!([{"grid": "camera", "row": "glare", "col": "gpu"}])).unwrap();
    let next = next_cells(store.connection(), "p", "camera", &none, &Scope::First).unwrap();
    assert_eq!(next["create"]["title"], "camera: GLARE row (1 cell)");
    // The three cells left, over two rows and columns, are no shape.
    let pick = Pick::parse(&json!({"slug": "camera", "rows": "*", "cols": "*", "onlyGaps": true})).unwrap();
    let (task, _, _) = tasks::create_from_pick(&store, "p", "s2", &pick, &none, None, 6).unwrap();
    assert_eq!(task.title, "camera: 3 gaps");
    assert!(tasks::to_json(&store, &task)["claimShape"].is_null());
}

#[test]
fn refusals_say_what_to_do() {
    let (_d, store) = store();
    camera(&store);
    chat(&store, "s1", "Glare GPU");
    let number = agent_create(&store, "s1", json!([{"grid": "camera", "row": "glare", "col": "gpu"}])).unwrap().task.number;
    let refusal = task_refused(agent_create(&store, "s2", json!([{"grid": "camera", "row": "glare", "col": "gpu"}])));
    assert_eq!(refusal, format!(
        "camera.glare.gpu is claimed by #{number} in chat \"Glare GPU\": pick another cell, or run `atelier grid next camera` for free ones"
    ));
    let refusal = refused(prove(&store, "s2", "camera", "glare", "gpu", "f1"));
    assert!(refusal.contains("`atelier grid next camera`") && refusal.contains(&format!("`atelier task take {number}`")), "{refusal}");
    prove(&store, "s3", "camera", "sunstar", "gpu", "f1").unwrap();
    let fresh: Prints = HashMap::from([(("camera".to_string(), "sunstar".to_string()), "f1".to_string())]);
    let cells = parse_cells(Some(&json!([{"grid": "camera", "row": "sunstar", "col": "gpu"}])), false).unwrap();
    let refusal = unclaimable(store.connection(), "p", &cells[0], &fresh).unwrap().unwrap();
    assert!(refusal.contains("nothing to do") && refusal.contains("atelier grid next camera"), "{refusal}");
}

fn template(name: &str, command: &str) -> Value {
    json!({"name": name, "command": command, "kind": "test", "given": "the {row} pass", "when": "it renders",
        "then": "it is right", "red": "FAILED|panicked"})
}

/// Camera with checks only on the gpu column; glare.perf adds its own,
/// sunstar.gpu overrides the column's.
fn camera_with_cell_checks(store: &Store) {
    owner_says(store, "s1", "@matrix the camera area");
    let mut payload = draft_payload("camera");
    payload["columns"][1].as_object_mut().unwrap().remove("checks");
    payload["cells"] = json!([
        {"row": "glare", "col": "perf", "checks": [template("perf", "scripts/bench.sh {row}")]},
        {"row": "sunstar", "col": "gpu", "checks": [template("gpu-own", "cargo test sunstar_gpu_by_hand")], "override": true},
    ]);
    draft(store, "s1", payload, vec![found("glare", &["camera/glare.rs"]), found("sunstar", &["camera/sunstar.rs"])]).unwrap();
    apply(store.connection(), &request("approve", "owner", None, "camera")).unwrap();
}

#[test]
fn column_check_templates_fill_in_the_row_and_a_cell_adds_or_overrides() {
    let (_d, store) = store();
    camera_with_cell_checks(&store);
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let commands = |row: &str, col: &str| -> Vec<String> {
        loaded.cell_checks(row, col).iter().map(|c| c["command"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(commands("glare", "gpu"), ["cargo test glare_on_gpu"]);
    assert_eq!(loaded.cell_checks("glare", "gpu")[0]["given"], "the glare pass", "{{row}} is filled in every text");
    assert_eq!(commands("sunstar", "gpu"), ["cargo test sunstar_gpu_by_hand"], "override drops the column's");
    assert_eq!(commands("glare", "perf"), ["scripts/bench.sh glare"], "a cell's own checks are templates too");
    assert!(commands("sunstar", "perf").is_empty());
    let shown = with_checks(&loaded, "sunstar", "perf", json!({}));
    assert_eq!((shown["needsCheck"].clone(), shown["checks"].clone()), (json!(true), json!([])));
    assert_eq!(with_checks(&loaded, "glare", "gpu", json!({}))["needsCheck"], false);
    // A cell check for a cell not in the draft is refused.
    let mut payload = draft_payload("lens");
    payload["cells"] = json!([{"row": "nope", "col": "gpu", "checks": [template("x", "true")]}]);
    owner_says(&store, "s1", "@matrix the lens area");
    assert!(refused(draft(&store, "s1", payload, vec![found("bokeh", &["lens/bokeh.rs"])])).contains("is not a row of the draft"));
}

#[test]
fn a_cell_without_checks_needs_one_is_listed_apart_and_cannot_be_claimed() {
    let (_d, store) = store();
    camera_with_cell_checks(&store);
    let next = next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::Row("sunstar".into())).unwrap();
    let needing: Vec<String> = next["needsCheck"].as_array().unwrap().iter()
        .map(|c| format!("{}.{}", c["row"].as_str().unwrap(), c["col"].as_str().unwrap())).collect();
    assert_eq!(needing, ["sunstar.perf"]);
    assert_eq!(next["needsCheckInGrid"], 1);
    assert!(next["claimable"].as_array().unwrap().iter().all(|c| !(c["row"] == "sunstar" && c["col"] == "perf")));
    let refusal = task_refused(agent_create(&store, "s2", json!([{"grid": "camera", "row": "sunstar", "col": "perf"}])));
    assert!(refusal.contains("camera.sunstar.perf has no check. Add one to the column or cell and get it approved"), "{refusal}");
    // The owner's pick of only that cell is refused the same way.
    let pick = Pick::parse(&json!({"slug": "camera", "rows": ["sunstar"], "cols": ["perf"], "onlyGaps": false})).unwrap();
    let refusal = task_refused(tasks::create_from_pick(&store, "p", "s2", &pick, &Prints::new(), None, 5));
    assert!(refusal.contains("camera.sunstar.perf has no check"), "{refusal}");
}
