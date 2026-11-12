//! The task types: what each one promises at `create` (its plan) and what it
//! must prove at `done` (its result), checked here and nowhere else.
//!
//! The same table answers `GET /api/workbench/task-types` and
//! `atelier task types [TYPE]`, so the shape an agent is shown is the shape
//! the server accepts (docs/tasks.md, "Types").

use serde_json::{json, Map, Value};
use std::collections::HashMap;

type Row = Map<String, Value>;

/// One task type.
pub struct TaskType {
    pub name: &'static str,
    /// `done` must name commits that exist in the session's repository.
    pub code: bool,
    /// `done` goes to `review` and the owner approves.
    pub review: bool,
    /// Short field descriptions, as the docs give them.
    pub plan: &'static str,
    pub result: &'static str,
}

pub const TYPES: &[TaskType] = &[
    TaskType { name: "bug", code: true, review: false,
        plan: "symptom, repro_steps[], expected, actual, suspected_area?",
        result: "root_cause, fix, proof (evidence that it failed before and passes after), regression_checked[]" },
    TaskType { name: "feature", code: true, review: false,
        plan: "outcome, criteria[] {id, text}",
        result: "criteria[] {id, met, evidence, reason?} (reason required when not met)" },
    TaskType { name: "ui_change", code: true, review: true,
        plan: "screens[] {id, name, how_to_reach, change}",
        result: "screens[] {id, before, after, notes?} (before and after are paths to two different images)" },
    TaskType { name: "visual_bug", code: true, review: true,
        plan: "symptom, repro_steps[], expected, actual, suspected_area?, screens[] {id, name, how_to_reach}",
        result: "root_cause, fix, screens[] {id, before, after, notes?} (before shows the bug, after shows it fixed: paths to two different images)" },
    TaskType { name: "render_change", code: true, review: true,
        plan: "scenes[] {id, scene, camera, change, reference?} (camera is the camera settings as text; reference: true when a reference image must be given)",
        result: "scenes[] {id, before, after, reference?, notes?} (before and after are renders of the same scene and camera, two different images; reference is an image, required when the plan item has reference: true)" },
    TaskType { name: "optimization", code: true, review: false,
        plan: "targets[] {id, name, metric, unit, baseline, target, how_measured, environment, higher_is_better?} (baseline and target are numbers; lower is better unless higher_is_better)",
        result: "method, targets[] {id, before, after, runs, why_faster?, failure_reason?} (met is worked out from after and target; why_faster required when met, failure_reason when not)" },
    TaskType { name: "plan", code: false, review: true,
        plan: "question, scope, constraints[]",
        result: "document (markdown), decisions[], open_questions[], proposed_tasks[] {type, title, why}" },
    TaskType { name: "investigation", code: false, review: false,
        plan: "questions[] {id, text}",
        result: "answers[] {id, answer, evidence[], confidence: low|medium|high, recommendation?}" },
    TaskType { name: "refactor", code: true, review: false,
        plan: "change, reason, invariants[] {id, text}",
        result: "invariants[] {id, how_verified}, files_changed, net_lines, deviations[]" },
    TaskType { name: "tests", code: true, review: false,
        plan: "behaviors[] {id, text}",
        result: "behaviors[] {id, test_path, test_name, fails_without_code, reason?} (reason required when fails_without_code is false)" },
    TaskType { name: "review", code: false, review: false,
        plan: "target (diff, branch or commit range), focus[]",
        result: "verdict: approve|changes_needed, findings[] {severity: high|medium|low, location, summary, failure_scenario}" },
    TaskType { name: "qa", code: false, review: false,
        plan: "scenarios[] {id, steps[], expected}",
        result: "scenarios[] {id, passed, evidence, notes?} (notes required when not passed)" },
    TaskType { name: "docs", code: true, review: false,
        plan: "audience, pages[] {id, path, change}",
        result: "pages[] {id, path, what_changed}" },
    TaskType { name: "chore", code: true, review: false,
        plan: "steps[] {id, text}",
        result: "steps[] {id, done, output?, reason?} (reason required when not done)" },
    TaskType { name: "general", code: false, review: false,
        plan: "outcome, done_when[] {id, text}",
        result: "done_when[] {id, met, evidence, reason?} (reason required when not met)" },
];

pub fn find(name: &str) -> Option<&'static TaskType> {
    TYPES.iter().find(|kind| kind.name == name)
}

pub fn names() -> String {
    TYPES.iter().map(|kind| kind.name).collect::<Vec<_>>().join(", ")
}

/// `GET /api/workbench/task-types`.
pub fn listing() -> Value {
    json!({"types": TYPES.iter().map(|kind| json!({
        "name": kind.name, "code": kind.code, "review": kind.review,
        "plan": kind.plan, "result": kind.result,
    })).collect::<Vec<_>>()})
}

/// A filled-in example of the `create` payload and the `done` payload for one
/// type, for an agent to copy (`atelier task types TYPE`).
pub fn example(name: &str) -> Option<Value> {
    let kind = find(name)?;
    let (plan, result) = examples(name);
    let mut done = json!({"summary": "One or two sentences on what was done."});
    if kind.code {
        done["commits"] = json!(["<sha of a commit in this worktree>"]);
    }
    done["followups"] = json!([{"type": "chore", "title": "Optional suggestion", "why": "Why it is worth doing"}]);
    // One plan item's entry, as `atelier task check` takes it while the work
    // goes on: the same entry the done result would carry, without its id.
    let check = item_lists(name).and_then(|(_, key)| {
        let mut entry = result[key][0].clone();
        let id = entry.as_object_mut()?.remove("id")?;
        Some(json!({"command": format!("atelier task check N {}", id.as_str().unwrap_or("ID")), "entry": entry}))
    });
    done["result"] = result;
    let mut shown = json!({
        "type": kind.name, "code": kind.code, "review": kind.review,
        "plan_fields": kind.plan, "result_fields": kind.result,
        "create": {"type": kind.name, "title": "Short title (≤ 120 chars)", "why": "One line (≤ 300 chars)", "plan": plan},
    });
    if let Some(check) = check {
        shown["check"] = check;
    }
    shown["done"] = done;
    Some(shown)
}

