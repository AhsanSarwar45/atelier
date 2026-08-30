//! Provider-neutral Beads provenance linking from tool actions.

use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct BdRunner {
    program: PathBuf,
    timeout: Duration,
}
impl Default for BdRunner {
    fn default() -> Self {
        Self {
            program: "bd".into(),
            timeout: Duration::from_secs(20),
        }
    }
}
impl BdRunner {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            ..Self::default()
        }
    }
    pub async fn run(&self, cwd: &Path, args: &[&str]) -> BdResult {
        let child = Command::new(&self.program)
            .args(args)
            .current_dir(cwd)
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(self.timeout, child).await {
            Ok(Ok(output)) => BdResult {
                ok: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Ok(Err(error)) => BdResult {
                ok: false,
                stdout: String::new(),
                stderr: error.to_string(),
            },
            Err(_) => BdResult {
                ok: false,
                stdout: String::new(),
                stderr: "bd timed out".into(),
            },
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct BdResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

fn valid_id(token: &str) -> bool {
    let stem = token.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '.');
    let Some((prefix, rest)) = stem.split_once('-') else {
        return false;
    };
    (2..=6).contains(&prefix.len())
        && prefix.starts_with(|ch: char| ch.is_ascii_lowercase())
        && prefix
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && rest.split('.').all(|part| {
            part.len() >= 1
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
        && rest.split('.').next().is_some_and(|part| part.len() >= 2)
}

fn ids_in(text: &str) -> Vec<String> {
    let mut found = BTreeSet::new();
    for token in text.split_whitespace() {
        let token =
            token.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '.');
        if valid_id(token) {
            found.insert(token.to_string());
        }
    }
    found.into_iter().collect()
}

pub fn candidates(tool: &str, input: &Value) -> Vec<String> {
    let mut found = BTreeSet::new();
    if tool == "Bash" {
        let command = input["command"].as_str().unwrap_or("");
        for segment in command.split([';', '&', '|', '\n', '(', ')']) {
            let words: Vec<_> = segment.split_whitespace().collect();
            let bd = words.iter().position(|word| *word == "bd");
            if let Some(at) = bd {
                for id in ids_in(&words[at + 1..].join(" ")) {
                    found.insert(id);
                }
            }
        }
    }
    if matches!(tool, "Edit" | "Write" | "NotebookEdit" | "MultiEdit") {
        if let Some(path) = input["file_path"].as_str() {
            for part in path.split('/') {
                let stem = part.rsplit_once('.').map_or(part, |(stem, _)| stem);
                if valid_id(stem) {
                    found.insert(stem.to_string());
                }
            }
        }
    }
    found.into_iter().collect()
}

pub async fn issue_exists(runner: &BdRunner, cwd: &Path, id: &str) -> Option<String> {
    let out = runner.run(cwd, &["show", id, "--json"]).await;
    let rows: Vec<Value> = serde_json::from_str(&out.stdout).ok()?;
    rows.into_iter()
        .find(|row| {
            row["id"]
                .as_str()
                .is_some_and(|found| found.eq_ignore_ascii_case(id))
        })
        .and_then(|row| row["title"].as_str().map(str::to_string))
}

pub async fn record_link(
    runner: &BdRunner,
    cwd: &Path,
    issue: &str,
    session: &str,
    source: &str,
) -> bool {
    runner
        .run(
            cwd,
            &[
                "provenance",
                "record",
                "--issue",
                issue,
                "--kind",
                "used",
                "--source",
                source,
                "--ref",
                session,
                "--ref-kind",
                "transcript",
            ],
        )
        .await
        .ok
}

pub async fn issues_for_session(runner: &BdRunner, cwd: &Path, session: &str) -> Vec<String> {
    let out = runner
        .run(cwd, &["provenance", "by-ref", session, "--json"])
        .await;
    let rows: Vec<Value> = serde_json::from_str(&out.stdout).unwrap_or_default();
    rows.into_iter()
        .filter(|row| row["ref_kind"] == "transcript")
        .filter_map(|row| row["issue_id"].as_str().map(str::to_string))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub async fn sessions_for_issue(runner: &BdRunner, cwd: &Path, issue: &str) -> Vec<String> {
    let out = runner
        .run(cwd, &["provenance", "log", issue, "--json"])
        .await;
    let rows: Vec<Value> = serde_json::from_str(&out.stdout).unwrap_or_default();
    rows.into_iter()
        .filter(|row| row["ref_kind"] == "transcript")
        .filter_map(|row| row["ref"].as_str().map(str::to_string))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub struct Linker {
    session: String,
    cwd: PathBuf,
    verdicts: HashMap<String, bool>,
    linked: HashSet<String>,
}
impl Linker {
    pub fn new(session: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            session: session.into(),
            cwd: cwd.into(),
            verdicts: HashMap::new(),
            linked: HashSet::new(),
        }
    }
    /// Confirm candidates serially, write idempotent board provenance, and
    /// return the same `link.bead` events the browser already understands.
    pub async fn observe(&mut self, runner: &BdRunner, tool: &str, input: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        for id in candidates(tool, input) {
            if self.linked.contains(&id) {
                continue;
            }
            let exists = if let Some(exists) = self.verdicts.get(&id) {
                *exists
            } else {
                let exists = issue_exists(runner, &self.cwd, &id).await.is_some();
                self.verdicts.insert(id.clone(), exists);
                exists
            };
            if !exists {
                continue;
            }
            if record_link(runner, &self.cwd, &id, &self.session, "workbench-tool").await {
                self.linked.insert(id.clone());
                events.push(json!({"type":"link.bead","beadId":id,"via":"tool"}));
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_workbench_services_metadata_links_only_actions_on_card_ids() {
        assert_eq!(
            candidates(
                "Bash",
                &json!({"command":"echo bw-nope; bd show bw-oesd.11 && bd close xx-a1"})
            ),
            ["bw-oesd.11", "xx-a1"]
        );
        assert_eq!(
            candidates("Write", &json!({"file_path":"/tmp/bw-oesd.11.md"})),
            ["bw-oesd.11"]
        );
        assert!(candidates("Read", &json!({"file_path":"/tmp/bw-oesd.11.md"})).is_empty());
        assert!(candidates("Write", &json!({"file_path":"/tmp/notes-bw-oesd.11.md"})).is_empty());
    }
}
