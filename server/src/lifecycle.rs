//! Provider hook entry points that must work on an installed machine with no
//! Python. Hard refusals are limited to ownership, protected Git history and
//! truthful lifecycle transitions. Writing preferences only warn.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Word { text: String, start: usize, end: usize }

#[derive(Clone, Debug, PartialEq, Eq)]
struct Segment { words: Vec<Word> }

#[derive(Clone, Debug)]
struct BdCall<'a> { segment: &'a Segment, executable: usize, verb: usize }

#[derive(Clone, Debug)]
struct GitCall<'a> { segment: &'a Segment, verb: usize, cwd: PathBuf }

const GATES: &[&str] = &[
    "workflow-gate", "board-actor", "board-merge-gate", "board-status-gate",
    "wait-gate", "board-touch", "board-prime", "board-gate", "landing-gate",
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
        "board-actor" | "board-actor.py" => actor(&data),
        "workflow-gate" | "workflow-gate.py" => workflow(&data),
        "board-merge-gate" | "board-merge-gate.py" | "landing-gate" | "landing-gate.py" => merge_gate(&data),
        "board-status-gate" | "board-status-gate.py" => status_gate(&data),
        "board-touch" | "board-touch.py" => { touch(&data); None },
        "board-prime" | "board-prime.py" => prime(&data),
        "board-gate" | "board-gate.py" => stop_gate(&data),
        "wait-gate" | "wait-gate.py" => { wait_warning(&data); None },
        // Presentation and interaction-style hooks are deliberately retired.
        // Existing joined projects may still name them, so they answer here
        // rather than falling through to a Python script.
        _ => None,
    };
    if let Some(output) = output { println!("{}", output); }
    0
}

fn cwd(data: &Value) -> PathBuf {
    tool_input(data)["workdir"].as_str().map(PathBuf::from)
        .or_else(|| data["cwd"].as_str().map(PathBuf::from))
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

fn shell_segments(command: &str) -> Vec<Segment> {
    let bytes = command.as_bytes();
    let mut segments = Vec::new();
    let mut words = Vec::new();
    let mut text = String::new();
    let mut start = 0;
    let mut quote = 0u8;
    let mut escaped = false;
    let finish_word = |at: usize, words: &mut Vec<Word>, text: &mut String, start: usize| {
        if !text.is_empty() { words.push(Word { text: std::mem::take(text), start, end: at }); }
    };
    let finish_segment = |segments: &mut Vec<Segment>, words: &mut Vec<Word>| {
        if !words.is_empty() { segments.push(Segment { words: std::mem::take(words) }); }
    };
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if escaped {
            text.push(byte as char);
            escaped = false;
            at += 1;
            continue;
        }
        if quote != b'\'' && byte == b'\\' {
            if text.is_empty() { start = at; }
            escaped = true;
            at += 1;
            continue;
        }
        if quote == 0 && matches!(byte, b'\'' | b'"') {
            if text.is_empty() { start = at; }
            quote = byte;
            at += 1;
            continue;
        }
        if quote == byte && quote != 0 {
            quote = 0;
            at += 1;
            continue;
        }
        if quote == 0 && byte.is_ascii_whitespace() {
            finish_word(at, &mut words, &mut text, start);
            if byte == b'\n' { finish_segment(&mut segments, &mut words); }
            at += 1;
            continue;
        }
        if quote == 0 && matches!(byte, b';' | b'|' | b'&') {
            finish_word(at, &mut words, &mut text, start);
            finish_segment(&mut segments, &mut words);
            at += if at + 1 < bytes.len() && bytes[at + 1] == byte { 2 } else { 1 };
            continue;
        }
        if text.is_empty() { start = at; }
        text.push(byte as char);
        at += 1;
    }
    finish_word(bytes.len(), &mut words, &mut text, start);
    finish_segment(&mut segments, &mut words);
    segments
}

fn executable(word: &str) -> &str {
    Path::new(word).file_name().and_then(|name| name.to_str()).unwrap_or(word)
}

fn first_command_word(segment: &Segment) -> usize {
    segment.words.iter().position(|word| !word.text.contains('=')).unwrap_or(segment.words.len())
}

