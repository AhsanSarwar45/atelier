//! Test-first checks (docs/tasks.md, "Checks").
//!
//! Every plan item of a task made under these rules carries `checks`: shell
//! commands written before the work, approved by the owner, run by the
//! server. This module reads and validates them, lints weak ones, runs them
//! (benchmarks repeated and timed), judges red and green, hashes the files
//! they rely on, and scans the diff at `done` for added skips and deleted
//! tests.
//!
//! What touches the outside world (running, hashing, git) is async and is
//! done by the route before the database writer; the writer only judges what
//! it is handed (`Gate`).

use crate::workbench::grids::proof;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

pub const KINDS: &[&str] = &["test", "benchmark", "structure", "characterisation"];
pub const FIELDS: &[&str] = &["name", "command", "kind", "given", "when", "then", "red", "timeout_s", "files", "watch", "bench"];
pub const DEFAULT_TIMEOUT_S: u64 = proof::CHECK_TIMEOUT_S;
pub const MAX_TIMEOUT_S: u64 = proof::CHECK_TIMEOUT_MAX_S;
/// A benchmark is timed at least this many times after its warmup.
pub const MIN_RUNS: u64 = 10;
pub const MAX_RUNS: u64 = 200;
/// The item id under which a type with no item list (bug, plan, review)
/// keeps its plan's own `checks`.
pub const PLAN_ITEM: &str = "plan";
/// How a missing file is hashed.
pub const MISSING: &str = "missing";

/* ------------------------------------------------------------- the spec */

#[derive(Clone, Debug, PartialEq)]
pub enum Budget {
    /// p50 at most this.
    Max(f64),
    /// p50 at least this many percent under the start-of-task baseline.
    ImprovePct(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bench {
    pub value: String,
    pub runs: u64,
    pub warmup: u64,
    pub budget: Budget,
    pub unit: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub name: String,
    pub command: String,
    pub kind: String,
    pub given: String,
    pub when: String,
    pub then: String,
    pub red: Option<String>,
    pub timeout_s: u64,
    pub files: Vec<String>,
    /// Paths a grid cell's proof also depends on: a change to any of them
    /// makes the proof stale. Not locked.
    pub watch: Vec<String>,
    pub bench: Option<Bench>,
}

impl Check {
    pub fn is_characterisation(&self) -> bool {
        self.kind == "characterisation"
    }
}

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

fn text_field(row: &Map<String, Value>, key: &str, at: &str, max: usize) -> Result<String, String> {
    match row.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            if text.chars().count() > max {
                return Err(format!("{at}.{key} is longer than {max} characters"));
            }
            Ok(text.trim().to_string())
        }
        Some(Value::String(_)) => Err(format!("{at}.{key} is blank")),
        None | Some(Value::Null) => Err(format!("{at}.{key} is required")),
        Some(other) => Err(format!("{at}.{key} must be text, got {}", kind_of(other))),
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A path a check may lock: relative to the task's folder, inside it.
pub fn valid_path(path: &str) -> bool {
    let path = path.trim();
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('~')
        && !path.contains('\\')
        && !path.split('/').any(|part| part == "..")
}

fn positive(value: &Value, at: &str) -> Result<f64, String> {
    match value.as_f64() {
        Some(number) if number.is_finite() && number > 0.0 => Ok(number),
        _ => Err(format!("{at} must be a number above 0")),
    }
}

fn count(row: &Map<String, Value>, key: &str, at: &str, default: u64, least: u64, most: u64) -> Result<u64, String> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => match value.as_u64() {
            Some(n) if (least..=most).contains(&n) => Ok(n),
            _ => Err(format!("{at}.{key} must be a whole number from {least} to {most}")),
        },
    }
}

fn parse_bench(value: &Value, at: &str) -> Result<Bench, String> {
    let row = value.as_object().ok_or_else(|| format!("{at} must be an object: {{value, runs, warmup, budget}}"))?;
    if let Some(unknown) = row.keys().find(|key| !["value", "runs", "warmup", "budget"].contains(&key.as_str())) {
        return Err(format!("{at}.{unknown} is not a bench field (allowed: value, runs, warmup, budget)"));
    }
    let pattern = text_field(row, "value", at, 400)?;
    let compiled = Regex::new(&pattern).map_err(|error| format!("{at}.value is not a valid regex: {error}"))?;
    if compiled.captures_len() != 2 {
        return Err(format!("{at}.value must have exactly one group, the number to read, e.g. \"p50_ms=([0-9.]+)\""));
    }
    let runs = count(row, "runs", at, MIN_RUNS, MIN_RUNS, MAX_RUNS)?;
    let warmup = count(row, "warmup", at, 1, 0, 50)?;
    let budget_at = format!("{at}.budget");
    let budget = row
        .get("budget")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{budget_at} is required: {{max, unit}} or {{improve_pct, unit}}"))?;
    if let Some(unknown) = budget.keys().find(|key| !["max", "improve_pct", "unit"].contains(&key.as_str())) {
        return Err(format!("{budget_at}.{unknown} is not a budget field (allowed: max, improve_pct, unit)"));
    }
    let unit = text_field(budget, "unit", &budget_at, 40)?;
    let budget = match (budget.get("max"), budget.get("improve_pct")) {
        (Some(max), None) => Budget::Max(positive(max, &format!("{budget_at}.max"))?),
        (None, Some(pct)) => {
            let pct = positive(pct, &format!("{budget_at}.improve_pct"))?;
            if pct >= 100.0 {
                return Err(format!("{budget_at}.improve_pct must be under 100"));
            }
            Budget::ImprovePct(pct)
        }
        _ => return Err(format!("{budget_at} takes max (absolute) or improve_pct (against the start-of-task baseline), one of them")),
    };
    Ok(Bench { value: pattern, runs, warmup, budget, unit })
}

