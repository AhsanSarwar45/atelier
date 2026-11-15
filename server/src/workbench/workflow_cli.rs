//! `atelier workflow …`: how a workflow run's agent sees the workflow and
//! reports its stage (docs/designs/workflows.md, "Reporting a stage").
//!
//! Like `atelier task`, every call names its chat with
//! `ATELIER_CHAT_SESSION_ID` and talks to the running app on `ATELIER_PORT`.

use crate::workbench::cli::server_url;
use serde_json::{json, Value};

pub const USAGE: &str = "\
usage: atelier workflow <command>
  show                         the workflow this chat runs: every stage, where each outcome leads, and the current stage
  done OUTCOME                 finish the current stage with one of its outcomes; the run moves on when your reply ends
  block --needs TEXT           stop for the owner, saying what you need";

fn session() -> Result<String, String> {
    std::env::var("ATELIER_CHAT_SESSION_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            "ATELIER_CHAT_SESSION_ID is not set: `atelier workflow` must run inside the chat of a workflow run".to_string()
        })
}

async fn send(body: Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(server_url("/api/workbench/workflow-run"))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("could not reach Atelier: {error}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|error| format!("invalid response from Atelier: {error}"))?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("Atelier refused the request").to_string());
    }
    Ok(value)
}

/// The workflow as `show` prints it: one line per stage, the current one marked.
fn listing(shown: &Value) -> String {
    let current = shown["current"].as_str().unwrap_or_default();
    let mut out = format!("Workflow \"{}\"\n", shown["workflow"].as_str().unwrap_or_default());
    for (at, stage) in shown["stages"].as_array().into_iter().flatten().enumerate() {
        let id = stage["id"].as_str().unwrap_or_default();
        let mark = if id == current { "→" } else { " " };
        out.push_str(&format!(
            "{mark} {}. {} ({id}, {})\n",
            at + 1,
            stage["name"].as_str().unwrap_or(id),
            stage["kind"].as_str().unwrap_or_default()
        ));
        for route in stage["routes"].as_array().into_iter().flatten() {
            out.push_str(&format!(
                "      {} → {}\n",
                route["outcome"].as_str().unwrap_or_default(),
                route["to"].as_str().unwrap_or_default()
            ));
        }
    }
    let outcomes: Vec<&str> = shown["outcomes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    out.push_str(&format!("This stage finishes with: atelier workflow done <{}>", outcomes.join("|")));
    out
}

pub async fn run(rest: &[String]) -> Result<i32, String> {
    let command = rest.first().map(String::as_str);
    let body = match command {
        Some("show") => json!({"action": "show", "session": session()?}),
        Some("done") => {
            let outcome = rest[1..].join(" ");
            if outcome.trim().is_empty() {
                return Err("usage: atelier workflow done OUTCOME".into());
            }
            json!({"action": "done", "session": session()?, "outcome": outcome})
        }
        Some("block") => {
            let needs = match rest.get(1).map(String::as_str) {
                Some("--needs") => rest[2..].join(" "),
                _ => String::new(),
            };
            if needs.trim().is_empty() {
                return Err("usage: atelier workflow block --needs TEXT".into());
            }
            json!({"action": "block", "session": session()?, "needs": needs})
        }
        Some("help" | "--help" | "-h") | None => {
            println!("{USAGE}");
            return Ok(0);
        }
        Some(other) => return Err(format!("unknown command `{other}`\n{USAGE}")),
    };
    let answer = send(body).await?;
    if command == Some("show") {
        println!("{}", listing(&answer));
    } else {
        println!("{}", answer["summary"].as_str().unwrap_or_default());
    }
    Ok(0)
}
