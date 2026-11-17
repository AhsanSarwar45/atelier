//! Cases before work: a cell holds a list of cases (one scenario each), a
//! coverage review that Atelier runs looks for missing scenarios, the agent
//! answers each gap with a case or a dismissal, and the owner approves a
//! row's cases in one step. A cell moves cases → reviewed → approved → red →
//! work → proved, and nothing in a row is claimed before the row is approved.
//! A column template may vary only by `{row}`. A proved cell with no approved
//! cases keeps its proof but needs cases before it is claimed or re-proved.

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

fn request(action: &str) -> Request {
    Request {
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        slug: Some("camera".into()),
        now: 1,
        ..Default::default()
    }
}

fn on(mut request: Request, row: &str, col: &str) -> Request {
    request.row = Some(row.into());
    request.col = Some(col.into());
    request
}

fn found(id: &str) -> search::Found {
    search::Found { id: id.into(), name: id.to_uppercase(), paths: vec![format!("camera/{id}.rs")], kind: "feature".into(), of: Vec::new() }
}

fn template(col: &str, command: &str) -> Value {
    json!([{"name": col, "command": command, "kind": "test", "given": "the {row} feature", "when": "it runs", "then": "it works",
        "red": format!("CASE camera/{{row}}/{col}/{col} FAIL")}])
}

fn draft(store: &Store, gpu: &str) -> Result<Outcome, TaskError> {
    let mut draft = request("draft");
    draft.slug = None;
    draft.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [
            {"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test", "checks": template("gpu", gpu)},
            {"id": "perf", "name": "Within budget", "proof_rule": "a benchmark",
             "checks": template("perf", "atelier case camera/{row}/perf/perf -- cargo bench {row}")},
        ],
    });
    draft.search = Some(Ok(search::Run { rows: vec![found("glare"), found("sunstar")], head: Some("h1".into()) }));
    apply(store.connection(), &draft)
}

/// An approved, ordered grid camera: rows glare and sunstar, columns gpu and
/// perf, each column with one check that varies only by `{row}`.
fn camera(store: &Store) {
    draft(store, "atelier case camera/{row}/gpu/gpu -- cargo test {row}_gpu").unwrap();
    let mut approve = request("approve");
    approve.actor = "owner".into();
    approve.session = None;
    apply(store.connection(), &approve).unwrap();
    let why = "it shares the pass the others build on";
    let mut order = request("order");
    order.payload = json!({
        "rows": [{"id": "glare", "after": [], "reason": why}, {"id": "sunstar", "after": [], "reason": why}],
        "columns": [{"id": "gpu", "after": [], "reason": why}, {"id": "perf", "after": [], "reason": why}],
    });
    apply(store.connection(), &order).unwrap();
}

fn case(row: &str, col: &str, id: &str) -> Value {
    json!({"id": id, "given": format!("{row} in a {id}"), "when": "the frame renders", "then": "it looks right",
        "command": format!("atelier case camera/{row}/{col}/{id} -- cargo test {row}_{id}"),
        "red": format!("CASE camera/{row}/{col}/{id} FAIL")})
}

fn cases(store: &Store, row: &str, col: &str, payload: Value) -> Result<Outcome, TaskError> {
    let mut asked = on(request("cases"), row, col);
    asked.payload = payload;
    apply(store.connection(), &asked)
}

/// The coverage review's answer, as the route records it after running the
/// reviewer: actor `reviewer`, the gaps it found.
fn review(store: &Store, row: &str, col: &str, gaps: &[&str]) -> Result<Outcome, TaskError> {
    let mut asked = on(request("review"), row, col);
    asked.actor = "reviewer".into();
    asked.payload = json!({"gaps": gaps.iter().map(|scenario| json!({"scenario": scenario})).collect::<Vec<_>>()});
    apply(store.connection(), &asked)
}

