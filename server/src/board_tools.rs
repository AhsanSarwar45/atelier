//! Native forms of the public board workflow commands. The binary speaks to
//! Git and `bd` directly; installed workflows never execute bundled Python.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn run(name: &str, rest: &[String]) -> Option<Result<i32, String>> {
    Some(match name {
        "board/job" => job(rest),
        "board/land" => land(rest),
        "checks" => checks(rest),
        "review" => review(rest),
        _ => return None,
    })
}

fn root() -> Result<PathBuf, String> {
    let program = crate::routes::find_git().ok_or_else(|| crate::routes::GIT_MISSING.to_string())?;
    let output = Command::new(program).args(["rev-parse", "--show-toplevel"]).output()
        .map_err(|error| format!("could not ask Git for the project root: {error}"))?;
    if !output.status.success() { return Err("this is not a Git project".into()); }
    Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

fn bd(root: &Path, args: &[String]) -> Result<String, String> {
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

fn metadata(root: &Path, id: &str, entries: &[(&str, String)]) -> Result<(), String> {
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
        return Ok(0);
    }
    if action == "cancel" {
        let id = rest.get(1).ok_or_else(|| "board/job cancel needs an id".to_string())?;
        let reason = flag(rest, "--reason").filter(|reason| !reason.trim().is_empty())
            .ok_or_else(|| "board/job cancel needs --reason explaining why the work is being dropped".to_string())?;
        cancel_tree(&root, id, &reason)?;
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
    for child in children(root, id)? {
        if child["status"].as_str() != Some("closed") {
            if let Some(child_id) = child["id"].as_str() { cancel_tree(root, child_id, reason)?; }
        }
    }
    bd(root, &["update".into(), id.into(), "--add-label".into(), "cancelled".into()])?;
    bd(root, &["close".into(), id.into(), "--force".into(), "--reason".into(), format!("cancelled: {reason}")])?;
    Ok(())
}

fn card(root: &Path, id: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(&bd(root, &["show".into(), id.into(), "--json".into()])?)
        .map_err(|error| error.to_string())?;
    Ok(value.as_array().and_then(|rows| rows.first()).cloned().unwrap_or(value))
}

fn labels(card: &Value) -> Vec<&str> {
    card["labels"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
}

fn meta<'a>(card: &'a Value, key: &str) -> Option<&'a str> {
    card["metadata"].get(key).and_then(Value::as_str)
}

fn step_body(step: &str, done: &str) -> String {
    match step {
        "checks" => format!("Run the project's declared verification commands.\n\n## Acceptance Criteria\n{done}\n\nRecord `checks: tree HASH suite=PASSED/FAILED`."),
        "land" => "Remove the finished worktree and branch after every commit has reached the landing branch and the merge slot is free.\n\n## Acceptance Criteria\nThe branch and worktree are gone and the merge slot is free.".into(),
        "ground" => "Read the sources that define the behavior and record the relevant facts here.\n\n## Acceptance Criteria\nThe sources and the facts they support are on this card.".into(),
        "design" => "Describe the effects of the change and record the manager's approval.\n\n## Acceptance Criteria\nThe approved design is on this card.".into(),
        "benchmark" => "Measure the claimed effect before and after.\n\n## Acceptance Criteria\nBoth measurements and their commands are on this card.".into(),
        "record" => "Put durable facts in the document that owns them.\n\n## Acceptance Criteria\nThe owning document contains the durable result.".into(),
        _ => format!("Complete the {step} step and record its evidence."),
    }
}

fn create_step(root: &Path, goal: &Value, id: &str, step: &str) -> Result<String, String> {
    let subject = meta(goal, "subject").unwrap_or_else(|| goal["title"].as_str().unwrap_or(id));
    let area = meta(goal, "area").unwrap_or("board");
    let kind = meta(goal, "kind").unwrap_or("chore");
    let done = meta(goal, "done").unwrap_or("The declared result is verified.");
    let priority = goal["priority"].as_i64().unwrap_or(2).to_string();
    let title = format!("{}: {}", step[..1].to_uppercase() + &step[1..], subject);
    let mut args = vec!["create".into(), "--title".into(), title, "--type".into(), "task".into(),
        "--parent".into(), id.into(), "-p".into(), priority, "-d".into(), step_body(step, done),
        "-l".into(), format!("step:{step}"), "-l".into(), format!("of:{id}"),
        "-l".into(), format!("area:{area}"), "-l".into(), format!("kind:{kind}"), "--json".into()];
    if step != "record" { args.extend(["-l".into(), "no-code".into()]); }
    created_id(&bd(root, &args)?)
}

pub(crate) fn advance_goal(root: &Path, id: &str) -> Result<(), String> {
    let goal = card(root, id)?;
    if goal["status"].as_str() == Some("closed") { return Ok(()); }
    let order: Vec<&str> = meta(&goal, "spine").unwrap_or("work,checks,land").split(',').filter(|s| !s.is_empty()).collect();
    let children_value: Value = serde_json::from_str(&bd(root, &["list".into(), "--parent".into(), id.into(), "--status".into(), "all".into(), "--limit".into(), "0".into(), "--json".into()])?).unwrap_or(Value::Array(vec![]));
    let children = children_value.as_array().cloned().unwrap_or_default();
    for step in order {
        let wanted = format!("step:{step}");
        let rows: Vec<&Value> = children.iter()
            .filter(|row| labels(row).iter().any(|label| *label == wanted))
            .collect();
        if step == "work" {
            if rows.is_empty() || rows.iter().any(|row| row["status"].as_str() != Some("closed")) { return Ok(()); }
            continue;
        }
        if rows.is_empty() {
            let opened = create_step(root, &goal, id, step)?;
            println!("opened {opened} ({step})");
            return Ok(());
        }
        if rows.iter().any(|row| row["status"].as_str() != Some("closed")) { return Ok(()); }
    }
    let judge = meta(&goal, "judge").unwrap_or("agent");
    if judge.starts_with("manager") {
        bd(root, &["update".into(), id.into(), "--status".into(), "manager_review".into()])?;
    } else {
        bd(root, &["close".into(), id.into(), "--reason".into(), "all native lifecycle steps completed".into()])?;
    }
    Ok(())
}

pub(crate) fn advance_all(root: &Path) {
    let Ok(text) = bd(root, &["list".into(), "--label".into(), "job".into(), "--status".into(), "all".into(), "--limit".into(), "0".into(), "--json".into()]) else { return };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return };
    for id in value.as_array().into_iter().flatten().filter_map(|row| row["id"].as_str()) { let _ = advance_goal(root, id); }
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let program = crate::routes::find_git().ok_or_else(|| crate::routes::GIT_MISSING.to_string())?;
    let output = Command::new(program).args(args).current_dir(root).output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(format!("git {} failed: {}", args.first().copied().unwrap_or(""), String::from_utf8_lossy(&output.stderr))); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn landing_name(root: &Path) -> String {
    let Some(program) = crate::routes::find_git() else { return "main".into() };
    ["ours", "main", "master"].into_iter().find(|name| Command::new(&program).args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).current_dir(root).status().is_ok_and(|s| s.success())).unwrap_or("main").into()
}

