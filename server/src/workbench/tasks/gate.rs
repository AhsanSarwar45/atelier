//! The writer's half of checks (docs/tasks.md, "Checks"): judging what the
//! route measured (`checks::Gate`) at start, check, done and an approved
//! amend, and keeping the task's gate: `{hashes: {files, harness}, runs:
//! {ITEM: {CHECK: run}}, flags, met: {ITEM: bool}, startCommit, baseline:
//! {ITEM: {CHECK: {p50, samples}}}, testCommand?}`.
//!
//! A task is gated when its plan has checks; one made before checks keeps
//! the old rules (an entry per item).

use super::checks::{self, Check, Gate, Run};
use super::{record_check, refuse, TaskError, TaskRow};
use serde_json::{json, Value};

pub fn gated(task: &TaskRow) -> bool {
    task.gate.is_some() || checks::is_checked(&task.plan)
}

fn measured<'a>(gate: Option<&'a Gate>, action: &str) -> Result<&'a Gate, TaskError> {
    let found = gate.ok_or_else(|| {
        TaskError::Refused(format!("the server could not run the checks for {action}: the task's chat has no folder"))
    })?;
    if let Some(error) = &found.error {
        return refuse(format!("the server could not run the checks for {action}: {error}"));
    }
    Ok(found)
}

fn stored(task: &TaskRow) -> Value {
    let mut stored = task.gate.clone().unwrap_or_else(|| json!({}));
    for (key, empty) in [("hashes", json!({"files": {}, "harness": []})), ("runs", json!({})), ("flags", json!([])), ("met", json!({}))] {
        if stored.get(key).is_none_or(Value::is_null) {
            stored[key] = empty;
        }
    }
    stored
}

/// `Err` naming the approved files of this item (or the harness) that
/// changed since the owner approved them.
fn locked(stored: &Value, item: &str, checks: &[Check], owned: &[String], found: &Gate) -> Result<(), String> {
    let changed = checks::changed_for(&stored["hashes"], checks, owned, &found.hashes);
    if changed.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{item}: approved check file changed: {}. Put it back as approved; if the check is wrong, run `atelier task amend` \
         with a reason for the owner to approve",
        changed.join(", ")
    ))
}

fn run_of<'a>(found: &'a Gate, item: &str, check: &Check) -> Result<&'a Run, String> {
    found.runs.get(item).and_then(|runs| runs.get(&check.name)).ok_or_else(|| format!("{item}: \"{}\" was not run", check.name))
}

fn baseline(stored: &Value, item: &str, check: &Check) -> Option<f64> {
    stored["baseline"][item][&check.name]["p50"].as_f64()
}

/// Green, and running no fewer tests than at start.
fn green(stored: &Value, item: &str, check: &Check, run: &Run) -> Result<(), String> {
    checks::judge_green(check, run, baseline(stored, item, check))?;
    checks::judge_count(run, stored["baseline"][item][&check.name]["tests"].as_u64())
}

fn recorded(run: &Run, passed: bool, reason: Option<&str>, phase: &str) -> Value {
    let mut value = run.to_json(passed, reason);
    value["phase"] = json!(phase);
    value
}

/// `task start`: no approved file changed, and every check red for its
/// stated reason (a characterisation check green). Stores the starting
/// commit, the runs and each benchmark's baseline.
pub fn start(task: &mut TaskRow, gate: Option<&Gate>) -> Result<Value, TaskError> {
    let found = measured(gate, "start")?;
    let mut stored = stored(task);
    let owned = checks::check_files(&task.kind, &task.plan);
    let mut problems = Vec::new();
    let mut runs = json!({});
    let mut baselines = json!({});
    let mut count = 0;
    let mut kept = 0;
    for (item, checks) in checks::item_checks(&task.kind, &task.plan) {
        if let Err(why) = locked(&stored, &item, &checks, &owned, found) {
            problems.push(why);
            continue;
        }
        for check in &checks {
            let run = match run_of(found, &item, check) {
                Ok(run) => run,
                Err(why) => {
                    problems.push(why);
                    continue;
                }
            };
            count += 1;
            match checks::judge_red(check, run) {
                Ok(p50) => {
                    if let Some(p50) = p50 {
                        baselines[&item][&check.name]["p50"] = json!(p50);
                        baselines[&item][&check.name]["samples"] = json!(run.samples);
                    }
                    if let Some(tests) = checks::tests_ran(&run.output) {
                        baselines[&item][&check.name]["tests"] = json!(tests);
                    }
                    if check.is_characterisation() {
                        kept += 1;
                    }
                    runs[&item][&check.name] = recorded(run, check.is_characterisation(), None, "start");
                }
                Err(why) => problems.push(format!("{item}: \"{}\" {why}", check.name)),
            }
        }
    }
    if !problems.is_empty() {
        return refuse(format!(
            "start is refused: every check must fail first, for its stated reason (a characterisation check must pass). {}",
            problems.join("; ")
        ));
    }
    stored["startCommit"] = json!(found.head);
    stored["baseline"] = baselines;
    stored["runs"] = runs;
    stored["met"] = json!({});
    task.gate = Some(stored);
    task.checks = None;
    Ok(json!({"red": count - kept, "kept": kept, "commit": found.head}))
}