fn approve_row(store: &Store, row: &str) -> Result<Outcome, TaskError> {
    let mut asked = request("approve_cases");
    asked.actor = "owner".into();
    asked.session = None;
    asked.row = Some(row.into());
    apply(store.connection(), &asked)
}

/// Every cell of `row` gets one case and a clean review.
fn reviewed_row(store: &Store, row: &str) {
    for col in ["gpu", "perf"] {
        cases(store, row, col, json!({"cases": [case(row, col, "dark-room")]})).unwrap();
        review(store, row, col, &[]).unwrap();
    }
}

fn approved_row(store: &Store, row: &str) {
    reviewed_row(store, row);
    approve_row(store, row).unwrap();
}

fn refused<T>(result: Result<T, TaskError>) -> String {
    match result {
        Err(error) => error.message().to_string(),
        Ok(_) => panic!("expected a refusal, but it was accepted"),
    }
}

fn cell_value(store: &Store, row: &str, col: &str, field: &str) -> Option<String> {
    store
        .connection()
        .query_row(
            &format!("SELECT {field} FROM grid_cell WHERE project_id = 'p' AND slug = 'camera' AND row = ?1 AND col = ?2"),
            params![row, col],
            |found| found.get(0),
        )
        .unwrap_or_else(|error| panic!("grid_cell has no {field} for camera.{row}.{col}: {error}"))
}

fn step(store: &Store, row: &str, col: &str) -> String {
    cell_value(store, row, col, "step").unwrap_or_default()
}

fn next(store: &Store, row: &str, col: &str) -> String {
    cell_value(store, row, col, "next").unwrap_or_default()
}

fn payload(store: &Store, cells: &[(&str, &str)]) -> Value {
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let picked: Vec<(String, String)> = cells.iter().map(|(row, col)| (row.to_string(), col.to_string())).collect();
    let label = Label { name: None, count: picked.len(), noun: "cell", shaped: false };
    task_payload(&loaded, &picked, &label)
}

/// `atelier task propose` for these cells: answered by its own route, not
/// by `tasks::apply`.
fn propose(store: &Store, cells: &[(&str, &str)]) -> Result<(), TaskError> {
    let payload = tasks::decided(payload(store, cells));
    tasks::propose(store, "p", "s1", &payload, &Default::default(), None, 2, &Default::default()).map(|_| ())
}

fn create(store: &Store, action: &str, cells: &[(&str, &str)]) -> Result<tasks::Outcome, TaskError> {
    let payload = payload(store, cells);
    tasks::apply(store, &tasks::Request {
        action: action.into(),
        actor: "agent".into(),
        session: Some("s1".into()),
        project: "p".into(),
        payload: tasks::decided(payload),
        cwd: Some("/repo".into()),
        now: 2,
        ..Default::default()
    })
}

fn handed(next: &Value) -> Vec<String> {
    next["create"]["cells"]
        .as_array()
        .map(|cells| cells.iter().map(|c| format!("{}.{}", c["row"].as_str().unwrap(), c["col"].as_str().unwrap())).collect())
        .unwrap_or_default()
}

/// Once the grid is ordered, a new cell is at "cases", and its next command adds them.
#[test]
fn a_new_cell_starts_at_cases() {
    let (_d, store) = store();
    camera(&store);
    assert_eq!(step(&store, "glare", "gpu"), "cases");
    assert_eq!(next(&store, "glare", "gpu"), "atelier grid cases camera glare gpu");
}

