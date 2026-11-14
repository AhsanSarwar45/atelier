//! `atelier task …`: the agent's side of tasks (docs/tasks.md, "CLI").
//!
//! Every call names its chat with `ATELIER_CHAT_SESSION_ID`, which the app
//! sets for the agent's process and its shells inherit, and talks to the
//! running app on `ATELIER_PORT`. Mutating calls print the task card as an
//! `atelier-widget` block, which the chat draws at the tool call.

use super::types;
use crate::workbench::cli::server_url;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const USAGE: &str = "\
usage: atelier task <command>
  types [TYPE]                 list this project's types and their default items, or print one type's payloads
  types create                 {name, description, code, review, items?} on stdin: a new type for the project
  types edit TYPE              {items?, description?, code?, review?} on stdin: items replace the scope's own
  types disable|enable TYPE [--item ID]
                               turn a type, or one of its default items, off or back on
  types undo                   put back the types as they were before the last change
                               (every types change takes --scope install|project; project is the default)
  propose                      {type, title, why, decisions, plan, cells?} on stdin or --input FILE: ask the owner first
  create                       {type, title, why, decisions, plan, cells?}; only when the owner's message says @task,
                               or when every cell is in an approved grid (`atelier grid next` prints one)
  start N
  check N ITEM                 the server runs the item's checks and ticks it when every one passes (no input);
                               a task made before checks takes the item's result entry on stdin or --input FILE
  block N --cause TEXT --needs TEXT
  unblock N
  amend N                      {plan, reason} on stdin or --input FILE: the whole new plan, and why a check is
                               wrong or impossible as approved; it applies at once (the owner can undo it), and
                               the reply says what it may weaken of the approved checks
  done N                       {summary, commits?, followups?, result?, cells?} on stdin or --input FILE; the server
                               re-runs every check and the project's test command first
  cancel N --reason TEXT
  take N
  note N --text TEXT           leave a note on any task in the project, in any state; whoever works on it sees it
  list [--all]                 this session's tasks (or the project's)
  show N";

const PRESENTED: &str = "The card is shown in the chat. Do not paste this block into your reply.";

fn session() -> Result<String, String> {
    std::env::var("ATELIER_CHAT_SESSION_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            "ATELIER_CHAT_SESSION_ID is not set: `atelier task` must run inside an Atelier chat \
             session, where the app sets it for the agent's shell"
                .to_string()
        })
}

fn number(word: Option<&String>, command: &str) -> Result<i64, String> {
    let word = word.ok_or_else(|| format!("usage: atelier task {command} N"))?;
    word.trim_start_matches('#')
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 1)
        .ok_or_else(|| format!("{word} is not a task number (use the N of #N)"))
}

/// The value after `--name`, once.
fn flag(rest: &[String], name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    for (at, word) in rest.iter().enumerate() {
        if word == name {
            let value = rest
                .get(at + 1)
                .filter(|value| !value.starts_with("--"))
                .ok_or_else(|| format!("missing value for {name}"))?;
            if found.replace(value.clone()).is_some() {
                return Err(format!("{name} is given twice"));
            }
        }
    }
    Ok(found)
}

fn only_flags(rest: &[String], allowed: &[&str]) -> Result<(), String> {
    let mut words = rest.iter();
    while let Some(word) = words.next() {
        if word.starts_with("--") {
            if !allowed.contains(&word.as_str()) {
                return Err(format!(
                    "unknown option {word}{}",
                    if allowed.is_empty() { String::new() } else { format!(" (options: {})", allowed.join(", ")) }
                ));
            }
            if *word != "--all" {
                words.next();
            }
        } else {
            return Err(format!("unexpected argument {word}\n{USAGE}"));
        }
    }
    Ok(())
}