fn examples(name: &str) -> (Value, Value) {
    match name {
        "bug" => (
            json!({"symptom": "Saving a draft twice loses the title", "repro_steps": ["Open a draft", "Press save twice"], "expected": "Title kept", "actual": "Title is empty", "suspected_area": "src/drafts/save.ts"}),
            json!({"root_cause": "The second save sends a stale form", "fix": "Read the form at send time", "proof": "test drafts::saves_twice failed before the fix and passes after", "regression_checked": ["drafts::autosave still passes"]}),
        ),
        "feature" => (
            json!({"outcome": "Owners can export a chat as markdown", "criteria": [{"id": "export", "text": "An Export button downloads a .md file"}, {"id": "images", "text": "Images are linked, not inlined"}]}),
            json!({"criteria": [{"id": "export", "met": true, "evidence": "e2e chat-export.spec.ts"}, {"id": "images", "met": false, "evidence": "Images are still inlined", "reason": "Needs the asset server, out of scope"}]}),
        ),
        "ui_change" => (
            json!({"screens": [{"id": "settings", "name": "Settings", "how_to_reach": "Sidebar > Settings", "change": "Group toggles under headings"}]}),
            json!({"screens": [{"id": "settings", "before": "shots/settings-before.png", "after": "shots/settings-after.png", "notes": "Dark theme checked too"}]}),
        ),
        "visual_bug" => (
            json!({"symptom": "Menu icons are blurry on 2x screens", "repro_steps": ["Open the app on a 2x display", "Open the settings menu"], "expected": "Sharp icons", "actual": "Blurry icons", "suspected_area": "src/icons/sprite.png",
                "screens": [{"id": "menu", "name": "Settings menu", "how_to_reach": "Header > Settings"}]}),
            json!({"root_cause": "Icons were 1x PNG sprites scaled up", "fix": "Draw the icons as inline SVG",
                "screens": [{"id": "menu", "before": "shots/menu-before.png", "after": "shots/menu-after.png", "notes": "Dark theme checked too"}]}),
        ),
        "render_change" => (
            json!({"scenes": [{"id": "sponza", "scene": "scenes/sponza.gltf", "camera": "position 0 2 8, look at 0 1 0, fov 60", "change": "Soft shadows from the sun light", "reference": true}]}),
            json!({"scenes": [{"id": "sponza", "before": "renders/sponza-before.png", "after": "renders/sponza-after.png", "reference": "renders/sponza-reference.png", "notes": "1024 samples"}]}),
        ),
        "optimization" => (
            json!({"targets": [{"id": "p95", "name": "Chat open p95", "metric": "p95 latency", "unit": "ms", "baseline": 140, "target": 100, "how_measured": "bench/open.ts, 50 runs", "environment": "local release build"}]}),
            json!({"method": "Cached the transcript fold", "targets": [{"id": "p95", "before": 140, "after": 90, "runs": 50, "why_faster": "The fold is no longer rebuilt on every open"}]}),
        ),
        "plan" => (
            json!({"question": "How should tasks replace the board?", "scope": "Server and UI", "constraints": ["No data loss"]}),
            json!({"document": "# Plan\n\n…", "decisions": ["Tasks live in workbench.db"], "open_questions": ["Do we import old cards?"], "proposed_tasks": [{"type": "feature", "title": "Tasks tab", "why": "Owners need to see tasks"}]}),
        ),
        "investigation" => (
            json!({"questions": [{"id": "leak", "text": "Why does memory grow overnight?"}]}),
            json!({"answers": [{"id": "leak", "answer": "The watch poller never drops closed receivers", "evidence": ["server/src/routes/live.rs:180", "heap profile shots/heap.png"], "confidence": "medium", "recommendation": "Drop receivers on close"}]}),
        ),
        "refactor" => (
            json!({"change": "Split store.rs by table", "reason": "7000 lines is hard to review", "invariants": [{"id": "schema", "text": "The schema is unchanged"}]}),
            json!({"invariants": [{"id": "schema", "how_verified": "sqlite .schema diff is empty"}], "files_changed": 6, "net_lines": -40, "deviations": []}),
        ),
        "tests" => (
            json!({"behaviors": [{"id": "retry", "text": "A failed upload is retried once"}]}),
            json!({"behaviors": [{"id": "retry", "test_path": "server/src/upload.rs", "test_name": "a_failed_upload_is_retried_once", "fails_without_code": true}]}),
        ),
        "review" => (
            json!({"target": "main..feature-branch", "focus": ["error handling"]}),
            json!({"verdict": "changes_needed", "findings": [{"severity": "high", "location": "server/src/a.rs:10", "summary": "Unwrap on user input", "failure_scenario": "An empty body panics the handler"}]}),
        ),
        "qa" => (
            json!({"scenarios": [{"id": "login", "steps": ["Open /", "Sign in"], "expected": "The dashboard shows"}]}),
            json!({"scenarios": [{"id": "login", "passed": true, "evidence": "shots/login.png"}]}),
        ),
        "docs" => (
            json!({"audience": "New contributors", "pages": [{"id": "readme", "path": "README.md", "change": "Add a quick start"}]}),
            json!({"pages": [{"id": "readme", "path": "README.md", "what_changed": "Added a five-step quick start"}]}),
        ),
        "chore" => (
            json!({"steps": [{"id": "deps", "text": "Update reqwest to 0.12"}]}),
            json!({"steps": [{"id": "deps", "done": true, "output": "cargo build passes"}]}),
        ),
        _ => (
            json!({"outcome": "The release notes are published", "done_when": [{"id": "posted", "text": "Notes are on the site"}]}),
            json!({"done_when": [{"id": "posted", "met": true, "evidence": "https://example.com/notes"}]}),
        ),
    }
}

// ---------------------------------------------------------------- checking

const TEXT_LIMIT: usize = 20_000;
const DOCUMENT_LIMIT: usize = 200_000;

fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "true/false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

fn object<'a>(value: &'a Value, at: &str) -> Result<&'a Row, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{at} must be an object, got {}", kind_of(value)))
}

fn only(row: &Row, allowed: &[&str], at: &str) -> Result<(), String> {
    match row.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(unknown) => Err(format!(
            "{at}: {unknown} is not a field here (allowed: {})",
            allowed.join(", ")
        )),
        None => Ok(()),
    }
}

fn present<'a>(row: &'a Row, key: &str) -> Option<&'a Value> {
    row.get(key).filter(|value| !value.is_null())
}

fn text_value<'a>(value: &'a Value, at: &str, limit: usize) -> Result<&'a str, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{at} must be text, got {}", kind_of(value)))?;
    if text.trim().is_empty() {
        return Err(format!("{at} is blank"));
    }
    if text.chars().count() > limit {
        return Err(format!("{at} is {} characters; the limit is {limit}", text.chars().count()));
    }
    Ok(text)
}

fn text<'a>(row: &'a Row, key: &str, at: &str) -> Result<&'a str, String> {
    let value = present(row, key).ok_or_else(|| format!("{at}: {key} is required (text)"))?;
    text_value(value, &format!("{at}: {key}"), TEXT_LIMIT)
}

fn long_text<'a>(row: &'a Row, key: &str, at: &str) -> Result<&'a str, String> {
    let value = present(row, key).ok_or_else(|| format!("{at}: {key} is required (text)"))?;
    text_value(value, &format!("{at}: {key}"), DOCUMENT_LIMIT)
}

fn optional_text<'a>(row: &'a Row, key: &str, at: &str) -> Result<Option<&'a str>, String> {
    present(row, key)
        .map(|value| text_value(value, &format!("{at}: {key}"), TEXT_LIMIT))
        .transpose()
}

fn boolean(row: &Row, key: &str, at: &str) -> Result<bool, String> {
    match present(row, key) {
        None => Err(format!("{at}: {key} is required (true or false)")),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(other) => Err(format!("{at}: {key} must be true or false, got {}", kind_of(other))),
    }
}

fn optional_boolean(row: &Row, key: &str, at: &str) -> Result<bool, String> {
    match present(row, key) {
        None => Ok(false),
        Some(_) => boolean(row, key, at),
    }
}