/// `grid cases` stores the cell's cases, and the reply names the step and the
/// next command (the review).
#[test]
fn grid_cases_stores_the_cases_and_names_the_review() {
    let (_d, store) = store();
    camera(&store);
    let outcome = cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room"), case("glare", "gpu", "low-sun")]})).unwrap();
    let stored: Value = serde_json::from_str(&cell_value(&store, "glare", "gpu", "cases").unwrap()).unwrap();
    let ids: Vec<&str> = stored.as_array().unwrap().iter().map(|case| case["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["dark-room", "low-sun"]);
    assert_eq!(step(&store, "glare", "gpu"), "cases");
    assert_eq!(next(&store, "glare", "gpu"), "atelier grid review camera glare gpu");
    assert!(outcome.summary.contains("atelier grid review camera glare gpu"), "{}", outcome.summary);
}

/// Rule 4: a case's red must contain its id.
#[test]
fn a_case_whose_red_lacks_its_id_is_refused() {
    let (_d, store) = store();
    camera(&store);
    let mut bad = case("glare", "gpu", "dark-room");
    bad["red"] = json!("FAILED|panicked");
    let message = refused(cases(&store, "glare", "gpu", json!({"cases": [bad]})));
    assert!(message.contains("camera/glare/gpu/dark-room"), "the refusal names the id red must contain: {message}");
    assert!(message.contains("atelier grid cases camera glare gpu"), "the refusal names the next command: {message}");
}

#[test]
fn a_case_id_must_be_a_slug_and_unique() {
    let (_d, store) = store();
    camera(&store);
    let message = refused(cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "Dark Room")]})));
    assert!(message.contains("Dark Room"), "{message}");
    let message = refused(cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark"), case("glare", "gpu", "dark")]})));
    assert!(message.contains("dark") && message.contains("twice"), "{message}");
    let message = refused(cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "gpu")]})));
    assert!(message.contains("column check"), "a case may not take a column check's name: {message}");
}

/// The review is Atelier's, never the agent's own.
#[test]
fn the_agent_cannot_record_its_own_review() {
    let (_d, store) = store();
    camera(&store);
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room")]})).unwrap();
    let mut asked = on(request("review"), "glare", "gpu");
    asked.payload = json!({"gaps": []});
    let message = refused(apply(store.connection(), &asked));
    assert!(message.contains("Atelier runs the coverage review"), "{message}");
    assert_eq!(step(&store, "glare", "gpu"), "cases");
}

#[test]
fn a_review_before_any_case_is_refused() {
    let (_d, store) = store();
    camera(&store);
    let message = refused(review(&store, "glare", "gpu", &[]));
    assert!(message.contains("step cases"), "{message}");
    assert!(message.contains("atelier grid cases camera glare gpu"), "{message}");
}

/// Step 2: a clean review moves the cell to "reviewed".
#[test]
fn a_review_with_no_gaps_moves_the_cell_to_reviewed() {
    let (_d, store) = store();
    camera(&store);
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room")]})).unwrap();
    review(&store, "glare", "gpu", &[]).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "reviewed");
    assert!(next(&store, "glare", "gpu").contains("owner"), "a reviewed cell waits for the owner: {}", next(&store, "glare", "gpu"));
}

/// Each gap must be answered, by a new case or a dismissal with a reason,
/// before the next review runs.
#[test]
fn gaps_must_be_answered_before_the_next_review() {
    let (_d, store) = store();
    camera(&store);
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room")]})).unwrap();
    review(&store, "glare", "gpu", &["the sun behind the camera", "two suns"]).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "cases");
    let message = refused(review(&store, "glare", "gpu", &[]));
    assert!(message.contains("r1g1") && message.contains("r1g2"), "the refusal names the open gaps: {message}");

    let message = refused(cases(&store, "glare", "gpu", json!({"dismiss": {"r1g2": ""}})));
    assert!(message.contains("reason"), "a dismissal needs a reason: {message}");

    let mut answer = case("glare", "gpu", "sun-behind");
    answer["covers"] = json!("r1g1");
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room"), answer], "dismiss": {"r1g2": "one sun only"}})).unwrap();
    assert_eq!(next(&store, "glare", "gpu"), "atelier grid review camera glare gpu");
    review(&store, "glare", "gpu", &[]).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "reviewed");
}