/// The JSON payload, from `--input FILE` or stdin. Stdin is only read when
/// it is not a terminal, so a call missing its payload fails instead of
/// waiting forever.
fn payload(rest: &[String], shape: &str) -> Result<Value, String> {
    let text = match flag(rest, "--input")? {
        Some(file) => std::fs::read_to_string(&file).map_err(|error| format!("{file}: {error}"))?,
        None => {
            use std::io::{IsTerminal, Read};
            if std::io::stdin().is_terminal() {
                return Err(format!("this command takes {shape} as JSON on stdin or with --input FILE"));
            }
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .map_err(|error| format!("stdin: {error}"))?;
            text
        }
    };
    if text.trim().is_empty() {
        return Err(format!("the payload is empty: give {shape} as JSON on stdin or with --input FILE"));
    }
    serde_json::from_str(&text).map_err(|error| format!("the payload is not valid JSON ({error}); it is {shape}"))
}

/// The payload when one is given: `--input FILE`, or stdin when it is not a
/// terminal and has something on it.
fn optional_payload(rest: &[String], shape: &str) -> Result<Option<Value>, String> {
    if flag(rest, "--input")?.is_some() {
        return payload(rest, shape).map(Some);
    }
    use std::io::{IsTerminal, Read};
    if std::io::stdin().is_terminal() {
        return Ok(None);
    }
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|error| format!("stdin: {error}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text).map(Some).map_err(|error| format!("the payload is not valid JSON ({error}); it is {shape}"))
}

/// Read every image or video the result names by path, for the server to
/// store. Paths are read relative to this shell's folder.
fn evidence(result: Option<&Value>) -> Result<BTreeMap<String, String>, String> {
    let mut named = Vec::new();
    if let Some(result) = result {
        super::media_strings(result, &mut named);
    }
    let mut files = BTreeMap::new();
    for path in named {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        files.insert(path, base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(files)
}

async fn post(body: Value) -> Result<i32, String> {
    let response = reqwest::Client::new()
        .post(server_url("/api/workbench/task"))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("could not reach Atelier: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("invalid response from Atelier: {error}"))?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("Atelier refused the task change").to_string());
    }
    print!("{}", value["widget"].as_str().unwrap_or_default());
    println!("{}", value["summary"].as_str().unwrap_or_default());
    println!("{PRESENTED}");
    // A check that left its item unmet was recorded, but did not pass.
    Ok(if value["failed"] == true { 1 } else { 0 })
}

async fn get(path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(server_url(path))
        .query(query)
        .send()
        .await
        .map_err(|error| format!("could not reach Atelier: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("invalid response from Atelier: {error}"))?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("Atelier refused the request").to_string());
    }
    Ok(value)
}

fn line(task: &Value) -> String {
    let holder = match task["sessionTitle"].as_str().or(task["sessionId"].as_str()) {
        Some(name) => format!(" · {name}"),
        None => " · unassigned".into(),
    };
    format!(
        "#{:<4} {:<12} {:<13} {}{}",
        task["number"],
        task["status"].as_str().unwrap_or(""),
        task["type"].as_str().unwrap_or(""),
        task["title"].as_str().unwrap_or(""),
        holder
    )
}

/// The types this chat's project offers, from the app; outside a chat, the
/// install's.
async fn listing() -> Result<Value, String> {
    let query: Vec<(&str, String)> = session().ok().map(|id| ("session", id)).into_iter().collect();
    get("/api/workbench/task-types", &query).await
}

async fn print_types(rest: &[String]) -> Result<i32, String> {
    match rest.first().map(String::as_str) {
        Some("create" | "edit" | "disable" | "enable" | "undo") => return change_types(rest).await,
        Some(word) if word.starts_with("--") => return Err(format!("unknown option {word}\n{USAGE}")),
        _ => {}
    }
    let listed = listing().await?;
    let entries = listed["types"].as_array().cloned().unwrap_or_default();
    let names: Vec<&str> = entries.iter().filter_map(|entry| entry["name"].as_str()).collect();
    match rest.first() {
        None => {
            println!("Task types (code = done needs commits; review = the owner approves):");
            for entry in &entries {
                let marks = [
                    entry["code"].as_bool().unwrap_or(false).then_some("code"),
                    entry["review"].as_bool().unwrap_or(false).then_some("review"),
                    entry["custom"].as_bool().unwrap_or(false).then_some("custom, planned like general"),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(", ");
                let name = entry["name"].as_str().unwrap_or_default();
                println!("\n{name}{}", if marks.is_empty() { String::new() } else { format!(" ({marks})") });
                if entry["custom"] == true {
                    println!("  about:  {}", entry["description"].as_str().unwrap_or_default());
                }
                println!("  plan:   {}", entry["plan"].as_str().unwrap_or_default());
                println!("  result: {}", entry["result"].as_str().unwrap_or_default());
                for item in entry["items"].as_array().into_iter().flatten() {
                    println!(
                        "  default item {}: {}{}",
                        item["id"].as_str().unwrap_or_default(),
                        item["text"].as_str().unwrap_or_default(),
                        if item.get("checks").is_some() { " (has checks)" } else { "" }
                    );
                }
            }
            println!("\n`atelier task types TYPE` prints a create and a done payload to copy.");
            println!(
                "Every create and propose gives `decisions`: one line for every type above, why the chosen type fits and why each other one does not. A type's default items go in plan.requirements, each with checks or a declined reason."
            );
            println!(
                "\nAnything visible on screen or in a render uses a visual type: {}. Pick ui_feature or render_feature for new work you can see (not feature), visual_bug for a bug you can see (not bug). Every item needs real images: an after, and a before (different from it) where the screen or scene already existed.",
                types::VISUAL_TYPES.join(", ")
            );
            println!(
                "Safety net: done on a feature or bug is refused when its commits change visual files (by default .tsx .jsx .css .scss .html .vue .svelte and shaders; a project sets its own under [tasks] visual_files; tests do not count) unless the result has screens[] {{name, before?, after}} screenshots."
            );
            Ok(0)
        }
        Some(name) => {
            let entry = entries
                .iter()
                .find(|entry| entry["name"] == name.as_str())
                .ok_or_else(|| format!("{name} is not a task type here (types: {})", names.join(", ")))?;
            let mut example = types::example(types::shape(name)).ok_or_else(|| format!("{name} has no example"))?;
            let recipe = example.as_object_mut().and_then(|row| row.remove("recipe"));
            example["type"] = json!(name);
            example["code"] = entry["code"].clone();
            example["review"] = entry["review"].clone();
            let create = &mut example["create"];
            create["type"] = json!(name);
            create["decisions"] = Value::Object(
                names
                    .iter()
                    .map(|other| {
                        let reason = if *other == name.as_str() { "<one line: why this type fits the work>" } else { "<one line: why the work is not this type>" };
                        (other.to_string(), json!(reason))
                    })
                    .collect(),
            );
            let items = entry["items"].as_array().cloned().unwrap_or_default();
            if !items.is_empty() {
                create["plan"]["requirements"] = Value::Array(
                    items
                        .iter()
                        .map(|item| {
                            let mut answered = json!({"id": item["id"], "text": item["text"]});
                            match item.get("checks") {
                                Some(checks) => answered["checks"] = checks.clone(),
                                None => {
                                    answered["checks"] = json!([{
                                        "name": item["id"], "kind": "test", "command": "<command that proves it>",
                                        "given": "<given>", "when": "<when>", "then": "<then>",
                                        "red": "<pattern the failing output matches>", "files": ["<the check's files>"],
                                    }]);
                                }
                            }
                            answered
                        })
                        .collect(),
                );
            }
            println!("{}", serde_json::to_string_pretty(&example).map_err(|e| e.to_string())?);
            if let Some(recipe) = recipe.as_ref().and_then(Value::as_str) {
                if !items.is_empty() {
                    println!("\nEach of plan.requirements takes checks that prove it, or instead declined: one line on why it does not apply.");
                }
                let shaped = if types::find(name).is_none() { " (planned like general)" } else { "" };
                println!("\nChecks for {name}{shaped}:\n\n{recipe}");
            }
            Ok(0)
        }
    }
}

/// `atelier task types create|edit|disable|enable|undo`: change the
/// project's task types (or the install's, with `--scope install`).
async fn change_types(rest: &[String]) -> Result<i32, String> {
    let action = rest[0].as_str();
    let scope = flag(rest, "--scope")?.unwrap_or_else(|| "project".into());
    let mut change = match action {
        "create" => {
            only_flags(&rest[1..], &["--input", "--scope"])?;
            json!({"type": payload(rest, "{name, description, code, review, items?}")?})
        }
        "edit" => {
            let name = rest.get(1).filter(|word| !word.starts_with("--")).ok_or("usage: atelier task types edit TYPE: {items?, description?, code?, review?} on stdin")?;
            only_flags(&rest[2..], &["--input", "--scope"])?;
            let mut change = payload(rest, "{items?, description?, code?, review?}")?;
            if !change.is_object() {
                return Err("the payload must be an object {items?, description?, code?, review?}".into());
            }
            change["name"] = json!(name);
            change
        }
        "disable" | "enable" => {
            let name = rest.get(1).filter(|word| !word.starts_with("--")).ok_or_else(|| format!("usage: atelier task types {action} TYPE [--item ID]"))?;
            only_flags(&rest[2..], &["--item", "--scope"])?;
            json!({"name": name, "item": flag(rest, "--item")?})
        }
        _ => {
            only_flags(&rest[1..], &["--scope"])?;
            json!({})
        }
    };
    change["action"] = json!(action);
    change["scope"] = json!(scope);
    let mut body = json!({"change": change});
    if let Ok(session) = session() {
        body["session"] = json!(session);
    } else if scope == "project" {
        return Err("ATELIER_CHAT_SESSION_ID is not set: run this in an Atelier chat to change the project's types, or pass --scope install".into());
    }
    let response = reqwest::Client::new()
        .post(server_url("/api/workbench/task-types"))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("could not reach Atelier: {error}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|error| format!("invalid response from Atelier: {error}"))?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("Atelier refused the type change").to_string());
    }
    let card = value["widget"].as_str().unwrap_or_default();
    print!("{card}");
    println!("{} The owner sees the change and can undo it.", value["summary"].as_str().unwrap_or_default());
    if !card.is_empty() {
        println!("{PRESENTED}");
    }
    Ok(0)
}

pub async fn run(rest: &[String]) -> Result<i32, String> {
    let Some(command) = rest.first().map(String::as_str) else {
        return Err(USAGE.into());
    };
    let rest = &rest[1..];
    match command {
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(0)
        }
        "types" => print_types(rest).await,
        "create" | "propose" => {
            only_flags(rest, &["--input"])?;
            let session = session()?;
            let payload = payload(rest, "{type, title, why, plan}")?;
            post(json!({"action": command, "actor": "agent", "session": session, "payload": payload})).await
        }
        "start" | "unblock" | "take" => {
            let number = number(rest.first(), command)?;
            only_flags(&rest[1..], &[])?;
            let session = session()?;
            post(json!({"action": command, "actor": "agent", "session": session, "number": number})).await
        }
        "block" => {
            let number = number(rest.first(), "block N --cause TEXT --needs TEXT")?;
            only_flags(&rest[1..], &["--cause", "--needs"])?;
            let session = session()?;
            let cause = flag(rest, "--cause")?.ok_or("--cause TEXT is required: what outside your control stops the work")?;
            let needs = flag(rest, "--needs")?.ok_or("--needs TEXT is required: what has to happen before work can resume")?;
            post(json!({"action": "block", "actor": "agent", "session": session, "number": number,
                "payload": {"cause": cause, "needed_to_resume": needs}})).await
        }
        "cancel" => {
            let number = number(rest.first(), "cancel N --reason TEXT")?;
            only_flags(&rest[1..], &["--reason"])?;
            let session = session()?;
            let reason = flag(rest, "--reason")?.ok_or("--reason TEXT is required")?;
            post(json!({"action": "cancel", "actor": "agent", "session": session, "number": number,
                "payload": {"reason": reason}})).await
        }
        "note" => {
            let number = number(rest.first(), "note N --text TEXT")?;
            only_flags(&rest[1..], &["--text"])?;
            let session = session()?;
            let text = flag(rest, "--text")?.ok_or("--text TEXT is required: what the note says")?;
            post(json!({"action": "note", "actor": "agent", "session": session, "number": number,
                "payload": {"text": text}})).await
        }
        "amend" => {
            let number = number(rest.first(), "amend N")?;
            only_flags(&rest[1..], &["--input"])?;
            let session = session()?;
            let payload = payload(rest, "{plan, reason}")?;
            post(json!({"action": "amend", "actor": "agent", "session": session, "number": number, "payload": payload})).await
        }
        "done" => {
            let number = number(rest.first(), "done N")?;
            only_flags(&rest[1..], &["--input"])?;
            let session = session()?;
            let payload = payload(rest, "{summary, commits?, followups?, result}")?;
            let files = evidence(payload.get("result"))?;
            post(json!({"action": "done", "actor": "agent", "session": session, "number": number,
                "payload": payload, "files": files,
                "ephemeral": std::env::var("ATELIER_PRESENTATION_EPHEMERAL").as_deref() == Ok("1")})).await
        }
        "check" => {
            let number = number(rest.first(), "check N ITEM")?;
            let item = rest
                .get(1)
                .filter(|word| !word.starts_with("--"))
                .ok_or("usage: atelier task check N ITEM: name the plan item's id (see `atelier task show N`)")?
                .clone();
            only_flags(&rest[2..], &["--input"])?;
            let session = session()?;
            // A task with checks takes no entry: the server runs the item's checks.
            let entry = optional_payload(rest, "the item's result entry (only for a task made before checks)")?;
            let files = evidence(entry.as_ref())?;
            post(json!({"action": "check", "actor": "agent", "session": session, "number": number,
                "payload": {"item": item, "entry": entry}, "files": files,
                "ephemeral": std::env::var("ATELIER_PRESENTATION_EPHEMERAL").as_deref() == Ok("1")})).await
        }
        "list" => {
            only_flags(rest, &["--all"])?;
            let session = session()?;
            let all = rest.iter().any(|word| word == "--all");
            let mut query = vec![("session", session)];
            if all {
                query.push(("all", "1".into()));
            }
            let value = get("/api/workbench/tasks", &query).await?;
            let tasks = value["tasks"].as_array().cloned().unwrap_or_default();
            if tasks.is_empty() {
                println!("{}", if all { "No tasks in this project." } else { "This session holds no tasks." });
            }
            for task in tasks {
                println!("{}", line(&task));
            }
            Ok(0)
        }
        "show" => {
            let number = number(rest.first(), "show N")?;
            only_flags(&rest[1..], &[])?;
            let session = session()?;
            let listed = get("/api/workbench/tasks", &[("session", session), ("all", "1".into())]).await?;
            let project = listed["projectId"].as_str().ok_or("Atelier named no project for this session")?;
            let value = get(&format!("/api/workbench/tasks/{}/{number}", urlencoding(project)), &[]).await?;
            println!("{}", line(&value["task"]));
            println!("{}", serde_json::to_string_pretty(&value["task"]).map_err(|e| e.to_string())?);
            let notes = value["task"]["notes"].as_array().cloned().unwrap_or_default();
            if !notes.is_empty() {
                println!("Notes:");
                for note in notes {
                    println!("  ({}) {}", note["actor"].as_str().unwrap_or(""), note["text"].as_str().unwrap_or(""));
                }
            }
            println!("History:");
            for event in value["events"].as_array().into_iter().flatten() {
                println!(
                    "  {} {} by {}{}",
                    event["seq"],
                    event["kind"].as_str().unwrap_or(""),
                    event["actor"].as_str().unwrap_or(""),
                    match &event["payload"] {
                        Value::Object(row) if !row.is_empty() => format!(" {}", event["payload"]),
                        _ => String::new(),
                    }
                );
            }
            Ok(0)
        }
        other => Err(format!("`{other}` is not a task command\n{USAGE}")),
    }
}

fn urlencoding(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}