fn bd_call(segment: &Segment) -> Option<BdCall<'_>> {
    let executable_at = first_command_word(segment);
    if executable(segment.words.get(executable_at)?.text.as_str()) != "bd" { return None; }
    let mut verb = executable_at + 1;
    while let Some(word) = segment.words.get(verb).map(|word| word.text.as_str()) {
        if matches!(word, "--actor" | "-C" | "--directory" | "--db" | "--database") {
            verb += 2;
            continue;
        }
        if ["--actor=", "--directory=", "--db=", "--database="].iter()
            .any(|prefix| word.starts_with(prefix)) {
            verb += 1;
            continue;
        }
        if matches!(word, "--global" | "--json" | "--readonly" | "--sandbox" | "--no-color" | "-q" | "--quiet" | "-v" | "--verbose") {
            verb += 1;
            continue;
        }
        break;
    }
    segment.words.get(verb)?;
    Some(BdCall { segment, executable: executable_at, verb })
}

fn git_call<'a>(segment: &'a Segment, initial: &Path) -> Option<GitCall<'a>> {
    let executable_at = first_command_word(segment);
    if executable(segment.words.get(executable_at)?.text.as_str()) != "git" { return None; }
    let mut cwd = initial.to_path_buf();
    let mut verb = executable_at + 1;
    while let Some(word) = segment.words.get(verb).map(|word| word.text.as_str()) {
        if word == "-C" {
            let named = PathBuf::from(segment.words.get(verb + 1)?.text.as_str());
            cwd = if named.is_absolute() { named } else { cwd.join(named) };
            verb += 2;
        } else if let Some(named) = word.strip_prefix("-C") {
            if named.is_empty() { return None; }
            let named = PathBuf::from(named);
            cwd = if named.is_absolute() { named } else { cwd.join(named) };
            verb += 1;
        } else if word.starts_with('-') {
            verb += 1;
        } else {
            return Some(GitCall { segment, verb, cwd });
        }
    }
    None
}

fn calls(command: &str, initial: &Path) -> Vec<(Segment, PathBuf)> {
    let mut cwd = initial.to_path_buf();
    let mut out = Vec::new();
    for segment in shell_segments(command) {
        let executable_at = first_command_word(&segment);
        if segment.words.get(executable_at).is_some_and(|word| executable(&word.text) == "cd") {
            if let Some(named) = segment.words.get(executable_at + 1) {
                let named = PathBuf::from(&named.text);
                cwd = if named.is_absolute() { named } else { cwd.join(named) };
            }
        } else {
            out.push((segment, cwd.clone()));
        }
    }
    out
}

fn actor(data: &Value) -> Option<Value> {
    if data["tool_name"].as_str() != Some("Bash") { return None; }
    let original = shell(data);
    let who = session(data);
    let parsed = calls(original, &cwd(data));
    let mut insertions: Vec<(usize, String)> = Vec::new();
    for (segment, here) in &parsed {
        let Some(call) = bd_call(segment) else { continue; };
        let copy = worktree_issue(here).unwrap_or_else(|| "main".to_string());
        let args = &call.segment.words[call.executable + 1..];
        let has_actor = args.iter().any(|word|
            word.text == "--actor" || word.text.starts_with("--actor="));
        if !has_actor {
            insertions.push((call.segment.words[call.executable].end, format!(" --actor {who}")));
        }
        let is_update_claim = call.segment.words[call.verb].text == "update"
            && call.segment.words.get(call.verb + 1).is_some_and(|word| !word.text.starts_with('-'))
            && call.segment.words[call.verb + 2..].iter().any(|word| word.text == "--claim");
        let has_copy = args.windows(2).any(|pair|
            pair[0].text == "--add-label" && pair[1].text.starts_with("copy:"))
            || args.iter().any(|word| word.text.starts_with("--add-label=copy:"));
        if is_update_claim && !has_copy {
            let claim = call.segment.words[call.verb + 2..].iter()
                .find(|word| word.text == "--claim").unwrap();
            insertions.push((claim.end, format!(" --add-label copy:{copy}")));
        }
    }
    let mut stamped = original.to_string();
    insertions.sort_by_key(|(at, _)| *at);
    for (at, value) in insertions.into_iter().rev() { stamped.insert_str(at, &value); }
    if stamped == original { return None; }
    let mut updated = tool_input(data).clone();
    updated["command"] = json!(stamped);
    Some(pretool("allow", "board identity", Some(updated)))
}