fn number(row: &Row, key: &str, at: &str) -> Result<f64, String> {
    match present(row, key) {
        None => Err(format!("{at}: {key} is required (a number)")),
        Some(value) => value
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| format!("{at}: {key} must be a number, got {}", kind_of(value))),
    }
}

fn integer(row: &Row, key: &str, at: &str, least: i64) -> Result<i64, String> {
    let value = present(row, key).ok_or_else(|| format!("{at}: {key} is required (a whole number)"))?;
    let whole = value
        .as_i64()
        .ok_or_else(|| format!("{at}: {key} must be a whole number, got {}", kind_of(value)))?;
    if whole < least {
        return Err(format!("{at}: {key} is {whole}; it must be at least {least}"));
    }
    Ok(whole)
}

fn one_of<'a>(row: &'a Row, key: &str, at: &str, allowed: &[&str]) -> Result<&'a str, String> {
    let word = text(row, key, at).map_err(|_| {
        format!("{at}: {key} is required and is one of {}", allowed.join(", "))
    })?;
    if !allowed.contains(&word) {
        return Err(format!("{at}: {key} is \"{word}\"; it must be one of {}", allowed.join(", ")));
    }
    Ok(word)
}

fn list<'a>(row: &'a Row, key: &str, at: &str, least: usize) -> Result<&'a Vec<Value>, String> {
    let value = present(row, key).ok_or_else(|| format!("{at}: {key} is required (a list)"))?;
    let items = value
        .as_array()
        .ok_or_else(|| format!("{at}: {key} must be a list, got {}", kind_of(value)))?;
    if items.len() < least {
        return Err(format!("{at}: {key} is empty; it needs at least {least}"));
    }
    Ok(items)
}

fn texts<'a>(row: &'a Row, key: &str, at: &str, least: usize) -> Result<Vec<&'a str>, String> {
    let base = if at.contains(':') || at.contains('[') { format!("{at}: {key}") } else { format!("{at}.{key}") };
    list(row, key, at, least)?
        .iter()
        .enumerate()
        .map(|(index, item)| text_value(item, &format!("{base}[{index}]"), TEXT_LIMIT))
        .collect()
}

/// A path for a field inside `at`: `plan` + `criteria` reads `plan.criteria`.
fn child(at: &str, key: &str) -> String {
    format!("{at}.{key}")
}

/// A plan list whose entries carry a unique `id`. Returns `(id, entry, path)`.
fn plan_items<'a>(
    row: &'a Row,
    key: &str,
    at: &str,
    allowed: &[&str],
) -> Result<Vec<(String, &'a Row, String)>, String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for (index, item) in list(row, key, at, 1)?.iter().enumerate() {
        let mut path = format!("{}[{index}]", child(at, key));
        let entry = object(item, &path)?;
        let id = match present(entry, "id") {
            Some(Value::String(id)) if !id.trim().is_empty() => id.clone(),
            Some(Value::String(_)) => return Err(format!("{path}: id is blank")),
            Some(other) => return Err(format!("{path}: id must be text, got {}", kind_of(other))),
            None => return Err(format!("{path}: id is required (text, unique in {key})")),
        };
        if id.chars().count() > 64 {
            return Err(format!("{path}: id is longer than 64 characters"));
        }
        if let Some(first) = seen.insert(id.clone(), index) {
            return Err(format!(
                "{path}: id \"{id}\" is already used by {}[{first}]; ids must be unique in {key}",
                child(at, key)
            ));
        }
        path = format!("{path} (id \"{id}\")");
        only(entry, allowed, &path)?;
        out.push((id, entry, path));
    }
    Ok(out)
}

/// A result list that must have exactly one entry per plan id. Returned in
/// the result's order as `(id, entry, path)`.
fn covering<'a>(
    plan_ids: &[String],
    row: &'a Row,
    key: &str,
    at: &str,
    allowed: &[&str],
) -> Result<Vec<(String, &'a Row, String)>, String> {
    let name = child(at, key);
    let value = present(row, key).ok_or_else(|| {
        format!(
            "{at}: {key} is required (a list with one entry for each plan id: {})",
            plan_ids.join(", ")
        )
    })?;
    let items = value
        .as_array()
        .ok_or_else(|| format!("{at}: {key} must be a list, got {}", kind_of(value)))?;
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let path = format!("{name}[{index}]");
        let entry = object(item, &path)?;
        let id = match present(entry, "id") {
            Some(Value::String(id)) => id.clone(),
            _ => {
                return Err(format!(
                    "{path}: id is required and must be one of the plan ids: {}",
                    plan_ids.join(", ")
                ))
            }
        };
        if !plan_ids.contains(&id) {
            return Err(format!(
                "{path}: id \"{id}\" is not in the plan (plan ids: {})",
                plan_ids.join(", ")
            ));
        }
        if let Some(first) = seen.insert(id.clone(), index) {
            return Err(format!(
                "{path}: id \"{id}\" is already covered by {name}[{first}]; give each plan id exactly once"
            ));
        }
        let path = format!("{path} (id \"{id}\")");
        only(entry, allowed, &path)?;
        out.push((id, entry, path));
    }
    let missing: Vec<&str> = plan_ids
        .iter()
        .filter(|id| !seen.contains_key(*id))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{name} does not cover plan id{} {}: every plan id needs exactly one entry (record each with `atelier task check` as you go, or give it in the done result)",
            if missing.len() == 1 { "" } else { "s" },
            missing.iter().map(|id| format!("\"{id}\"")).collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(out)
}

/// `{type, title, why}`, as followups and proposed tasks are written.
pub fn check_suggestion(item: &Value, at: &str) -> Result<(), String> {
    let row = object(item, at)?;
    only(row, &["type", "title", "why"], at)?;
    let kind = text(row, "type", at)?;
    if find(kind).is_none() {
        return Err(format!("{at}: type \"{kind}\" is not a task type (types: {})", names()));
    }
    check_title(text(row, "title", at)?, &format!("{at}: title"))?;
    check_why(text(row, "why", at)?, &format!("{at}: why"))?;
    Ok(())
}

pub fn check_title(title: &str, at: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err(format!("{at} is blank"));
    }
    if title.chars().count() > 120 {
        return Err(format!("{at} is {} characters; the limit is 120", title.chars().count()));
    }
    if title.contains('\n') {
        return Err(format!("{at} must be one line"));
    }
    Ok(())
}

pub fn check_why(why: &str, at: &str) -> Result<(), String> {
    if why.trim().is_empty() {
        return Err(format!("{at} is blank"));
    }
    if why.chars().count() > 300 {
        return Err(format!("{at} is {} characters; the limit is 300", why.chars().count()));
    }
    if why.contains('\n') {
        return Err(format!("{at} must be one line"));
    }
    Ok(())
}