/// One check, validated, with its defaults filled in.
pub fn parse_check(value: &Value, at: &str) -> Result<Check, String> {
    let row = value
        .as_object()
        .ok_or_else(|| format!("{at} must be an object: {{name, command, kind, given, when, then, red?, timeout_s?, files?, watch?, bench?}}"))?;
    if let Some(unknown) = row.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return Err(format!("{at}.{unknown} is not a check field (allowed: {})", FIELDS.join(", ")));
    }
    let name = text_field(row, "name", at, 64)?;
    if !valid_name(&name) {
        return Err(format!("{at}.name \"{name}\" must be lower-case letters, digits and -"));
    }
    let at = format!("{at} (check \"{name}\")");
    let command = text_field(row, "command", &at, 4000)?;
    let kind = text_field(row, "kind", &at, 40)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("{at}.kind \"{kind}\" is not a check kind (kinds: {})", KINDS.join(", ")));
    }
    let given = text_field(row, "given", &at, 600)?;
    let when = text_field(row, "when", &at, 600)?;
    let then = text_field(row, "then", &at, 600)?;
    let red = match row.get("red") {
        None | Some(Value::Null) => None,
        Some(_) if kind == "characterisation" => {
            return Err(format!("{at}.red is not used by a characterisation check: it must pass before the change, not fail"))
        }
        Some(_) => {
            let red = text_field(row, "red", &at, 600)?;
            Regex::new(&red).map_err(|error| format!("{at}.red is not a valid regex: {error}"))?;
            Some(red)
        }
    };
    let timeout_s = count(row, "timeout_s", &at, DEFAULT_TIMEOUT_S, 1, MAX_TIMEOUT_S)
        .map_err(|_| format!("{at}.timeout_s must be a whole number of seconds from 1 to {MAX_TIMEOUT_S}"))?;
    let files = paths(row, "files", &at)?;
    let watch = paths(row, "watch", &at)?;
    let bench = match (kind.as_str(), row.get("bench")) {
        ("benchmark", Some(value)) if !value.is_null() => Some(parse_bench(value, &format!("{at}.bench"))?),
        ("benchmark", _) => return Err(format!("{at}.bench is required for a benchmark: {{value, runs, warmup, budget}}")),
        (_, None | Some(Value::Null)) => None,
        (_, Some(_)) => return Err(format!("{at}.bench is only for kind benchmark")),
    };
    Ok(Check { name, command, kind, given, when, then, red, timeout_s, files, watch, bench })
}

/// A check's list of paths (`files`, `watch`): relative, inside the folder,
/// without repeats.
fn paths(row: &Map<String, Value>, key: &str, at: &str) -> Result<Vec<String>, String> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            let mut paths = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let path = item.as_str().ok_or_else(|| format!("{at}.{key}[{index}] must be a path (text)"))?.trim().to_string();
                if !valid_path(&path) {
                    return Err(format!("{at}.{key}[{index}] \"{path}\" must be a path inside the task's folder, relative to it"));
                }
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
            Ok(paths)
        }
        Some(other) => Err(format!("{at}.{key} must be a list of paths, got {}", kind_of(other))),
    }
}

/// A `checks` list: one or more, names unique.
pub fn parse_checks(value: &Value, at: &str) -> Result<Vec<Check>, String> {
    let items = match value {
        Value::Array(items) if !items.is_empty() => items,
        Value::Array(_) => return Err(format!("{at} is empty: give one or more checks")),
        other => return Err(format!("{at} must be a list of checks, got {}", kind_of(other))),
    };
    let mut checks: Vec<Check> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let check = parse_check(item, &format!("{at}[{index}]"))?;
        if checks.iter().any(|known| known.name == check.name) {
            return Err(format!("{at}[{index}]: check name \"{}\" is used twice; names are unique within an item", check.name));
        }
        checks.push(check);
    }
    Ok(checks)
}

/// Checks already validated (an approved plan); a malformed one is skipped.
pub fn read_checks(value: &Value) -> Vec<Check> {
    value.as_array().into_iter().flatten().filter_map(|item| parse_check(item, "check").ok()).collect()
}

/* ------------------------------------------------------- plans and items */

/// Whether a plan is under the check rules: it has `checks` somewhere (its
/// own, or on an item). A plan without is an old task's (migration).
pub fn is_checked(plan: &Value) -> bool {
    let Some(row) = plan.as_object() else { return false };
    row.contains_key("checks")
        || row.values().any(|value| {
            value.as_array().is_some_and(|items| items.iter().any(|item| item.get("checks").is_some()))
        })
}

/// The raw `checks` of each plan item, `(item id, checks)`, in plan order:
/// the type's item list, or the plan's own checks under `PLAN_ITEM`, then
/// each `requirements` entry that has checks (its type's default items).
pub fn plan_items(kind: &str, plan: &Value) -> Vec<(String, Value)> {
    let mut items: Vec<(String, Value)> = match super::types::item_lists(kind) {
        Some((key, _)) => plan[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| Some((item["id"].as_str()?.to_string(), item.get("checks").cloned().unwrap_or(Value::Null))))
            .collect(),
        None => vec![(PLAN_ITEM.to_string(), plan.get("checks").cloned().unwrap_or(Value::Null))],
    };
    items.extend(
        plan["requirements"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| Some((item["id"].as_str()?.to_string(), item.get("checks")?.clone()))),
    );
    items
}

/// Every item's checks, parsed.
pub fn item_checks(kind: &str, plan: &Value) -> Vec<(String, Vec<Check>)> {
    plan_items(kind, plan).into_iter().map(|(id, checks)| (id, read_checks(&checks))).collect()
}

/// One item's checks.
pub fn checks_of(kind: &str, plan: &Value, item: &str) -> Option<Vec<Check>> {
    item_checks(kind, plan).into_iter().find(|(id, _)| id == item).map(|(_, checks)| checks)
}

/// `create` and `propose`: every item must have a check.
pub fn require_checks(kind: &str, plan: &Value) -> Result<(), String> {
    for (id, checks) in plan_items(kind, plan) {
        let at = if id == PLAN_ITEM && super::types::item_lists(kind).is_none() {
            "plan.checks".to_string()
        } else {
            format!("item \"{id}\"")
        };
        if checks.is_null() {
            let list = super::types::item_lists(kind).map(|(key, _)| format!("plan.{key}[] (id \"{id}\")")).unwrap_or(at.clone());
            return Err(format!(
                "{list} has no checks: every plan item needs checks: [{{name, command, kind, given, when, then, red, files}}], \
                 written before the work (see `atelier task types {kind}`)"
            ));
        }
        parse_checks(&checks, &format!("{at}.checks"))?;
    }
    Ok(())
}

/// Every file the plan's checks name, in order, without repeats.
pub fn check_files(kind: &str, plan: &Value) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut files = Vec::new();
    for (_, checks) in item_checks(kind, plan) {
        for check in checks {
            for file in check.files {
                if seen.insert(file.clone()) {
                    files.push(file);
                }
            }
        }
    }
    files
}

/* ------------------------------------------------------------------ lint */

/// A flag for the owner: an approved check file, a helper beside it or the
/// harness changed during the task. Not a refusal; the owner reviews it.
pub fn changed_file_flag(path: &str) -> Value {
    let mut value = flag(None, None, "check-file-changed", format!("{path} changed since the owner approved the checks"));
    value["path"] = json!(path);
    value
}

fn flag(item: Option<&str>, check: Option<&str>, kind: &str, text: impl Into<String>) -> Value {
    let mut value = json!({"kind": kind, "text": text.into()});
    if let Some(item) = item {
        value["item"] = json!(item);
    }
    if let Some(check) = check {
        value["check"] = json!(check);
    }
    value
}