fn main_copy(root: &Path, branch: &str) -> Result<PathBuf, String> {
    let listing = git(root, &["worktree", "list", "--porcelain"])?;
    let mut path = None;
    for line in listing.lines() {
        if let Some(value) = line.strip_prefix("worktree ") { path = Some(PathBuf::from(value)); }
        if line == format!("branch refs/heads/{branch}") { return path.ok_or_else(|| "landing worktree has no path".into()); }
    }
    Err(format!("no worktree has the landing branch {branch} checked out"))
}

fn land(rest: &[String]) -> Result<i32, String> {
    let id = rest.first().ok_or_else(|| "board/land needs a card id".to_string())?;
    let work = root()?;
    let item = card(&work, id)?;
    let goal = labels(&item).iter().find_map(|label| label.strip_prefix("of:"))
        .or_else(|| item["parent"].as_str()).or_else(|| item["parent_id"].as_str())
        .unwrap_or(id).to_string();
    if !git(&work, &["status", "--porcelain"])?.is_empty() { return Err("the worktree has uncommitted changes".into()); }
    let branch = git(&work, &["branch", "--show-current"])?;
    let landing = landing_name(&work);
    if branch == landing { return Err(format!("{landing} is the landing branch; run board/land from the branch carrying the work")); }
    let subjects = git(&work, &["log", "--format=%s", &format!("{landing}..{branch}")])?;
    if !subjects.lines().any(|subject| subject_names(subject, id)) {
        return Err(format!("no commit subject on {branch} names {id}"));
    }
    let open_work: Vec<Value> = children(&work, &goal)?.into_iter().filter(|row| {
        row["status"].as_str() != Some("closed") && labels(row).contains(&"step:work")
    }).collect();
    let carried: Vec<String> = open_work.iter().filter_map(|row| row["id"].as_str())
        .filter(|work_id| subjects.lines().any(|subject| subject_names(subject, work_id)))
        .map(str::to_string).collect();
    git(&work, &["rebase", &landing])?;
    let main = main_copy(&work, &landing)?;
    let actor = std::env::var("BEADS_ACTOR").unwrap_or_else(|_| "atelier-land".into());
    bd(&work, &["--actor".into(), actor.clone(), "merge-slot".into(), "acquire".into()])?;
    let merged = git(&main, &["merge", "--ff-only", &branch]);
    let _ = bd(&work, &["--actor".into(), actor.clone(), "merge-slot".into(), "release".into()]);
    merged?;
    for work_id in &carried {
        bd(&work, &["--actor".into(), actor.clone(), "close".into(), work_id.clone(),
            "--reason".into(), format!("commit naming {work_id} landed on {landing}")])?;
    }
    advance_goal(&work, &goal)?;
    if carried.is_empty() {
        println!("landed {id} on {landing}; closed nothing because no open work-item id was named by a landed commit subject");
    } else {
        println!("landed {id} on {landing}; closed {}", carried.join(", "));
    }
    Ok(0)
}

