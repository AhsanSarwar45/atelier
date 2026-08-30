//! Provider hook entry points that must work on an installed machine with no
//! Python. Hard refusals are limited to ownership, protected Git history and
//! truthful lifecycle transitions. Writing preferences only warn.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

const GATES: &[&str] = &[
    "workflow-gate.py", "board-actor.py", "board-merge-gate.py",
    "board-status-gate.py", "wait-gate.py", "board-touch.py",
    "board-prime.py", "board-gate.py", "landing-gate.py",
    "habit-reading.py", "helper-proof.py", "plan-doc-lint.py",
    "slice-gate.py", "agent-fence.py", "picture-gate.py",
];

pub fn is_ours(name: &str) -> bool { GATES.contains(&name) }

pub fn run(name: &str) -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() { return 0; }
    let data: Value = serde_json::from_str(&input).unwrap_or_else(|_| json!({}));
    let output = match name {
        "board-actor.py" => actor(&data),
        "workflow-gate.py" => workflow(&data),
        "board-merge-gate.py" | "landing-gate.py" => merge_gate(&data),
        "board-status-gate.py" => status_gate(&data),
        "board-touch.py" => { touch(&data); None },
        "board-prime.py" => prime(&data),
        "board-gate.py" => stop_gate(&data),
        "wait-gate.py" => { wait_warning(&data); None },
        // Presentation and interaction-style hooks are deliberately retired.
        // Existing joined projects may still name them, so they answer here
        // rather than falling through to a Python script.
        _ => None,
    };
    if let Some(output) = output { println!("{}", output); }
    0
}

fn cwd(data: &Value) -> PathBuf {
    data["cwd"].as_str().map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| PathBuf::from("."))
}

fn root(data: &Value) -> PathBuf {
    let here = cwd(data);
    command(&here, "git", &["rev-parse", "--show-toplevel"])
        .filter(|(_, ok)| *ok).map(|(out, _)| PathBuf::from(out.trim()))
        .unwrap_or(here)
}

fn tool_input(data: &Value) -> &Value { data.get("tool_input").unwrap_or(&Value::Null) }
fn shell(data: &Value) -> &str { tool_input(data)["command"].as_str().unwrap_or("") }
fn session(data: &Value) -> String {
    format!("s-{}", data["session_id"].as_str().unwrap_or("nosession").chars().take(8).collect::<String>())
}

fn command(root: &Path, program: &str, args: &[&str]) -> Option<(String, bool)> {
    let resolved = if program == "git" { crate::routes::find_git().unwrap_or_else(|| PathBuf::from(program)) } else { PathBuf::from(program) };
    let output = Command::new(resolved).args(args).current_dir(root).output().ok()?;
    Some((String::from_utf8_lossy(&output.stdout).trim().to_string(), output.status.success()))
}

fn bd(root: &Path, args: &[&str]) -> Option<Value> {
    let path = crate::routes::find_bd()?;
    let output = Command::new(path).args(args).current_dir(root).output().ok()?;
    if !output.status.success() { return None; }
    serde_json::from_slice(&output.stdout).ok()
}

fn rows(value: Value) -> Vec<Value> {
    match value { Value::Array(rows) => rows, Value::Object(_) => vec![value], _ => Vec::new() }
}

fn pretool(decision: &str, reason: &str, updated: Option<Value>) -> Value {
    let mut output = json!({"hookEventName":"PreToolUse","permissionDecision":decision,
        "permissionDecisionReason":reason});
    if let Some(updated) = updated { output["updatedInput"] = updated; }
    json!({"hookSpecificOutput":output})
}

fn deny(reason: impl Into<String>) -> Option<Value> { Some(pretool("deny", &reason.into(), None)) }