/// The commands a shell line chains, split on `&&`, `||`, `;` and `|`.
fn segments(command: &str) -> Vec<String> {
    command
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace([';', '|'], "\n")
        .lines()
        .map(|part| part.trim().trim_start_matches('!').trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn first_word(segment: &str) -> &str {
    segment.split_whitespace().next().unwrap_or("")
}

const MOCK_CALLS: &[&str] = &["toHaveBeenCalled", "toBeCalled", "assert_called", "assert_has_calls", "assert_any_call", "called_once", ".times("];

/// Whether every assertion in a test file is about a mock being called.
fn mock_only(text: &str) -> bool {
    let assertions: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("expect(") || line.contains("assert") || line.contains(".verify(") || line.contains("should."))
        .collect();
    !assertions.is_empty() && assertions.iter().all(|line| MOCK_CALLS.iter().any(|mock| line.contains(mock)))
}

/// The weak-check lint run at propose and create: flags for the owner's
/// card, not refusals. `task_kind` is the task's type; `files` holds the
/// text of the check files the route could read.
pub fn lint(task_kind: &str, items: &[(String, Vec<Check>)], files: &BTreeMap<String, String>) -> Vec<Value> {
    let code = super::types::find(task_kind).is_some_and(|kind| kind.code);
    let mut flags = Vec::new();
    for (item, checks) in items {
        for check in checks {
            let here = |text: String| flag(Some(item), Some(&check.name), "weak", text);
            let command = check.command.trim();
            let parts = segments(command);
            if matches!(command, "true" | ":" | "exit 0" | "/bin/true") || first_word(command) == "echo" && parts.len() == 1 {
                flags.push(here(format!("\"{}\" runs `{command}`, which always passes: it checks nothing", check.name)));
                continue;
            }
            let exists_only = !parts.is_empty()
                && parts.iter().all(|part| {
                    let words: Vec<&str> = part.split_whitespace().collect();
                    matches!(words.first(), Some(&"ls"))
                        || (matches!(words.first(), Some(&"test") | Some(&"[")) && matches!(words.get(1), Some(&"-f") | Some(&"-e") | Some(&"-d") | Some(&"-s")))
                });
            if exists_only && check.kind == "test" && task_kind != "docs" {
                flags.push(here(format!("\"{}\" only checks that a file exists, not what it does", check.name)));
            }
            let grep_only = !parts.is_empty() && parts.iter().all(|part| matches!(first_word(part), "grep" | "rg" | "egrep" | "fgrep" | "git"));
            if grep_only && code && task_kind != "docs" && check.kind != "structure" && check.kind != "characterisation" {
                flags.push(here(format!("\"{}\" only searches the source; it never runs the code", check.name)));
            }
            if matches!(check.kind.as_str(), "test" | "structure") {
                match &check.red {
                    None => flags.push(here(format!(
                        "\"{}\" has no red pattern, so any failure at start counts, even a typo or a missing fixture",
                        check.name
                    ))),
                    Some(red) => {
                        if Regex::new(red).is_ok_and(|pattern| pattern.is_match("") || pattern.is_match("x\n")) {
                            flags.push(here(format!(
                                "\"{}\" has red /{red}/, which matches any output, so it does not name a behaviour",
                                check.name
                            )));
                        }
                    }
                }
            }
            if check.files.iter().any(|path| files.get(path).is_some_and(|text| mock_only(text))) {
                flags.push(here(format!("\"{}\" only asserts that a mock was called, not what the code produces", check.name)));
            }
        }
    }
    flags
}

/* -------------------------------------------------------------- running */

/// What one run of one check did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Run {
    pub command: String,
    /// 124 when it timed out, -1 when it could not start or was killed.
    pub exit: i32,
    /// The last 40 lines.
    pub output_tail: String,
    /// More of the output, to match `red` against (not stored).
    pub output: String,
    pub ms: u64,
    pub commit: Option<String>,
    pub at: i64,
    /// A benchmark's timed values, one per run after the warmup.
    pub samples: Option<Vec<f64>>,
    /// A benchmark's p50.
    pub value: Option<f64>,
}

impl Run {
    pub fn to_json(&self, passed: bool, reason: Option<&str>) -> Value {
        let mut value = json!({
            "command": self.command, "exit": self.exit, "passed": passed, "outputTail": self.output_tail,
            "commit": self.commit, "at": self.at, "ms": self.ms,
        });
        if let Some(samples) = &self.samples {
            value["samples"] = json!(samples);
        }
        if let Some(p50) = self.value {
            value["value"] = json!(p50);
        }
        if let Some(reason) = reason {
            value["reason"] = json!(reason);
        }
        value
    }
}

