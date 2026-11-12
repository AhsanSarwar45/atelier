//! `atelier grid …`: the agent's side of coverage grids (docs/grids.md, "CLI").
//!
//! Like `atelier task`, every call names its chat with
//! `ATELIER_CHAT_SESSION_ID` and talks to the running app on `ATELIER_PORT`.
//! Mutating calls print the grid card as an `atelier-widget` block and a
//! one-line summary; errors exit non-zero and name the field that is wrong.

use crate::workbench::cli::server_url;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

pub const USAGE: &str = "\
usage: atelier grid <command>
  list [--rows]                   grids with % proved and open counts; --rows adds every owned row id
  show SLUG [ROW COL]             the matrix as text, or one cell with proof and history
  template list
  template set NAME               {columns:[{id,name,proof_rule}]} on stdin or --input FILE
  draft                           {slug,title,area,template?,row_search,columns,rows}; only when the owner's message says @matrix
  discover SLUG                   rerun the grid's row search now
  prove SLUG ROW COL              {summary,checks,tests?,commits?,benchmarks?,evidence?}
  verify SLUG [ROW COL]           re-run checks (whole grid: every proved cell)
  na SLUG ROW COL --reason TEXT   ask the owner to mark a cell N/A
  audit SLUG [--done]             proved cells to audit; --done prints the audit summary
  pass SLUG ROW COL [--note TEXT]
  reopen SLUG ROW COL --reason TEXT";

const PRESENTED: &str = "The card is shown in the chat. Do not paste this block into your reply.";

/// What `prove` may wait for: its checks run before the answer comes back.
const LONG: Duration = Duration::from_secs(3700);

fn session() -> Result<String, String> {
    std::env::var("ATELIER_CHAT_SESSION_ID")
        .ok()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            "ATELIER_CHAT_SESSION_ID is not set: `atelier grid` must run inside an Atelier chat \
             session, where the app sets it for the agent's shell"
                .to_string()
        })
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

const SWITCHES: &[&str] = &["--rows", "--done"];

/// The words that are not options, checking the options against `allowed`.
fn words<'a>(rest: &'a [String], allowed: &[&str]) -> Result<Vec<&'a str>, String> {
    let mut found = Vec::new();
    let mut items = rest.iter();
    while let Some(word) = items.next() {
        if word.starts_with("--") {
            if !allowed.contains(&word.as_str()) {
                return Err(format!(
                    "unknown option {word}{}",
                    if allowed.is_empty() { String::new() } else { format!(" (options: {})", allowed.join(", ")) }
                ));
            }
            if !SWITCHES.contains(&word.as_str()) {
                items.next();
            }
        } else {
            found.push(word.as_str());
        }
    }
    Ok(found)
}

/// Exactly these positional words.
fn exactly<'a>(rest: &'a [String], allowed: &[&str], names: &[&str], command: &str) -> Result<Vec<&'a str>, String> {
    let found = words(rest, allowed)?;
    if found.len() != names.len() {
        return Err(format!("usage: atelier grid {command} {}", names.join(" ")));
    }
    Ok(found)
}

fn payload(rest: &[String], shape: &str) -> Result<Value, String> {
    let text = match flag(rest, "--input")? {
        Some(file) => std::fs::read_to_string(&file).map_err(|error| format!("{file}: {error}"))?,
        None => {
            use std::io::{IsTerminal, Read};
            if std::io::stdin().is_terminal() {
                return Err(format!("this command takes {shape} as JSON on stdin or with --input FILE"));
            }
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).map_err(|error| format!("stdin: {error}"))?;
            text
        }
    };
    if text.trim().is_empty() {
        return Err(format!("the payload is empty: give {shape} as JSON on stdin or with --input FILE"));
    }
    serde_json::from_str(&text).map_err(|error| format!("the payload is not valid JSON ({error}); it is {shape}"))
}