fn mutation(data: &Value) -> bool {
    match data["tool_name"].as_str().unwrap_or("") {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "apply_patch" => true,
        "Bash" => {
            calls(shell(data), &cwd(data)).iter().any(|(segment, here)| {
                if let Some(call) = bd_call(segment) {
                    return matches!(call.segment.words[call.verb].text.as_str(),
                        "close" | "create" | "reopen" | "update");
                }
                if let Some(call) = git_call(segment, here) {
                    return matches!(call.segment.words[call.verb].text.as_str(),
                        "commit" | "merge" | "reset" | "checkout" | "switch");
                }
                let at = first_command_word(segment);
                let Some(name) = segment.words.get(at).map(|word| executable(&word.text)) else { return false; };
                matches!(name, "rm" | "mv" | "cp") || (name == "sed" &&
                    segment.words[at + 1..].iter().any(|word| word.text == "-i" || word.text.starts_with("-i")))
            })
        }
        _ => false,
    }
}

fn worktree_issue(path: &Path) -> Option<String> {
    let parts: Vec<_> = path.components().filter_map(|part| part.as_os_str().to_str()).collect();
    parts.windows(2).find_map(|pair| match pair[0] {
        "worktrees" => Some(pair[1].to_string()),
        ".worktrees" => Some(pair[1].strip_prefix("bd-").unwrap_or(pair[1]).to_string()),
        _ => None,
    })
}

fn claim_transition(data: &Value) -> Option<(String, PathBuf)> {
    let parsed = calls(shell(data), &cwd(data));
    let meaningful: Vec<_> = parsed.iter().filter_map(|(segment, here)| {
        let call = bd_call(segment)?;
        Some((call, here))
    }).collect();
    if meaningful.len() != 1 || meaningful.len() != parsed.len() { return None; }
    let (call, here) = &meaningful[0];
    if call.segment.words[call.verb].text != "update" { return None; }
    let issue = call.segment.words.get(call.verb + 1)?.text.clone();
    if issue.starts_with('-') || !call.segment.words[call.verb + 2..].iter().any(|word| word.text == "--claim") {
        return None;
    }
    Some((issue, (*here).clone()))
}

fn creates_first_work(data: &Value) -> bool {
    let parsed = calls(shell(data), &cwd(data));
    parsed.len() == 1 && bd_call(&parsed[0].0).is_some_and(|call|
        call.segment.words[call.verb].text == "create")
}

fn expired(card: &Value) -> bool {
    card["lease_expires_at"].as_str()
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .is_some_and(|when| when < chrono::Utc::now())
}

fn claimable(card: &Value, who: &str) -> bool {
    let assignee = card["assignee"].as_str().unwrap_or("");
    (card["status"].as_str() == Some("open") && assignee.is_empty())
        || assignee == who || expired(card)
}

fn ownership_refusal(card: &Value, issue: &str, who: &str) -> Option<String> {
    if card["status"].as_str() != Some("in_progress") {
        return Some(format!("Beads issue {issue} must be claimed and in_progress before this worktree is changed."));
    }
    let assignee = card["assignee"].as_str().unwrap_or("");
    if !assignee.is_empty() && assignee != who {
        return Some(format!("Beads issue {issue} is owned by {assignee}, not this session."));
    }
    None
}

fn workflow(data: &Value) -> Option<Value> {
    if !mutation(data) { return None; }
    if creates_first_work(data) { return None; }
    if let Some((issue, here)) = claim_transition(data) {
        if worktree_issue(&here).as_deref() != Some(&issue) {
            return deny(format!("Claim {issue} from its own isolated worktree, not {}.", here.display()));
        }
        let project = command(&here, "git", &["rev-parse", "--show-toplevel"])
            .filter(|(_, ok)| *ok).map(|(out, _)| PathBuf::from(out)).unwrap_or(here);
        let Some(card) = bd(&project, &["show", &issue, "--json"])
            .and_then(|value| rows(value).into_iter().next()) else {
            // Preserve the existing outage behavior for an already isolated,
            // correctly named worktree.
            return None;
        };
        if claimable(&card, &session(data)) { return None; }
        return deny(format!("Beads issue {issue} is owned by {}, not this session.",
            card["assignee"].as_str().unwrap_or("another session")));
    }
    let here = cwd(data);
    let Some(issue) = worktree_issue(&here) else {
        return deny("Changes require an owned Beads work item in its isolated worktree.");
    };
    let project = root(data);
    let Some(card) = bd(&project, &["show", &issue, "--json"]).and_then(|v| rows(v).into_iter().next()) else {
        // An isolated, correctly named worktree is enough during a temporary board outage.
        return None;
    };
    ownership_refusal(&card, &issue, &session(data)).and_then(deny)
}