/// Check a plan for its type.
pub fn check_plan(kind: &str, plan: &Value) -> Result<(), String> {
    let at = "plan";
    let row = object(plan, at)?;
    match kind {
        "bug" => {
            only(row, &["symptom", "repro_steps", "expected", "actual", "suspected_area"], at)?;
            text(row, "symptom", at)?;
            texts(row, "repro_steps", at, 1)?;
            text(row, "expected", at)?;
            text(row, "actual", at)?;
            optional_text(row, "suspected_area", at)?;
        }
        "feature" => {
            only(row, &["outcome", "criteria"], at)?;
            text(row, "outcome", at)?;
            for (_, entry, path) in plan_items(row, "criteria", at, &["id", "text"])? {
                text(entry, "text", &path)?;
            }
        }
        "ui_change" => {
            only(row, &["screens"], at)?;
            for (_, entry, path) in plan_items(row, "screens", at, &["id", "name", "how_to_reach", "change"])? {
                text(entry, "name", &path)?;
                text(entry, "how_to_reach", &path)?;
                text(entry, "change", &path)?;
            }
        }
        "visual_bug" => {
            only(row, &["symptom", "repro_steps", "expected", "actual", "suspected_area", "screens"], at)?;
            text(row, "symptom", at)?;
            texts(row, "repro_steps", at, 1)?;
            text(row, "expected", at)?;
            text(row, "actual", at)?;
            optional_text(row, "suspected_area", at)?;
            for (_, entry, path) in plan_items(row, "screens", at, &["id", "name", "how_to_reach"])? {
                text(entry, "name", &path)?;
                text(entry, "how_to_reach", &path)?;
            }
        }
        "render_change" => {
            only(row, &["scenes"], at)?;
            for (_, entry, path) in plan_items(row, "scenes", at, &["id", "scene", "camera", "change", "reference"])? {
                text(entry, "scene", &path)?;
                text(entry, "camera", &path)?;
                text(entry, "change", &path)?;
                optional_boolean(entry, "reference", &path)?;
            }
        }
        "optimization" => {
            only(row, &["targets"], at)?;
            let allowed = ["id", "name", "metric", "unit", "baseline", "target", "how_measured", "environment", "higher_is_better"];
            for (_, entry, path) in plan_items(row, "targets", at, &allowed)? {
                for key in ["name", "metric", "unit"] {
                    text(entry, key, &path)?;
                }
                number(entry, "baseline", &path)?;
                number(entry, "target", &path)?;
                text(entry, "how_measured", &path)?;
                text(entry, "environment", &path)?;
                optional_boolean(entry, "higher_is_better", &path)?;
            }
        }
        "plan" => {
            only(row, &["question", "scope", "constraints"], at)?;
            text(row, "question", at)?;
            text(row, "scope", at)?;
            texts(row, "constraints", at, 0)?;
        }
        "investigation" => {
            only(row, &["questions"], at)?;
            for (_, entry, path) in plan_items(row, "questions", at, &["id", "text"])? {
                text(entry, "text", &path)?;
            }
        }
        "refactor" => {
            only(row, &["change", "reason", "invariants"], at)?;
            text(row, "change", at)?;
            text(row, "reason", at)?;
            for (_, entry, path) in plan_items(row, "invariants", at, &["id", "text"])? {
                text(entry, "text", &path)?;
            }
        }
        "tests" => {
            only(row, &["behaviors"], at)?;
            for (_, entry, path) in plan_items(row, "behaviors", at, &["id", "text"])? {
                text(entry, "text", &path)?;
            }
        }
        "review" => {
            only(row, &["target", "focus"], at)?;
            text(row, "target", at)?;
            texts(row, "focus", at, 0)?;
        }
        "qa" => {
            only(row, &["scenarios"], at)?;
            for (_, entry, path) in plan_items(row, "scenarios", at, &["id", "steps", "expected"])? {
                texts(entry, "steps", &path, 1)?;
                text(entry, "expected", &path)?;
            }
        }
        "docs" => {
            only(row, &["audience", "pages"], at)?;
            text(row, "audience", at)?;
            for (_, entry, path) in plan_items(row, "pages", at, &["id", "path", "change"])? {
                text(entry, "path", &path)?;
                text(entry, "change", &path)?;
            }
        }
        "chore" => {
            only(row, &["steps"], at)?;
            for (_, entry, path) in plan_items(row, "steps", at, &["id", "text"])? {
                text(entry, "text", &path)?;
            }
        }
        "general" => {
            only(row, &["outcome", "done_when"], at)?;
            text(row, "outcome", at)?;
            for (_, entry, path) in plan_items(row, "done_when", at, &["id", "text"])? {
                text(entry, "text", &path)?;
            }
        }
        other => return Err(format!("type \"{other}\" is not a task type (types: {})", names())),
    }
    Ok(())
}

/// A plan list's ids, from a plan that has already been checked.
fn plan_ids(plan: &Value, key: &str) -> Vec<String> {
    plan[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_string))
        .collect()
}

/// Whether an optimization target was met, and how that reads in a message.
pub fn target_met(plan_target: &Value, after: f64) -> (bool, String) {
    let target = plan_target["target"].as_f64().unwrap_or(f64::NAN);
    let higher = plan_target["higher_is_better"].as_bool().unwrap_or(false);
    let met = if higher { after >= target } else { after <= target };
    let verb = if met { "meets" } else { "does not meet" };
    (met, format!("after {after} {verb} target {target}"))
}

/// The plan list a type's result answers one entry per item, as
/// `(plan key, result key)`: what `atelier task check` ticks. Types without
/// one (bug, plan, review) have nothing to tick.
pub fn item_lists(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "feature" => ("criteria", "criteria"),
        "general" => ("done_when", "done_when"),
        "ui_change" => ("screens", "screens"),
        "visual_bug" => ("screens", "screens"),
        "render_change" => ("scenes", "scenes"),
        "optimization" => ("targets", "targets"),
        "investigation" => ("questions", "answers"),
        "refactor" => ("invariants", "invariants"),
        "tests" => ("behaviors", "behaviors"),
        "qa" => ("scenarios", "scenarios"),
        "docs" => ("pages", "pages"),
        "chore" => ("steps", "steps"),
        _ => return None,
    })
}

/// The fields one result entry may carry, by type.
fn entry_fields(kind: &str) -> &'static [&'static str] {
    match kind {
        "feature" | "general" => &["id", "met", "evidence", "reason"],
        "ui_change" | "visual_bug" => &["id", "before", "after", "notes"],
        "render_change" => &["id", "before", "after", "reference", "notes"],
        "optimization" => &["id", "before", "after", "runs", "why_faster", "failure_reason"],
        "investigation" => &["id", "answer", "evidence", "confidence", "recommendation"],
        "refactor" => &["id", "how_verified"],
        "tests" => &["id", "test_path", "test_name", "fails_without_code", "reason"],
        "qa" => &["id", "passed", "evidence", "notes"],
        "docs" => &["id", "path", "what_changed"],
        "chore" => &["id", "done", "output", "reason"],
        _ => &["id"],
    }
}