pub fn median(samples: &[f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = sorted.len() / 2;
    Some(if sorted.len() % 2 == 0 { (sorted[middle - 1] + sorted[middle]) / 2.0 } else { sorted[middle] })
}

async fn shell(folder: &Path, command: &str, timeout_s: u64) -> (i32, String, u64) {
    match proof::run_shell(folder, command, Duration::from_secs(timeout_s), true, 256 * 1024, true).await {
        Ok(run) => {
            let mut output = String::from_utf8_lossy(&run.stdout).to_string();
            if run.timed_out {
                output.push_str(&format!("\n(timed out after {timeout_s} s)"));
            }
            (if run.timed_out { 124 } else { run.code.unwrap_or(-1) }, output, run.ms)
        }
        Err(error) => (-1, format!("could not start: {error}"), 0),
    }
}

/// Run one check in `folder`. A benchmark's command does one measured run;
/// it is run `warmup` times unrecorded, then `runs` times, reading
/// `bench.value` from each; a failed or unreadable run ends it there.
pub async fn run_check(folder: &Path, check: &Check, commit: Option<&str>, at: i64) -> Run {
    let mut run = Run { command: check.command.clone(), commit: commit.map(str::to_string), at, ..Default::default() };
    let Some(bench) = &check.bench else {
        let (exit, output, ms) = shell(folder, &check.command, check.timeout_s).await;
        run.exit = exit;
        run.output_tail = proof::tail(output.as_bytes(), proof::TAIL_LINES);
        run.output = output;
        run.ms = ms;
        return run;
    };
    let pattern = Regex::new(&bench.value).ok();
    let mut samples = Vec::new();
    for index in 0..bench.warmup + bench.runs {
        let (exit, output, ms) = shell(folder, &check.command, check.timeout_s).await;
        run.ms += ms;
        run.exit = exit;
        run.output_tail = proof::tail(output.as_bytes(), proof::TAIL_LINES);
        run.output = output;
        if exit != 0 {
            break;
        }
        let read = pattern
            .as_ref()
            .and_then(|pattern| pattern.captures_iter(&run.output).last())
            .and_then(|found| found.get(1))
            .and_then(|value| value.as_str().trim().parse::<f64>().ok());
        let Some(value) = read else {
            run.output_tail.push_str(&format!("\n(no value matching /{}/ in the output)", bench.value));
            samples.clear();
            break;
        };
        if index >= bench.warmup {
            samples.push(value);
        }
    }
    if samples.len() as u64 == bench.runs {
        run.value = median(&samples);
        run.samples = Some(samples);
    }
    run
}

/// Run each check, in order, at `commit`.
pub async fn run_all(folder: &Path, checks: &[Check], commit: Option<&str>, at: i64) -> BTreeMap<String, Run> {
    let mut runs = BTreeMap::new();
    for check in checks {
        runs.insert(check.name.clone(), run_check(folder, check, commit, at).await);
    }
    runs
}

/* -------------------------------------------------------------- judging */

fn last_lines(run: &Run, lines: usize) -> String {
    let tail = proof::tail(run.output_tail.as_bytes(), lines);
    if tail.is_empty() {
        "(no output)".into()
    } else {
        tail
    }
}

fn red_matches(check: &Check, run: &Run) -> bool {
    check.red.as_deref().is_none_or(|red| Regex::new(red).is_ok_and(|pattern| pattern.is_match(&run.output) || pattern.is_match(&run.output_tail)))
}

/// Red at start (or for a changed check at amend). `Ok` with the baseline
/// p50 for a benchmark that measured one; `Err` saying what is wrong, for
/// the caller to name the item and check.
pub fn judge_red(check: &Check, run: &Run) -> Result<Option<f64>, String> {
    if check.is_characterisation() {
        return if run.exit == 0 {
            Ok(None)
        } else {
            Err(format!(
                "is a characterisation check and must pass before the change, but it fails (exit {}): {}",
                run.exit,
                last_lines(run, 5)
            ))
        };
    }
    if let Some(bench) = &check.bench {
        return match (run.value, &bench.budget) {
            (Some(p50), Budget::Max(max)) if p50 <= *max => Err(format!(
                "already meets its budget (p50 {p50} {} ≤ {max}), so it proves nothing",
                bench.unit
            )),
            (Some(p50), _) => Ok(Some(p50)),
            (None, Budget::Max(_)) if run.exit != 0 && check.red.is_some() && red_matches(check, run) => Ok(None),
            (None, Budget::ImprovePct(_)) => Err(format!(
                "could not be measured for a baseline (exit {}): {}",
                run.exit,
                last_lines(run, 5)
            )),
            (None, _) => Err(format!("failed for another reason (exit {}): {}", run.exit, last_lines(run, 5))),
        };
    }
    if run.exit == 0 {
        return Err("already passes, so it proves nothing".into());
    }
    if !red_matches(check, run) {
        return Err(format!(
            "failed for another reason: its output does not match red /{}/: {}",
            check.red.as_deref().unwrap_or(""),
            last_lines(run, 5)
        ));
    }
    Ok(None)
}

/// How many tests a run reports it ran (passed and failed, not skipped):
/// cargo's `test result:` lines (summed over every binary), vitest's
/// `Tests` line, or pytest's summary. None when it reports none of these.
pub fn tests_ran(output: &str) -> Option<u64> {
    static CARGO: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static COUNT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let cargo = CARGO.get_or_init(|| Regex::new(r"test result: \w+\. (\d+) passed; (\d+) failed").unwrap());
    let count = COUNT.get_or_init(|| Regex::new(r"(\d+) (passed|failed)").unwrap());
    let mut found = None;
    for caps in cargo.captures_iter(output) {
        let ran: u64 = caps[1].parse::<u64>().unwrap_or(0) + caps[2].parse::<u64>().unwrap_or(0);
        found = Some(found.unwrap_or(0) + ran);
    }
    if found.is_some() {
        return found;
    }
    let summary = output.lines().rev().find(|line| {
        let line = line.trim_start();
        (line.starts_with("Tests ") || line.starts_with('=')) && count.is_match(line)
    })?;
    Some(count.captures_iter(summary).map(|caps| caps[1].parse::<u64>().unwrap_or(0)).sum())
}

/// `Err` when a run that passes ran fewer tests than the check did at
/// start: tests were dropped, filtered or skipped to get it green.
pub fn judge_count(run: &Run, at_start: Option<u64>) -> Result<(), String> {
    let Some(then) = at_start else { return Ok(()) };
    let now = tests_ran(&run.output).unwrap_or(0);
    if now >= then {
        return Ok(());
    }
    Err(format!("ran {now} test{}, {then} at start", if now == 1 { "" } else { "s" }))
}

/// Green: `Err` with why the check does not pass.
pub fn judge_green(check: &Check, run: &Run, baseline: Option<f64>) -> Result<(), String> {
    if run.exit != 0 {
        return Err(format!("fails (exit {}): {}", run.exit, last_lines(run, 3)));
    }
    let Some(bench) = &check.bench else { return Ok(()) };
    let Some(p50) = run.value else {
        return Err(format!("printed no value matching /{}/ on every run", bench.value));
    };
    match bench.budget {
        Budget::Max(max) if p50 <= max => Ok(()),
        Budget::Max(max) => Err(format!("p50 {p50} {} is over the budget of {max}", bench.unit)),
        Budget::ImprovePct(pct) => {
            let Some(baseline) = baseline else {
                return Err("has no start-of-task baseline to compare with".into());
            };
            let target = baseline * (1.0 - pct / 100.0);
            if p50 <= target {
                Ok(())
            } else {
                Err(format!(
                    "p50 {p50} {} is not {pct}% under the baseline {baseline} (needs ≤ {target:.4})",
                    bench.unit
                ))
            }
        }
    }
}

/* --------------------------------------------------------------- hashes */

pub fn sha_file(folder: &Path, path: &str) -> String {
    use sha2::{Digest, Sha256};
    match std::fs::read(folder.join(path)) {
        Ok(bytes) => format!("{:x}", Sha256::digest(&bytes)),
        Err(_) => MISSING.into(),
    }
}

/// The sha256 of each path in `folder` (`MISSING` for one that is not there).
pub fn hash_files(folder: &Path, paths: &[String]) -> BTreeMap<String, String> {
    paths.iter().map(|path| (path.clone(), sha_file(folder, path))).collect()
}

/// The paths to lock for a plan: its checks' files, then the harness.
pub fn locked_paths(kind: &str, plan: &Value, harness: &[String]) -> Vec<String> {
    let mut paths = check_files(kind, plan);
    for path in harness {
        if valid_path(path) && !paths.contains(path) {
            paths.push(path.clone());
        }
    }
    paths
}

/// Folders that hold tests. A check file inside one locks the folder: the
/// helpers, fixtures, tolerances and baselines beside it are part of the
/// check too. The other test files there are not (`is_test_file`).
pub const TEST_FOLDERS: &[&str] = &["tests", "test", "__tests__", "spec", "e2e"];
/// At most this many files are locked for one plan.
pub const MAX_LOCKED: usize = 5000;

/// The test folder a check file lives in: its topmost ancestor folder named
/// like one (`tests/suite/a.sh` → `tests`). None for a file outside one,
/// such as a test module beside the code it tests.
pub fn test_folder(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let folders = &parts[..parts.len().saturating_sub(1)];
    folders.iter().position(|part| TEST_FOLDERS.contains(part)).map(|at| folders[..=at].join("/"))
}

/// Whether `path` is a test file by its name (`a.test.tsx`, `a.spec.ts`,
/// `test_a.py`, `a_test.go`, `a_spec.rb`): another test, not a helper, so
/// a check beside it does not lock it.
pub fn is_test_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.split('.').next().unwrap_or(name);
    name.contains(".test.") || name.contains(".spec.") || (stem.starts_with("test_") && name.ends_with(".py"))
        || ((stem.ends_with("_test") || stem.ends_with("_spec")) && stem != name)
}

