//! Native forms of the public board workflow commands. The binary speaks to
//! Git and `bd` directly; installed workflows never execute bundled Python.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn run(name: &str, rest: &[String]) -> Option<Result<i32, String>> {
    let tool = match name {
        "board/job" | "board/land" | "board/reconcile" | "board/status" | "board/cleanup" | "checks" | "review" => name,
        _ => return None,
    };
    if asks_for_help(rest) {
        println!("{}", usage(tool));
        return Some(Ok(0));
    }
    Some(match tool {
        "board/job" => job(rest),
        "board/land" => land(rest),
        "checks" => checks(rest),
        "board/reconcile" => crate::board_landing::reconcile_command(rest),
        "board/status" => crate::board_landing::status_command(rest),
        "board/cleanup" => crate::board_landing::cleanup(rest),
        _ => review(rest),
    })
}

/// Is this a request to be told what the flags are, rather than to act?
///
/// `atelier tool checks --help` ran the project's whole declared suite —
/// minutes of it — and recorded the result on the surrounding job's card, and
/// `board/job new --help` created a real epic that then had to be cancelled.
/// There was no way to ask what the flags were without paying for the command
/// (`docs/hook-friction-2.md` §8 of the tooling entries, bw-e3dw.7).
fn asks_for_help(rest: &[String]) -> bool {
    rest.iter().any(|word| matches!(word.as_str(), "--help" | "-h" | "--schema"))
}

fn usage(tool: &str) -> &'static str {
    match tool {
        "board/job" => "usage: atelier tool board/job <action> [options]

  new --what TEXT --done TEXT [options]     open a job and its work items
  epic --what TEXT --done TEXT [options]    open a container of jobs
  under ID --do 'WHAT|DONE' ...             add work items to an open job
  upgrade ID [options]                      give an existing card work items
  cancel ID --reason TEXT                   drop a job and everything under it

options for new, epic and upgrade:
  --what TEXT        the outcome, which becomes the title
  --done TEXT        the acceptance criterion; may not be empty
  --do 'WHAT|DONE'   one work item; repeat for each. Defaults to the job itself
  --evidence TEXT    what shows the fault is real
  --not TEXT         what this job does not cover
  --area NAME        area label (default: board)
  --kind NAME        bug, feature or chore (default: feature)
  --priority N, -p N 0 to 4 (default: 2)
  --parent ID        file this job under an existing card
  --steps LIST       legacy review requirements; no generated step tickets
  --judge NAME       who approves before landing (default: agent)",
        "board/land" => "usage: atelier tool board/land CARD-ID

Rebases the card's branch onto the landing branch, takes the merge slot,
fast-forwards the landing branch and releases the slot, then closes the work
items the landed commits name. Run it from the card's own worktree.

Safe to run twice: if the commits already landed it says so and finishes the
close. The actor is BEADS_ACTOR, or the Git user; another actor cannot land owned work.",
        "board/reconcile" => "usage: atelier tool board/reconcile [--apply] [--legacy] [--retire-steps]\n\nDry-run by default. Recover interrupted landings, derive parents, and optionally audit explicit legacy commit headers or retire generated operational steps.",
        "board/status" => "usage: atelier tool board/status [CARD-ID]\n\nPrint stored and recursively derived status, including hierarchy errors.",
        "board/cleanup" => "usage: atelier tool board/cleanup JOB-ID\n\nRemove a completed job worktree and its merged branch. No delivery commit is required for cleanup.",
        "checks" => "usage: atelier tool checks [CARD-ID] [options]

Runs the project's declared verification suites against the current tree,
records the result on the card without closing unlanded work.

  --all              run every declared suite, not only those matching changes
  --dry              say which suites would run, and run none of them
  --record NAME=PASSED|FAILED
                     record a result without running the suite; repeatable",
        _ => "usage: atelier tool review JOB-ID [--provider claude|codex]

Sends the committed, unlanded changes to an external reader. Given a step:review card, reads the job from its `of:` label.",
    }
}