/// Check one result entry against its plan item. Returns the reason when the
/// item was not met, None when it was.
fn check_item(kind: &str, plan_item: &Value, entry: &Row, path: &str) -> Result<Option<String>, String> {
    let unmet = |flag: bool, why: Option<&str>, key: &str, because: &str| -> Result<Option<String>, String> {
        if flag {
            return Ok(None);
        }
        why.map(|why| Some(why.to_string()))
            .ok_or_else(|| format!("{path}: {key} is required because {because}"))
    };
    match kind {
        "feature" | "general" => {
            let met = boolean(entry, "met", path)?;
            text(entry, "evidence", path)?;
            let reason = optional_text(entry, "reason", path)?;
            unmet(met, reason, "reason", "met is false")
        }
        "ui_change" | "visual_bug" | "render_change" => {
            before_and_after(entry, path)?;
            let wanted = plan_item.get("reference").and_then(Value::as_bool).unwrap_or(false);
            match optional_text(entry, "reference", path)? {
                Some(shot) => image(shot, "reference", path)?,
                None if wanted => {
                    return Err(format!(
                        "{path}: reference is required because the plan asks for a reference image for this scene"
                    ))
                }
                None => {}
            }
            optional_text(entry, "notes", path)?;
            Ok(None)
        }
        "optimization" => {
            number(entry, "before", path)?;
            let after = number(entry, "after", path)?;
            integer(entry, "runs", path, 1)?;
            let why_faster = optional_text(entry, "why_faster", path)?;
            let failure = optional_text(entry, "failure_reason", path)?;
            let (met, how) = target_met(plan_item, after);
            if met {
                if why_faster.is_none() {
                    return Err(format!("{path}: why_faster is required because {how}"));
                }
                if failure.is_some() {
                    return Err(format!("{path}: failure_reason is only for a target that was missed, and {how}"));
                }
                Ok(None)
            } else {
                failure
                    .map(|why| Some(why.to_string()))
                    .ok_or_else(|| format!("{path}: failure_reason is required because {how}"))
            }
        }
        "investigation" => {
            text(entry, "answer", path)?;
            texts(entry, "evidence", path, 1)?;
            one_of(entry, "confidence", path, &["low", "medium", "high"])?;
            optional_text(entry, "recommendation", path)?;
            Ok(None)
        }
        "refactor" => {
            text(entry, "how_verified", path)?;
            Ok(None)
        }
        "tests" => {
            text(entry, "test_path", path)?;
            text(entry, "test_name", path)?;
            let fails = boolean(entry, "fails_without_code", path)?;
            let reason = optional_text(entry, "reason", path)?;
            unmet(fails, reason, "reason", "fails_without_code is false")
        }
        "qa" => {
            let passed = boolean(entry, "passed", path)?;
            text(entry, "evidence", path)?;
            let notes = optional_text(entry, "notes", path)?;
            unmet(passed, notes, "notes", "passed is false")
        }
        "docs" => {
            text(entry, "path", path)?;
            text(entry, "what_changed", path)?;
            Ok(None)
        }
        "chore" => {
            let done = boolean(entry, "done", path)?;
            optional_text(entry, "output", path)?;
            let reason = optional_text(entry, "reason", path)?;
            unmet(done, reason, "reason", "done is false")
        }
        other => Err(format!("a {other} task has no plan items to check")),
    }
}

/// Whether a type's every item is proved with before and after images.
pub fn is_visual(kind: &str) -> bool {
    matches!(kind, "ui_change" | "visual_bug" | "render_change")
}

/// One stored image: the served address an uploaded PNG, JPEG, GIF or WebP
/// file was given. A path still in the result was not uploaded: the file was
/// missing, or not an image.
fn image(shot: &str, side: &str, path: &str) -> Result<(), String> {
    if is_served_image(shot) {
        return Ok(());
    }
    Err(format!(
        "{path}: {side} must be a path to a PNG, JPEG, GIF or WebP file in the session's folder; \"{shot}\" could not be read as one (missing, or not an image)"
    ))
}

/// A visual item's `before` and `after`: two stored images, and not the same
/// one. The served address is named by the file's SHA-256, so the same file
/// given twice has the same address.
fn before_and_after(entry: &Row, path: &str) -> Result<(), String> {
    let before = text(entry, "before", path)?;
    let after = text(entry, "after", path)?;
    image(before, "before", path)?;
    image(after, "after", path)?;
    if before == after {
        return Err(format!(
            "{path}: before and after are the same image (the same file contents); before shows how it was, after shows the change"
        ));
    }
    Ok(())
}

/// A plan item by its id, from a plan that has already been checked.
fn plan_item<'a>(plan: &'a Value, key: &str, id: &str) -> Option<&'a Value> {
    plan[key].as_array()?.iter().find(|item| item["id"].as_str() == Some(id))
}

/// Check every entry of a type's item list against the plan, adding each
/// unmet item to `unmet` as `id: reason`.
fn check_items(kind: &str, plan: &Value, row: &Row, at: &str, unmet: &mut Vec<String>) -> Result<(), String> {
    let (plan_key, result_key) = item_lists(kind).ok_or_else(|| format!("a {kind} task has no plan items"))?;
    for (id, entry, path) in covering(&plan_ids(plan, plan_key), row, result_key, at, entry_fields(kind))? {
        let item = plan_item(plan, plan_key, &id).unwrap_or(&Value::Null);
        if let Some(reason) = check_item(kind, item, entry, &path)? {
            unmet.push(format!("{id}: {reason}"));
        }
    }
    Ok(())
}

/// One plan item's result entry, as `atelier task check N ITEM` records it
/// while the work goes on: the same shape and the same checks as that entry
/// in the type's `done` result. Returns the entry with its `id` and, when the
/// item was not met, the reason.
pub fn check_one(kind: &str, plan: &Value, item: &str, entry: &Value) -> Result<(Value, Option<String>), String> {
    let (plan_key, result_key) = item_lists(kind).ok_or_else(|| {
        format!("a {kind} task has no plan items to check; its whole result is given with `atelier task done`")
    })?;
    let ids = plan_ids(plan, plan_key);
    let planned = plan_item(plan, plan_key, item).ok_or_else(|| {
        format!("\"{item}\" is not an item in the plan (plan {plan_key} ids: {})", ids.join(", "))
    })?;
    let path = format!("{result_key} entry (id \"{item}\")");
    let row = object(entry, &path)?;
    match present(row, "id") {
        None => {}
        Some(Value::String(id)) if id == item => {}
        Some(other) => {
            return Err(format!("{path}: id is {other}, but the command names \"{item}\"; leave id out or make them match"))
        }
    }
    only(row, entry_fields(kind), &path)?;
    let reason = check_item(kind, planned, row, &path)?;
    let mut stored = Row::new();
    stored.insert("id".into(), json!(item));
    for (key, value) in row {
        if key != "id" {
            stored.insert(key.clone(), value.clone());
        }
    }
    Ok((Value::Object(stored), reason))
}

/// The plan ids a type ticks, in plan order (empty for a type with none).
pub fn item_ids(kind: &str, plan: &Value) -> Vec<String> {
    item_lists(kind).map(|(plan_key, _)| plan_ids(plan, plan_key)).unwrap_or_default()
}