/// What `task check N ITEM` found for a gated task.
pub struct Checked {
    pub met: bool,
    pub passed: usize,
    pub total: usize,
    pub problems: Vec<String>,
}

/// `task check N ITEM`: run the item's checks; tick it when every one
/// passes and none of its approved files changed, untick it otherwise.
pub fn check(task: &mut TaskRow, item: &str, gate: Option<&Gate>) -> Result<Checked, TaskError> {
    let ids: Vec<String> = checks::plan_items(&task.kind, &task.plan).into_iter().map(|(id, _)| id).collect();
    let checks = checks::checks_of(&task.kind, &task.plan, item)
        .ok_or_else(|| TaskError::Refused(format!("\"{item}\" is not an item in the plan (items with checks: {})", ids.join(", "))))?;
    let found = measured(gate, "check")?;
    let mut stored = stored(task);
    let owned = checks::check_files(&task.kind, &task.plan);
    let mut problems = Vec::new();
    if let Err(why) = locked(&stored, item, &checks, &owned, found) {
        problems.push(why);
    }
    let mut passed = 0;
    let mut passing = Vec::new();
    for check in &checks {
        let run = run_of(found, item, check).map_err(TaskError::Refused)?;
        // A check whose own approved files changed does not count as passing,
        // whatever it printed: what ran is no longer the check the owner approved.
        let tampered = !checks::changed_for(&stored["hashes"], std::slice::from_ref(check), &owned, &found.hashes).is_empty();
        let judged = if tampered { Err("ran with an approved file changed".to_string()) } else { green(&stored, item, check, run) };
        match judged {
            Ok(()) => {
                passed += 1;
                passing.push(check.name.clone());
                stored["runs"][item][&check.name] = recorded(run, true, None, "check");
            }
            Err(why) => {
                stored["runs"][item][&check.name] = recorded(run, false, Some(&why), "check");
                problems.push(format!("\"{}\" {why}", check.name));
            }
        }
    }
    let met = problems.is_empty();
    stored["met"][item] = json!(met);
    task.gate = Some(stored);
    if super::types::item_lists(&task.kind).is_some() {
        if met {
            record_check(task, json!({"id": item, "met": true, "checks": passing}));
        } else {
            untick(task, item);
        }
    }
    Ok(Checked { met, passed, total: checks.len(), problems })
}

fn untick(task: &mut TaskRow, item: &str) {
    let Some((_, key)) = super::types::item_lists(&task.kind) else { return };
    let Some(entries) = task.checks.as_mut().and_then(|checks| checks[key].as_array_mut()) else { return };
    entries.retain(|entry| entry["id"].as_str() != Some(item));
    if entries.is_empty() {
        task.checks = None;
    }
}

/// How many plan items are ticked by their checks, of how many.
pub fn ticked(task: &TaskRow) -> (usize, usize) {
    let items = checks::plan_items(&task.kind, &task.plan);
    let met = task.gate.as_ref().map(|gate| gate["met"].clone()).unwrap_or(Value::Null);
    (items.iter().filter(|(id, _)| met[id] == true).count(), items.len())
}

