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
fn locked(stored: &Value, item: &str, checks: &[Check], found: &Gate) -> Result<(), String> {
    let changed = checks::changed_for(&stored["hashes"], checks, &found.hashes);
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
    let mut problems = Vec::new();
    let mut runs = json!({});
    let mut baselines = json!({});
    let mut count = 0;
    for (item, checks) in checks::item_checks(&task.kind, &task.plan) {
        if let Err(why) = locked(&stored, &item, &checks, found) {
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
                        baselines[&item][&check.name] = json!({"p50": p50, "samples": run.samples});
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
    Ok(json!({"red": count, "commit": found.head}))
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
    let mut problems = Vec::new();
    if let Err(why) = locked(&stored, item, &checks, found) {
        problems.push(why);
    }
    let mut passed = 0;
    let mut passing = Vec::new();
    for check in &checks {
        let run = run_of(found, item, check).map_err(TaskError::Refused)?;
        match checks::judge_green(check, run, baseline(&stored, item, check)) {
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
    let mut problems = Vec::new();
    for (item, checks) in checks::item_checks(&task.kind, &task.plan) {
        if let Err(why) = locked(&stored, &item, &checks, found) {
            problems.push(why);
        }
        let mut met = true;
        for check in &checks {
            let run = run_of(found, &item, check).map_err(TaskError::Refused)?;
            match checks::judge_green(check, run, baseline(&stored, &item, check)) {
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

/// The owner approves an amend of a gated task: its new plan needs checks
/// on every item, a changed check must have its files and, once the task
/// has started, fail against the starting code for its stated reason. The
/// changed checks' files are locked anew; the rest keep their approval.
pub fn approve_amend(task: &mut TaskRow, plan: &Value, gate: Option<&Gate>) -> Result<(), TaskError> {
    checks::require_checks(&task.kind, plan)?;
    let found = measured(gate, "the amend")?;
    let mut stored = stored(task);
    let changed = checks::changed_checks(&task.kind, &task.plan, plan);
    let started = stored["startCommit"].is_string();
    let mut problems = Vec::new();
    let mut fresh = Vec::new();
    for (item, checks) in &changed {
        for check in checks {
            for path in &check.files {
                if found.hashes.get(path).map(String::as_str) == Some(checks::MISSING) {
                    problems.push(format!("{item}: \"{}\" names {path}, which is not in the chat's folder", check.name));
                }
                fresh.push(path.clone());
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
                    stored["runs"][item][&check.name] = recorded(run, check.is_characterisation(), None, "amend");
                    if let Some(p50) = p50 {
                        stored["baseline"][item][&check.name] = json!({"p50": p50, "samples": run.samples});
                    }
                }
                Err(why) => problems.push(format!("{item}: \"{}\" {why} (an amended check must fail against the starting code, as at start)", check.name)),
            }
        }
    }
    if !problems.is_empty() {
        return refuse(format!("the amend cannot be approved: {}", problems.join("; ")));
    }
    let harness: Vec<String> =
        stored["hashes"]["harness"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    let mut files = serde_json::Map::new();
    for path in checks::locked_paths(&task.kind, plan, &harness) {
        let before = stored["hashes"]["files"].get(&path).cloned();
        let now = found.hashes.get(&path).map(|sha| json!(sha));
        let kept = if fresh.contains(&path) { now.or(before) } else { before.or(now) };
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
        ask(&store, "start", Some(one), json!({}), Some(measured(&[("export", "keeps", 0, "ok")], &[]))).unwrap();
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
        let mut gate = green(&[]);
        gate.hashes = hashes(&["tests/i.rs"]);
        let message = refused(ask(&store, "done", Some(one), json!({"summary": "s", "commits": ["abcdef1"], "result": {}}), Some(gate)));
        assert!(message.contains("images: approved check file changed: tests/i.rs"), "{message}");
    }
}