fn current_branch(root: &Path) -> String {
    command(root, "git", &["branch", "--show-current"]).map(|v| v.0).unwrap_or_default()
}

fn landing_branch(root: &Path) -> String {
    let candidates = ["ours", "main", "master"];
    candidates.into_iter().find(|name| command(root, "git", &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")])
        .is_some_and(|(_, ok)| ok)).unwrap_or("main").to_string()
}

fn merge_refusal(on_landing: bool, fast_forward: bool, holder: &str, who: &str,
    dirty: bool) -> Option<String> {
    if !on_landing { return None; }
    if !fast_forward {
        return Some("A merge into the landing branch must be a fast-forward (`git merge --ff-only`).".into());
    }
    if !holder.is_empty() && holder != who {
        return Some(format!("The merge slot is held by {holder}; only its owner may land."));
    }
    if dirty {
        return Some("The landing worktree has tracked changes; preserve or commit them before merging.".into());
    }
    None
}

fn merge_gate(data: &Value) -> Option<Value> {
    let parsed = calls(shell(data), &cwd(data));
    for (segment, here) in &parsed {
        let Some(call) = git_call(segment, here) else { continue; };
        if call.segment.words[call.verb].text != "merge" { continue; }
        let project = command(&call.cwd, "git", &["rev-parse", "--show-toplevel"])
            .filter(|(_, ok)| *ok).map(|(out, _)| PathBuf::from(out)).unwrap_or(call.cwd.clone());
        let on_landing = current_branch(&project) == landing_branch(&project);
        let fast_forward = call.segment.words[call.verb + 1..].iter()
            .any(|word| word.text == "--ff-only");
        let who = session(data);
        let slot = bd(&project, &["merge-slot", "check", "--json", "--actor", &who]);
        let holder = slot.as_ref().and_then(|value|
            value["holder"].as_str().or_else(|| value["owner"].as_str())).unwrap_or("");
        let dirty = command(&project, "git", &["status", "--porcelain", "--untracked-files=no"])
            .is_some_and(|(out, ok)| ok && !out.is_empty());
        if let Some(reason) = merge_refusal(on_landing, fast_forward, holder, &who, dirty) {
            return deny(reason);
        }
    }
    None
}

fn no_commit(card: &Value) -> bool {
    card["issue_type"].as_str().is_some_and(|t| matches!(t, "epic" | "decision")) ||
        card["labels"].as_array().is_some_and(|labels| labels.iter().any(|l|
            matches!(l.as_str(), Some("job" | "no-code" | "find" | "question" | "decision"))))
}

fn subject_names(subject: &str, id: &str) -> bool {
    subject.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '.')))
        .any(|word| word == id)
}

fn landed(root: &Path, id: &str) -> bool {
    command(root, "git", &["log", &landing_branch(root), "--format=%s"])
        .is_some_and(|(out, ok)| ok && out.lines().any(|subject| subject_names(subject, id)))
}

fn flag_value(words: &[Word], name: &str) -> Option<String> {
    words.iter().position(|word| word.text == name)
        .and_then(|at| words.get(at + 1)).map(|word| word.text.clone())
        .or_else(|| words.iter().find_map(|word|
            word.text.strip_prefix(&format!("{name}=")).map(str::to_string)))
}