/// The committed files under `dir`, relative to `folder`.
fn tracked_under(folder: &Path, dir: &str) -> Vec<String> {
    let output = std::process::Command::new("git").args(["ls-files", "-z", "--", dir]).current_dir(folder).output();
    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// `paths` and, for each in a test folder, every committed file in that
/// folder but the other test files: what approval locks.
pub fn widened(folder: &Path, paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = paths.to_vec();
    let mut seen: BTreeSet<String> = out.iter().cloned().collect();
    let mut roots = BTreeSet::new();
    for path in paths {
        let Some(root) = test_folder(path) else { continue };
        if !roots.insert(root.clone()) {
            continue;
        }
        for file in tracked_under(folder, &root) {
            if out.len() >= MAX_LOCKED {
                return out;
            }
            if is_test_file(&file) {
                continue;
            }
            if seen.insert(file.clone()) {
                out.push(file);
            }
        }
    }
    out
}

/// What approval stores: `{files: {path: sha}, harness: [path]}`.
pub fn approved_hashes(hashes: &BTreeMap<String, String>, harness: &[String]) -> Value {
    json!({"files": hashes, "harness": harness})
}

/// The approved files one item depends on that have changed since approval:
/// its checks' files, the rest of the test folders they live in but other
/// test files, and the harness.
/// `owned` is every check file of the plan: another check's own file counts
/// against that check's item, not against everything in its test folder.
pub fn changed_for(approved: &Value, checks: &[Check], owned: &[String], current: &BTreeMap<String, String>) -> Vec<String> {
    let mut paths: Vec<String> = checks.iter().flat_map(|check| check.files.iter().cloned()).collect();
    // Everything else approved in the test folders those files live in, but
    // other test files, which a lock made before they were left out may hold.
    let roots: BTreeSet<String> = paths.iter().filter_map(|path| test_folder(path)).collect();
    if let Some(files) = approved["files"].as_object() {
        for path in files.keys() {
            if !owned.contains(path) && !is_test_file(path) && roots.iter().any(|root| path.starts_with(&format!("{root}/"))) {
                paths.push(path.clone());
            }
        }
    }
    paths.extend(approved["harness"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string));
    let mut changed = Vec::new();
    for path in paths {
        let Some(then) = approved["files"][&path].as_str() else { continue };
        let now = current.get(&path).map(String::as_str).unwrap_or(MISSING);
        if now != then && !changed.contains(&path) {
            changed.push(path);
        }
    }
    changed
}

/* -------------------------------------------------------------- the gate */

/// What the route found outside the writer, for the writer to judge.
#[derive(Clone, Debug, Default)]
pub struct Gate {
    /// HEAD in the task's folder.
    pub head: Option<String>,
    /// The sha256 of each locked path now (or, at approval, then).
    pub hashes: BTreeMap<String, String>,
    /// The project's `[tasks] harness`.
    pub harness: Vec<String>,
    /// The runs, by item and check name.
    pub runs: BTreeMap<String, BTreeMap<String, Run>>,
    /// `[tasks] test_command` and its run, at done.
    pub test_command: Option<(String, Run)>,
    /// Flags found: the lint's at propose and create, the diff scan
    /// scan's at done.
    pub flags: Vec<Value>,
    /// Check files a draft names that are not in the folder.
    pub missing: Vec<String>,
    /// Why the checks could not be run at all (no folder, no worktree).
    pub error: Option<String>,
}

/// What a task change needs measured, outside the writer.
#[derive(Clone, Debug)]
pub enum Measure {
    /// `task start`: every check, on the starting commit.
    Start,
    /// `task check N ITEM`: that item's checks.
    Item(String),
    /// `task done`: every check, the project's test command, and, when all
    /// pass, the diff scan scan.
    Done { test_command: Option<String> },
    /// The agent files an amend: the new plan's changed checks, against the
    /// code as it was at start, and its files' hashes.
    Amend { plan: Value },
}

/// What a plan change may weaken of the checks the owner approved, in
/// words: an item or check removed, or an approved check changed. Added
/// items and checks weaken nothing. A hint for the agent, not a verdict.
pub fn may_weaken(kind: &str, old: &Value, new: &Value) -> Vec<String> {
    let after: BTreeMap<String, Value> = plan_items(kind, new).into_iter().collect();
    let name = |check: &Value| check["name"].as_str().unwrap_or("").to_string();
    let mut said = Vec::new();
    for (item, listed) in plan_items(kind, old) {
        let Some(now) = after.get(&item) else {
            said.push(format!("removes item \"{item}\""));
            continue;
        };
        let now: Vec<&Value> = now.as_array().into_iter().flatten().collect();
        for check in listed.as_array().into_iter().flatten() {
            match now.iter().find(|other| name(other) == name(check)) {
                None => said.push(format!("removes check \"{}\" of {item}", name(check))),
                Some(other) if *other != check => said.push(format!("changes check \"{}\" of {item}", name(check))),
                Some(_) => {}
            }
        }
    }
    said
}

/// The checks of `new` that are not, as they are, in `old`: what an amend
/// changed, by item.
pub fn changed_checks(kind: &str, old: &Value, new: &Value) -> Vec<(String, Vec<Check>)> {
    let before: BTreeMap<String, Value> = plan_items(kind, old).into_iter().collect();
    plan_items(kind, new)
        .into_iter()
        .filter_map(|(item, listed)| {
            let had = before.get(&item).and_then(Value::as_array).cloned().unwrap_or_default();
            let changed: Vec<Check> = listed
                .as_array()
                .into_iter()
                .flatten()
                .filter(|check| !had.contains(check))
                .filter_map(|check| parse_check(check, "").ok())
                .collect();
            (!changed.is_empty()).then_some((item, changed))
        })
        .collect()
}

/// Measure, in the task's folder, what `measure` needs for a task with
/// checks whose stored gate is `stored` (`{hashes, startCommit?, baseline?}`).
pub async fn measure(folder: &Path, kind: &str, plan: &Value, stored: &Value, measure: Measure, at: i64) -> Gate {
    let harness: Vec<String> =
        stored["hashes"]["harness"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    let mut gate = Gate { harness: harness.clone(), ..Default::default() };
    if !folder.is_dir() {
        gate.error = Some(format!("the task's folder {} is not there", folder.display()));
        return gate;
    }
    let head = proof::head(folder).await;
    gate.head = head.clone();
    let start = stored["startCommit"].as_str().map(str::to_string);
    match measure {
        Measure::Start => {
            gate.hashes = hash_files(folder, &widened(folder, &locked_paths(kind, plan, &harness)));
            for (item, checks) in item_checks(kind, plan) {
                gate.runs.insert(item, run_all(folder, &checks, head.as_deref(), at).await);
            }
        }
        Measure::Item(item) => {
            gate.hashes = hash_files(folder, &widened(folder, &locked_paths(kind, plan, &harness)));
            if let Some(checks) = checks_of(kind, plan, &item) {
                gate.runs.insert(item, run_all(folder, &checks, head.as_deref(), at).await);
            }
        }
        Measure::Done { test_command } => {
            gate.hashes = hash_files(folder, &widened(folder, &locked_paths(kind, plan, &harness)));
            let items = item_checks(kind, plan);
            let mut green = true;
            for (item, checks) in &items {
                let runs = run_all(folder, checks, head.as_deref(), at).await;
                green &= checks.iter().all(|check| {
                    let baseline = stored["baseline"][item][&check.name]["p50"].as_f64();
                    runs.get(&check.name).is_some_and(|run| judge_green(check, run, baseline).is_ok())
                });
                gate.runs.insert(item.clone(), runs);
            }
            if let Some(command) = test_command.filter(|command| !command.trim().is_empty()) {
                let (exit, output, ms) = shell(folder, &command, MAX_TIMEOUT_S).await;
                green &= exit == 0;
                let run = Run {
                    command: command.clone(), exit, output_tail: proof::tail(output.as_bytes(), proof::TAIL_LINES),
                    output, ms, commit: head.clone(), at, ..Default::default()
                };
                gate.test_command = Some((command, run));
            }
            // The audits only mean something once every check passes.
            if let (true, Some(start)) = (green, start.as_deref()) {
                gate.flags.extend(diff_flags(folder, start).await);
            }
        }
        Measure::Amend { plan: new } => {
            gate.hashes = hash_files(folder, &widened(folder, &locked_paths(kind, &new, &harness)));
        }
    }
    gate
}

/// The project's `[tasks]` settings (harness, test_command), read from its
/// manifest; the defaults when it has none.
pub fn project_settings(project_folder: &Path) -> crate::project_manifest::TaskSettings {
    crate::identity::data_dir()
        .and_then(|data| crate::project_manifest::locate(project_folder, &data))
        .map(|located| located.manifest.tasks)
        .unwrap_or_default()
}

/// What `create`, `propose` and each approval need for a plan with checks,
/// taken in `folder`: the locked files' hashes, the check files that are
/// missing, and the lint's flags (it reads the check files).
pub fn draft_gate(folder: &Path, kind: &str, plan: &Value, harness: &[String]) -> Gate {
    if !is_checked(plan) {
        return Gate::default();
    }
    let paths = widened(folder, &locked_paths(kind, plan, harness));
    let hashes = hash_files(folder, &paths);
    let own = check_files(kind, plan);
    let missing = own.iter().filter(|path| hashes.get(*path).map(String::as_str) == Some(MISSING)).cloned().collect();
    let texts: BTreeMap<String, String> = own
        .iter()
        .filter_map(|path| {
            let bytes = std::fs::read(folder.join(path)).ok()?;
            (bytes.len() <= 512 * 1024).then(|| (path.clone(), String::from_utf8_lossy(&bytes).to_string()))
        })
        .collect();
    let flags = lint(kind, &item_checks(kind, plan), &texts);
    Gate { hashes, harness: harness.to_vec(), flags, missing, ..Default::default() }
}

/* ------------------------------------------------------------------- git */

async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::routes::git_output(dir, args).await.map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/* ------------------------------------------------------------- diff scan */

fn is_test_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    super::visual::is_test_file(path)
        || path.split('/').any(|part| part == "tests" || part == "test" || part == "spec" || part == "__tests__")
        || name.starts_with("test_")
        || name.contains("_test.")
        || name == "tests.rs"
        || name.ends_with("_tests.rs")
}

fn test_definition(line: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r#"#\[(tokio::)?test\]|^\s*(async\s+)?def\s+test_|^\s*func\s+Test|\b(it|test|xit|fit|xtest)(\.(skip|only|todo))?\s*\(\s*['"`]|^\s*@Test\b"#).unwrap()
        })
        .is_match(line)
}

