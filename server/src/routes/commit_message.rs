//! A commit message written from what is staged, and the setting for which
//! agent writes it.
//!
//! One short run of the provider's own command line with no tools at all: the
//! staged diff goes in on stdin and the message comes back as text. Nothing is
//! committed here — the panel puts the answer in the message box, where it can
//! be read and changed before anything is saved.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::db::Database;
use crate::routes::git::{checked_repo, run_git, spoke_or_refused, GitJson, Refused};
use crate::routes::projects::AppState;

type Refusal = (StatusCode, String);

const PROVIDER: &str = "workbench.commit-message.provider";
const PROFILE: &str = "workbench.commit-message.profile";
const MODEL: &str = "workbench.commit-message.model";
const EFFORT: &str = "workbench.commit-message.effort";

/// The agents that can be run once from the command line with no chat.
const BRANDS: &[&str] = &["claude", "codex"];

/// How much of the diff the agent is shown. A commit larger than this is
/// summarised from its file list and the first part of its changes.
const MOST_DIFF_BYTES: usize = 60_000;

/// How long one message may take before the run is stopped.
const TIME_LIMIT: Duration = Duration::from_secs(120);

/// Which agent writes commit messages. Every field unset means the first
/// installed agent with its own defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessageSettings {
    pub provider: Option<String>,
    pub profile: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choosing {
    provider: Option<String>,
    profile: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

pub fn commit_message_settings(db: &AppState) -> Result<CommitMessageSettings, String> {
    let read = |key: &str| db.setting(key).map_err(|why| why.to_string());
    Ok(CommitMessageSettings {
        provider: read(PROVIDER)?,
        profile: read(PROFILE)?,
        model: read(MODEL)?,
        effort: read(EFFORT)?,
    })
}

async fn read(State(db): State<AppState>) -> Result<Json<CommitMessageSettings>, Refusal> {
    commit_message_settings(&db)
        .map(Json)
        .map_err(|why| unreadable("The commit message settings could not be read", why))
}

async fn write(
    State(db): State<AppState>,
    Json(asked): Json<Choosing>,
) -> Result<Json<CommitMessageSettings>, Refusal> {
    let provider = trimmed(asked.provider.as_deref());
    if let Some(named) = provider {
        if !BRANDS.contains(&named) {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Commit messages cannot be generated with {named}."),
            ));
        }
    }
    for (key, value) in [
        (PROVIDER, provider),
        (PROFILE, trimmed(asked.profile.as_deref())),
        (MODEL, trimmed(asked.model.as_deref())),
        (EFFORT, trimmed(asked.effort.as_deref())),
    ] {
        db.set_setting(key, value)
            .map_err(|why| unreadable("The commit message settings could not be saved", why))?;
    }
    read(State(db)).await
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn unreadable(what: &str, why: impl std::fmt::Display) -> Refusal {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {why}"))
}