fn actor(data: &Value) -> Option<Value> {
    if data["tool_name"].as_str() != Some("Bash") { return None; }
    let original = shell(data);
    if !original.split_whitespace().any(|word| word == "bd") || original.contains("bd --actor") { return None; }
    let who = session(data);
    let copy = cwd(data).to_string_lossy().split("/worktrees/").nth(1)
        .and_then(|tail| tail.split('/').next()).unwrap_or("main").to_string();
    let mut out = Vec::new();
    for line in original.lines() {
        let mut line = line.to_string();
        if line.trim_start().starts_with("bd ") {
            line = line.replacen("bd ", &format!("bd --actor {who} "), 1);
            if line.contains(" --claim") && !line.contains("copy:") {
                line = line.replacen("--claim", &format!("--claim --add-label copy:{copy}"), 1);
            }
        }
        out.push(line);
    }
    let stamped = out.join("\n");
    if stamped == original { return None; }
    let mut updated = tool_input(data).clone();
    updated["command"] = json!(stamped);
    Some(pretool("allow", "board identity", Some(updated)))
}

fn mutation(data: &Value) -> bool {
    match data["tool_name"].as_str().unwrap_or("") {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "apply_patch" => true,
        "Bash" => {
            let text = shell(data).to_ascii_lowercase();
            ["git commit", "git merge", "git reset", "git checkout", "git switch",
             "rm ", "mv ", "cp ", "sed -i", "bd close", "bd update", "bd create"]
                .iter().any(|needle| text.contains(needle))
        }
        _ => false,
    }
}

fn workflow(data: &Value) -> Option<Value> {
    if !mutation(data) { return None; }
    let here = cwd(data);
    let rendered = here.to_string_lossy();
    let Some(issue) = rendered.split("/worktrees/").nth(1)
        .and_then(|tail| tail.split('/').next()).filter(|id| !id.is_empty()) else {
        return deny("Changes require an owned Beads work item in its isolated worktree.");
    };
    let project = root(data);
    let Some(card) = bd(&project, &["show", issue, "--json"]).and_then(|v| rows(v).into_iter().next()) else {
        // An isolated, correctly named worktree is enough during a temporary board outage.
        return None;
    };
    if card["status"].as_str() != Some("in_progress") {
        return deny(format!("Beads issue {issue} must be claimed and in_progress before this worktree is changed."));
    }
    let assignee = card["assignee"].as_str().unwrap_or("");
    if !assignee.is_empty() && assignee != session(data) {
        return deny(format!("Beads issue {issue} is owned by {assignee}, not this session."));
    }
    None
}

fn current_branch(root: &Path) -> String {
    command(root, "git", &["branch", "--show-current"]).map(|v| v.0).unwrap_or_default()
}