fn subject_names(subject: &str, id: &str) -> bool {
    card_ids(subject).iter().any(|word| word == id)
}

fn manifest(root: &Path) -> Result<crate::project_manifest::ProjectManifest, String> {
    let data = crate::identity::data_dir().ok_or_else(|| "Atelier has no data directory".to_string())?;
    crate::project_manifest::locate(root, &data).map(|found| found.manifest)
        .ok_or_else(|| "This project has no Atelier settings. Run `atelier init` first.".to_string())
}

fn shell_output(root: &Path, command: &str) -> Result<std::process::Output, String> {
    if cfg!(windows) { Command::new("cmd").args(["/C", command]).current_dir(root).output() }
    else { Command::new("sh").args(["-c", command]).current_dir(root).output() }
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
    if passed == 0 && failed == 0 { format!("{name}=ran-ok") } else { format!("{name}={passed}/{failed}") }
}

fn card_ids(text: &str) -> Vec<String> {
    text.split(|character: char| !(character.is_ascii_alphanumeric() || character == '-' || character == '.'))
        .filter(|word| word.contains('-') && word.chars().any(|character| character.is_ascii_digit()))
        .map(str::to_string).collect()
}

fn checks(rest: &[String]) -> Result<i32, String> {
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
    let tree = git(&root, &["write-tree"])?;
    let mut tokens = Vec::new();
    let mut failure = None;
    if !recorded.is_empty() {
        for result in recorded {
            let (name, counts) = result.split_once('=').ok_or_else(|| "--record must be NAME=PASSED/FAILED".to_string())?;
            if !settings.verification.commands.iter().any(|suite| suite.name == name) {
                return Err(format!("--record names {name}, which this project does not declare"));
            }
            let (_, failed) = counts.split_once('/').ok_or_else(|| "--record must be NAME=PASSED/FAILED".to_string())?;
            if failed.parse::<u64>().map_err(|_| "recorded counts must be integers")? > 0 { failure = Some(name.to_string()); }
            tokens.push(format!("{name}={counts}"));
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
    let proof = format!("checks: tree {tree} {}", tokens.join(" "));
    println!("{proof}");
    if let Some(card) = card {
        bd(&root, &["comments".into(), "add".into(), card.clone(), proof.clone()])?;
        if failure.is_none() {
            bd(&root, &["close".into(), card.clone(), "--reason".into(), format!("{proof}. Run by `atelier tool checks {card}`")])?;
            let row = self::card(&root, card)?;
            if let Some(goal) = row["parent"].as_str().or_else(|| row["parent_id"].as_str()) {
                advance_goal(&root, goal)?;
            }
            println!("closed {card}");
        }
    }
    Ok(if failure.is_some() { 1 } else { 0 })
}

fn review(rest: &[String]) -> Result<i32, String> {
    let asked = rest.first().filter(|word| !word.starts_with('-'))
        .ok_or_else(|| "review needs a job id".to_string())?;
    let root = root()?;
    let asked_card = card(&root, asked)?;
    let id = if labels(&asked_card).contains(&"step:review") {
        labels(&asked_card).iter().find_map(|label| label.strip_prefix("of:"))
            .ok_or_else(|| format!("review step {asked} names no job"))?.to_string()
    } else { asked.clone() };
    let goal = card(&root, &id)?;
    if !labels(&goal).contains(&"job") { return Err(format!("{id} is not a job")); }
    let children_value: Value = serde_json::from_str(&bd(&root, &["list".into(), "--parent".into(), id.clone(), "--status".into(), "all".into(), "--limit".into(), "0".into(), "--json".into()])?)
        .map_err(|error| error.to_string())?;
    let children = children_value.as_array().cloned().unwrap_or_default();
    for required in ["work", "checks"] {
        let wanted = format!("step:{required}");
        let rows: Vec<&Value> = children.iter().filter(|row| labels(row).iter().any(|label| *label == wanted)).collect();
        if rows.is_empty() || rows.iter().any(|row| row["status"].as_str() != Some("closed")) {
            return Err(format!("{id} is not ready for review: its {required} work is not closed"));
        }
    }
    let provider = flag(rest, "--provider").or_else(|| {
        crate::routes::find_tool("claude", &[]).map(|_| "claude".to_string())
    }).or_else(|| crate::routes::find_tool("codex", &[]).map(|_| "codex".to_string()))
        .ok_or_else(|| "External review needs Claude Code or Codex CLI; choose its path in Settings → Dependencies.".to_string())?;
    let program = crate::routes::find_tool(&provider, &[])
        .ok_or_else(|| format!("{provider} is not available"))?;
    let card_json = bd(&root, &["show".into(), id.clone(), "--json".into()])?;
    if card_json.contains("review:attempted") {
        return Err(format!("{id} already used its one external-review attempt"));
    }
    bd(&root, &["update".into(), id.clone(), "--add-label".into(), "review:attempted".into()])?;
    let trunk = landing_name(&root);
    let mut commits = Vec::new();
    for work_id in std::iter::once(id.as_str()).chain(children.iter()
        .filter(|row| labels(row).contains(&"step:work"))
        .filter_map(|row| row["id"].as_str())) {
        commits.extend(git(&root, &["log", &trunk, "--format=%H", "--fixed-strings", "--grep", work_id])?
            .lines().map(str::to_string));
    }
    commits.sort();
    commits.dedup();
    if commits.is_empty() { return Err(format!("{id} has no landed commits to review")); }
    let mut change = String::new();
    for sha in commits.iter().rev() {
        change.push_str(&git(&root, &["show", "--format=commit %H%n%s", "--stat", "--patch", sha])?);
        change.push('\n');
        if change.len() > 300_000 { change.truncate(300_000); change.push_str("\n[diff truncated; inspect the repository read-only]\n"); break; }
    }
    let instructions = include_str!("../../machinery/workers/external-review.md");
    let prompt = format!("{instructions}\n\nReturn this exact shape:\n{{\"verdict\":\"PASS or NEEDS_WORK\",\"summary\":\"one sentence\",\"verified\":[\"fact\"],\"findings\":[{{\"severity\":\"critical, high, or medium\",\"confidence\":80,\"file\":\"path\",\"line\":null,\"title\":\"failure\",\"evidence\":\"proof\",\"recommendation\":\"verifiable correction\"}}]}}\n\nJob:\n{card_json}\n\nLanded commits and diff:\n{change}");
    let output = if provider == "claude" {
        Command::new(program).args(["-p", &prompt, "--output-format", "text", "--permission-mode", "plan"])
            .current_dir(&root).output()
    } else {
        Command::new(program).args(["exec", "--sandbox", "read-only", "--color", "never", &prompt])
            .current_dir(&root).output()
    }.map_err(|error| format!("could not start {provider} review: {error}"))?;
    let verdict = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let note = format!("external review via {provider} (exit {}):\n\n{}", output.status.code().unwrap_or(1), verdict.trim());
    bd(&root, &["comments".into(), "add".into(), id.clone(), note])?;
    print!("{verdict}");
    if !output.status.success() { return Ok(1); }
    let parsed = serde_json::from_str::<Value>(verdict.trim()).or_else(|_| {
        let start = verdict.find('{').unwrap_or(verdict.len());
        let end = verdict.rfind('}').map(|at| at + 1).unwrap_or(start);
        serde_json::from_str::<Value>(&verdict[start..end])
    }).map_err(|error| format!("{provider} returned no readable review JSON: {error}"))?;
    let findings = parsed["findings"].as_array().ok_or_else(|| "review JSON has no findings array".to_string())?;
    let priority = goal["priority"].as_i64().unwrap_or(2).to_string();
    let area = meta(&goal, "area").unwrap_or("board");
    let kind = meta(&goal, "kind").unwrap_or("bug");
    let mut made = Vec::new();
    for finding in findings {
        let title = finding["title"].as_str().unwrap_or("").trim();
        if title.is_empty() { continue; }
        let done = finding["recommendation"].as_str().unwrap_or("The reported failure no longer reproduces.");
        let child = make_item(&root, &id, &format!("{title}|{done}"), area, kind, &priority)?;
        let where_at = match (finding["file"].as_str(), finding["line"].as_i64()) {
            (Some(file), Some(line)) => format!("{file}:{line}"),
            (Some(file), None) => file.to_string(),
            _ => "not specified".into(),
        };
        let evidence = finding["evidence"].as_str().unwrap_or("");
        bd(&root, &["update".into(), child.clone(), "--append-notes".into(), format!("External review at {where_at}:\n\n{evidence}")])?;
        made.push(child);
    }
    let review_rows: Vec<&Value> = children.iter().filter(|row| labels(row).contains(&"step:review")).collect();
    for row in review_rows.into_iter().filter(|row| row["status"].as_str() != Some("closed")) {
        if let Some(step_id) = row["id"].as_str() {
            bd(&root, &["close".into(), step_id.into(), "--reason".into(), format!("external review completed via {provider}")])?;
        }
    }
    metadata(&root, &id, &[("reviewed_commits", commits.join(","))])?;
    if made.is_empty() {
        advance_goal(&root, &id)?;
    } else {
        bd(&root, &["update".into(), id.clone(), "--status".into(), "open".into()])?;
        let _ = create_step(&root, &goal, &id, "checks")?;
        println!("filed findings: {}", made.join(", "));
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_machinery_commit_subjects_name_exact_cards_only() {
        assert!(subject_names("bw-one.12: finish native machinery", "bw-one.12"));
        assert!(!subject_names("bw-one.123: a different card", "bw-one.12"));
        assert!(!subject_names("mention bw-one.12 only in a body we did not pass", "bw-one.1"));
    }

    #[test]
    fn native_machinery_prose_preferences_do_not_change_the_required_spine() {
        let steps = chosen_spine(&["--steps".into(), "design,review".into()]);
        assert_eq!(steps, ["design", "work", "checks", "review", "land"]);
    }
}