/// Check a result against the (approved) plan. Returns the unmet plan items,
/// each with its reason; an empty list means no shortfalls.
pub fn check_result(kind: &str, plan: &Value, result: &Value) -> Result<Vec<String>, String> {
    let at = "result";
    let row = object(result, at)?;
    let mut unmet = Vec::new();
    match kind {
        "visual_bug" => {
            only(row, &["root_cause", "fix", "screens"], at)?;
            text(row, "root_cause", at)?;
            text(row, "fix", at)?;
            check_items(kind, plan, row, at, &mut unmet)?;
        }
        "bug" => {
            only(row, &["root_cause", "fix", "proof", "regression_checked"], at)?;
            text(row, "root_cause", at)?;
            text(row, "fix", at)?;
            text(row, "proof", at)?;
            texts(row, "regression_checked", at, 0)?;
        }
        "optimization" => {
            only(row, &["method", "targets"], at)?;
            text(row, "method", at)?;
            check_items(kind, plan, row, at, &mut unmet)?;
        }
        "plan" => {
            only(row, &["document", "decisions", "open_questions", "proposed_tasks"], at)?;
            long_text(row, "document", at)?;
            texts(row, "decisions", at, 0)?;
            texts(row, "open_questions", at, 0)?;
            for (index, item) in list(row, "proposed_tasks", at, 0)?.iter().enumerate() {
                check_suggestion(item, &format!("result.proposed_tasks[{index}]"))?;
            }
        }
        "refactor" => {
            only(row, &["invariants", "files_changed", "net_lines", "deviations"], at)?;
            check_items(kind, plan, row, at, &mut unmet)?;
            integer(row, "files_changed", at, 0)?;
            integer(row, "net_lines", at, i64::MIN)?;
            texts(row, "deviations", at, 0)?;
        }
        "review" => {
            only(row, &["verdict", "findings"], at)?;
            let verdict = one_of(row, "verdict", at, &["approve", "changes_needed"])?;
            let findings = list(row, "findings", at, 0)?;
            if verdict == "changes_needed" && findings.is_empty() {
                return Err("result: findings is empty, and verdict changes_needed needs at least one finding".into());
            }
            for (index, item) in findings.iter().enumerate() {
                let path = format!("result.findings[{index}]");
                let entry = object(item, &path)?;
                only(entry, &["severity", "location", "summary", "failure_scenario"], &path)?;
                one_of(entry, "severity", &path, &["high", "medium", "low"])?;
                text(entry, "location", &path)?;
                text(entry, "summary", &path)?;
                text(entry, "failure_scenario", &path)?;
            }
        }
        other => {
            let Some((_, result_key)) = item_lists(other) else {
                return Err(format!("type \"{other}\" is not a task type (types: {})", names()));
            };
            only(row, &[result_key], at)?;
            check_items(kind, plan, row, at, &mut unmet)?;
        }
    }
    Ok(unmet)
}

/// The served form an uploaded image takes in a stored result.
pub const SERVED: &str = "/api/presentation-assets/";

fn is_served_image(value: &str) -> bool {
    value.strip_prefix(SERVED).is_some_and(|asset| {
        asset.rsplit_once('.').is_some_and(|(hash, extension)| {
            hash.len() == 64 && matches!(extension, "png" | "jpg" | "gif" | "webp")
        })
    })
}