fn labels(card: &Value) -> Vec<&str> {
    card["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

fn passing_check(text: &str, tree: &str) -> bool {
    text.contains(&format!("checks: tree {tree} "))
        && text.contains("=PASSED") && !text.contains("=FAILED")
}

fn fresh_checks(root: &Path, id: &str, card: &Value) -> bool {
    if !labels(card).iter().any(|label| *label == "step:checks") { return true; }
    let Some((tree, ok)) = command(root, "git", &["rev-parse", "HEAD"]) else { return false; };
    if !ok || tree.is_empty() { return false; }
    let comments = bd(root, &["comments", id, "--json"]).map(rows).unwrap_or_default();
    comments.iter().any(|comment| {
        let text = comment["text"].as_str().or_else(|| comment["body"].as_str())
            .or_else(|| comment["comment"].as_str()).unwrap_or("");
        passing_check(text, &tree)
    })
}

fn manager_review_refusal(card: &Value, id: &str) -> Option<String> {
    (card["status"].as_str() == Some("manager_review"))
        .then(|| format!("{id} is in the manager's column and only the manager may move it."))
}

fn status_gate(data: &Value) -> Option<Value> {
    for (segment, here) in calls(shell(data), &cwd(data)) {
        let Some(call) = bd_call(&segment) else { continue; };
        let verb = call.segment.words[call.verb].text.as_str();
        if verb == "create" { eprintln!("warning: direct bd create skips optional ticket-writing guidance"); }
        let arguments = &call.segment.words[call.verb + 1..];
        let status = flag_value(arguments, "--status").or_else(|| flag_value(arguments, "-s"));
        let closing = verb == "close" || status.as_deref() == Some("closed");
        let reviewing = matches!(status.as_deref(), Some("in_review" | "inreview" | "manager_review"));
        let moving = status.is_some() || verb == "reopen";
        if !closing && !moving { continue; }
        if closing && arguments.iter().any(|word| matches!(word.text.as_str(), "--force" | "-f")) {
            return deny("A forced close can skip blockers and unfinished children; close truthfully without --force.");
        }
        let Some(id) = arguments.iter().find(|word| !word.text.starts_with('-'))
            .map(|word| word.text.clone()) else { continue; };
        let project = command(&here, "git", &["rev-parse", "--show-toplevel"])
            .filter(|(_, ok)| *ok).map(|(out, _)| PathBuf::from(out)).unwrap_or(here);
        let Some(card) = bd(&project, &["show", &id, "--json"]).and_then(|v| rows(v).into_iter().next()) else { continue; };
        if let Some(reason) = manager_review_refusal(&card, &id) { return deny(reason); }
        if (closing || reviewing) && !no_commit(&card) && !landed(&project, &id) {
            return deny(format!("{id} cannot advance: no commit naming it has reached {}.", landing_branch(&project)));
        }
        if closing {
            if !no_commit(&card) && command(&project, "git", &["status", "--porcelain"])
                .is_some_and(|(out, ok)| ok && !out.is_empty()) {
                return deny(format!("{id} cannot close while its worktree has uncommitted changes."));
            }
            if !fresh_checks(&project, &id, &card) {
                return deny(format!("{id} is the checks step and has no fresh passing evidence for the current Git tree."));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_machinery_updated_hook_input_is_an_explicit_allow() {
        let value = pretool("allow", "board identity", Some(json!({"command":"bd --actor s-test show x-1"})));
        assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(value["hookSpecificOutput"]["updatedInput"].is_object());
    }

    #[test]
    fn native_machinery_ticket_prose_is_not_a_hard_gate() {
        let data = json!({"tool_name":"Bash","tool_input":{"command":"bd create --title 'Fix duplicate cards'"}});
        assert!(status_gate(&data).is_none());
    }

    #[test]
    fn native_machinery_uses_explicit_tool_workdir() {
        let data = json!({"cwd":"/wrong", "tool_input":{"workdir":"/right"}});
        assert_eq!(cwd(&data), PathBuf::from("/right"));
    }

    #[test]
    fn native_machinery_stamps_bd_and_only_labels_update_claim() {
        let ready = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"bd ready --claim"}});
        let value = actor(&ready).expect("all bd calls receive an actor");
        assert_eq!(value["hookSpecificOutput"]["updatedInput"]["command"],
            "bd --actor s-test ready --claim");

        let update = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"bd update bw-1 --claim"}});
        let value = actor(&update).expect("a claim transition is rewritten");
        assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(value["hookSpecificOutput"]["updatedInput"]["command"].as_str()
            .unwrap().contains("--claim --add-label copy:bw-1"));

        let chained = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo",
            "tool_input":{"command":"cd .worktrees/bd-bw-2 && bd update bw-2 --claim"}});
        let command = actor(&chained).unwrap()["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str().unwrap().to_string();
        assert!(command.contains("--add-label copy:bw-2"), "{command}");

        let show = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo",
            "tool_input":{"command":"echo before && /usr/local/bin/bd show bw-1 | bd list"}});
        let value = actor(&show).expect("both real bd calls are stamped");
        assert_eq!(value["hookSpecificOutput"]["updatedInput"]["command"],
            "echo before && /usr/local/bin/bd --actor s-test show bw-1 | bd --actor s-test list");

        let every = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo",
            "tool_input":{"command":"bd ready || bd show bw-1; bd list\nbd blocked"}});
        let command = actor(&every).unwrap()["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str().unwrap().to_string();
        assert_eq!(command.matches("bd --actor s-test").count(), 4, "{command}");
    }

    #[test]
    fn native_machinery_does_not_duplicate_actor_or_copy_label() {
        let data = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/.worktrees/bd-bw-1",
            "tool_input":{"command":"bd --actor somebody update bw-1 --claim --add-label copy:bw-1"}});
        assert!(actor(&data).is_none());

        let data = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/.worktrees/bd-bw-2",
            "tool_input":{"command":"bd --actor somebody update bw-2 --claim"}});
        let command = actor(&data).unwrap()["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str().unwrap().to_string();
        assert_eq!(command.matches("--actor").count(), 1, "{command}");
        assert!(command.contains("--add-label copy:bw-2"), "{command}");
    }

    #[test]
    fn native_machinery_does_not_mutate_unrelated_or_quoted_bd() {
        for command in ["echo bd ready", "echo 'bd update bw-1 --claim'", "touch bd"] {
            let data = json!({"tool_name":"Bash", "tool_input":{"command":command}});
            assert!(actor(&data).is_none(), "mutated {command}");
        }
    }

    #[test]
    fn native_machinery_parses_real_merges_only() {
        let merges = |command: &str| calls(command, Path::new("/start")).iter().any(|(segment, here)|
            git_call(segment, here).is_some_and(|call| call.segment.words[call.verb].text == "merge"));
        assert!(merges("git merge --ff-only bw-1"));
        assert!(merges("cd /repo && git merge --ff-only bw-1"));
        assert!(merges("true || /usr/bin/git merge --ff-only bw-1"));
        assert!(!merges("git merge-base ours bw-1"));
        assert!(!merges("echo git merge --ff-only bw-1"));
        assert!(!merges("echo 'git merge --ff-only bw-1'"));
        assert!(!merges("touch git-merge"));
    }

    #[test]
    fn native_machinery_claim_bootstrap_is_narrow() {
        let open = json!({"status":"open"});
        let mine = json!({"status":"in_progress", "assignee":"s-test"});
        let theirs = json!({"status":"in_progress", "assignee":"s-other",
            "lease_expires_at":"2999-01-01T00:00:00Z"});
        let expired = json!({"status":"in_progress", "assignee":"s-old",
            "lease_expires_at":"2000-01-01T00:00:00Z"});
        assert!(claimable(&open, "s-test"));
        assert!(claimable(&mine, "s-test"));
        assert!(!claimable(&theirs, "s-test"));
        assert!(claimable(&expired, "s-test"));
        assert!(ownership_refusal(&theirs, "bw-1", "s-test").unwrap().contains("s-other"));

        let claim = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command":"cd worktrees/bw-1 && bd update bw-1 --claim"}});
        assert_eq!(claim_transition(&claim).unwrap().0, "bw-1");
        let ready = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"bd ready --claim"}});
        assert!(claim_transition(&ready).is_none());
        let mixed = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"rm file && bd update bw-1 --claim"}});
        assert!(claim_transition(&mixed).is_none());
    }

    #[test]
    fn native_machinery_non_worktree_mutation_is_denied() {
        let data = json!({"tool_name":"Edit", "cwd":"/repo", "tool_input":{"file_path":"src/lib.rs"}});
        let refusal = workflow(&data).expect("a denial");
        assert_eq!(refusal["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    #[test]
    fn native_machinery_merge_invariants_are_hard_denials() {
        assert!(merge_refusal(true, false, "", "s-test", false).unwrap().contains("fast-forward"));
        assert!(merge_refusal(true, true, "s-other", "s-test", false).unwrap().contains("s-other"));
        assert!(merge_refusal(true, true, "s-test", "s-test", true).unwrap().contains("tracked changes"));
        assert!(merge_refusal(true, true, "s-test", "s-test", false).is_none());
    }

    #[test]
    fn native_machinery_manager_review_cannot_be_moved() {
        let card = json!({"status":"manager_review"});
        assert!(manager_review_refusal(&card, "bw-1").unwrap().contains("only the manager"));
    }

    #[test]
    fn native_machinery_landed_subjects_name_exact_cards() {
        assert!(subject_names("fix bw-oesd.16.1: database", "bw-oesd.16.1"));
        assert!(!subject_names("fix bw-oesd.16.10: database", "bw-oesd.16.1"));
    }

    #[test]
    fn native_machinery_check_evidence_is_fresh_and_passing() {
        assert!(passing_check("checks: tree abc cargo=PASSED", "abc"));
        assert!(!passing_check("checks: tree old cargo=PASSED", "abc"));
        assert!(!passing_check("checks: tree abc cargo=FAILED", "abc"));
    }
}