fn skip_marker(line: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(
                r#"\b(it|test|describe|context)\.(skip|only|todo)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(skip|skipif|xfail)|pytest\.(skip|xfail)\s*\(|@unittest\.skip|#\[ignore|@(Disabled|Ignore)\b|\bt\.Skip(Now|f)?\s*\("#,
            )
            .unwrap()
        })
        .is_match(line)
}

fn exit_call(line: &str) -> bool {
    static PATTERN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"\b(process::exit|process\.exit|sys\.exit|os\.Exit|os\._exit)\s*\(|^\s*exit\s*\(").unwrap())
        .is_match(line)
}

/// Flags from a unified diff (`git diff --no-renames -U0 START HEAD`).
pub fn scan_diff(diff: &str) -> Vec<Value> {
    let mut flags = Vec::new();
    let mut path = String::new();
    let mut deleted = false;
    let mut counts: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut said: BTreeSet<(String, &str)> = BTreeSet::new();
    let mut push = |flags: &mut Vec<Value>, path: &str, kind: &'static str, text: String| {
        if said.insert((path.to_string(), kind)) {
            flags.push(flag(None, None, kind, text));
        }
    };
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            path = rest.rsplit(" b/").next().unwrap_or("").to_string();
            deleted = false;
            continue;
        }
        if line.starts_with("deleted file mode") {
            deleted = true;
            if is_test_path(&path) {
                push(&mut flags, &path, "test-deleted", format!("the test file {path} was deleted"));
            }
            continue;
        }
        if line.starts_with("+++") || line.starts_with("---") || line.starts_with("@@") || line.starts_with("index ") {
            continue;
        }
        if let Some(added) = line.strip_prefix('+') {
            if skip_marker(added) {
                push(&mut flags, &path, "skip-added", format!("{path} adds a skip or only marker: {}", added.trim()));
            }
            if is_test_path(&path) && exit_call(added) {
                push(&mut flags, &path, "exit-in-test", format!("{path} adds an exit call in a test file: {}", added.trim()));
            }
            if test_definition(added) {
                counts.entry(path.clone()).or_default().0 += 1;
            }
        } else if let Some(removed) = line.strip_prefix('-') {
            if !deleted && test_definition(removed) {
                counts.entry(path.clone()).or_default().1 += 1;
            }
        }
    }
    for (path, (added, removed)) in counts {
        if removed > added {
            let lost = removed - added;
            flags.push(flag(None, None, "test-deleted", format!(
                "{path} loses {lost} test{}",
                if lost == 1 { "" } else { "s" }
            )));
        }
    }
    flags
}