/// The image and video files a proof's evidence names, read for upload.
fn evidence(payload: &Value) -> BTreeMap<String, String> {
    let mut named = Vec::new();
    if let Some(evidence) = payload.get("evidence") {
        crate::workbench::tasks::media_strings(evidence, &mut named);
    }
    let mut files = BTreeMap::new();
    for path in named {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        files.insert(path, base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    files
}

async fn send(body: Value) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .post(server_url("/api/workbench/grid"))
        .timeout(LONG)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("could not reach Atelier: {error}"))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|error| format!("invalid response from Atelier: {error}"))?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("Atelier refused the grid change").to_string());
    }
    Ok(value)
}

async fn post(body: Value) -> Result<i32, String> {
    let value = send(body).await?;
    let widget = value["widget"].as_str().unwrap_or_default();
    print!("{widget}");
    println!("{}", value["summary"].as_str().unwrap_or_default());
    if !widget.is_empty() {
        println!("{PRESENTED}");
    }
    Ok(if value["failed"].is_null() { 0 } else { 1 })
}

async fn get(path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .get(server_url(path))
        .query(query)
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

fn encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn listing(session: &str) -> Result<Value, String> {
    get("/api/workbench/grids", &[("session", session.to_string())]).await
}

async fn grid(session: &str, slug: &str) -> Result<(String, Value), String> {
    let listed = listing(session).await?;
    let project = listed["projectId"].as_str().ok_or("Atelier named no project for this session")?.to_string();
    let value = get(&format!("/api/workbench/grids/{}/{}", encode(&project), encode(slug)), &[]).await?;
    Ok((project, value))
}

fn mark(cell: &Value) -> char {
    match (cell["state"].as_str().unwrap_or(""), cell["stale"].as_bool().unwrap_or(false)) {
        ("proved", true) => 's',
        ("proved", false) => '✓',
        ("gap", _) => '✗',
        ("in_progress", _) => '~',
        ("na_pending", _) => '?',
        ("na", _) => '-',
        _ => '·',
    }
}

fn summary_line(grid: &Value) -> String {
    let counts = &grid["counts"];
    let percent = match grid["percent"].as_i64() {
        Some(p) => format!("{p:>3}%"),
        None => " -- ".into(),
    };
    let mut line = format!(
        "{:<20} {percent} {:<9} {}  (open: {} gap, {} stale, {} unchecked, {} in progress, {} N/A pending)",
        grid["slug"].as_str().unwrap_or(""),
        grid["status"].as_str().unwrap_or(""),
        grid["title"].as_str().unwrap_or(""),
        counts["gap"], counts["stale"], counts["unchecked"], counts["inProgress"], counts["naPending"],
    );
    if !grid["pending"].is_null() {
        line.push_str(" [draft awaiting the owner]");
    }
    if grid["discovery"]["ok"] == false {
        line.push_str(&format!(" [row search failed: {}]", grid["discovery"]["error"].as_str().unwrap_or("")));
    }
    line
}

/// The matrix: one line per row, one mark per live column, then the key
/// and the open cells with their reasons.
fn print_matrix(value: &Value) {
    let grid = &value["grid"];
    println!("{}", summary_line(grid));
    println!("{}", grid["area"].as_str().unwrap_or(""));
    let columns: Vec<&Value> =
        value["columns"].as_array().into_iter().flatten().filter(|c| c["retired"] != true).collect();
    let cells = value["cells"].as_array().cloned().unwrap_or_default();
    let cell = |row: &str, col: &str| cells.iter().find(|c| c["row"] == row && c["col"] == col);
    println!();
    for row in value["rows"].as_array().into_iter().flatten().filter(|r| r["removed"] != true) {
        let id = row["id"].as_str().unwrap_or("");
        let marks: String = columns
            .iter()
            .map(|col| cell(id, col["id"].as_str().unwrap_or("")).map(mark).unwrap_or(' '))
            .collect();
        let mut note = String::new();
        match row["kind"].as_str() {
            Some("combination") => note = format!(" (× {})", strings(&row["of"]).join(", ")),
            Some("reference") => {
                note = format!(" (→ {}.{})", row["ref"]["grid"].as_str().unwrap_or("?"), row["ref"]["row"].as_str().unwrap_or("?"))
            }
            _ => {}
        }
        if row["missing"] == true {
            note.push_str(" [missing from the search]");
        }
        println!("{marks}  {id}: {}{note}", row["name"].as_str().unwrap_or(""));
    }
    println!("\nColumns:");
    for (index, col) in columns.iter().enumerate() {
        println!(
            "  {:>2}. {}: {} — {}",
            index + 1,
            col["id"].as_str().unwrap_or(""),
            col["name"].as_str().unwrap_or(""),
            col["proofRule"].as_str().unwrap_or("")
        );
    }
    println!("Key: · unchecked  ✗ gap  ~ in progress  ✓ proved  s stale  ? N/A pending  - N/A");
    let open: Vec<&Value> = cells
        .iter()
        .filter(|c| c["ref"] != true)
        .filter(|c| matches!(mark(c), '✗' | 's' | '~' | '?') || (c["state"] == "gap"))
        .collect();
    if !open.is_empty() {
        println!("\nOpen cells:");
        for c in open {
            let mut line = format!(
                "  {}.{}.{} [{}]",
                grid["slug"].as_str().unwrap_or(""),
                c["row"].as_str().unwrap_or(""),
                c["col"].as_str().unwrap_or(""),
                if mark(c) == 's' { "stale".to_string() } else { c["state"].as_str().unwrap_or("").replace('_', " ") }
            );
            if let Some(reason) = c["reason"].as_str() {
                line.push_str(&format!(" {reason}"));
            }
            if let Some(task) = c["claimedTask"].as_i64() {
                line.push_str(&format!(" (#{task})"));
            }
            println!("{line}");
        }
    }
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn print_cell(slug: &str, value: &Value) {
    let cell = &value["cell"];
    println!(
        "{slug}.{}.{} — {} × {}: {}{}",
        cell["row"].as_str().unwrap_or(""),
        cell["col"].as_str().unwrap_or(""),
        value["row"]["name"].as_str().unwrap_or(""),
        value["column"]["name"].as_str().unwrap_or(""),
        cell["state"].as_str().unwrap_or("").replace('_', " "),
        if cell["stale"] == true { " (stale)" } else { "" }
    );
    println!("Proof rule: {}", value["column"]["proofRule"].as_str().unwrap_or(""));
    println!("Covers: {}", strings(&value["row"]["paths"]).join(", "));
    if let Some(reason) = cell["reason"].as_str() {
        println!("Reason: {reason}");
    }
    if let Some(task) = cell["claimedTask"].as_i64() {
        println!("Claimed by task #{task}");
    }
    if !cell["proof"].is_null() {
        println!("Proof (by {}):", cell["provedBy"].as_str().unwrap_or("?"));
        println!("{}", serde_json::to_string_pretty(&cell["proof"]).unwrap_or_default());
    }
    if !cell["lastCheck"].is_null() {
        println!("Last check: {}", serde_json::to_string_pretty(&cell["lastCheck"]).unwrap_or_default());
    }
    if let Some(at) = cell["auditedAt"].as_i64() {
        println!("Audited at {at} by {}", cell["auditedBy"].as_str().unwrap_or("?"));
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
}

fn cell_body(session: &str, action: &str, slug: &str, row: &str, col: &str, payload: Value) -> Value {
    json!({"action": action, "actor": "agent", "session": session, "slug": slug, "row": row, "col": col, "payload": payload})
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
        "list" => {
            words(rest, &["--rows"]).and_then(|w| if w.is_empty() { Ok(()) } else { Err(format!("usage: atelier grid list [--rows]")) })?;
            let session = session()?;
            let value = listing(&session).await?;
            let grids = value["grids"].as_array().cloned().unwrap_or_default();
            let live: Vec<&Value> = grids.iter().filter(|g| g["status"] != "discarded").collect();
            if live.is_empty() {
                println!("No grids in this project.");
            }
            let rows = rest.iter().any(|w| w == "--rows");
            for grid in live {
                println!("{}", summary_line(grid));
                if rows && grid["status"] == "approved" {
                    let slug = grid["slug"].as_str().unwrap_or("");
                    let project = value["projectId"].as_str().unwrap_or("");
                    let detail = get(&format!("/api/workbench/grids/{}/{}", encode(project), encode(slug)), &[]).await?;
                    let owned: Vec<String> = detail["rows"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|r| r["kind"] != "reference" && r["removed"] != true)
                        .filter_map(|r| r["id"].as_str().map(str::to_string))
                        .collect();
                    println!("    owns: {}", owned.join(", "));
                }
            }
            Ok(0)
        }
        "show" => {
            let found = words(rest, &[])?;
            let session = session()?;
            match found.as_slice() {
                [slug] => {
                    let (_, value) = grid(&session, slug).await?;
                    print_matrix(&value);
                }
                [slug, row, col] => {
                    let listed = listing(&session).await?;
                    let project = listed["projectId"].as_str().ok_or("Atelier named no project for this session")?;
                    let value = get(
                        &format!("/api/workbench/grids/{}/{}/cells/{}/{}", encode(project), encode(slug), encode(row), encode(col)),
                        &[],
                    )
                    .await?;
                    print_cell(slug, &value);
                }
                _ => return Err("usage: atelier grid show SLUG [ROW COL]".into()),
            }
            Ok(0)
        }
        "template" => match rest.first().map(String::as_str) {
            Some("list") => {
                words(&rest[1..], &[])?;
                let session = session()?;
                let value = listing(&session).await?;
                let templates = value["templates"].as_array().cloned().unwrap_or_default();
                if templates.is_empty() {
                    println!("No templates in this project. Propose one with `atelier grid template set NAME`.");
                }
                for template in templates {
                    println!("{}{}", template["name"].as_str().unwrap_or(""), if template["pending"].is_null() { "" } else { " [change awaiting the owner]" });
                    for column in template["columns"].as_array().into_iter().flatten() {
                        println!(
                            "  {}: {} — {}",
                            column["id"].as_str().unwrap_or(""),
                            column["name"].as_str().unwrap_or(""),
                            column["proofRule"].as_str().unwrap_or("")
                        );
                    }
                }
                Ok(0)
            }
            Some("set") => {
                let found = exactly(&rest[1..], &["--input"], &["NAME"], "template set")?;
                let session = session()?;
                let payload = payload(rest, "{columns: [{id, name, proof_rule}]}")?;
                post(json!({"action": "template_set", "actor": "agent", "session": session, "slug": found[0], "payload": payload})).await
            }
            _ => Err("usage: atelier grid template list | template set NAME".into()),
        },
        "draft" => {
            exactly(rest, &["--input"], &[], "draft")?;
            let session = session()?;
            let payload = payload(rest, "{slug, title, area, template?, row_search, columns, rows}")?;
            post(json!({"action": "draft", "actor": "agent", "session": session, "payload": payload})).await
        }
        "discover" => {
            let found = exactly(rest, &[], &["SLUG"], "discover")?;
            let session = session()?;
            post(json!({"action": "discover", "actor": "agent", "session": session, "slug": found[0]})).await
        }
        "prove" => {
            let found = exactly(rest, &["--input"], &["SLUG", "ROW", "COL"], "prove")?;
            let session = session()?;
            let payload = payload(rest, "{summary, checks, tests?, commits?, benchmarks?, evidence?}")?;
            let files = evidence(&payload);
            let mut body = cell_body(&session, "prove", found[0], found[1], found[2], payload);
            body["files"] = json!(files);
            body["ephemeral"] = json!(std::env::var("ATELIER_PRESENTATION_EPHEMERAL").as_deref() == Ok("1"));
            post(body).await
        }
        "verify" => {
            let found = words(rest, &[])?;
            let session = session()?;
            match found.as_slice() {
                [slug] => post(json!({"action": "verify", "actor": "agent", "session": session, "slug": slug})).await,
                [slug, row, col] => post(cell_body(&session, "verify", slug, row, col, json!({}))).await,
                _ => Err("usage: atelier grid verify SLUG [ROW COL]".into()),
            }
        }
        "na" => {
            let found = exactly(rest, &["--reason"], &["SLUG", "ROW", "COL"], "na")?;
            let reason = flag(rest, "--reason")?.ok_or("--reason TEXT is required: why this requirement does not apply")?;
            let session = session()?;
            post(cell_body(&session, "na", found[0], found[1], found[2], json!({"reason": reason}))).await
        }
        "pass" => {
            let found = exactly(rest, &["--note"], &["SLUG", "ROW", "COL"], "pass")?;
            let note = flag(rest, "--note")?.unwrap_or_default();
            let session = session()?;
            post(cell_body(&session, "pass", found[0], found[1], found[2], json!({"note": note}))).await
        }
        "reopen" => {
            let found = exactly(rest, &["--reason"], &["SLUG", "ROW", "COL"], "reopen")?;
            let reason = flag(rest, "--reason")?.ok_or("--reason TEXT is required: what is missing")?;
            let session = session()?;
            post(cell_body(&session, "reopen", found[0], found[1], found[2], json!({"reason": reason}))).await
        }
        "audit" => {
            let found = exactly(rest, &["--done"], &["SLUG"], "audit")?;
            let session = session()?;
            if rest.iter().any(|w| w == "--done") {
                return post(json!({"action": "audit_done", "actor": "agent", "session": session, "slug": found[0]})).await;
            }
            let (project, value) = grid(&session, found[0]).await?;
            let slug = found[0];
            let mut proved: Vec<&Value> = value["cells"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["state"] == "proved" && c["ref"] != true)
                .collect();
            proved.sort_by_key(|c| c["stale"] == true);
            if proved.is_empty() {
                println!("Grid \"{slug}\" has no proved cells to audit.");
            }
            println!("Audit of \"{slug}\": {} proved cell(s), fresh first.\n", proved.len());
            for c in proved {
                let (row, col) = (c["row"].as_str().unwrap_or(""), c["col"].as_str().unwrap_or(""));
                let detail = get(
                    &format!("/api/workbench/grids/{}/{}/cells/{}/{}", encode(&project), encode(slug), encode(row), encode(col)),
                    &[],
                )
                .await?;
                let cell = &detail["cell"];
                println!(
                    "== {slug}.{row}.{col}{}{}",
                    if cell["stale"] == true { " (stale: re-check before passing)" } else { "" },
                    if cell["auditedAt"].is_null() { "" } else { " (audited before)" }
                );
                println!("Proof rule: {}", detail["column"]["proofRule"].as_str().unwrap_or(""));
                println!("Covers: {}", strings(&detail["row"]["paths"]).join(", "));
                println!("Proved by: {}", cell["provedBy"].as_str().unwrap_or("?"));
                println!("Proof: {}", serde_json::to_string_pretty(&cell["proof"]).unwrap_or_default());
                println!("Last check: {}\n", serde_json::to_string(&cell["lastCheck"]).unwrap_or_default());
            }
            println!("Give a verdict on each: `atelier grid pass {slug} ROW COL` or `atelier grid reopen {slug} ROW COL --reason TEXT`, then `atelier grid audit {slug} --done`.");
            Ok(0)
        }
        other => Err(format!("`{other}` is not a grid command\n{USAGE}")),
    }
}
