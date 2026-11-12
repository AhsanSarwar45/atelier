//! A grid's row search (docs/grids.md, "Row search"): the saved command that
//! lists the area's features, run in a checkout, and its output checked.
//!
//! A run that fails in any way yields an error and no rows, so applying it
//! changes nothing but the error stored in `grid.discovery`.

use super::proof::{run_shell, tail};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

pub const TIMEOUT_S: u64 = 120;
pub const TIMEOUT_MAX_S: u64 = 600;
pub const STDOUT_CAP: usize = 1024 * 1024;

/// One row the search printed.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub id: String,
    pub name: String,
    pub paths: Vec<String>,
    /// `feature` or `combination`.
    pub kind: String,
    pub of: Vec<String>,
}

impl Found {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "kind": self.kind, "paths": self.paths, "of": self.of,
            "ref": Value::Null, "source": "search"})
    }
}

/// A search's rows, with the commit the checkout was at.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub rows: Vec<Found>,
    pub head: Option<String>,
}

/// The saved search, checked: `{command, watch[], timeout_s?}`.
pub fn check_row_search(value: &Value) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or("row_search is required and is an object: {command, watch[], timeout_s?}")?;
    if let Some(unknown) = object.keys().find(|key| !["command", "watch", "timeout_s"].contains(&key.as_str())) {
        return Err(format!("row_search.{unknown} is not a row_search field (allowed: command, watch, timeout_s)"));
    }
    let command = match object.get("command") {
        Some(Value::String(command)) if !command.trim().is_empty() => command.trim().to_string(),
        _ => return Err("row_search.command is required: a shell command, run in the checkout, that prints one JSON row per line".into()),
    };
    if command.chars().count() > 2000 {
        return Err("row_search.command is longer than 2000 characters; put it in a committed script".into());
    }
    let watch: Vec<String> = match object.get("watch") {
        Some(Value::Array(items)) if !items.is_empty() => items
            .iter()
            .enumerate()
            .map(|(index, item)| match item.as_str().map(str::trim) {
                Some(path) if super::repo_relative(path) => Ok(path.to_string()),
                _ => Err(format!("row_search.watch[{index}] must be a repo-relative path prefix, like \"renderer/camera/\"")),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err("row_search.watch is required and must not be empty: the repo-relative path prefixes that make up the area".into()),
    };
    let mut checked = json!({"command": command, "watch": watch});
    match object.get("timeout_s") {
        None | Some(Value::Null) => {}
        Some(value) => match value.as_u64() {
            Some(seconds) if (1..=TIMEOUT_MAX_S).contains(&seconds) => checked["timeout_s"] = json!(seconds),
            _ => return Err(format!("row_search.timeout_s must be a whole number of seconds from 1 to {TIMEOUT_MAX_S}")),
        },
    }
    Ok(checked)
}

/// Read the search's output: one JSON object per line.
pub fn parse(stdout: &str) -> Result<Vec<Found>, String> {
    let mut rows: Vec<Found> = Vec::new();
    let mut seen = HashSet::new();
    for (index, line) in stdout.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let at = format!("line {}", index + 1);
        let value: Value = serde_json::from_str(line).map_err(|error| format!("{at} is not valid JSON ({error}): {line}"))?;
        let object = value.as_object().ok_or_else(|| format!("{at} is not a JSON object: {line}"))?;
        if let Some(unknown) = object.keys().find(|key| !["id", "name", "paths", "kind", "of"].contains(&key.as_str())) {
            return Err(format!("{at}: {unknown} is not a row field (allowed: id, name, paths, kind, of)"));
        }
        let id = object.get("id").and_then(Value::as_str).unwrap_or("");
        if !super::valid_id(id) {
            return Err(format!("{at}: id \"{id}\" is not a valid id ({})", super::ID_RULE));
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("{at}: id \"{id}\" is printed twice"));
        }
        let name = object.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if name.is_empty() || name.chars().count() > 120 {
            return Err(format!("{at}: row \"{id}\" needs a name of 1 to 120 characters"));
        }
        let paths = match object.get("paths") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item.as_str().map(str::trim) {
                    Some(path) if super::repo_relative(path) => Ok(path.to_string()),
                    _ => Err(format!("{at}: row \"{id}\" has a path that is not repo-relative: {item}")),
                })
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(format!("{at}: row \"{id}\" paths must be a list")),
        };
        let kind = match object.get("kind").and_then(Value::as_str) {
            None => "feature",
            Some("feature") => "feature",
            Some("combination") => "combination",
            Some(other) => return Err(format!("{at}: row \"{id}\" kind \"{other}\" is not feature or combination")),
        };
        let of: Vec<String> = match object.get("of") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items.iter().map(|item| item.as_str().unwrap_or("").to_string()).collect(),
            Some(_) => return Err(format!("{at}: row \"{id}\" of must be a list of row ids")),
        };
        if kind == "combination" && of.len() < 2 {
            return Err(format!("{at}: combination \"{id}\" needs of with at least two row ids"));
        }
        if kind == "feature" && !of.is_empty() {
            return Err(format!("{at}: row \"{id}\" has of but is not a combination"));
        }
        rows.push(Found { id: id.to_string(), name: name.to_string(), paths, kind: kind.to_string(), of });
    }
    let ids: HashSet<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    for row in &rows {
        if let Some(other) = row.of.iter().find(|other| !ids.contains(other.as_str()) || *other == &row.id) {
            return Err(format!("combination \"{}\" names \"{other}\" in of, which is not another row this run prints", row.id));
        }
    }
    Ok(rows)
}