/// The diff scan over the task's changes since `start`.
pub async fn diff_flags(folder: &Path, start: &str) -> Vec<Value> {
    match git(folder, &["diff", "--no-renames", "-U0", start, "HEAD"]).await {
        Ok(diff) => scan_diff(&diff),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn sample(name: &str) -> Value {
        json!({"name": name, "command": "cargo test export", "kind": "test", "given": "g", "when": "w", "then": "t",
            "red": "export.*FAILED", "files": ["tests/export.rs"]})
    }

    #[test]
    fn a_check_is_validated_and_filled_in() {
        let check = parse_check(&sample("repro"), "c").unwrap();
        assert_eq!(check.timeout_s, DEFAULT_TIMEOUT_S);
        assert_eq!(check.files, vec!["tests/export.rs".to_string()]);
        let bad = |change: Value| {
            let mut value = sample("repro");
            for (key, field) in change.as_object().unwrap() {
                value[key] = field.clone();
            }
            parse_check(&value, "c").unwrap_err()
        };
        assert!(bad(json!({"name": "Repro"})).contains("lower-case"));
        assert!(bad(json!({"kind": "vibe"})).contains("not a check kind"));
        assert!(bad(json!({"red": "("})).contains("not a valid regex"));
        assert!(bad(json!({"timeout_s": 4000})).contains("timeout_s"));
        assert!(bad(json!({"files": ["/etc/passwd"]})).contains("inside the task's folder"));
        assert!(bad(json!({"files": ["../x"]})).contains("inside the task's folder"));
        assert!(bad(json!({"bench": {}})).contains("only for kind benchmark"));
        assert!(bad(json!({"kind": "characterisation"})).contains("red is not used"));
        assert!(bad(json!({"then": ""})).contains("then is blank"));
        assert!(bad(json!({"extra": 1})).contains("not a check field"));
        assert!(bad(json!({"kind": "benchmark"})).contains("bench is required"));
        let bench = |bench: Value| bad(json!({"kind": "benchmark", "bench": bench}));
        assert!(bench(json!({"value": "p50=[0-9]+", "budget": {"max": 1, "unit": "ms"}})).contains("exactly one group"));
        assert!(bench(json!({"value": "p50=([0-9]+)", "runs": 5, "budget": {"max": 1, "unit": "ms"}})).contains("runs must be"));
        assert!(bench(json!({"value": "p50=([0-9]+)", "budget": {"max": 1, "improve_pct": 5, "unit": "ms"}})).contains("one of them"));
        let mut good = sample("speed");
        good["kind"] = json!("benchmark");
        good["bench"] = json!({"value": "p50=([0-9.]+)", "warmup": 2, "budget": {"improve_pct": 20, "unit": "ms"}});
        let check = parse_check(&good, "c").unwrap();
        assert_eq!(check.bench.unwrap(), Bench { value: "p50=([0-9.]+)".into(), runs: 10, warmup: 2, budget: Budget::ImprovePct(20.0), unit: "ms".into() });
    }

    #[test]
    fn a_checks_list_needs_one_and_unique_names() {
        assert!(parse_checks(&json!([]), "x.checks").unwrap_err().contains("empty"));
        assert!(parse_checks(&json!([sample("a"), sample("a")]), "x.checks").unwrap_err().contains("used twice"));
        assert_eq!(parse_checks(&json!([sample("a"), sample("b")]), "x.checks").unwrap().len(), 2);
    }

    #[test]
    fn a_plan_is_checked_when_it_has_checks_anywhere() {
        assert!(!is_checked(&json!({"outcome": "o", "criteria": [{"id": "a", "text": "t"}]})));
        assert!(is_checked(&json!({"outcome": "o", "criteria": [{"id": "a", "text": "t", "checks": [sample("x")]}]})));
        assert!(is_checked(&json!({"symptom": "s", "checks": [sample("x")]})));
    }

    fn checks(list: Value) -> Vec<(String, Vec<Check>)> {
        vec![("a".into(), list.as_array().unwrap().iter().map(|c| parse_check(c, "c").unwrap()).collect())]
    }

    #[test]
    fn the_lint_flags_each_kind_of_weak_check() {
        let with = |change: Value| {
            let mut value = sample("w");
            for (key, field) in change.as_object().unwrap() {
                value[key] = field.clone();
            }
            value
        };
        let texts = |kind: &str, list: Value, files: &BTreeMap<String, String>| -> Vec<String> {
            lint(kind, &checks(list), files).iter().map(|f| f["text"].as_str().unwrap().to_string()).collect()
        };
        let none = BTreeMap::new();
        assert!(texts("feature", json!([sample("w")]), &none).is_empty());
        for always in ["true", ":", "exit 0", "echo ok"] {
            let found = texts("feature", json!([with(json!({"command": always}))]), &none);
            assert!(found[0].contains("always passes"), "{always}: {found:?}");
        }
        let found = texts("feature", json!([with(json!({"command": "test -f src/a.rs && ls src"}))]), &none);
        assert!(found.iter().any(|t| t.contains("only checks that a file exists")), "{found:?}");
        assert!(texts("docs", json!([with(json!({"command": "test -f docs/a.md"}))]), &none).is_empty());
        let found = texts("feature", json!([with(json!({"command": "grep -q exportCsv src/a.ts"}))]), &none);
        assert!(found.iter().any(|t| t.contains("only searches the source")), "{found:?}");
        let found = texts("docs", json!([with(json!({"command": "grep -q Export docs/a.md"}))]), &none);
        assert!(found.is_empty(), "{found:?}");
        let mut no_red = sample("w");
        no_red.as_object_mut().unwrap().remove("red");
        assert!(texts("feature", json!([no_red]), &none)[0].contains("no red pattern"));
        assert!(texts("feature", json!([with(json!({"red": ".*"}))]), &none)[0].contains("matches any output"));
        let files = BTreeMap::from([("tests/export.rs".to_string(), "expect(save).toHaveBeenCalled();\nexpect(api).toHaveBeenCalledWith(1);\n".to_string())]);
        assert!(texts("feature", json!([sample("w")]), &files)[0].contains("mock was called"));
        let real = BTreeMap::from([("tests/export.rs".to_string(), "expect(save).toHaveBeenCalled();\nexpect(out).toBe(3);\n".to_string())]);
        assert!(texts("feature", json!([sample("w")]), &real).is_empty());
        let flags = lint("feature", &checks(json!([with(json!({"command": "true"}))])), &none);
        assert_eq!((flags[0]["kind"].as_str(), flags[0]["item"].as_str(), flags[0]["check"].as_str()), (Some("weak"), Some("a"), Some("w")));
    }

    fn run(exit: i32, output: &str) -> Run {
        Run { exit, output: output.into(), output_tail: output.into(), ..Default::default() }
    }

    #[test]
    fn red_needs_a_failure_for_the_stated_reason() {
        let check = parse_check(&sample("repro"), "c").unwrap();
        assert!(judge_red(&check, &run(0, "ok")).unwrap_err().contains("already passes"));
        assert!(judge_red(&check, &run(101, "error[E0425]: cannot find value")).unwrap_err().contains("another reason"));
        assert!(judge_red(&check, &run(101, "test export_keeps_order ... FAILED")).is_ok());
        let mut value = sample("same");
        value["kind"] = json!("characterisation");
        value.as_object_mut().unwrap().remove("red");
        let pinned = parse_check(&value, "c").unwrap();
        assert!(judge_red(&pinned, &run(0, "ok")).is_ok());
        assert!(judge_red(&pinned, &run(1, "boom")).unwrap_err().contains("must pass before the change"));
    }

    fn bench(budget: Value) -> Check {
        let mut value = sample("speed");
        value["kind"] = json!("benchmark");
        value.as_object_mut().unwrap().remove("red");
        value["bench"] = json!({"value": "p50_ms=([0-9.]+)", "runs": 10, "warmup": 2, "budget": budget});
        parse_check(&value, "c").unwrap()
    }

    fn timed(value: f64) -> Run {
        Run { exit: 0, value: Some(value), samples: Some(vec![value; 10]), ..Default::default() }
    }

    #[test]
    fn a_benchmark_is_red_when_it_misses_an_absolute_budget_and_green_within_it() {
        let check = bench(json!({"max": 0.4, "unit": "ms"}));
        assert!(judge_red(&check, &timed(0.3)).unwrap_err().contains("already meets its budget"));
        assert_eq!(judge_red(&check, &timed(0.9)).unwrap(), Some(0.9));
        assert!(judge_green(&check, &timed(0.39), None).is_ok());
        assert!(judge_green(&check, &timed(0.41), None).unwrap_err().contains("over the budget"));
        assert!(judge_green(&check, &run(0, "nothing"), None).unwrap_err().contains("no value"));
    }

    #[test]
    fn a_relative_budget_is_measured_against_the_start_baseline() {
        let check = bench(json!({"improve_pct": 20, "unit": "ms"}));
        assert_eq!(judge_red(&check, &timed(10.0)).unwrap(), Some(10.0));
        assert!(judge_red(&check, &run(1, "no binary")).unwrap_err().contains("baseline"));
        assert!(judge_green(&check, &timed(8.0), Some(10.0)).is_ok());
        assert!(judge_green(&check, &timed(8.5), Some(10.0)).unwrap_err().contains("not 20% under"));
        assert!(judge_green(&check, &timed(1.0), None).unwrap_err().contains("baseline"));
    }

    #[tokio::test]
    async fn a_benchmark_runs_warmup_and_then_every_timed_run() {
        let folder = tempfile::tempdir().unwrap();
        let script = "n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo $n > count; echo \"p50_ms=$n\"";
        let mut check = bench(json!({"max": 100, "unit": "ms"}));
        check.command = script.into();
        let ran = run_check(folder.path(), &check, Some("abc"), 7).await;
        assert_eq!(ran.exit, 0);
        assert_eq!(ran.samples.as_deref(), Some(&[3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0][..]));
        assert_eq!(ran.value, Some(7.5));
        assert_eq!(std::fs::read_to_string(folder.path().join("count")).unwrap().trim(), "12");
        check.command = "echo nothing".into();
        let ran = run_check(folder.path(), &check, None, 7).await;
        assert!(ran.samples.is_none() && judge_green(&check, &ran, None).is_err());
    }

    #[test]
    fn hashes_name_the_changed_file_of_the_item_and_the_harness() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(folder.path().join("tests")).unwrap();
        std::fs::write(folder.path().join("tests/export.rs"), "a").unwrap();
        std::fs::write(folder.path().join("Cargo.toml"), "x").unwrap();
        let harness = vec!["Cargo.toml".to_string()];
        let plan = json!({"outcome": "o", "criteria": [{"id": "a", "text": "t", "checks": [sample("repro")]}]});
        let paths = locked_paths("feature", &plan, &harness);
        assert_eq!(paths, vec!["tests/export.rs".to_string(), "Cargo.toml".to_string()]);
        let approved = approved_hashes(&hash_files(folder.path(), &paths), &harness);
        let checks = checks_of("feature", &plan, "a").unwrap();
        assert!(changed_for(&approved, &checks, &[], &hash_files(folder.path(), &paths)).is_empty());
        std::fs::write(folder.path().join("tests/export.rs"), "b").unwrap();
        assert_eq!(changed_for(&approved, &checks, &[], &hash_files(folder.path(), &paths)), vec!["tests/export.rs".to_string()]);
        std::fs::remove_file(folder.path().join("Cargo.toml")).unwrap();
        assert_eq!(changed_for(&approved, &checks, &[], &hash_files(folder.path(), &paths)).len(), 2);
    }

    #[test]
    fn the_diff_scan_flags_skips_exits_and_lost_tests() {
        let diff = "\
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1 +1 @@
-it('exports', () => {
+it.skip('exports', () => {
+  process.exit(0)
diff --git a/tests/old.rs b/tests/old.rs
deleted file mode 100644
--- a/tests/old.rs
+++ /dev/null
@@ -1,2 +0,0 @@
-#[test]
-fn old() {}
diff --git a/server/src/lib.rs b/server/src/lib.rs
--- a/server/src/lib.rs
+++ b/server/src/lib.rs
@@ -5,2 +5,0 @@
-    #[test]
-    fn keeps_order() {}
+    #[ignore]
+    std::process::exit(1);
";
        let flags = scan_diff(diff);
        let kinds: Vec<&str> = flags.iter().map(|f| f["kind"].as_str().unwrap()).collect();
        assert!(kinds.contains(&"skip-added"), "{flags:?}");
        assert!(kinds.contains(&"exit-in-test"), "{flags:?}");
        assert_eq!(kinds.iter().filter(|k| **k == "test-deleted").count(), 2, "{flags:?}");
        assert_eq!(kinds.iter().filter(|k| **k == "exit-in-test").count(), 1, "an exit outside a test file is not flagged: {flags:?}");
        assert!(scan_diff("diff --git a/x.rs b/x.rs\n+fn plain() {}\n").is_empty());
    }

}