/// Reviews stop after three rounds: once round 3's gaps are answered, the
/// cell is reviewed and the owner sees the answers.
#[test]
fn after_three_rounds_the_answers_go_to_the_owner() {
    let (_d, store) = store();
    camera(&store);
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room")]})).unwrap();
    for round in 1..=3 {
        review(&store, "glare", "gpu", &["one more"]).unwrap();
        cases(&store, "glare", "gpu", json!({"dismiss": {format!("r{round}g1"): "not this feature"}})).unwrap();
    }
    assert_eq!(step(&store, "glare", "gpu"), "reviewed");
    let message = refused(review(&store, "glare", "gpu", &[]));
    assert!(message.contains("3 rounds"), "{message}");
}

/// The owner approves a row only when every cell of it is reviewed.
#[test]
fn the_owner_cannot_approve_a_row_before_every_cell_is_reviewed() {
    let (_d, store) = store();
    camera(&store);
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room")]})).unwrap();
    review(&store, "glare", "gpu", &[]).unwrap();
    let message = refused(approve_row(&store, "glare"));
    assert!(message.contains("glare.perf") && message.contains("step cases"), "{message}");
    assert_eq!(step(&store, "glare", "gpu"), "reviewed");
}

/// Approving a row moves each cell to "approved"; claiming it then moves it to red.
#[test]
fn an_approved_row_is_approved_then_red_once_claimed() {
    let (_d, store) = store();
    camera(&store);
    approved_row(&store, "glare");
    assert_eq!(step(&store, "glare", "gpu"), "approved");
    assert_eq!(step(&store, "glare", "perf"), "approved");
    assert_eq!(step(&store, "sunstar", "gpu"), "cases");
    create(&store, "create", &[("glare", "gpu")]).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "red");
}

/// No cell of a row is claimed before the row is approved: not by
/// `grid next`, `task create` or `task propose`.
#[test]
fn no_cell_of_a_row_is_claimed_before_the_row_is_approved() {
    let (_d, store) = store();
    camera(&store);
    reviewed_row(&store, "glare");
    let message = refused(create(&store, "create", &[("glare", "gpu")]));
    assert!(message.contains("glare") && message.contains("approve"), "{message}");
    let message = refused(propose(&store, &[("glare", "gpu")]));
    assert!(message.contains("glare") && message.contains("approve"), "{message}");

    let next = next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap();
    assert!(handed(&next).is_empty(), "next hands out a cell of a row not approved: {next}");
    assert_eq!(next["finished"], false, "{next}");
    approve_row(&store, "glare").unwrap();
    let next = next_cells(store.connection(), "p", "camera", &Prints::new(), &Scope::First).unwrap();
    assert_eq!(handed(&next), ["glare.gpu"]);
}

/// Editing cases sends the cell back to "cases", and its row needs approval again.
#[test]
fn editing_cases_sends_the_cell_back_to_cases() {
    let (_d, store) = store();
    camera(&store);
    approved_row(&store, "glare");
    cases(&store, "glare", "gpu", json!({"cases": [case("glare", "gpu", "dark-room"), case("glare", "gpu", "fog")]})).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "cases");
    assert_eq!(cell_value(&store, "glare", "gpu", "review"), None, "the old review is cleared");
    let message = refused(create(&store, "create", &[("glare", "perf")]));
    assert!(message.contains("approve"), "{message}");
}