/// `task done`: every check passes, no approved file changed and the
/// project's test command passes. Stores the runs, and break-it's and the
/// diff scan's flags beside the lint's, for the owner's review card.
pub fn done(task: &mut TaskRow, gate: Option<&Gate>) -> Result<(), TaskError> {
    let found = measured(gate, "done")?;
    let mut stored = stored(task);
    let owned = checks::check_files(&task.kind, &task.plan);
    let mut problems = Vec::new();
    for (item, checks) in checks::item_checks(&task.kind, &task.plan) {
        if let Err(why) = locked(&stored, &item, &checks, &owned, found) {
            problems.push(why);
        }
        let mut met = true;
        for check in &checks {
            let run = run_of(found, &item, check).map_err(TaskError::Refused)?;
            match green(&stored, &item, check, run) {
                Ok(()) => stored["runs"][&item][&check.name] = recorded(run, true, None, "done"),
                Err(why) => {
                    met = false;
                    stored["runs"][&item][&check.name] = recorded(run, false, Some(&why), "done");
                    problems.push(format!("{item}: \"{}\" {why}", check.name));
                }
            }
        }
        stored["met"][&item] = json!(met);
    }
    if let Some((command, run)) = &found.test_command {
        let mut value = recorded(run, run.exit == 0, None, "done");
        value["name"] = json!("test_command");
        value["command"] = json!(command);
        stored["testCommand"] = value;
        if run.exit != 0 {
            let tail = super::super::grids::proof::tail(run.output_tail.as_bytes(), 3);
            problems.push(format!("the project's test command `{command}` fails (exit {}): {tail}", run.exit));
        }
    }
    if !problems.is_empty() {
        return refuse(format!("done is refused while a check fails: {}", problems.join("; ")));
    }
    let mut flags: Vec<Value> = stored["flags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|flag| flag["kind"] == "weak")
        .cloned()
        .collect();
    flags.extend(found.flags.iter().cloned());
    stored["flags"] = json!(flags);
    stored["doneCommit"] = json!(found.head);
    task.gate = Some(stored);
    Ok(())
}

/// The agent files an amend of a gated task: a changed check must have its
/// files and, once the task has started, fail against the starting code for
/// its stated reason. The runs and the changed checks' file hashes are kept
/// with the amend, so the owner's approval needs no runs.
pub fn file_amend(task: &mut TaskRow, plan: &Value, gate: Option<&Gate>) -> Result<(), TaskError> {
    let found = measured(gate, "the amend")?;
    let mut stored = stored(task);
    let changed = checks::changed_checks(&task.kind, &task.plan, plan);
    let started = stored["startCommit"].is_string();
    let mut problems = Vec::new();
    let (mut runs, mut baseline, mut files) = (json!({}), json!({}), serde_json::Map::new());
    for (item, checks) in &changed {
        for check in checks {
            for path in &check.files {
                match found.hashes.get(path) {
                    Some(sha) if sha == checks::MISSING => {
                        problems.push(format!("{item}: \"{}\" names {path}, which is not in the chat's folder", check.name))
                    }
                    Some(sha) => {
                        files.insert(path.clone(), json!(sha));
                    }
                    None => {}
                }
            }
            if !started {
                continue;
            }
            let run = match run_of(found, item, check) {
                Ok(run) => run,
                Err(why) => {
                    problems.push(why);
                    continue;
                }
            };
            match checks::judge_red(check, run) {
                Ok(p50) => {
                    runs[item][&check.name] = recorded(run, check.is_characterisation(), None, "amend");
                    if let Some(p50) = p50 {
                        baseline[item][&check.name]["p50"] = json!(p50);
                        baseline[item][&check.name]["samples"] = json!(run.samples);
                    }
                    if let Some(tests) = checks::tests_ran(&run.output) {
                        baseline[item][&check.name]["tests"] = json!(tests);
                    }
                }
                Err(why) => problems.push(format!("{item}: \"{}\" {why} (an amended check must fail against the starting code, as at start)", check.name)),
            }
        }
    }
    if !problems.is_empty() {
        return refuse(format!("the amend cannot be filed: {}", problems.join("; ")));
    }
    stored["amendProof"] = json!({"runs": runs, "baseline": baseline, "files": files});
    task.gate = Some(stored);
    Ok(())
}

/// The owner approves an amend of a gated task. Its changed checks were
/// proved when it was filed; approval only confirms their files are as they
/// were then, keeps those runs, and locks the changed checks' files anew
/// while the rest keep their approval.
pub fn approve_amend(task: &mut TaskRow, plan: &Value, gate: Option<&Gate>) -> Result<(), TaskError> {
    checks::require_checks(&task.kind, plan)?;
    let found = measured(gate, "the amend")?;
    let mut stored = stored(task);
    let changed = checks::changed_checks(&task.kind, &task.plan, plan);
    let proof = stored.as_object_mut().and_then(|stored| stored.remove("amendProof")).unwrap_or(Value::Null);
    if !changed.is_empty() && proof.is_null() {
        return refuse("the amend cannot be approved: it was filed before amends were checked when filed; the agent must file it again".to_string());
    }
    let moved: Vec<String> = proof["files"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(path, sha)| found.hashes.get(path.as_str()).map(|now| json!(now)) != Some((*sha).clone()))
        .map(|(path, _)| format!("{path} changed since the amend was filed"))
        .collect();
    if !moved.is_empty() {
        return refuse(format!("the amend cannot be approved: {}; the agent must file it again", moved.join("; ")));
    }
    for key in ["runs", "baseline"] {
        for (item, checks) in proof[key].as_object().into_iter().flatten() {
            for (name, value) in checks.as_object().into_iter().flatten() {
                stored[key][item][name] = value.clone();
            }
        }
    }
    let fresh: Vec<String> = changed.iter().flat_map(|(_, checks)| checks.iter().flat_map(|check| check.files.clone())).collect();
    let harness: Vec<String> =
        stored["hashes"]["harness"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    let mut files = serde_json::Map::new();
    // The changed checks' test folders are locked again as they are now.
    let roots: Vec<String> = fresh.iter().filter_map(|path| checks::test_folder(path)).collect();
    let owned = checks::check_files(&task.kind, plan);
    let mut paths = checks::locked_paths(&task.kind, plan, &harness);
    paths.extend(found.hashes.keys().filter(|path| !paths.contains(path)).cloned().collect::<Vec<_>>());
    for path in paths {
        let before = stored["hashes"]["files"].get(&path).cloned();
        let now = found.hashes.get(&path).map(|sha| json!(sha));
        // An unchanged check's own file keeps its approval.
        let renewed = fresh.contains(&path) || (!owned.contains(&path) && roots.iter().any(|root| path.starts_with(&format!("{root}/"))));
        let kept = if renewed { now.or(before) } else { before.or(now) };
        if let Some(sha) = kept {
            files.insert(path, sha);
        }
    }
    stored["hashes"]["files"] = Value::Object(files);
    // Items that changed are ticked again by their checks.
    for (item, _) in &changed {
        stored["met"][item] = json!(false);
    }
    task.gate = Some(stored);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::{apply, get, Outcome, Request};
    use super::*;
    use crate::workbench::store::Store;

    fn store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let id = "m0";
        store.open_message("s1", id, "user", "2026-01-01T00:00:00Z").unwrap();
        store.grow_message("s1", id, "@task do it").unwrap();
        (directory, store)
    }

    fn ask(store: &Store, action: &str, number: Option<i64>, payload: Value, gate: Option<Gate>) -> Result<Outcome, TaskError> {
        let owner = matches!(action, "approve_amend" | "reject_amend");
        apply(store, &Request {
            action: action.into(),
            actor: if owner { "owner" } else { "agent" }.into(),
            session: (!owner).then(|| "s1".to_string()),
            project: "p".into(),
            number,
            payload,
            gate,
            now: 1,
            ..Default::default()
        })
    }

    fn refused(result: Result<Outcome, TaskError>) -> String {
        match result {
            Err(TaskError::Refused(message)) => message,
            Err(TaskError::Failed(message)) => panic!("failed, not refused: {message}"),
            Ok(outcome) => panic!("expected a refusal, got: {}", outcome.summary),
        }
    }

    pub(crate) fn check(name: &str, file: &str) -> Value {
        json!({"name": name, "command": format!("cargo test {name}"), "kind": "test", "given": "g", "when": "w", "then": "t",
            "red": "FAILED|panicked", "files": [file]})
    }

    /// A feature with criteria export (checks a, b, c) and images (check i).
    fn plan() -> Value {
        json!({"outcome": "o", "criteria": [
            {"id": "export", "text": "x", "checks": [check("a", "tests/a.rs"), check("b", "tests/b.rs"), check("c", "tests/c.rs")]},
            {"id": "images", "text": "y", "checks": [check("i", "tests/i.rs")]},
        ]})
    }

    fn hashes(changed: &[&str]) -> std::collections::BTreeMap<String, String> {
        ["tests/a.rs", "tests/b.rs", "tests/c.rs", "tests/i.rs", "Cargo.toml"]
            .iter()
            .map(|path| (path.to_string(), if changed.contains(path) { "changed" } else { "approved" }.to_string()))
            .collect()
    }

    /// A gate as the route measures it: each check's run (exit, output).
    pub(crate) fn measured(runs: &[(&str, &str, i32, &str)], changed: &[&str]) -> Gate {
        let mut gate = Gate { head: Some("abc1234".into()), hashes: hashes(changed), harness: vec!["Cargo.toml".into()], ..Default::default() };
        for (item, name, exit, output) in runs {
            let run = Run { command: format!("cargo test {name}"), exit: *exit, output: output.to_string(), output_tail: output.to_string(), commit: Some("abc1234".into()), ..Default::default() };
            gate.runs.entry(item.to_string()).or_default().insert(name.to_string(), run);
        }
        gate
    }

    const FAILING: &str = "test a ... FAILED";

    /// For tests of other rules: what the route would measure for a gated
    /// task's start (every check red) or check and done (every check green),
    /// with no files locked.
    pub(crate) fn simulated(task: Option<&TaskRow>, action: &str) -> Option<Gate> {
        let task = task.filter(|task| gated(task))?;
        let exit = match action {
            "start" => 101,
            "check" | "done" => 0,
            _ => return None,
        };
        let mut gate = Gate { head: Some("abc1234".into()), ..Default::default() };
        for (item, checks) in checks::item_checks(&task.kind, &task.plan) {
            for check in checks {
                let output = if exit == 0 { "ok".to_string() } else { format!("{FAILING}\n{}", check.red.clone().unwrap_or_default()) };
                let run = Run { exit: if check.is_characterisation() { 0 } else { exit }, output: output.clone(), output_tail: output, ..Default::default() };
                gate.runs.entry(item.clone()).or_default().insert(check.name, run);
            }
        }
        Some(gate)
    }

    fn red() -> Gate {
        measured(&[("export", "a", 101, FAILING), ("export", "b", 101, FAILING), ("export", "c", 101, FAILING), ("images", "i", 101, FAILING)], &[])
    }

    fn green(failing: &[&str]) -> Gate {
        let runs: Vec<(&str, &str, i32, &str)> = [("export", "a"), ("export", "b"), ("export", "c"), ("images", "i")]
            .into_iter()
            .map(|(item, name)| if failing.contains(&name) { (item, name, 101, FAILING) } else { (item, name, 0, "ok") })
            .collect();
        measured(&runs, &[])
    }

    fn created(store: &Store, plan: Value) -> i64 {
        let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan});
        ask(store, "create", None, payload, Some(measured(&[], &[]))).unwrap().task.number
    }

    #[test]
    fn start_needs_every_check_red_for_its_stated_reason() {
        let (_d, store) = store();
        let one = created(&store, plan());
        assert!(refused(ask(&store, "start", Some(one), json!({}), None)).contains("could not run the checks"));
        let mut gate = red();
        gate.runs.get_mut("export").unwrap().insert("b".into(), Run { exit: 0, output: "ok".into(), ..Default::default() });
        let message = refused(ask(&store, "start", Some(one), json!({}), Some(gate)));
        assert!(message.contains("export: \"b\" already passes, so it proves nothing"), "{message}");
        let mut gate = red();
        gate.runs.get_mut("images").unwrap().insert("i".into(), Run { exit: 1, output: "error[E0425]: cannot find value".into(), output_tail: "error[E0425]: cannot find value".into(), ..Default::default() });
        let message = refused(ask(&store, "start", Some(one), json!({}), Some(gate)));
        assert!(message.contains("images: \"i\" failed for another reason: its output does not match red /FAILED|panicked/: error[E0425]"), "{message}");
        assert_eq!(get(store.connection(), "p", one).unwrap().unwrap().status, "todo");
        let outcome = ask(&store, "start", Some(one), json!({}), Some(red())).unwrap();
        assert_eq!(outcome.task.status, "in_progress");
        let stored = outcome.task.gate.unwrap();
        assert_eq!(stored["startCommit"], "abc1234");
        assert_eq!((stored["runs"]["export"]["a"]["exit"].clone(), stored["runs"]["export"]["a"]["passed"].clone()), (json!(101), json!(false)));
        assert!(outcome.summary.contains("All 4 checks fail"), "{}", outcome.summary);
    }

    #[test]
    fn a_characterisation_check_must_pass_at_start() {
        let (_d, store) = store();
        let mut keep = check("keeps", "tests/k.rs");
        keep["kind"] = json!("characterisation");
        keep.as_object_mut().unwrap().remove("red");
        let one = created(&store, json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [keep]}]}));
        let message = refused(ask(&store, "start", Some(one), json!({}), Some(measured(&[("export", "keeps", 1, "1 failed")], &[]))));
        assert!(message.contains("export: \"keeps\" is a characterisation check and must pass before the change"), "{message}");
        let started = ask(&store, "start", Some(one), json!({}), Some(measured(&[("export", "keeps", 0, "ok")], &[]))).unwrap();
        assert!(started.summary.contains("The characterisation check passes"), "a passing check is not said to fail: {}", started.summary);
    }

    #[test]
    fn a_changed_approved_file_fails_start_check_and_done() {
        let (_d, store) = store();
        let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan()});
        let one = ask(&store, "create", None, payload, Some(measured(&[], &[]))).unwrap().task.number;
        let mut gate = red();
        gate.hashes = hashes(&["tests/b.rs"]);
        let message = refused(ask(&store, "start", Some(one), json!({}), Some(gate)));
        assert!(message.contains("export: approved check file changed: tests/b.rs"), "{message}");
        assert!(!message.contains("images:"), "only the item whose file changed: {message}");
        let mut gate = red();
        gate.hashes = hashes(&["Cargo.toml"]);
        let message = refused(ask(&store, "start", Some(one), json!({}), Some(gate)));
        assert!(message.contains("images: approved check file changed: Cargo.toml"), "the harness is every item's: {message}");
        ask(&store, "start", Some(one), json!({}), Some(red())).unwrap();
        // At check the item is not met while its file is changed, even with every check green.
        let mut gate = green(&[]);
        gate.hashes = hashes(&["tests/a.rs"]);
        let outcome = ask(&store, "check", Some(one), json!({"item": "export"}), Some(gate)).unwrap();
        assert_eq!(outcome.detail["met"], false);
        assert!(outcome.summary.contains("approved check file changed: tests/a.rs"), "{}", outcome.summary);
        // The check whose file changed is not counted as passing.
        assert_eq!(outcome.detail["passed"].as_u64().unwrap() + 1, outcome.detail["total"].as_u64().unwrap(), "{}", outcome.detail);
        let mut gate = green(&[]);
        gate.hashes = hashes(&["tests/i.rs"]);
        let message = refused(ask(&store, "done", Some(one), json!({"summary": "s", "commits": ["abcdef1"], "result": {}}), Some(gate)));
        assert!(message.contains("images: approved check file changed: tests/i.rs"), "{message}");
    }

    fn started(store: &Store, plan: Value, gate: Gate) -> i64 {
        let one = created(store, plan);
        ask(store, "start", Some(one), json!({}), Some(gate)).unwrap();
        one
    }

    #[test]
    fn the_server_ticks_an_item_only_when_every_check_passes_and_says_2_of_3() {
        let (_d, store) = store();
        let one = started(&store, plan(), red());
        let message = refused(ask(&store, "check", Some(one), json!({"item": "export", "entry": {"met": true, "evidence": "trust me"}}), Some(green(&[]))));
        assert!(message.contains("has checks, so check takes no entry"), "{message}");
        assert!(refused(ask(&store, "check", Some(one), json!({"item": "nope"}), Some(green(&[])))).contains("\"nope\" is not an item in the plan"));
        let outcome = ask(&store, "check", Some(one), json!({"item": "export"}), Some(green(&["c"]))).unwrap();
        assert_eq!(outcome.detail, json!({"item": "export", "met": false, "passed": 2, "total": 3,
            "reason": "\"c\" fails (exit 101): test a ... FAILED"}));
        assert!(outcome.summary.contains("\"export\" is not met: 2 of 3 checks pass"), "{}", outcome.summary);
        assert!(outcome.task.checks.is_none(), "nothing is ticked");
        let runs = &outcome.task.gate.as_ref().unwrap()["runs"]["export"];
        assert_eq!((runs["a"]["passed"].clone(), runs["a"]["exit"].clone(), runs["a"]["commit"].clone()), (json!(true), json!(0), json!("abc1234")));
        assert_eq!((runs["c"]["passed"].clone(), runs["c"]["outputTail"].clone()), (json!(false), json!(FAILING)));
        let outcome = ask(&store, "check", Some(one), json!({"item": "export"}), Some(green(&[]))).unwrap();
        assert_eq!((outcome.detail["met"].clone(), outcome.detail["passed"].clone()), (json!(true), json!(3)));
        assert!(outcome.summary.contains("3 of 3 checks pass. 1 of 2 items ticked"), "{}", outcome.summary);
        assert_eq!(outcome.task.checks.as_ref().unwrap()["criteria"][0], json!({"id": "export", "met": true, "checks": ["a", "b", "c"]}));
        assert_eq!(super::super::to_json(&store, &outcome.task)["checkMet"], json!({"export": true}));
        // A later failure unticks it.
        let outcome = ask(&store, "check", Some(one), json!({"item": "export"}), Some(green(&["a"]))).unwrap();
        assert!(outcome.task.checks.is_none());
        assert_eq!(outcome.task.gate.unwrap()["met"]["export"], false);
    }

    fn done_payload() -> Value {
        json!({"summary": "s", "commits": ["abcdef1"], "result": {}})
    }

    #[test]
    fn done_reruns_every_check_and_the_test_command_and_is_refused_while_one_fails() {
        let (_d, store) = store();
        let one = started(&store, plan(), red());
        let message = refused(ask(&store, "done", Some(one), done_payload(), Some(green(&["i"]))));
        assert!(message.starts_with("done is refused while a check fails: images: \"i\" fails (exit 101)"), "{message}");
        let mut gate = green(&[]);
        let failing = Run { exit: 2, output_tail: "error: 3 tests failed".into(), ..Default::default() };
        gate.test_command = Some(("npm test".into(), failing));
        let message = refused(ask(&store, "done", Some(one), done_payload(), Some(gate)));
        assert!(message.contains("the project's test command `npm test` fails (exit 2): error: 3 tests failed"), "{message}");
        // Item entries are not given: the checks met them.
        let mut given = done_payload();
        given["result"] = json!({"criteria": [{"id": "export", "met": true, "evidence": "e"}]});
        let message = refused(ask(&store, "done", Some(one), given, Some(green(&[]))));
        assert!(message.contains("criteria is not given for a task with checks"), "{message}");
        let mut gate = green(&[]);
        gate.test_command = Some(("npm test".into(), Run { exit: 0, ..Default::default() }));
        let outcome = ask(&store, "done", Some(one), done_payload(), Some(gate)).unwrap();
        assert_eq!(outcome.task.status, "done");
        let stored = outcome.task.gate.unwrap();
        assert_eq!((stored["met"]["export"].clone(), stored["met"]["images"].clone()), (json!(true), json!(true)));
        assert_eq!((stored["testCommand"]["command"].clone(), stored["testCommand"]["passed"].clone()), (json!("npm test"), json!(true)));
    }

    fn bench(budget: Value) -> Value {
        json!({"name": "p50", "command": "scripts/bench.sh", "kind": "benchmark", "given": "g", "when": "w", "then": "t",
            "files": ["tests/a.rs"], "bench": {"value": "p50_ms=([0-9.]+)", "runs": 10, "budget": budget}})
    }

    fn timed(p50: f64) -> Gate {
        let mut gate = measured(&[], &[]);
        let run = Run { exit: 0, value: Some(p50), samples: Some(vec![p50; 10]), output: format!("p50_ms={p50}"), ..Default::default() };
        gate.runs.entry("export".into()).or_default().insert("p50".into(), run);
        gate
    }

    #[test]
    fn a_benchmark_starts_over_its_absolute_budget_and_is_done_within_it() {
        let (_d, store) = store();
        let one = created(&store, json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [bench(json!({"max": 100, "unit": "ms"}))]}]}));
        let message = refused(ask(&store, "start", Some(one), json!({}), Some(timed(90.0))));
        assert!(message.contains("export: \"p50\" already meets its budget (p50 90 ms ≤ 100), so it proves nothing"), "{message}");
        let outcome = ask(&store, "start", Some(one), json!({}), Some(timed(150.0))).unwrap();
        let stored = outcome.task.gate.unwrap();
        assert_eq!(stored["baseline"]["export"]["p50"]["p50"], 150.0);
        assert_eq!(stored["baseline"]["export"]["p50"]["samples"].as_array().unwrap().len(), 10);
        let message = refused(ask(&store, "done", Some(one), done_payload(), Some(timed(120.0))));
        assert!(message.contains("p50 120 ms is over the budget of 100"), "{message}");
        let outcome = ask(&store, "done", Some(one), done_payload(), Some(timed(95.0))).unwrap();
        assert_eq!(outcome.task.gate.unwrap()["runs"]["export"]["p50"]["value"], 95.0);
    }

    #[test]
    fn a_relative_benchmark_is_judged_against_its_start_of_task_baseline() {
        let (_d, store) = store();
        let one = created(&store, json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [bench(json!({"improve_pct": 20, "unit": "ms"}))]}]}));
        ask(&store, "start", Some(one), json!({}), Some(timed(100.0))).unwrap();
        let outcome = ask(&store, "check", Some(one), json!({"item": "export"}), Some(timed(85.0))).unwrap();
        assert_eq!(outcome.detail["met"], false);
        assert!(outcome.summary.contains("p50 85 ms is not 20% under the baseline 100"), "{}", outcome.summary);
        let outcome = ask(&store, "check", Some(one), json!({"item": "export"}), Some(timed(79.0))).unwrap();
        assert_eq!(outcome.detail["met"], true);
        ask(&store, "done", Some(one), done_payload(), Some(timed(80.0))).unwrap();
    }

    /// The whole path with real commands in a real repository: red at
    /// start, a fix committed, the server's tick, and done.
    #[tokio::test]
    async fn real_checks_go_red_then_green_through_measure() {
        use crate::workbench::grids::proof::tests::{commit_file, repository};
        let root = repository();
        let dir = root.path();
        commit_file(dir, "src/value.txt", "1\n");
        commit_file(dir, "tests/value.sh", "grep -qx 2 src/value.txt || { echo 'value FAILED'; exit 1; }\n");
        let check = json!({"name": "two", "command": "sh tests/value.sh", "kind": "test", "given": "g", "when": "w", "then": "t",
            "red": "value FAILED", "files": ["tests/value.sh"]});
        let plan = json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [check]}]});
        let (_d, store) = store();
        let draft = checks::draft_gate(dir, "feature", &plan, &[]);
        let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan});
        let one = ask(&store, "create", None, payload, Some(draft)).unwrap().task.number;
        let stored = |store: &Store| get(store.connection(), "p", one).unwrap().unwrap();
        let task = stored(&store);
        let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), checks::Measure::Start, 1).await;
        ask(&store, "start", Some(one), json!({}), Some(gate)).unwrap();
        commit_file(dir, "src/value.txt", "2\n");
        let task = stored(&store);
        let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), checks::Measure::Item("export".into()), 2).await;
        assert_eq!(ask(&store, "check", Some(one), json!({"item": "export"}), Some(gate)).unwrap().detail["met"], true);
        // Tampering with the approved check is caught at done.
        std::fs::write(dir.join("tests/value.sh"), "true\n").unwrap();
        let task = stored(&store);
        let done = checks::Measure::Done { test_command: Some("test -f src/value.txt".into()) };
        let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), done.clone(), 3).await;
        assert!(refused(ask(&store, "done", Some(one), done_payload(), Some(gate))).contains("approved check file changed: tests/value.sh"));
        std::fs::write(dir.join("tests/value.sh"), "grep -qx 2 src/value.txt || { echo 'value FAILED'; exit 1; }\n").unwrap();
        let gate = checks::measure(dir, &task.kind, &task.plan, task.gate.as_ref().unwrap(), done, 4).await;
        assert!(gate.flags.is_empty(), "{:?}", gate.flags);
        let outcome = ask(&store, "done", Some(one), done_payload(), Some(gate)).unwrap();
        assert_eq!(outcome.task.status, "done");
    }

    #[tokio::test]
    async fn done_measures_break_it_and_the_diff_scan_once_every_check_passes() {
        use crate::workbench::grids::proof::tests::{commit_file, git_run, repository};
        let root = repository();
        let dir = root.path();
        commit_file(dir, "src/value.txt", "1\n");
        commit_file(dir, "tests/value.sh", "grep -qx 2 src/value.txt || { echo 'value FAILED'; exit 1; }\n");
        commit_file(dir, "src/a.test.ts", "it('exports', () => {})\n");
        let start = git_run(dir, &["rev-parse", "HEAD"]);
        commit_file(dir, "src/value.txt", "2\n");
        commit_file(dir, "src/a.test.ts", "it.skip('exports', () => {})\n");
        let real = json!({"name": "real", "command": "sh tests/value.sh", "kind": "test", "given": "g", "when": "w", "then": "t",
            "red": "value FAILED", "files": ["tests/value.sh"]});
        let empty = json!({"name": "empty", "command": "test -f tests/value.sh", "kind": "test", "given": "g", "when": "w", "then": "t",
            "files": ["tests/value.sh"]});
        let plan = json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [real, empty]}]});
        let stored = json!({"hashes": {"files": {}, "harness": []}, "startCommit": start});
        let done = checks::Measure::Done { test_command: None };
        let gate = checks::measure(dir, "feature", &plan, &stored, done.clone(), 1).await;
        let kinds: Vec<(String, String)> = gate.flags.iter()
            .map(|f| (f["kind"].as_str().unwrap().to_string(), f["check"].as_str().unwrap_or("").to_string())).collect();
        assert!(kinds.contains(&("proves-nothing".into(), "empty".into())), "{kinds:?}");
        assert!(!kinds.contains(&("proves-nothing".into(), "real".into())), "{kinds:?}");
        assert!(kinds.iter().any(|(kind, _)| kind == "skip-added"), "{kinds:?}");
        assert_eq!(git_run(dir, &["status", "--porcelain"]), "", "the checkout is untouched");
        assert_eq!(git_run(dir, &["worktree", "list"]).lines().count(), 1, "the scratch worktree is gone");
        // While a check fails the audits do not run.
        std::fs::write(dir.join("src/value.txt"), "3\n").unwrap();
        assert!(checks::measure(dir, "feature", &plan, &stored, done, 2).await.flags.is_empty());
    }

    #[test]
    fn done_keeps_the_lint_and_adds_break_it_and_diff_flags_for_the_owner() {
        let (_d, store) = store();
        let mut gate = measured(&[], &[]);
        gate.flags = vec![json!({"kind": "weak", "item": "export", "check": "a", "text": "\"a\" has no red pattern"})];
        let payload = json!({"type": "feature", "title": "T", "why": "W", "plan": plan()});
        let one = ask(&store, "create", None, payload, Some(gate)).unwrap().task.number;
        ask(&store, "start", Some(one), json!({}), Some(red())).unwrap();
        let mut gate = green(&[]);
        gate.flags = vec![
            json!({"kind": "proves-nothing", "item": "images", "check": "i", "text": "\"i\" still passes with the task's changes undone, so it proves nothing"}),
            json!({"kind": "skip-added", "text": "src/a.test.ts adds a skip or only marker: it.skip('exports', () => {"}),
            json!({"kind": "exit-in-test", "text": "src/a.test.ts adds an exit call in a test file: process.exit(0)"}),
            json!({"kind": "test-deleted", "text": "the test file tests/old.rs was deleted"}),
        ];
        let outcome = ask(&store, "done", Some(one), done_payload(), Some(gate)).unwrap();
        let shown = super::super::to_json(&store, &outcome.task);
        let kinds: Vec<&str> = shown["checkFlags"].as_array().unwrap().iter().map(|f| f["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["weak", "proves-nothing", "skip-added", "exit-in-test", "test-deleted"]);
        assert_eq!(outcome.task.status, "done", "flags inform the owner; they do not refuse done");
    }

    #[test]
    fn an_amend_needs_a_reason_and_a_changed_check_must_go_red_again() {
        let (_d, store) = store();
        let one = started(&store, plan(), red());
        ask(&store, "check", Some(one), json!({"item": "export"}), Some(green(&[]))).unwrap();
        let mut new_plan = plan();
        new_plan["criteria"][1]["checks"][0]["command"] = json!("cargo test i -- --exact images_are_linked");
        let message = refused(ask(&store, "amend", Some(one), json!({"plan": new_plan}), None));
        assert!(message.starts_with("reason is required: amend takes {plan, reason}"), "{message}");
        let mut unchecked = plan();
        unchecked["criteria"][1].as_object_mut().unwrap().remove("checks");
        let message = refused(ask(&store, "amend", Some(one), json!({"plan": unchecked, "reason": "r"}), None));
        assert!(message.contains("has no checks"), "{message}");
        let reason = "\"i\" runs every test in the file, and one needs a GPU";
        // The changed check is run against the starting code when the amend is filed: still green there, it is refused.
        assert!(refused(ask(&store, "amend", Some(one), json!({"plan": new_plan, "reason": reason}), None)).contains("could not run the checks"));
        let gate = measured(&[("images", "i", 0, "ok")], &["tests/i.rs"]);
        let message = refused(ask(&store, "amend", Some(one), json!({"plan": new_plan, "reason": reason}), Some(gate)));
        assert!(message.contains("images: \"i\" already passes, so it proves nothing (an amended check must fail against the starting code"), "{message}");
        let gate = measured(&[("images", "i", 101, FAILING)], &["tests/i.rs", "tests/a.rs"]);
        let outcome = ask(&store, "amend", Some(one), json!({"plan": new_plan, "reason": reason}), Some(gate.clone())).unwrap();
        assert_eq!(outcome.detail["reason"], reason);
        assert_eq!(super::super::to_json(&store, &outcome.task)["amendReason"], reason);
        let outcome = ask(&store, "approve_amend", Some(one), json!({}), Some(gate)).unwrap();
        let stored = outcome.task.gate.clone().unwrap();
        assert_eq!(stored["hashes"]["files"]["tests/i.rs"], "changed", "the changed check's file is locked anew");
        assert_eq!(stored["hashes"]["files"]["tests/a.rs"], "approved", "an unchanged check keeps its approval");
        assert_eq!(stored["met"], json!({"export": true, "images": false}));
        assert!(stored.get("amendReason").is_none());
        assert_eq!(outcome.task.plan, new_plan);
    }

    #[tokio::test]
    async fn an_amended_check_runs_against_the_starting_code() {
        use crate::workbench::grids::proof::tests::{commit_file, git_run, repository};
        let root = repository();
        let dir = root.path();
        commit_file(dir, "src/value.txt", "1\n");
        commit_file(dir, "tests/value.sh", "grep -qx 2 src/value.txt || { echo 'value FAILED'; exit 1; }\n");
        let start = git_run(dir, &["rev-parse", "HEAD"]);
        commit_file(dir, "src/value.txt", "2\n");
        let check = |command: &str| json!({"name": "two", "command": command, "kind": "test", "given": "g", "when": "w", "then": "t",
            "red": "value FAILED", "files": ["tests/value.sh"]});
        let old = json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [check("sh tests/value.sh")]}]});
        let new = json!({"outcome": "o", "criteria": [{"id": "export", "text": "x", "checks": [check("sh tests/value.sh && test -s src/value.txt")]}]});
        let stored = json!({"hashes": {"files": {}, "harness": []}, "startCommit": start});
        let gate = checks::measure(dir, "feature", &old, &stored, checks::Measure::Amend { plan: new }, 1).await;
        let run = &gate.runs["export"]["two"];
        assert_eq!(run.exit, 1, "red against the starting code, though it passes at HEAD: {run:?}");
        assert!(run.output.contains("value FAILED"));
        assert_eq!(git_run(dir, &["worktree", "list"]).lines().count(), 1);
    }
}