/// Whether a string in a result names an image or video file by its
/// extension, so the CLI uploads it and the server stores it.
pub fn looks_like_media(value: &str) -> bool {
    let value = value.trim();
    if value.contains('\n') || value.len() > 4096 || value.starts_with(SERVED) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    MEDIA_EXTENSIONS.iter().any(|extension| lower.ends_with(&format!(".{extension}")))
}

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
pub const MEDIA_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "m4v"];

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(n: char) -> String {
        format!("{SERVED}{}.png", n.to_string().repeat(64))
    }

    #[test]
    fn every_example_passes_its_own_checks() {
        for kind in TYPES {
            let (plan, mut result) = examples(kind.name);
            if let Some((_, key)) = item_lists(kind.name).filter(|_| is_visual(kind.name)) {
                result[key][0]["before"] = json!(asset('a'));
                result[key][0]["after"] = json!(asset('b'));
                if kind.name == "render_change" {
                    result[key][0]["reference"] = json!(asset('c'));
                }
            }
            check_plan(kind.name, &plan).unwrap_or_else(|e| panic!("{} plan: {e}", kind.name));
            check_result(kind.name, &plan, &result)
                .unwrap_or_else(|e| panic!("{} result: {e}", kind.name));
            assert!(example(kind.name).is_some());
        }
    }

    fn plan_error(kind: &str, plan: Value) -> String {
        check_plan(kind, &plan).unwrap_err()
    }

    fn result_error(kind: &str, plan: Value, result: Value) -> String {
        check_plan(kind, &plan).unwrap();
        check_result(kind, &plan, &result).unwrap_err()
    }

    #[test]
    fn an_unknown_type_is_named_back() {
        assert!(plan_error("epic", json!({})).contains("\"epic\" is not a task type"));
    }

    #[test]
    fn bug() {
        let plan = examples("bug").0;
        assert_eq!(plan_error("bug", json!({"symptom": "x", "expected": "y", "actual": "z"})),
            "plan: repro_steps is required (a list)");
        assert_eq!(plan_error("bug", json!({"symptom": "x", "repro_steps": [], "expected": "y", "actual": "z"})),
            "plan: repro_steps is empty; it needs at least 1");
        assert_eq!(plan_error("bug", json!({"symptom": "x", "repro_steps": ["a", " "], "expected": "y", "actual": "z"})),
            "plan.repro_steps[1] is blank");
        assert_eq!(result_error("bug", plan.clone(), json!({"root_cause": "a", "fix": "b", "regression_checked": []})),
            "result: proof is required (text)");
        assert!(result_error("bug", plan, json!({"root_cause": "a", "fix": "b", "proof": "c", "regression_checked": [], "extra": 1}))
            .starts_with("result: extra is not a field here"));
    }

    #[test]
    fn feature_needs_a_reason_for_each_unmet_criterion() {
        let plan = examples("feature").0;
        let error = result_error("feature", plan.clone(), json!({"criteria": [
            {"id": "export", "met": true, "evidence": "e"},
            {"id": "images", "met": false, "evidence": "e"}]}));
        assert_eq!(error, "result.criteria[1] (id \"images\"): reason is required because met is false");
        let unmet = check_result("feature", &plan, &examples("feature").1).unwrap();
        assert_eq!(unmet, vec!["images: Needs the asset server, out of scope"]);
    }

    #[test]
    fn plan_ids_are_unique_and_present() {
        assert_eq!(plan_error("feature", json!({"outcome": "o", "criteria": [{"id": "a", "text": "t"}, {"id": "a", "text": "u"}]})),
            "plan.criteria[1]: id \"a\" is already used by plan.criteria[0]; ids must be unique in criteria");
        assert_eq!(plan_error("feature", json!({"outcome": "o", "criteria": [{"text": "t"}]})),
            "plan.criteria[0]: id is required (text, unique in criteria)");
        assert_eq!(plan_error("feature", json!({"outcome": "o", "criteria": []})),
            "plan: criteria is empty; it needs at least 1");
    }

    #[test]
    fn a_result_covers_every_plan_id_exactly_once() {
        let plan = examples("feature").0;
        assert_eq!(result_error("feature", plan.clone(), json!({"criteria": [{"id": "export", "met": true, "evidence": "e"}]})),
            "result.criteria does not cover plan id \"images\": every plan id needs exactly one entry (record each with `atelier task check` as you go, or give it in the done result)");
        assert_eq!(result_error("feature", plan.clone(), json!({"criteria": [
            {"id": "export", "met": true, "evidence": "e"}, {"id": "export", "met": true, "evidence": "e"},
            {"id": "images", "met": true, "evidence": "e"}]})),
            "result.criteria[1]: id \"export\" is already covered by result.criteria[0]; give each plan id exactly once");
        assert_eq!(result_error("feature", plan, json!({"criteria": [{"id": "nope", "met": true, "evidence": "e"}]})),
            "result.criteria[0]: id \"nope\" is not in the plan (plan ids: export, images)");
    }

    #[test]
    fn ui_change_needs_stored_images() {
        let plan = examples("ui_change").0;
        let error = result_error("ui_change", plan.clone(), json!({"screens": [{"id": "settings", "before": "a.png", "after": asset('b')}]}));
        assert!(error.starts_with("result.screens[0] (id \"settings\"): before must be a path to a PNG"), "{error}");
        assert_eq!(result_error("ui_change", plan, json!({"screens": [{"id": "settings", "before": asset('a')}]})),
            "result.screens[0] (id \"settings\"): after is required (text)");
        assert!(plan_error("ui_change", json!({"screens": [{"id": "s", "name": "n", "change": "c"}]}))
            .contains("how_to_reach is required"));
    }

    #[test]
    fn visual_types_need_two_different_stored_images() {
        for kind in ["ui_change", "visual_bug", "render_change"] {
            let (plan, mut result) = examples(kind);
            let key = item_lists(kind).unwrap().1;
            result[key][0]["reference"] = json!(asset('c'));
            if kind != "render_change" {
                result[key][0].as_object_mut().unwrap().remove("reference");
            }
            // A path that was never uploaded: missing, or not an image.
            result[key][0]["before"] = json!("shots/missing.png");
            result[key][0]["after"] = json!(asset('b'));
            let error = result_error(kind, plan.clone(), result.clone());
            assert!(error.contains("before must be a path to a PNG") && error.contains("missing, or not an image"), "{kind}: {error}");
            result[key][0]["before"] = json!(asset('a'));
            result[key][0].as_object_mut().unwrap().remove("after");
            assert!(result_error(kind, plan.clone(), result.clone()).ends_with("after is required (text)"), "{kind}");
            // The same file for both sides.
            result[key][0]["after"] = json!(asset('a'));
            assert!(result_error(kind, plan.clone(), result.clone()).contains("before and after are the same image"), "{kind}");
            result[key][0]["after"] = json!(asset('b'));
            assert!(check_result(kind, &plan, &result).unwrap().is_empty(), "{kind}");
            // `check` is held to the same rule.
            let mut entry = result[key][0].clone();
            entry["after"] = json!(asset('a'));
            assert!(check_one(kind, &plan, entry["id"].as_str().unwrap(), &entry).unwrap_err().contains("same image"));
        }
    }

    #[test]
    fn visual_bug_has_the_bug_fields_and_screens() {
        let plan = examples("visual_bug").0;
        let mut without = plan.clone();
        without.as_object_mut().unwrap().remove("screens");
        assert_eq!(plan_error("visual_bug", without), "plan: screens is required (a list)");
        assert!(plan_error("visual_bug", json!({"symptom": "s", "repro_steps": ["a"], "expected": "e", "actual": "a",
            "screens": [{"id": "x", "name": "n"}]})).contains("how_to_reach is required"));
        let screens = json!([{"id": "menu", "before": asset('a'), "after": asset('b')}]);
        assert_eq!(result_error("visual_bug", plan.clone(), json!({"fix": "f", "screens": screens})),
            "result: root_cause is required (text)");
        assert!(check_result("visual_bug", &plan, &json!({"root_cause": "r", "fix": "f", "screens": screens})).unwrap().is_empty());
        assert_eq!(item_lists("visual_bug"), Some(("screens", "screens")));
        assert!(find("visual_bug").unwrap().review && find("visual_bug").unwrap().code);
    }

    #[test]
    fn render_change_needs_a_reference_only_where_the_plan_asks() {
        let plan = json!({"scenes": [
            {"id": "a", "scene": "a.gltf", "camera": "fov 60", "change": "c", "reference": true},
            {"id": "b", "scene": "b.gltf", "camera": "fov 40", "change": "c"}]});
        let both = |reference: Option<String>| {
            let mut first = json!({"id": "a", "before": asset('a'), "after": asset('b')});
            if let Some(shot) = reference { first["reference"] = json!(shot); }
            json!({"scenes": [first, {"id": "b", "before": asset('c'), "after": asset('d')}]})
        };
        assert_eq!(result_error("render_change", plan.clone(), both(None)),
            "result.scenes[0] (id \"a\"): reference is required because the plan asks for a reference image for this scene");
        assert!(result_error("render_change", plan.clone(), both(Some("ref.png".into()))).contains("reference must be a path to a PNG"));
        assert!(check_result("render_change", &plan, &both(Some(asset('e')))).unwrap().is_empty());
        assert!(plan_error("render_change", json!({"scenes": [{"id": "a", "scene": "s", "change": "c"}]})).contains("camera is required"));
        assert!(plan_error("render_change", json!({"scenes": [{"id": "a", "scene": "s", "camera": "c", "change": "c", "reference": "yes"}]}))
            .contains("reference must be true or false"));
    }

    fn optimization_plan(higher: bool) -> Value {
        json!({"targets": [
            {"id": "rps", "name": "Throughput", "metric": "requests/s", "unit": "rps", "baseline": 100, "target": 150, "how_measured": "wrk", "environment": "local", "higher_is_better": true},
            {"id": "mem", "name": "Memory", "metric": "rss", "unit": "MB", "baseline": 300, "target": 200, "how_measured": "ps", "environment": "local", "higher_is_better": higher},
            {"id": "p95", "name": "Latency", "metric": "p95", "unit": "ms", "baseline": 140, "target": 100, "how_measured": "bench", "environment": "local"}]})
    }

    #[test]
    fn optimization_works_out_met_and_demands_the_matching_reason() {
        let plan = optimization_plan(false);
        let entry = |id: &str, after: f64, extra: Value| {
            let mut row = json!({"id": id, "before": 1, "after": after, "runs": 5});
            for (k, v) in extra.as_object().unwrap() { row[k] = v.clone(); }
            row
        };
        let result = json!({"method": "m", "targets": [
            entry("rps", 160.0, json!({"why_faster": "w"})),
            entry("mem", 190.0, json!({"why_faster": "w"})),
            entry("p95", 140.0, json!({}))]});
        assert_eq!(result_error("optimization", plan.clone(), result),
            "result.targets[2] (id \"p95\"): failure_reason is required because after 140 does not meet target 100");
        let result = json!({"method": "m", "targets": [
            entry("rps", 160.0, json!({})),
            entry("mem", 190.0, json!({"why_faster": "w"})),
            entry("p95", 90.0, json!({"why_faster": "w"}))]});
        assert_eq!(result_error("optimization", plan.clone(), result),
            "result.targets[0] (id \"rps\"): why_faster is required because after 160 meets target 150");
        let result = json!({"method": "m", "targets": [
            entry("rps", 120.0, json!({"failure_reason": "IO bound"})),
            entry("mem", 190.0, json!({"why_faster": "w"})),
            entry("p95", 90.0, json!({"why_faster": "w", "failure_reason": "x"}))]});
        assert!(result_error("optimization", plan.clone(), result).contains("failure_reason is only for a target that was missed"));
        let result = json!({"method": "m", "targets": [
            entry("rps", 120.0, json!({"failure_reason": "IO bound"})),
            entry("mem", 190.0, json!({"why_faster": "w"})),
            entry("p95", 100.0, json!({"why_faster": "w"}))]});
        assert_eq!(check_result("optimization", &plan, &result).unwrap(), vec!["rps: IO bound"]);
        let result = json!({"method": "m", "targets": [
            entry("rps", 160.0, json!({"why_faster": "w"})),
            {"id": "mem", "before": 1, "after": "fast", "runs": 5},
            entry("p95", 90.0, json!({"why_faster": "w"}))]});
        assert_eq!(result_error("optimization", plan.clone(), result),
            "result.targets[1] (id \"mem\"): after must be a number, got text");
        let result = json!({"method": "m", "targets": [
            entry("rps", 160.0, json!({"why_faster": "w"})),
            {"id": "mem", "before": 1, "after": 1, "runs": 0, "why_faster": "w"},
            entry("p95", 90.0, json!({"why_faster": "w"}))]});
        assert_eq!(result_error("optimization", plan, result),
            "result.targets[1] (id \"mem\"): runs is 0; it must be at least 1");
        assert_eq!(plan_error("optimization", json!({"targets": [{"id": "x", "name": "n", "metric": "m", "unit": "u", "baseline": "fast", "target": 1, "how_measured": "h", "environment": "e"}]})),
            "plan.targets[0] (id \"x\"): baseline must be a number, got text");
    }

    #[test]
    fn plan_type() {
        let plan = examples("plan").0;
        assert_eq!(result_error("plan", plan.clone(), json!({"document": "d", "decisions": [], "open_questions": [], "proposed_tasks": [{"type": "epic", "title": "t", "why": "w"}]})),
            "result.proposed_tasks[0]: type \"epic\" is not a task type (types: bug, feature, ui_change, visual_bug, render_change, optimization, plan, investigation, refactor, tests, review, qa, docs, chore, general)");
        assert_eq!(result_error("plan", plan, json!({"decisions": [], "open_questions": [], "proposed_tasks": []})),
            "result: document is required (text)");
    }

    #[test]
    fn investigation() {
        let plan = examples("investigation").0;
        assert_eq!(result_error("investigation", plan.clone(), json!({"answers": [{"id": "leak", "answer": "a", "evidence": [], "confidence": "high"}]})),
            "result.answers[0] (id \"leak\"): evidence is empty; it needs at least 1");
        assert_eq!(result_error("investigation", plan, json!({"answers": [{"id": "leak", "answer": "a", "evidence": ["x"], "confidence": "sure"}]})),
            "result.answers[0] (id \"leak\"): confidence is \"sure\"; it must be one of low, medium, high");
    }

    #[test]
    fn refactor() {
        let plan = examples("refactor").0;
        assert_eq!(result_error("refactor", plan.clone(), json!({"invariants": [{"id": "schema", "how_verified": "v"}], "files_changed": 2.5, "net_lines": 1, "deviations": []})),
            "result: files_changed must be a whole number, got a number");
        assert!(check_result("refactor", &plan, &json!({"invariants": [{"id": "schema", "how_verified": "v"}], "files_changed": 2, "net_lines": -10, "deviations": []})).unwrap().is_empty());
    }

    #[test]
    fn tests_type() {
        let plan = examples("tests").0;
        assert_eq!(result_error("tests", plan.clone(), json!({"behaviors": [{"id": "retry", "test_path": "p", "test_name": "n", "fails_without_code": false}]})),
            "result.behaviors[0] (id \"retry\"): reason is required because fails_without_code is false");
        assert_eq!(result_error("tests", plan, json!({"behaviors": [{"id": "retry", "test_path": "p", "test_name": "n"}]})),
            "result.behaviors[0] (id \"retry\"): fails_without_code is required (true or false)");
    }

    #[test]
    fn review() {
        let plan = examples("review").0;
        assert_eq!(result_error("review", plan.clone(), json!({"verdict": "changes_needed", "findings": []})),
            "result: findings is empty, and verdict changes_needed needs at least one finding");
        assert_eq!(result_error("review", plan.clone(), json!({"verdict": "approve", "findings": [{"severity": "huge", "location": "l", "summary": "s", "failure_scenario": "f"}]})),
            "result.findings[0]: severity is \"huge\"; it must be one of high, medium, low");
        assert!(check_result("review", &plan, &json!({"verdict": "approve", "findings": []})).unwrap().is_empty());
        assert_eq!(plan_error("review", json!({"focus": []})), "plan: target is required (text)");
    }

    #[test]
    fn qa() {
        let plan = examples("qa").0;
        assert_eq!(result_error("qa", plan.clone(), json!({"scenarios": [{"id": "login", "passed": false, "evidence": "e"}]})),
            "result.scenarios[0] (id \"login\"): notes is required because passed is false");
        assert_eq!(check_result("qa", &plan, &json!({"scenarios": [{"id": "login", "passed": false, "evidence": "e", "notes": "500 error"}]})).unwrap(),
            vec!["login: 500 error"]);
        assert_eq!(plan_error("qa", json!({"scenarios": [{"id": "a", "steps": [], "expected": "x"}]})),
            "plan.scenarios[0] (id \"a\"): steps is empty; it needs at least 1");
    }

    #[test]
    fn docs() {
        let plan = examples("docs").0;
        assert_eq!(result_error("docs", plan, json!({"pages": [{"id": "readme", "path": "README.md"}]})),
            "result.pages[0] (id \"readme\"): what_changed is required (text)");
        assert_eq!(plan_error("docs", json!({"pages": [{"id": "a", "path": "p", "change": "c"}]})), "plan: audience is required (text)");
    }

    #[test]
    fn chore() {
        let plan = examples("chore").0;
        assert_eq!(result_error("chore", plan.clone(), json!({"steps": [{"id": "deps", "done": false}]})),
            "result.steps[0] (id \"deps\"): reason is required because done is false");
        assert_eq!(check_result("chore", &plan, &json!({"steps": [{"id": "deps", "done": false, "reason": "blocked upstream"}]})).unwrap(),
            vec!["deps: blocked upstream"]);
    }

    #[test]
    fn general() {
        let plan = examples("general").0;
        assert_eq!(result_error("general", plan, json!({"done_when": [{"id": "posted", "met": "yes", "evidence": "e"}]})),
            "result.done_when[0] (id \"posted\"): met must be true or false, got text");
        assert_eq!(plan_error("general", json!({"outcome": "o"})), "plan: done_when is required (a list)");
    }

    #[test]
    fn media_paths_are_recognised_by_extension() {
        assert!(looks_like_media("shots/a.PNG"));
        assert!(looks_like_media("/tmp/run.webm"));
        assert!(!looks_like_media("server/src/a.rs:10"));
        assert!(!looks_like_media(&asset('a')));
    }
}