pub(crate) fn root() -> Result<PathBuf, String> {
    let program = crate::routes::find_git().ok_or_else(|| crate::routes::GIT_MISSING.to_string())?;
    let output = Command::new(program).args(["rev-parse", "--show-toplevel"]).output()
        .map_err(|error| format!("could not ask Git for the project root: {error}"))?;
    if !output.status.success() { return Err("this is not a Git project".into()); }
    Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

pub(crate) fn bd(root: &Path, args: &[String]) -> Result<String, String> {
    let program = crate::routes::find_bd().ok_or_else(|| "Beads is not installed".to_string())?;
    let output = Command::new(program).args(args).current_dir(root).output()
        .map_err(|error| format!("could not start bd: {error}"))?;
    if !output.status.success() {
        return Err(format!("bd {} failed: {}{}", args.first().map(String::as_str).unwrap_or(""),
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn flag(rest: &[String], name: &str) -> Option<String> {
    rest.iter().position(|word| word == name).and_then(|at| rest.get(at + 1)).cloned()
        .or_else(|| rest.iter().find_map(|word| word.strip_prefix(&format!("{name}=")).map(str::to_string)))
}

fn flags(rest: &[String], name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut words = rest.iter();
    while let Some(word) = words.next() {
        if word == name { if let Some(value) = words.next() { out.push(value.clone()); } }
        else if let Some(value) = word.strip_prefix(&format!("{name}=")) { out.push(value.to_string()); }
    }
    out
}

fn created_id(output: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(output).map_err(|error| format!("bd returned unreadable JSON: {error}"))?;
    value["id"].as_str().or_else(|| value.as_array().and_then(|rows| rows.first()).and_then(|row| row["id"].as_str()))
        .map(str::to_string).ok_or_else(|| "bd created a card but returned no id".into())
}

fn make_item(root: &Path, parent: &str, item: &str, area: &str, kind: &str, priority: &str) -> Result<String, String> {
    let (title, done) = item.split_once('|').ok_or_else(|| format!("work item must be '<what>|<done>': {item}"))?;
    if title.trim().is_empty() || done.trim().is_empty() { return Err("work item title and acceptance must not be empty".into()); }
    let description = format!("## Acceptance Criteria\n{}\n", done.trim());
    let args = vec!["create".into(), "--title".into(), title.trim().into(), "--type".into(), "task".into(),
        "--parent".into(), parent.into(), "-p".into(), priority.into(), "-d".into(), description,
        "--acceptance".into(), done.trim().into(), "-l".into(), format!("area:{area}"),
        "-l".into(), format!("kind:{kind}"), "--json".into()];
    let mut args = args;
    args.extend(["-l".into(), "step:work".into(), "-l".into(), format!("of:{parent}")]);
    created_id(&bd(root, &args)?)
}

fn chosen_spine(rest: &[String]) -> Vec<String> {
    let requested: Vec<String> = flag(rest, "--steps").unwrap_or_default().split(',')
        .map(str::trim).filter(|step| !step.is_empty()).map(str::to_string).collect();
    ["ground", "design"].into_iter().filter(|step| requested.iter().any(|wanted| wanted == step))
        .chain(std::iter::once("work"))
        .chain(["checks", "benchmark", "review", "record"].into_iter().filter(|step| *step == "checks" || requested.iter().any(|wanted| wanted == step)))
        .chain(std::iter::once("land")).map(str::to_string).collect()
}

pub(crate) fn metadata(root: &Path, id: &str, entries: &[(&str, String)]) -> Result<(), String> {
    let mut args = vec!["update".into(), id.into()];
    for (key, value) in entries { args.extend(["--set-metadata".into(), format!("{key}={value}")]); }
    bd(root, &args).map(|_| ())
}

fn job(rest: &[String]) -> Result<i32, String> {
    let root = root()?;
    let action = rest.first().map(String::as_str).unwrap_or("help");
    if action == "under" {
        let parent = rest.get(1).ok_or_else(|| "board/job under needs a goal id".to_string())?;
        let parent_value: Value = serde_json::from_str(&bd(&root, &["show".into(), parent.clone(), "--json".into()])?)
            .map_err(|error| error.to_string())?;
        let card = parent_value.as_array().and_then(|rows| rows.first()).unwrap_or(&parent_value);
        let labels: Vec<&str> = card["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let area = labels.iter().find_map(|label| label.strip_prefix("area:")).unwrap_or("board");
        let kind = labels.iter().find_map(|label| label.strip_prefix("kind:")).unwrap_or("feature");
        let priority = card["priority"].as_i64().unwrap_or(2).to_string();
        let items = flags(rest, "--do");
        if items.is_empty() { return Err("board/job under needs at least one --do '<what>|<done>'".into()); }
        for item in items { println!("{}", make_item(&root, parent, &item, area, kind, &priority)?); }
        advance_goal(&root, parent)?;
        return Ok(0);
    }
    if action == "cancel" {
        let id = rest.get(1).ok_or_else(|| "board/job cancel needs an id".to_string())?;
        let reason = flag(rest, "--reason").filter(|reason| !reason.trim().is_empty())
            .ok_or_else(|| "board/job cancel needs --reason explaining why the work is being dropped".to_string())?;
        cancel_tree(&root, id, &reason)?;
        advance_goal(&root, id)?;
        println!("{id} cancelled");
        return Ok(0);
    }
    if action == "upgrade" {
        let id = rest.get(1).ok_or_else(|| "board/job upgrade needs a card id".to_string())?;
        let existing = card(&root, id)?;
        if existing["status"].as_str() == Some("closed") { return Err(format!("{id} is closed")); }
        let what = flag(rest, "--what").unwrap_or_else(|| existing["title"].as_str().unwrap_or(id).to_string());
        let done = flag(rest, "--done").or_else(|| existing["acceptance_criteria"].as_str().map(str::to_string))
            .ok_or_else(|| "--done must not be empty".to_string())?;
        let area = flag(rest, "--area").unwrap_or_else(|| labels(&existing).iter().find_map(|label| label.strip_prefix("area:")).unwrap_or("board").to_string());
        let kind = flag(rest, "--kind").unwrap_or_else(|| labels(&existing).iter().find_map(|label| label.strip_prefix("kind:")).unwrap_or("feature").to_string());
        let spine = chosen_spine(rest);
        bd(&root, &["update".into(), id.clone(), "--add-label".into(), "job".into(), "--remove-label".into(), "find".into(),
            "--title".into(), what.clone(), "--acceptance".into(), done.clone()])?;
        metadata(&root, id, &[("subject", what.clone()), ("area", area.clone()), ("kind", kind.clone()),
            ("done", done.clone()), ("spine", spine.join(",")), ("judge", flag(rest, "--judge").unwrap_or_else(|| "agent".into()))])?;
        let priority = existing["priority"].as_i64().unwrap_or(2).to_string();
        let mut items = flags(rest, "--do");
        if items.is_empty() { items.push(format!("{what}|{done}")); }
        for item in items { println!("{}", make_item(&root, id, &item, &area, &kind, &priority)?); }
        advance_goal(&root, id)?;
        println!("{id}");
        return Ok(0);
    }
    if !matches!(action, "new" | "epic") { return Err("usage: atelier tool board/job new|upgrade|epic|under|cancel ...".into()); }
    let what = flag(rest, "--what").ok_or_else(|| "--what is required".to_string())?;
    let done = flag(rest, "--done").ok_or_else(|| "--done must not be empty".to_string())?;
    if done.trim().is_empty() { return Err("--done must not be empty".into()); }
    let evidence = flag(rest, "--evidence").unwrap_or_default();
    let not_in = flag(rest, "--not").unwrap_or_default();
    let area = flag(rest, "--area").unwrap_or_else(|| "board".into());
    let kind = flag(rest, "--kind").unwrap_or_else(|| "feature".into());
    let priority = flag(rest, "--priority").or_else(|| flag(rest, "-p")).unwrap_or_else(|| "2".into());
    let description = format!("## What is wrong\n{what}\n\n## Evidence it is real\n{evidence}\n\n## Success Criteria\n{done}\n\n## Not in this job\n{not_in}\n");
    let mut args = vec!["create".into(), "--title".into(), what.clone(), "--type".into(), "epic".into(),
        "-p".into(), priority.clone(), "-d".into(), description, "--acceptance".into(), done.clone(),
        "-l".into(), if action == "epic" { "container".into() } else { "job".into() },
        "-l".into(), format!("area:{area}"), "-l".into(), format!("kind:{kind}"), "--json".into()];
    if let Some(parent) = flag(rest, "--parent") { args.extend(["--parent".into(), parent]); }
    let id = created_id(&bd(&root, &args)?)?;
    let spine = chosen_spine(rest);
    metadata(&root, &id, &[
        ("subject", what.clone()), ("area", area.clone()), ("kind", kind.clone()),
        ("done", done.clone()), ("spine", spine.join(",")),
        ("judge", flag(rest, "--judge").unwrap_or_else(|| "agent".into())),
    ])?;
    println!("{id}");
    let mut items = flags(rest, "--do");
    if action == "new" && items.is_empty() {
        // Inline work is valid at every size. A job with no explicit split is
        // one work item, not a run that can never move past its work position.
        items.push(format!("{what}|{done}"));
    }
    for item in items { println!("{}", make_item(&root, &id, &item, &area, &kind, &priority)?); }
    advance_goal(&root, &id)?;
    Ok(0)
}

fn children(root: &Path, id: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(&bd(root, &["list".into(), "--parent".into(), id.into(),
        "--status".into(), "all".into(), "--limit".into(), "0".into(), "--json".into()])?)
        .map_err(|error| format!("bd returned unreadable children for {id}: {error}"))?;
    Ok(value.as_array().cloned().unwrap_or_default())
}

fn cancel_tree(root: &Path, id: &str, reason: &str) -> Result<(), String> {
    // Validate the entire scope before the first write, including cycles and
    // ownership, so a later child cannot leave a partly cancelled job.
    fn collect(root: &Path, id: &str, actor: &str, visiting: &mut std::collections::HashSet<String>, out: &mut Vec<String>) -> Result<(), String> {
        if !visiting.insert(id.into()) { return Err(format!("Cycle in cancellation scope at {id}")); }
        let row = card(root, id)?;
        if row["assignee"].as_str().is_some_and(|owner| !owner.is_empty() && owner != actor) {
            return Err(format!("{id} belongs to another actor; its scope cannot be cancelled by this session"));
        }
        if row["status"] == "manager_review" { return Err(format!("{id} needs the manager's scope decision")); }
        for child in children(root, id)? {
            if child["status"] != "closed" {
                if let Some(child_id) = child["id"].as_str() { collect(root, child_id, actor, visiting, out)?; }
            }
        }
        visiting.remove(id);
        if row["status"] != "closed" { out.push(id.into()); }
        Ok(())
    }
    let mut ids = Vec::new();
    collect(root, id, &crate::board_landing::actor(root)?, &mut std::collections::HashSet::new(), &mut ids)?;
    for id in ids {
        bd(root, &["update".into(), id.clone(), "--add-label".into(), "cancelled".into(), "--status".into(), "closed".into(), "--force".into(),
            "--set-metadata".into(), "status_derived=false".into(), "--append-notes".into(), format!("Cancelled scope: {reason}")])?;
    }
    Ok(())
}

pub(crate) fn card(root: &Path, id: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(&bd(root, &["show".into(), id.into(), "--json".into()])?)
        .map_err(|error| error.to_string())?;
    Ok(value.as_array().and_then(|rows| rows.first()).cloned().unwrap_or(value))
}

pub(crate) fn labels(card: &Value) -> Vec<&str> {
    card["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}



pub(crate) fn advance_goal(root: &Path, _id: &str) -> Result<(), String> {
    crate::board_landing::reconcile_parents(root)
}

pub(crate) fn advance_all(root: &Path) {
    if let Err(error) = crate::board_landing::recover(root).and_then(|_| reconcile_parents_for_touch(root)) {
        eprintln!("Board reconciliation failed: {error}");
    }
}
fn reconcile_parents_for_touch(root: &Path) -> Result<(), String> {
    crate::board_landing::reconcile_parents(root)
}

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let program = crate::routes::find_git().ok_or_else(|| crate::routes::GIT_MISSING.to_string())?;
    let output = Command::new(program).args(args).current_dir(root).output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("git {} failed: {}", args.first().copied().unwrap_or(""), String::from_utf8_lossy(&output.stderr))); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn landing_name(root: &Path) -> String {
    crate::board_landing::landing_branch(root)
}

pub(crate) fn main_copy(root: &Path, branch: &str) -> Result<PathBuf, String> {
    let listing = git(root, &["worktree", "list", "--porcelain"])?;
    let mut path = None;
    for line in listing.lines() {
        if let Some(value) = line.strip_prefix("worktree ") { path = Some(PathBuf::from(value)); }
        if line == format!("branch refs/heads/{branch}") { return path.ok_or_else(|| "landing worktree has no path".into()); }
    }
    Err(format!("no worktree has the landing branch {branch} checked out"))
}

fn land(rest: &[String]) -> Result<i32, String> {
    crate::board_landing::land(rest)
}

/// Does this subject name this card?
///
/// It asks whether the subject holds the id it was given, as a whole word.
/// Guessing at the shape of an id instead — a hyphen and a digit — made every
/// card `bd` issued without a digit in it unlandable: `bw-uxoe` was invisible
/// to the check, so no subject in any form could satisfy it, and the refusal
/// then reported a naming failure that had not happened
/// (`docs/hook-friction-2.md` §5).
pub(crate) fn subject_names(subject: &str, id: &str) -> bool {
    let header = subject.split_once(':').map(|(header, _)| header).unwrap_or(subject);
    header.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '.'))).any(|word| word == id)
}

pub(crate) fn manifest(root: &Path) -> Result<crate::project_manifest::ProjectManifest, String> {
    let data = crate::identity::data_dir().ok_or_else(|| "Atelier has no data directory".to_string())?;
    crate::project_manifest::locate(root, &data).or_else(|| crate::project_manifest::locate(&crate::board_landing::common_root(root), &data)).map(|found| found.manifest)
        .ok_or_else(|| "This project has no Atelier settings. Run `atelier init` first.".to_string())
}

/// Run a declared suite, in an environment with no standing bypass in it.
///
/// A bypass is documented as a prefix, but a worker in a job copy has to carry
/// one on every command and a shell-shaped task encourages exporting it once.
/// Exported, the gate stands down out loud, its sentence reaches the session's
/// own file, and a case asserting the gate says nothing to a session fails —
/// a red that belongs to neither the change nor the app, named after a
/// compaction test rather than the variable (`docs/hook-friction-2.md` §7 of
/// the tooling entries, bw-e3dw.19). A suite is never the thing a bypass is
/// for, so it does not inherit one.
fn shell_output(root: &Path, command: &str) -> Result<std::process::Output, String> {
    let mut shell = if cfg!(windows) { Command::new("cmd") } else { Command::new("sh") };
    shell.args([if cfg!(windows) { "/C" } else { "-c" }, command])
        .current_dir(root)
        .env_remove(crate::hook_bypass::TOKEN)
        .output()
        .map_err(|error| format!("could not run `{command}`: {error}"))
}

fn changed(root: &Path, trunk: &str) -> Vec<String> {
    git(root, &["diff", "--name-only", &format!("{trunk}...HEAD")]).unwrap_or_default()
        .lines().map(str::to_string).filter(|line| !line.is_empty()).collect()
}

fn result_token(name: &str, output: &str, ok: bool) -> String {
    let mut passed = 0_u64;
    let mut failed = 0_u64;
    for line in output.lines() {
        if let Some(at) = line.find("test result:") {
            let words: Vec<&str> = line[at..].split_whitespace().collect();
            for pair in words.windows(2) {
                if pair[1].starts_with("passed") { passed += pair[0].parse::<u64>().unwrap_or(0); }
                if pair[1].starts_with("failed") { failed += pair[0].parse::<u64>().unwrap_or(0); }
            }
        }
    }
    if !ok && failed == 0 { failed = 1; }
    let counts = if passed == 0 && failed == 0 { String::new() } else { format!(" ({passed} passed, {failed} failed)") };
    format!("{name}={}{counts}", if failed == 0 { "PASSED" } else { "FAILED" })
}

/// What a person hands `--record`, in the one form the card and the gate read.
///
/// `NAME=PASSED` and `NAME=FAILED` are the words the card asks for. Counts are
/// taken too — `NAME=719/0` is what a suite's own summary looks like, and it
/// was the only form this accepted while the card asked for the other one.
fn recorded_token(name: &str, said: &str) -> Result<String, String> {
    let plain = said.trim();
    if plain.eq_ignore_ascii_case("passed") || plain.eq_ignore_ascii_case("failed") {
        return Ok(format!("{name}={}", plain.to_ascii_uppercase()));
    }
    let (passed, failed) = plain
        .split_once('/')
        .ok_or_else(|| format!("--record {name}= must say PASSED, FAILED, or PASSED/FAILED counts"))?;
    let passed: u64 = passed.trim().parse().map_err(|_| "recorded counts must be integers".to_string())?;
    let failed: u64 = failed.trim().parse().map_err(|_| "recorded counts must be integers".to_string())?;
    Ok(format!(
        "{name}={} ({passed} passed, {failed} failed)",
        if failed == 0 { "PASSED" } else { "FAILED" }
    ))
}

pub(crate) fn checks(rest: &[String]) -> Result<i32, String> {
    let root = root()?;
    let card = rest.iter().find(|word| !word.starts_with('-') && !word.contains('='));
    let all = rest.iter().any(|word| word == "--all");
    let dry = rest.iter().any(|word| word == "--dry");
    let recorded = flags(rest, "--record");
    let settings = manifest(&root)?;
    if settings.verification.commands.is_empty() {
        return Err("This project declares no verification commands in Project Settings.".into());
    }
    let trunk = if settings.git.completed_work_branch.is_empty() { landing_name(&root) } else { settings.git.completed_work_branch.clone() };
    let files = changed(&root, &trunk);
    let selected: Vec<_> = settings.verification.commands.iter().filter(|suite| {
        all || suite.paths.is_empty() || files.iter().any(|file| suite.paths.iter().any(|path| file.starts_with(path)))
    }).collect();
    if dry {
        println!("{} file(s) changed against {trunk}", files.len());
        for suite in &selected { println!("would run {}: `{}`", suite.name, suite.command); }
        if selected.is_empty() { println!("no declared suite matches the changed paths"); }
        return Ok(0);
    }
    if !git(&root, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Commit the tracked changes before recording checks for the landing tree.".into());
    }
    let tree = git(&root, &["rev-parse", "HEAD^{tree}"])?;
    let mut tokens = Vec::new();
    let mut failure = None;
    if !recorded.is_empty() {
        for result in recorded {
            let (name, said) = result.split_once('=').ok_or_else(|| "--record must be NAME=PASSED or NAME=FAILED".to_string())?;
            if !settings.verification.commands.iter().any(|suite| suite.name == name) {
                return Err(format!("--record names {name}, which this project does not declare"));
            }
            let token = recorded_token(name, said)?;
            if token.contains("=FAILED") { failure = Some(name.to_string()); }
            tokens.push(token);
        }
    } else {
        if selected.is_empty() { return Err("No declared suite matches the changed paths. Use --all to run every suite, or record evidence on the card explicitly.".into()); }
        for suite in selected {
            println!("running {}: `{}`", suite.name, suite.command);
            let output = shell_output(&root, &suite.command)?;
            let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            print!("{text}");
            tokens.push(result_token(&suite.name, &text, output.status.success()));
            if !output.status.success() { failure = Some(suite.name.clone()); break; }
        }
    }
    if git(&root, &["rev-parse", "HEAD^{tree}"])? != tree
        || !git(&root, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("The committed tree changed during checks; no passing evidence recorded".into());
    }
    let proof = format!("checks: tree {tree} {}", tokens.join(" "));
    println!("{proof}");
    if let Some(card) = card {
        // The card was claimed by the session that called this tool, so close
        // it as that session rather than as the repository's human owner: a
        // run that passes every suite and then cannot flip the status leaves
        // the card open with its own evidence attached saying it passed
        // (`docs/hook-friction-2.md` §10).
        let row = self::card(&root, card)?;
        let actor = crate::board_landing::actor(&root)?;
        if row["assignee"].as_str().is_some_and(|owner| !owner.is_empty() && owner != actor) {
            return Err(format!("{card} belongs to another actor; record checks as the claiming session"));
        }
        bd(&root, &["--actor".into(), actor.clone(), "comments".into(), "add".into(), card.clone(), proof.clone()])?;
        let suite_names: Vec<String> = tokens.iter().filter_map(|token| token.split_once('=').map(|(name, _)| name.to_string())).collect();
        let all_required = settings.verification.commands.iter().filter(|suite| all || suite.paths.is_empty() || files.iter().any(|file| suite.paths.iter().any(|path| file.starts_with(path))))
            .all(|suite| suite_names.contains(&suite.name));
        metadata(&root, card, &[("checks_tree", tree.clone()), ("checks_passed", (failure.is_none() && all_required).to_string()), ("checks_suites", serde_json::to_string(&suite_names).unwrap())])?;
        println!("Recorded checks for {card}; work closes when it lands.");

    }
    Ok(if failure.is_some() { 1 } else { 0 })
}

fn bounded_output(command: &mut Command) -> Result<std::process::Output, String> {
    use std::{io::{Read, Seek, SeekFrom}, process::Stdio, time::{Duration, Instant}};
    let mut stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.stdout(Stdio::from(stdout.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(stderr.try_clone().map_err(|e| e.to_string())?))
        .spawn().map_err(|e| e.to_string())?;
    let started = Instant::now(); let mut heartbeat = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if heartbeat.elapsed() >= Duration::from_secs(30) {
            eprintln!("External review still running ({} seconds)", started.elapsed().as_secs()); heartbeat = Instant::now();
        }
        if started.elapsed() > Duration::from_secs(600) {
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
            std::thread::sleep(Duration::from_secs(1));
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            let _ = child.kill(); let _ = child.wait();
            return Err("TIMEOUT: external review exceeded ten minutes; no passing proof recorded".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    stdout.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    stderr.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut out = Vec::new(); let mut err = Vec::new();
    stdout.read_to_end(&mut out).map_err(|e| e.to_string())?;
    stderr.read_to_end(&mut err).map_err(|e| e.to_string())?;
    Ok(std::process::Output { status, stdout: out, stderr: err })
}

fn review(rest: &[String]) -> Result<i32, String> {
    let asked = rest.first().filter(|word| !word.starts_with('-'))
        .ok_or_else(|| "review needs a job id".to_string())?;
    let root = root()?;
    if manifest(&root)?.review.external_review == "never" { return Err("This project's policy disables external review".into()); }
    let asked_card = card(&root, asked)?;
    let id = if labels(&asked_card).contains(&"step:review") {
        labels(&asked_card).iter().find_map(|label| label.strip_prefix("of:"))
            .ok_or_else(|| format!("review step {asked} names no job"))?.to_string()
    } else { asked.clone() };
    card(&root, &id)?;
    if !git(&root, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Commit the tracked changes before review.".into());
    }
    let provider = flag(rest, "--provider").or_else(|| {
        crate::routes::find_tool("claude", &[]).map(|_| "claude".to_string())
    }).or_else(|| crate::routes::find_tool("codex", &[]).map(|_| "codex".to_string()))
        .ok_or_else(|| "External review needs Claude Code or Codex CLI; choose its path in Settings → Dependencies.".to_string())?;
    let program = crate::routes::find_tool(&provider, &[])
        .ok_or_else(|| format!("{provider} is not available"))?;
    let card_json = bd(&root, &["show".into(), id.clone(), "--json".into()])?;
    let trunk = landing_name(&root);
    let reviewed_tree = git(&root, &["rev-parse", "HEAD^{tree}"])?;
    let commits: Vec<String> = git(&root, &["log", &format!("{trunk}..HEAD"), "--format=%H"])?.lines().map(str::to_string).collect();
    if commits.is_empty() { return Err(format!("{id} has no unlanded commits to review")); }
    let mut change = String::new();
    for sha in commits.iter().rev() {
        change.push_str(&git(&root, &["show", "--format=commit %H%n%s", "--stat", "--patch", sha])?);
        change.push('\n');
        if change.len() > 300_000 { let mut end = 300_000; while !change.is_char_boundary(end) { end -= 1; } change.truncate(end); change.push_str("\n[diff truncated; inspect the repository read-only]\n"); break; }
    }
    let base = git(&root, &["rev-parse", &trunk])?;
    let head = git(&root, &["rev-parse", "HEAD"])?;
    let agreements = std::fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default();
    let instructions = include_str!("../../machinery/workers/external-review.md");
    let prompt = format!("{instructions}\n\nImmutable scope: base {base}, head {head}. Repository: {}.\nProject instructions:\n{agreements}\n\nReturn this exact shape:\n{{\"verdict\":\"PASS or NEEDS_WORK\",\"summary\":\"one sentence\",\"verified\":[\"fact\"],\"findings\":[{{\"severity\":\"critical, high, or medium\",\"confidence\":80,\"file\":\"path\",\"line\":null,\"title\":\"failure\",\"evidence\":\"proof\",\"recommendation\":\"verifiable correction\"}}]}}\n\nJob:\n{card_json}\n\nUnlanded commits and diff:\n{change}", root.display());
    if git(&root, &["rev-parse", "HEAD^{tree}"])? != reviewed_tree { return Err("The tree changed while preparing review".into()); }
    let mut command = Command::new(program);
    if provider == "claude" {
        command.args(["--agents", r#"{"reviewer":{"description":"Independent code review","prompt":"Review the supplied immutable scope. Do not edit files or mutate Git, Beads, applications or processes. Return only the requested JSON verdict.","tools":["Read","Grep","Glob"]}}"#, "--agent", "reviewer", "-p", &prompt, "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--no-session-persistence", "--output-format", "json", "--json-schema", r#"{"type":"object","required":["verdict","summary","findings"],"properties":{"verdict":{"enum":["PASS","NEEDS_WORK"]},"summary":{"type":"string"},"findings":{"type":"array","items":{"type":"object"}}}}"#]);
    } else if provider == "codex" {
        command.args(["exec", "--sandbox", "read-only", "--color", "never", &prompt]);
    } else { return Err("Review provider must be claude or codex".into()); }
    command.current_dir(&root).env_remove("ATELIER_BYPASS");
    let evidence = crate::board_landing::common_root(&root).join(".git/atelier-reviews").join(format!("{id}-{head}"));
    std::fs::create_dir_all(&evidence).map_err(|e| e.to_string())?;
    std::fs::write(evidence.join("packet.txt"), &prompt).map_err(|e| e.to_string())?;
    let output = bounded_output(&mut command)?;
    std::fs::write(evidence.join("stdout.json"), &output.stdout).map_err(|e| e.to_string())?;
    std::fs::write(evidence.join("stderr.txt"), &output.stderr).map_err(|e| e.to_string())?;
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    let verdict = String::from_utf8_lossy(&output.stdout).to_string();
    let note = format!("external review via {provider} (exit {}):\n\n{}", output.status.code().unwrap_or(1), verdict.trim());
    bd(&root, &["comments".into(), "add".into(), id.clone(), note])?;
    print!("{verdict}");
    if !output.status.success() { return Ok(1); }
    let parsed = serde_json::from_str::<Value>(verdict.trim()).or_else(|_| {
        let start = verdict.find('{').unwrap_or(verdict.len());
        let end = verdict.rfind('}').map(|at| at + 1).unwrap_or(start);
        serde_json::from_str::<Value>(&verdict[start..end])
    }).map_err(|error| format!("{provider} returned no readable review JSON: {error}"))?;
    let parsed = if provider == "claude" { claude_verdict(&parsed)? } else { parsed };
    std::fs::write(evidence.join("verdict.json"), serde_json::to_vec_pretty(&parsed).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let findings = parsed["findings"].as_array().ok_or_else(|| "review JSON has no findings array".to_string())?;
    let passed = parsed["verdict"].as_str() == Some("PASS") && findings.is_empty();
    if git(&root, &["rev-parse", "HEAD^{tree}"])? != reviewed_tree
        || !git(&root, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("The tree changed during review; rerun review on the committed result".into());
    }
    metadata(&root, &id, &[("review_tree", reviewed_tree), ("review_passed", passed.to_string()), ("reviewed_commits", commits.join(","))])?;
    if !passed { return Ok(1); }

    Ok(0)
}

fn claude_verdict(envelope: &Value) -> Result<Value, String> {
    if envelope["is_error"] == true { return Err("REVIEWER_ERROR: reviewer reported failure".into()); }
    if let Some(value) = envelope.get("structured_output") { return Ok(value.clone()); }
    let text = envelope["result"].as_str().ok_or("REVIEWER_ERROR: missing review verdict")?.trim();
    let text = text.strip_prefix("```json").and_then(|s| s.trim().strip_suffix("```")).unwrap_or(text).trim();
    let value: Value = serde_json::from_str(text).map_err(|e| format!("REVIEWER_ERROR: invalid verdict: {e}"))?;
    if !matches!(value["verdict"].as_str(), Some("PASS" | "NEEDS_WORK")) || !value["findings"].is_array() {
        return Err("REVIEWER_ERROR: missing verdict or findings".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_machinery_review_accepts_json_envelopes_but_not_prose_or_errors() {
        let result = serde_json::json!({"verdict":"NEEDS_WORK","findings":[{"title":"fault"}]});
        assert_eq!(claude_verdict(&serde_json::json!({"structured_output":result})).unwrap(), result);
        assert_eq!(claude_verdict(&serde_json::json!({"result":format!("```json\n{result}\n```")})).unwrap(), result);
        assert!(claude_verdict(&serde_json::json!({"result":"Looks good"})).is_err());
        assert!(claude_verdict(&serde_json::json!({"is_error":true,"structured_output":result})).is_err());
    }

    /// A worker in a job copy has to carry a bypass on every command; once it
    /// is exported rather than welded on, the gate stands down out loud and a
    /// case asserting the gate says nothing to a session goes red
    /// (`docs/hook-friction-2.md` bw-e3dw.19).
    #[test]
    fn native_machinery_a_declared_suite_inherits_no_standing_bypass() {
        let root = tempfile::tempdir().unwrap();
        // SAFETY: single-threaded test setup, restored before it returns.
        unsafe { std::env::set_var(crate::hook_bypass::TOKEN, "a worktree is per job") };
        let out = shell_output(
            root.path(),
            &format!("printf %s \"${{{}:-none}}\"", crate::hook_bypass::TOKEN),
        )
        .unwrap();
        unsafe { std::env::remove_var(crate::hook_bypass::TOKEN) };
        assert_eq!(String::from_utf8_lossy(&out.stdout), "none");
    }

    /// Asking what the flags are ran the suite, or created a real epic that
    /// had to be cancelled afterwards (`docs/hook-friction-2.md` bw-e3dw.7).
    #[test]
    fn native_machinery_asking_for_help_is_not_asking_for_the_work() {
        assert!(asks_for_help(&["--help".to_string()]));
        assert!(asks_for_help(&["--schema".to_string()]));
        assert!(asks_for_help(&["new".to_string(), "-h".to_string()]));
        assert!(!asks_for_help(&["new".to_string(), "--what".to_string(), "a fault".to_string()]));
        // A card whose own text says `--help` is still a card, not a question.
        assert!(!asks_for_help(&["bw-1".to_string()]));

        for tool in ["board/job", "board/land", "checks", "review"] {
            let answer = usage(tool);
            assert!(answer.starts_with("usage: atelier tool "), "{tool}");
            let run = run(tool, &["--help".to_string()]).expect("a known tool");
            assert_eq!(run.unwrap(), 0, "{tool} answers and does nothing");
        }
        assert!(run("board/nonsense", &["--help".to_string()]).is_none());
    }

    #[test]
    fn native_machinery_commit_subjects_name_exact_cards_only() {
        assert!(subject_names("bw-one.12: finish native machinery", "bw-one.12"));
        assert!(!subject_names("bw-one.123: a different card", "bw-one.12"));
        assert!(!subject_names("mention bw-one.12 only in a body we did not pass", "bw-one.1"));

        // An id `bd` issued with no digit in it was invisible to the check, so
        // no subject in any form could land it (`docs/hook-friction-2.md` §5).
        assert!(subject_names("bw-uxoe: the chat list opens again", "bw-uxoe"));
        assert!(subject_names("fix(bw-uxoe): the chat list opens again", "bw-uxoe"));
        assert!(subject_names("bw-uxoe", "bw-uxoe"));
        assert!(!subject_names("bw-uxoen: a neighbour", "bw-uxoe"));
    }

    #[test]
    fn native_machinery_prose_preferences_do_not_change_the_required_spine() {
        let steps = chosen_spine(&["--steps".into(), "design,review".into()]);
        assert_eq!(steps, ["design", "work", "checks", "review", "land"]);
    }
}