fn landing_branch(root: &Path) -> String {
    let candidates = ["ours", "main", "master"];
    candidates.into_iter().find(|name| command(root, "git", &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")])
        .is_some_and(|(_, ok)| ok)).unwrap_or("main").to_string()
}

fn merge_gate(data: &Value) -> Option<Value> {
    let text = shell(data);
    if !text.contains("git merge") { return None; }
    let project = root(data);
    if current_branch(&project) != landing_branch(&project) { return None; }
    if !text.contains("--ff-only") { return deny("A merge into the landing branch must be a fast-forward (`git merge --ff-only`)."); }
    let slot = bd(&project, &["merge-slot", "status", "--json"]);
    if let Some(slot) = slot {
        let holder = slot["holder"].as_str().or_else(|| slot["owner"].as_str()).unwrap_or("");
        if !holder.is_empty() && holder != session(data) {
            return deny(format!("The merge slot is held by {holder}; only its owner may land."));
        }
    }
    None
}

fn card_ids(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.'))
        .filter(|word| word.contains('-') && word.chars().any(|c| c.is_ascii_digit()))
        .map(str::to_string).collect()
}

fn no_commit(card: &Value) -> bool {
    card["issue_type"].as_str().is_some_and(|t| matches!(t, "epic" | "decision")) ||
        card["labels"].as_array().is_some_and(|labels| labels.iter().any(|l|
            matches!(l.as_str(), Some("job" | "no-code" | "find" | "question" | "decision"))))
}

fn landed(root: &Path, id: &str) -> bool {
    command(root, "git", &["log", &landing_branch(root), "--fixed-strings", "--grep", id,
        "--max-count", "1", "--format=%H"]).is_some_and(|(out, ok)| ok && !out.is_empty())
}

fn status_gate(data: &Value) -> Option<Value> {
    let text = shell(data);
    if !text.contains("bd ") { return None; }
    if text.contains("bd create") { eprintln!("warning: direct bd create skips optional ticket-writing guidance"); }
    let closing = text.contains("bd close") || text.contains("--status closed") || text.contains("-s closed");
    let reviewing = text.contains("in_review") || text.contains("inreview") || text.contains("manager_review");
    if !closing && !reviewing { return None; }
    let project = root(data);
    for id in card_ids(text) {
        let Some(card) = bd(&project, &["show", &id, "--json"]).and_then(|v| rows(v).into_iter().next()) else { continue; };
        if card["status"].as_str() == Some("manager_review") {
            return deny(format!("{id} is in the manager's column and only the manager may move it."));
        }
        if !no_commit(&card) && !landed(&project, &id) {
            return deny(format!("{id} cannot advance: no commit naming it has reached {}.", landing_branch(&project)));
        }
        if closing {
            let children = bd(&project, &["list", "--parent", &id, "--status", "all", "--limit", "0", "--json"])
                .map(rows).unwrap_or_default();
            if children.iter().any(|row| row["status"].as_str() != Some("closed")) {
                return deny(format!("{id} still has unfinished children."));
            }
            let gates = bd(&project, &["gate", "list", "--json"]).map(rows).unwrap_or_default();
            if gates.iter().any(|row| row["status"].as_str() != Some("closed") &&
                (row["parent"].as_str() == Some(&id) || row["issue_id"].as_str() == Some(&id))) {
                return deny(format!("{id} still has unresolved review gates."));
            }
        }
    }
    None
}

fn touch(data: &Value) {
    let project = root(data);
    let who = session(data);
    let Some(cards) = bd(&project, &["list", "--assignee", &who, "--status", "in_progress", "--limit", "0", "--json"]).map(rows) else { return; };
    let ids: Vec<String> = cards.iter().filter_map(|card| card["id"].as_str().map(str::to_string)).collect();
    if !ids.is_empty() {
        if let Some(path) = crate::routes::find_bd() {
            let _ = Command::new(path).arg("--actor").arg(&who).arg("heartbeat").args(&ids).current_dir(&project).status();
        }
    }
    crate::board_tools::advance_all(&project);
}

fn prime(data: &Value) -> Option<Value> {
    let project = root(data);
    let who = session(data);
    let ready = bd(&project, &["ready", "--limit", "8", "--json"]).map(rows).unwrap_or_default();
    let names: Vec<String> = ready.iter().filter_map(|card| Some(format!("{} P{} {}", card["id"].as_str()?, card["priority"].as_i64().unwrap_or(2), card["title"].as_str().unwrap_or("")))).collect();
    let context = format!("Board actor: {who}. Claim work before editing; work in its isolated worktree; name the card in commits; use fast-forward landings; do not move cards out of manager review. Ticket prose preferences are guidance, not hard gates.{}",
        if names.is_empty() { String::new() } else { format!("\n\nReady now:\n  {}", names.join("\n  ")) });
    Some(json!({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":context}}))
}

fn stop_gate(data: &Value) -> Option<Value> {
    if data["stop_hook_active"].as_bool() == Some(true) { return None; }
    let project = root(data);
    let who = session(data);
    let cards = bd(&project, &["list", "--assignee", &who, "--status", "in_progress", "--limit", "0", "--json"])
        .map(rows).unwrap_or_default();
    if cards.is_empty() { return None; }
    let ids: Vec<&str> = cards.iter().filter_map(|card| card["id"].as_str()).collect();
    let message = data["last_assistant_message"].as_str().unwrap_or("");
    if message.contains('?') || message.to_ascii_lowercase().contains("blocked") { return None; }
    Some(json!({"decision":"block","reason":format!("Owned work is still open: {}. Continue, close it truthfully, or state the concrete blocker.", ids.join(", "))}))
}

fn wait_warning(data: &Value) {
    let text = shell(data);
    if text.contains("sleep ") && (text.contains("while ") || text.contains("until ")) {
        eprintln!("warning: this foreground polling loop can consume an agent turn; use a background command when practical");
    }
}