/// `GET`/`PUT /api/settings/commit-message`, from this computer only.
pub fn commit_message_settings_routes() -> Router<AppState> {
    Router::new()
        .route("/settings/commit-message", get(read).put(write))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

/// Request body for writing a message.
#[derive(Deserialize)]
pub struct GenerateRequest {
    /// Absolute working directory of the repository.
    pub path: String,
}

/// Cut `text` to at most `most` bytes without splitting a character.
fn cut_to(text: &str, most: usize) -> &str {
    if text.len() <= most {
        return text;
    }
    let mut end = most;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// What the agent is asked, with the staged changes under it.
fn prompt_for(files: &str, recent: &str, diff: &str) -> String {
    let shown = cut_to(diff, MOST_DIFF_BYTES);
    let cut = if shown.len() < diff.len() {
        "\n[The diff is cut short here. The file list above is complete.]\n"
    } else {
        ""
    };
    let recent = if recent.trim().is_empty() {
        String::new()
    } else {
        format!("Recent commit subjects in this repository, for style:\n{recent}\n\n")
    };
    format!(
        "Write a Git commit message for the staged changes below.\n\
         Rules:\n\
         - First line: a summary of at most 72 characters, in the imperative mood, with no period at the end.\n\
         - Follow the style of the recent commit subjects when there are any.\n\
         - Add a blank line and a short body only when the change needs explaining.\n\
         - Output the commit message and nothing else: no preamble, no quotes, no code fence.\n\
         - Do not use any tools. Everything you need is below.\n\n\
         {recent}Staged files:\n{files}\n\nStaged diff:\n{shown}{cut}"
    )
}

/// The message out of what the agent printed: no code fence, no quotes round
/// the whole of it, no trailing space.
fn message_from(said: &str) -> String {
    let mut text = said.trim();
    if let Some(inside) = text.strip_prefix("```") {
        let inside = inside.strip_suffix("```").unwrap_or(inside);
        // The fence may name a language on its own first line.
        text = match inside.split_once('\n') {
            Some((first, rest)) if !first.trim().contains(' ') && first.trim().len() < 12 => rest,
            _ => inside,
        }
        .trim();
    }
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Write a commit message for what is staged.
///
/// # Endpoint
///
/// `POST /api/git/commit-message` — `{ path }` → `{ message }`
pub async fn generate(
    Extension(db): Extension<Arc<Database>>,
    GitJson(body): GitJson<GenerateRequest>,
) -> Result<Response, Refused> {
    let repo = checked_repo(&body.path)?;

    let files = spoke_or_refused(
        run_git(&repo, &["diff", "--cached", "--no-color", "--stat=200"]).await?,
    )?;
    let files = String::from_utf8_lossy(&files.stdout).into_owned();
    if files.trim().is_empty() {
        return Err(Refused::new(StatusCode::CONFLICT, "Stage changes first."));
    }
    let diff = spoke_or_refused(
        run_git(&repo, &["diff", "--cached", "--no-color", "--no-ext-diff"]).await?,
    )?;
    let diff = String::from_utf8_lossy(&diff.stdout).into_owned();
    // A repository with nothing committed has no log, and that is no failure.
    let recent = match run_git(&repo, &["log", "-8", "--format=%s"]).await {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => String::new(),
    };

    let settings = commit_message_settings(&db)
        .map_err(|why| Refused::new(StatusCode::INTERNAL_SERVER_ERROR, why))?;
    let message = ask_agent(&settings, &prompt_for(&files, &recent, &diff)).await?;
    Ok(Json(serde_json::json!({ "message": message })).into_response())
}

/// Run the chosen agent once on `prompt` and hand back what it wrote.
async fn ask_agent(settings: &CommitMessageSettings, prompt: &str) -> Result<String, Refused> {
    let unavailable = |said: String| Refused::new(StatusCode::UNPROCESSABLE_ENTITY, said);
    let brand = match settings.provider.as_deref() {
        Some(brand) if BRANDS.contains(&brand) => brand.to_string(),
        Some(_) => {
            return Err(unavailable(
                "Commit messages are generated with Claude or Codex. Choose one in Settings."
                    .into(),
            ))
        }
        None => BRANDS
            .iter()
            .find(|brand| crate::routes::find_tool(brand, &[]).is_some())
            .ok_or_else(|| unavailable("Neither Claude nor Codex is installed.".into()))?
            .to_string(),
    };
    let Some(program) = crate::routes::find_tool(&brand, &[]) else {
        return Err(unavailable(format!("{brand} is not installed.")));
    };
    let system = crate::workbench::profiles::system_dir(&brand).unwrap_or_default();
    let home = crate::workbench::profiles::chat_dir(&brand, settings.profile.as_deref(), &system);

    // Run somewhere empty, so the agent reads no project instructions and
    // could touch nothing even if it tried to.
    let scratch: PathBuf =
        std::env::temp_dir().join(format!("atelier-commit-message-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch)
        .map_err(|why| Refused::new(StatusCode::INTERNAL_SERVER_ERROR, why.to_string()))?;
    let answer_file = scratch.join("answer.txt");

    let mut command = Command::new(program);
    command
        .current_dir(&scratch)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(variable) = crate::workbench::profiles::variable(&brand) {
        if !home.as_os_str().is_empty() {
            command.env(variable, &home);
        }
    }
    if brand == "claude" {
        // No tool of any kind, no MCP server, and no record of the run, so it
        // is never listed as a chat. The prompt is read from stdin: a diff is
        // far longer than one argument is allowed to be.
        command.args([
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--no-session-persistence",
        ]);
        if let Some(model) = &settings.model {
            command.args(["--model", model]);
        }
        if let Some(effort) = &settings.effort {
            command.args(["--effort", effort]);
        }
    } else {
        command
            .args([
                "exec",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "-o",
            ])
            .arg(&answer_file);
        if let Some(model) = &settings.model {
            command.args(["-m", model]);
        }
        if let Some(effort) = &settings.effort {
            command
                .arg("-c")
                .arg(format!("model_reasoning_effort=\"{effort}\""));
        }
        // `-` reads the prompt from stdin.
        command.arg("-");
    }

    let ran = run_to_the_end(command, prompt).await;
    let written = std::fs::read_to_string(&answer_file).ok();
    let _ = std::fs::remove_dir_all(&scratch);
    let output = ran?;

    let failed = |output: &std::process::Output| {
        let said = String::from_utf8_lossy(&output.stderr);
        let said = said.trim();
        Refused::new(
            StatusCode::BAD_GATEWAY,
            if said.is_empty() {
                format!("{brand} could not write a message.")
            } else {
                cut_to(said, 2_000).to_string()
            },
        )
    };

    let said = if brand == "claude" {
        let envelope: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|_| failed(&output))?;
        if envelope["is_error"] == true || !output.status.success() {
            return Err(match envelope["result"].as_str() {
                Some(why) if !why.trim().is_empty() => {
                    Refused::new(StatusCode::BAD_GATEWAY, cut_to(why.trim(), 2_000))
                }
                _ => failed(&output),
            });
        }
        envelope["result"].as_str().unwrap_or_default().to_string()
    } else {
        if !output.status.success() {
            return Err(failed(&output));
        }
        written.unwrap_or_default()
    };

    let message = message_from(&said);
    if message.is_empty() {
        return Err(Refused::new(
            StatusCode::BAD_GATEWAY,
            format!("{brand} returned an empty message."),
        ));
    }
    Ok(message)
}

/// Start the command, hand it the prompt, and wait for it — but not for ever.
async fn run_to_the_end(mut command: Command, prompt: &str) -> Result<std::process::Output, Refused> {
    let broke = |why: std::io::Error| {
        Refused::new(StatusCode::INTERNAL_SERVER_ERROR, format!("The agent could not be run: {why}"))
    };
    let mut child = command.spawn().map_err(broke)?;
    if let Some(mut stdin) = child.stdin.take() {
        // An agent that exits before reading everything closes the pipe, and
        // what it printed on the way out is the thing worth reporting.
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    // Dropping the wait on the deadline drops the child, and `kill_on_drop`
    // stops it.
    match tokio::time::timeout(TIME_LIMIT, child.wait_with_output()).await {
        Ok(output) => output.map_err(broke),
        Err(_) => Err(Refused::new(
            StatusCode::GATEWAY_TIMEOUT,
            "Generating the message took too long.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fenced_answer_loses_its_fence() {
        assert_eq!(message_from("```\nFix the thing\n\nBody.\n```"), "Fix the thing\n\nBody.");
        assert_eq!(message_from("```text\nFix the thing\n```"), "Fix the thing");
    }

    #[test]
    fn a_plain_answer_is_kept_as_written() {
        assert_eq!(message_from("  Add remote button  \n\nWhy it matters.  \n"), "Add remote button\n\nWhy it matters.");
    }

    #[test]
    fn a_long_diff_is_cut_and_says_so() {
        let diff = "é".repeat(MOST_DIFF_BYTES);
        let prompt = prompt_for(" a.txt | 1 +\n", "", &diff);
        assert!(prompt.contains("The diff is cut short here"));
        assert!(prompt.len() < diff.len());
    }

    #[test]
    fn a_short_diff_is_sent_whole() {
        let prompt = prompt_for(" a.txt | 1 +\n", "Add the panel\n", "+hello\n");
        assert!(prompt.contains("+hello"));
        assert!(prompt.contains("Add the panel"));
        assert!(!prompt.contains("cut short"));
    }
}