/// Run the saved search in `folder`.
pub async fn run(folder: &Path, row_search: &Value) -> Result<Run, String> {
    let command = row_search["command"].as_str().ok_or("the grid has no row search command")?;
    let timeout = row_search["timeout_s"].as_u64().unwrap_or(TIMEOUT_S).clamp(1, TIMEOUT_MAX_S);
    if !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    let head = super::proof::head(folder).await;
    let ran = run_shell(folder, command, Duration::from_secs(timeout), false, STDOUT_CAP, false)
        .await
        .map_err(|error| format!("the row search could not start: {error}"))?;
    if ran.timed_out {
        return Err(format!("the row search timed out after {timeout} s"));
    }
    if ran.stdout_cut {
        return Err("the row search printed more than 1 MiB".into());
    }
    if ran.code != Some(0) {
        let said = tail(&ran.stderr, 20);
        return Err(format!(
            "the row search exited {}{}",
            ran.code.map_or("by a signal".to_string(), |code| code.to_string()),
            if said.is_empty() { String::new() } else { format!(": {said}") }
        ));
    }
    let rows = parse(&String::from_utf8_lossy(&ran.stdout))?;
    Ok(Run { rows, head })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_output_is_one_valid_row_per_line() {
        let rows = parse(
            "{\"id\":\"glare\",\"name\":\"Glare\",\"paths\":[\"camera/glare.rs\"]}\n\n\
             {\"id\":\"exposure\",\"name\":\"Exposure\",\"paths\":[\"camera/exposure.rs\"]}\n\
             {\"id\":\"glare_x_exposure\",\"name\":\"Glare × exposure\",\"kind\":\"combination\",\"of\":[\"glare\",\"exposure\"]}\n",
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[2].kind.as_str(), rows[2].of.len()), ("combination", 2));
        assert!(parse("{\"id\":\"Glare\",\"name\":\"x\"}").unwrap_err().contains("not a valid id"));
        assert!(parse("{\"id\":\"a.b\",\"name\":\"x\"}").unwrap_err().contains("not a valid id"));
        assert!(parse("{\"id\":\"a\",\"name\":\"x\"}\n{\"id\":\"a\",\"name\":\"y\"}").unwrap_err().contains("printed twice"));
        assert!(parse("not json").unwrap_err().contains("not valid JSON"));
        assert!(parse("{\"id\":\"c\",\"name\":\"x\",\"kind\":\"combination\",\"of\":[\"a\",\"b\"]}").unwrap_err().contains("not another row"));
        assert!(parse("{\"id\":\"a\",\"name\":\"x\",\"paths\":[\"/etc\"]}").unwrap_err().contains("repo-relative"));
    }

    #[test]
    fn a_saved_search_needs_a_command_and_what_it_watches() {
        assert!(check_row_search(&json!({"command": "x"})).unwrap_err().contains("watch is required"));
        assert!(check_row_search(&json!({"command": "x", "watch": []})).unwrap_err().contains("must not be empty"));
        assert!(check_row_search(&json!({"command": "x", "watch": ["a/"], "timeout_s": 601})).unwrap_err().contains("timeout_s"));
        assert_eq!(
            check_row_search(&json!({"command": " x ", "watch": ["a/"], "timeout_s": 30})).unwrap(),
            json!({"command": "x", "watch": ["a/"], "timeout_s": 30})
        );
    }

    #[tokio::test]
    async fn a_search_that_fails_says_why() {
        let folder = tempfile::tempdir().unwrap();
        let search = |command: &str| json!({"command": command, "watch": ["a/"], "timeout_s": 1});
        assert!(run(folder.path(), &search("echo nope >&2; exit 2")).await.unwrap_err().contains("exited 2: nope"));
        assert!(run(folder.path(), &search("sleep 5")).await.unwrap_err().contains("timed out"));
        let ok = run(folder.path(), &search("echo '{\"id\":\"a\",\"name\":\"A\"}'")).await.unwrap();
        assert_eq!(ok.rows[0].id, "a");
    }
}