/// Rule 3: a cell's checks are its column's checks and then its own cases.
#[test]
fn a_cells_checks_are_its_columns_and_its_cases() {
    let (_d, store) = store();
    camera(&store);
    approved_row(&store, "glare");
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let checks = loaded.cell_checks("glare", "gpu");
    let names: Vec<&str> = checks.iter().map(|check| check["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["gpu", "dark-room"]);
    assert_eq!(checks[0]["command"], "atelier case camera/glare/gpu/gpu -- cargo test glare_gpu");
    assert_eq!(checks[1]["case"], "camera/glare/gpu/dark-room");
    assert_eq!(checks[1]["red"], "CASE camera/glare/gpu/dark-room FAIL");
}

/// Rule 3: a column template varies only by `{row}`.
#[test]
fn a_column_template_with_another_placeholder_is_refused() {
    let (_d, store) = store();
    let message = refused(draft(&store, "atelier case camera/{row}/gpu/gpu -- cargo test {row}_{scene}"));
    assert!(message.contains("{scene}") && message.contains("{row}"), "{message}");
}

/// Rule 4: a column template's red contains its case id.
#[test]
fn a_column_template_whose_red_lacks_its_case_id_is_refused() {
    let (_d, store) = store();
    let mut draft_request = request("draft");
    draft_request.slug = None;
    draft_request.payload = json!({
        "slug": "camera", "title": "Camera", "area": "The camera.",
        "row_search": {"command": "scripts/rows.sh", "watch": ["camera/"]},
        "columns": [{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "a GPU test",
            "checks": [{"name": "gpu", "command": "cargo test {row}", "kind": "test", "given": "g", "when": "w", "then": "t", "red": "FAILED"}]}],
    });
    draft_request.search = Some(Ok(search::Run { rows: vec![found("glare")], head: Some("h1".into()) }));
    let message = refused(apply(store.connection(), &draft_request));
    assert!(message.contains("camera/{row}/gpu/gpu"), "{message}");
}

/// Rule 6: a cell proved before cases keeps its proof, but it needs cases
/// before it is claimed or proved again.
#[test]
fn a_cell_proved_before_cases_keeps_its_proof_but_needs_cases() {
    let (_d, store) = store();
    camera(&store);
    store
        .connection()
        .execute(
            "UPDATE grid_cell SET state = 'proved', proof = '{\"summary\":\"old\"}', fingerprint = 'f0' WHERE row = 'glare' AND col = 'gpu'",
            [],
        )
        .unwrap();
    refresh_steps(store.connection(), "1 = 1", params![]).unwrap();
    assert_eq!(step(&store, "glare", "gpu"), "proved");
    let loaded = load(store.connection(), "p", "camera").unwrap().unwrap();
    let shown = with_checks(&loaded, "glare", "gpu", cell_json(loaded.cell("glare", "gpu").unwrap(), false, true));
    assert_eq!(shown["needsCases"], true, "{shown}");
    assert_eq!(shown["state"], "proved", "{shown}");

    let mut prove = on(request("prove"), "glare", "gpu");
    prove.payload = json!({"summary": "again"});
    prove.checks = vec![proof::CheckResult { name: "gpu".into(), exit: 0, ms: 1, tail: "CASE camera/glare/gpu/gpu PASS - -".into() }];
    prove.fingerprint = Some("f1".into());
    prove.head = Some("h1".into());
    let message = refused(apply(store.connection(), &prove));
    assert!(message.contains("Needs cases"), "{message}");
    assert!(message.contains("atelier grid cases camera glare gpu"), "{message}");
}

/// Proving checks the CASE line: a check whose output has none is invalid,
/// not passed.
#[test]
fn a_proof_whose_check_prints_no_case_line_is_refused_as_invalid() {
    let (_d, store) = store();
    camera(&store);
    approved_row(&store, "glare");
    create(&store, "create", &[("glare", "gpu")]).unwrap();
    store.connection().execute("UPDATE task SET status = 'in_progress' WHERE number = 1", []).unwrap();
    refresh_steps(store.connection(), "1 = 1", params![]).unwrap();
    let mut prove = on(request("prove"), "glare", "gpu");
    prove.payload = json!({"summary": "done"});
    prove.checks = vec![
        proof::CheckResult { name: "gpu".into(), exit: 0, ms: 1, tail: "test result: ok".into() },
        proof::CheckResult { name: "dark-room".into(), exit: 0, ms: 1, tail: "CASE camera/glare/gpu/dark-room PASS - -".into() },
    ];
    prove.fingerprint = Some("f1".into());
    prove.head = Some("h1".into());
    let message = refused(apply(store.connection(), &prove));
    assert!(message.contains("invalid") && message.contains("CASE camera/glare/gpu/gpu"), "{message}");
}
