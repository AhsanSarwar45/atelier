//! Proof for a grid cell (docs/grids.md, "Proof" and "Covered code and
//! staleness"): checking what an agent hands in, running its checks, and the
//! fingerprint of the code a row covers.
//!
//! Everything here runs outside the database writer. The route runs the
//! checks and takes the fingerprints first, and hands the results to
//! `grids::apply`, which only decides.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};

/// How long a check may run when it does not say, and at most.
pub const CHECK_TIMEOUT_S: u64 = 600;
pub const CHECK_TIMEOUT_MAX_S: u64 = 3600;
/// How many lines of a failing check's output are kept and shown.
pub const TAIL_LINES: usize = 40;
const SUMMARY_MAX: usize = 600;

/// What one shell command did.
#[derive(Debug, Clone)]
pub struct ShellRun {
    /// The exit code; None when it was killed or ended by a signal.
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout: Vec<u8>,
    /// More was printed than was kept.
    pub stdout_cut: bool,
    pub stderr: Vec<u8>,
    pub ms: u64,
}

async fn read_capped(mut reader: impl AsyncRead + Unpin, cap: usize, keep_tail: bool) -> (Vec<u8>, bool) {
    let mut kept = Vec::new();
    let mut cut = false;
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if keep_tail {
                    kept.extend_from_slice(&chunk[..read]);
                    if kept.len() > cap {
                        let extra = kept.len() - cap;
                        kept.drain(..extra);
                        cut = true;
                    }
                } else if kept.len() < cap {
                    let room = cap - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                    cut |= read > room;
                } else {
                    cut = true;
                }
            }
        }
    }
    (kept, cut)
}

/// Run `command` with `sh -c` in `folder`, killing it (and whatever it
/// started) when it outlives `timeout`. With `merged`, stderr goes into
/// stdout, so a check's output reads in the order it was printed.
pub async fn run_shell(
    folder: &Path,
    command: &str,
    timeout: Duration,
    merged: bool,
    stdout_cap: usize,
    keep_tail: bool,
) -> std::io::Result<ShellRun> {
    let script = if merged { format!("exec 2>&1\n{command}") } else { command.to_string() };
    let mut process = tokio::process::Command::new("sh");
    process
        .arg("-c")
        .arg(script)
        .current_dir(folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);
    let started = Instant::now();
    let mut child = process.spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let reading_out = tokio::spawn(read_capped(stdout, stdout_cap, keep_tail));
    let reading_err = tokio::spawn(read_capped(stderr, 16 * 1024, true));
    let (code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => (status?.code(), false),
        Err(_) => {
            kill_group(&mut child);
            let _ = child.wait().await;
            (None, true)
        }
    };
    // Something the command left running in the background may hold the
    // pipes open; what was read by now is what there is.
    let grace = Duration::from_secs(5);
    let (stdout, stdout_cut) = match tokio::time::timeout(grace, reading_out).await {
        Ok(Ok(read)) => read,
        _ => (Vec::new(), false),
    };
    let (stderr, _) = match tokio::time::timeout(grace, reading_err).await {
        Ok(Ok(read)) => read,
        _ => (Vec::new(), false),
    };
    #[cfg(unix)]
    kill_group(&mut child);
    Ok(ShellRun { code, timed_out, stdout, stdout_cut, stderr, ms: started.elapsed().as_millis() as u64 })
}

fn kill_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The command was started as the leader of its own process group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

/// The last `lines` lines of some output, as text.
pub fn tail(bytes: &[u8], lines: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let all: Vec<&str> = text.trim_end().lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/* --------------------------------------------------------------- checks */

/// One check the proof names.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub name: String,
    pub command: String,
    pub timeout_s: u64,
}

/// What one check did, as stored in `last_check.results`.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckResult {
    pub name: String,
    /// The exit code; 124 when it timed out, -1 when it could not start or
    /// was ended by a signal.
    pub exit: i32,
    pub ms: u64,
    pub tail: String,
}

impl CheckResult {
    pub fn passed(&self) -> bool {
        self.exit == 0
    }

    pub fn to_json(&self) -> Value {
        json!({"name": self.name, "exit": self.exit, "ms": self.ms, "tail": self.tail})
    }
}

/// Run each check in turn in `folder`. Every check runs, so the stored
/// result says which ones fail, not only the first.
pub async fn run_checks(folder: &Path, checks: &[Check]) -> Vec<CheckResult> {
    let mut results = Vec::new();
    for check in checks {
        let run = run_shell(folder, &check.command, Duration::from_secs(check.timeout_s), true, 256 * 1024, true).await;
        results.push(match run {
            Ok(run) => {
                let mut tail = tail(&run.stdout, TAIL_LINES);
                if run.timed_out {
                    tail.push_str(&format!("\n(timed out after {} s)", check.timeout_s));
                }
                CheckResult {
                    name: check.name.clone(),
                    exit: if run.timed_out { 124 } else { run.code.unwrap_or(-1) },
                    ms: run.ms,
                    tail,
                }
            }
            Err(error) => CheckResult { name: check.name.clone(), exit: -1, ms: 0, tail: format!("could not start: {error}") },
        });
    }
    results
}

/* ---------------------------------------------------------------- proof */

fn text<'a>(object: &'a serde_json::Map<String, Value>, key: &str, at: &str, max: usize) -> Result<&'a str, String> {
    match object.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => {
            let count = value.trim().chars().count();
            if count > max {
                return Err(format!("{at}{key} is {count} characters; at most {max}"));
            }
            Ok(value.trim())
        }
        Some(Value::String(_)) => Err(format!("{at}{key} is blank")),
        None | Some(Value::Null) => Err(format!("{at}{key} is required")),
        Some(_) => Err(format!("{at}{key} must be text")),
    }
}

fn list<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Result<&'a [Value], String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(format!("{key} must be a list")),
    }
}

fn texts(object: &serde_json::Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    list(object, key)?
        .iter()
        .enumerate()
        .map(|(index, item)| match item.as_str().map(str::trim) {
            Some(value) if !value.is_empty() => Ok(value.to_string()),
            _ => Err(format!("{key}[{index}] must be non-blank text")),
        })
        .collect()
}

/// A proof, checked and with its defaults filled in.
#[derive(Debug, Clone)]
pub struct Proof {
    pub checks: Vec<Check>,
    pub commits: Vec<String>,
    /// The stored form (`grid_cell.proof`).
    pub value: Value,
}

/// Check a `prove` payload's shape: everything that does not need git or the
/// checks' results. Benchmarks are judged here, since they are numbers.
pub fn check_proof(payload: &Value) -> Result<Proof, String> {
    let object = payload
        .as_object()
        .ok_or("the prove payload must be an object: {summary, checks, tests?, commits?, benchmarks?, evidence?}")?;
    const FIELDS: &[&str] = &["summary", "checks", "tests", "commits", "benchmarks", "evidence"];
    if let Some(unknown) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return Err(format!("{unknown} is not a proof field (allowed: {})", FIELDS.join(", ")));
    }
    let summary = text(object, "summary", "", SUMMARY_MAX)?;
    let given = list(object, "checks")?;
    if given.is_empty() {
        return Err("checks is required: at least one {name, command, timeout_s?} that exits 0 when the requirement is met".into());
    }
    let mut checks = Vec::new();
    let mut stored_checks = Vec::new();
    for (index, item) in given.iter().enumerate() {
        let at = format!("checks[{index}].");
        let check = item.as_object().ok_or_else(|| format!("checks[{index}] must be an object: {{name, command, timeout_s?}}"))?;
        if let Some(unknown) = check.keys().find(|key| !["name", "command", "timeout_s"].contains(&key.as_str())) {
            return Err(format!("{at}{unknown} is not a check field (allowed: name, command, timeout_s)"));
        }
        let name = text(check, "name", &at, 120)?.to_string();
        let command = text(check, "command", &at, 4000)?.to_string();
        let timeout_s = match check.get("timeout_s") {
            None | Some(Value::Null) => CHECK_TIMEOUT_S,
            Some(value) => match value.as_u64() {
                Some(seconds) if (1..=CHECK_TIMEOUT_MAX_S).contains(&seconds) => seconds,
                _ => return Err(format!("{at}timeout_s must be a whole number of seconds from 1 to {CHECK_TIMEOUT_MAX_S}")),
            },
        };
        if checks.iter().any(|known: &Check| known.name == name) {
            return Err(format!("{at}name \"{name}\" is used twice; each check needs its own name"));
        }
        stored_checks.push(json!({"name": name, "command": command, "timeout_s": timeout_s}));
        checks.push(Check { name, command, timeout_s });
    }
    let tests = texts(object, "tests")?;
    let commits: Vec<String> = texts(object, "commits")?.into_iter().map(|sha| sha.to_ascii_lowercase()).collect();
    for (index, sha) in commits.iter().enumerate() {
        if !(7..=40).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("commits[{index}] \"{sha}\" is not a commit SHA (7 to 40 hex characters)"));
        }
    }
    let mut benchmarks = Vec::new();
    for (index, item) in list(object, "benchmarks")?.iter().enumerate() {
        let at = format!("benchmarks[{index}].");
        let bench = item
            .as_object()
            .ok_or_else(|| format!("benchmarks[{index}] must be an object: {{name, value, budget, unit?, lower_is_better?}}"))?;
        if let Some(unknown) = bench.keys().find(|key| !["name", "value", "budget", "unit", "lower_is_better"].contains(&key.as_str())) {
            return Err(format!("{at}{unknown} is not a benchmark field (allowed: name, value, budget, unit, lower_is_better)"));
        }
        let name = text(bench, "name", &at, 120)?;
        let number = |key: &str| {
            bench
                .get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .ok_or_else(|| format!("{at}{key} is required and is a number"))
        };
        let value = number("value")?;
        let budget = number("budget")?;
        let unit = match bench.get("unit") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(unit)) => unit.trim().to_string(),
            Some(_) => return Err(format!("{at}unit must be text")),
        };
        let lower = match bench.get("lower_is_better") {
            None | Some(Value::Null) => true,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Err(format!("{at}lower_is_better must be true or false")),
        };
        let met = if lower { value <= budget } else { value >= budget };
        if !met {
            return Err(format!(
                "benchmarks[{index}] \"{name}\" misses its budget: {value}{unit} is {} the budget of {budget}{unit}. \
                 Make it meet the budget, or don't claim it",
                if lower { "over" } else { "under" },
                unit = if unit.is_empty() { String::new() } else { format!(" {unit}") }
            ));
        }
        benchmarks.push(json!({"name": name, "value": value, "budget": budget, "unit": unit, "lower_is_better": lower}));
    }
    let evidence = texts(object, "evidence")?;
    let value = json!({
        "summary": summary,
        "checks": stored_checks,
        "tests": tests,
        "commits": commits,
        "benchmarks": benchmarks,
        "evidence": evidence,
    });
    Ok(Proof { checks, commits, value })
}

/// The checks of a stored proof, to run again.
pub fn stored_checks(proof: &Value) -> Vec<Check> {
    proof["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|check| {
            Some(Check {
                name: check["name"].as_str()?.to_string(),
                command: check["command"].as_str()?.to_string(),
                timeout_s: check["timeout_s"].as_u64().unwrap_or(CHECK_TIMEOUT_S).clamp(1, CHECK_TIMEOUT_MAX_S),
            })
        })
        .collect()
}

/* --------------------------------------------------------- fingerprints */

async fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = crate::routes::git_output(dir, args).await.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).to_string())
}

/// The commit `HEAD` names in `folder`, or None outside a repository or
/// before the first commit.
pub async fn head(folder: &Path) -> Option<String> {
    git(folder, &["rev-parse", "--verify", "HEAD^{commit}"]).await.map(|sha| sha.trim().to_string())
}

/// The top of the working tree `folder` is in.
pub async fn toplevel(folder: &Path) -> Option<PathBuf> {
    git(folder, &["rev-parse", "--show-toplevel"]).await.map(|path| PathBuf::from(path.trim()))
}

/// The paths as git pathspecs from the top of the tree, so a folder below it
/// reads the same files.
fn pathspecs(paths: &[String]) -> Vec<String> {
    paths.iter().map(|path| format!(":(top,literal){}", path.trim_end_matches('/'))).collect()
}

/// Fingerprints already taken, by (folder, commit, paths). A commit is
/// immutable, so nothing here goes stale.
fn known() -> &'static Mutex<HashMap<(String, String, Vec<String>), String>> {
    static KNOWN: OnceLock<Mutex<HashMap<(String, String, Vec<String>), String>>> = OnceLock::new();
    KNOWN.get_or_init(Default::default)
}

/// sha256 of the sorted `git ls-tree -r` lines for the covered paths at
/// commit `head`: the path and blob id of every committed file under them.
/// No paths, or paths that no longer exist, give the fingerprint of nothing.
pub async fn fingerprint(folder: &Path, head: &str, paths: &[String]) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut sorted: Vec<String> = paths.to_vec();
    sorted.sort();
    sorted.dedup();
    let key = (folder.display().to_string(), head.to_string(), sorted.clone());
    if let Some(found) = known().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(found.clone());
    }
    let listing = if sorted.is_empty() {
        String::new()
    } else {
        let mut args = vec!["ls-tree".to_string(), "-r".into(), "--full-tree".into(), head.to_string(), "--".into()];
        // `--full-tree` reads the paths from the top of the tree, whatever
        // folder below it this is asked in.
        args.extend(sorted.iter().map(|path| path.trim_end_matches('/').to_string()));
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        git(folder, &args).await?
    };
    let mut lines: Vec<String> = listing.lines().filter(|line| !line.is_empty()).map(str::to_string).collect();
    lines.extend(dependencies(folder, head, &lines).await);
    lines.sort();
    lines.dedup();
    let digest = Sha256::digest(lines.join("\n").as_bytes());
    let print = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let mut known = known().lock().unwrap_or_else(|e| e.into_inner());
    if known.len() > 20_000 {
        known.clear();
    }
    known.insert(key, print.clone());
    Some(print)
}

/// Files whose text may pull in other files.
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "wgsl", "glsl", "hlsl", "vert", "frag", "comp", "metal", "c", "h", "cc", "cpp", "hpp", "ts", "tsx", "js", "jsx", "mjs",
];
/// How deep, and how many files, the walk of what covered files pull in goes.
const DEPENDENCY_ROUNDS: usize = 6;
const MAX_DEPENDENCIES: usize = 2000;

/// The paths a file's text pulls in, as written: the first string of a
/// macro call (`include_str!("x")`, `include_bytes!`, `include!`, and any
/// `name!("x.wgsl")` such as a shader macro) and `#include "x"` /
/// `#import "x"` lines (WGSL, GLSL, C).
pub fn pulled_in(text: &str) -> Vec<String> {
    static MACRO: OnceLock<regex::Regex> = OnceLock::new();
    static INCLUDE: OnceLock<regex::Regex> = OnceLock::new();
    let call = MACRO.get_or_init(|| regex::Regex::new(r#"[A-Za-z_][A-Za-z0-9_]*!\s*\(\s*"([^"\\]+)""#).unwrap());
    let include = INCLUDE.get_or_init(|| regex::Regex::new(r#"(?m)^\s*#\s*(?:include|import)\s+["<]([^">]+)[">]"#).unwrap());
    call.captures_iter(text)
        .chain(include.captures_iter(text))
        .map(|caps| caps[1].trim().to_string())
        .filter(|path| path.contains('.') && !path.starts_with('/') && !path.contains("://"))
        .collect()
}

/// `dir/target` with `.` and `..` resolved; None when it climbs out.
fn joined(dir: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The text of these blobs, by id, from one `git cat-file --batch`.
async fn blobs(folder: &Path, ids: &[String]) -> HashMap<String, String> {
    use tokio::io::AsyncWriteExt;
    let mut found = HashMap::new();
    if ids.is_empty() {
        return found;
    }
    let Ok(mut child) = tokio::process::Command::new("git")
        .args(["cat-file", "--batch"])
        .current_dir(folder)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return found;
    };
    let mut stdin = child.stdin.take();
    let request = ids.join("\n") + "\n";
    let writer = async move {
        if let Some(stdin) = stdin.as_mut() {
            let _ = stdin.write_all(request.as_bytes()).await;
        }
        drop(stdin);
    };
    let (_, output) = tokio::join!(writer, child.wait_with_output());
    let Ok(output) = output else { return found };
    let bytes = output.stdout;
    let mut at = 0;
    while at < bytes.len() {
        let Some(end) = bytes[at..].iter().position(|b| *b == b'\n') else { break };
        let header = String::from_utf8_lossy(&bytes[at..at + end]).to_string();
        at += end + 1;
        let fields: Vec<&str> = header.split(' ').collect();
        if fields.len() != 3 {
            continue; // "<id> missing"
        }
        let size: usize = fields[2].parse().unwrap_or(0);
        let body = &bytes[at.min(bytes.len())..(at + size).min(bytes.len())];
        at += size + 1;
        if size <= 1024 * 1024 {
            found.insert(fields[0].to_string(), String::from_utf8_lossy(body).to_string());
        }
    }
    found
}

/// The `ls-tree` lines of the files the listed files pull in, followed
/// recursively: a shader a covered Rust file includes is covered too.
/// Targets resolve from the including file's folder, then the top.
async fn dependencies(folder: &Path, head: &str, listed: &[String]) -> Vec<String> {
    let entry = |line: &str| -> Option<(String, String)> {
        let (meta, path) = line.split_once('\t')?;
        let id = meta.split(' ').nth(2)?.to_string();
        Some((id, path.to_string()))
    };
    let mut seen: std::collections::HashSet<String> = listed.iter().filter_map(|line| entry(line).map(|(_, path)| path)).collect();
    let mut frontier: Vec<String> = listed.to_vec();
    let mut out = Vec::new();
    for _ in 0..DEPENDENCY_ROUNDS {
        let sources: Vec<(String, String)> = frontier
            .iter()
            .filter_map(|line| entry(line))
            .filter(|(_, path)| path.rsplit_once('.').is_some_and(|(_, ext)| SOURCE_EXTENSIONS.contains(&ext)))
            .collect();
        if sources.is_empty() {
            break;
        }
        let ids: Vec<String> = sources.iter().map(|(id, _)| id.clone()).collect();
        let texts = blobs(folder, &ids).await;
        let mut wanted: Vec<String> = Vec::new();
        for (id, path) in &sources {
            let Some(text) = texts.get(id) else { continue };
            let dir = path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
            for target in pulled_in(text) {
                for candidate in [joined(dir, &target), joined("", &target)].into_iter().flatten() {
                    if !seen.contains(&candidate) && !wanted.contains(&candidate) {
                        wanted.push(candidate);
                    }
                }
            }
        }
        if wanted.is_empty() || seen.len() >= MAX_DEPENDENCIES {
            break;
        }
        wanted.truncate(MAX_DEPENDENCIES.saturating_sub(seen.len()));
        let mut args = vec!["ls-tree".to_string(), "--full-tree".into(), head.to_string(), "--".into()];
        args.extend(wanted.iter().cloned());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let Some(listing) = git(folder, &args).await else { break };
        frontier = listing
            .lines()
            .filter(|line| line.contains(" blob "))
            .map(str::to_string)
            .filter(|line| entry(line).is_some_and(|(_, path)| seen.insert(path)))
            .collect();
        out.extend(frontier.iter().cloned());
        if frontier.is_empty() {
            break;
        }
    }
    out
}

/// The covered paths that have uncommitted changes (or untracked files) in
/// `folder`'s working tree.
pub async fn dirty(folder: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["status".to_string(), "--porcelain".into(), "--untracked-files=all".into(), "--".into()];
    args.extend(pathspecs(paths));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = crate::routes::git_output(folder, &args).await.map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("git status failed in {}: {}", folder.display(), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.len() > 3)
        .map(|line| line[3..].to_string())
        .collect())
}

/// Which of these commits the repository at `folder` does not have, by the
/// same test `task done` uses.
pub async fn missing_commits(folder: &Path, commits: &[String]) -> std::collections::HashSet<String> {
    let mut missing = std::collections::HashSet::new();
    for sha in commits {
        let found = git(folder, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).await.is_some();
        if !found {
            missing.insert(sha.clone());
        }
    }
    missing
}

/// The files that changed between two commits, for the watcher.
pub async fn changed_between(folder: &Path, old: &str, new: &str) -> Option<Vec<String>> {
    git(folder, &["diff", "--name-only", old, new])
        .await
        .map(|text| text.lines().map(str::to_string).filter(|line| !line.is_empty()).collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::Command;

    pub fn git_run(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Write a file and commit it; the new HEAD.
    pub fn commit_file(dir: &Path, file: &str, body: &str) -> String {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        git_run(dir, &["add", file]);
        git_run(dir, &["commit", "-q", "-m", file]);
        git_run(dir, &["rev-parse", "HEAD"])
    }

    pub fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        git_run(root.path(), &["init", "-q", "-b", "main"]);
        root
    }

    #[test]
    fn a_proof_needs_a_summary_and_a_check_and_its_benchmarks_must_meet_their_budgets() {
        assert!(check_proof(&json!({"checks": [{"name": "a", "command": "true"}]})).unwrap_err().contains("summary is required"));
        assert!(check_proof(&json!({"summary": "s"})).unwrap_err().contains("checks is required"));
        assert!(check_proof(&json!({"summary": "s", "checks": [{"name": "a", "command": "true", "timeout_s": 4000}]}))
            .unwrap_err()
            .contains("timeout_s must be"));
        let proof = check_proof(&json!({"summary": "s", "checks": [{"name": "a", "command": "true"}],
            "benchmarks": [{"name": "glare", "value": 0.8, "budget": 1.0, "unit": "ms"}]}))
        .unwrap();
        assert_eq!(proof.checks[0].timeout_s, CHECK_TIMEOUT_S);
        assert_eq!(proof.value["benchmarks"][0]["lower_is_better"], true);
        let over = check_proof(&json!({"summary": "s", "checks": [{"name": "a", "command": "true"}],
            "benchmarks": [{"name": "glare", "value": 1.2, "budget": 1.0, "unit": "ms"}]}))
        .unwrap_err();
        assert!(over.contains("misses its budget") && over.contains("over"), "{over}");
        let under = check_proof(&json!({"summary": "s", "checks": [{"name": "a", "command": "true"}],
            "benchmarks": [{"name": "fps", "value": 50, "budget": 60, "lower_is_better": false}]}))
        .unwrap_err();
        assert!(under.contains("under"), "{under}");
        assert!(check_proof(&json!({"summary": "s", "checks": [{"name": "a", "command": "true"}], "commits": ["xyz"]}))
            .unwrap_err()
            .contains("not a commit SHA"));
    }

    #[tokio::test]
    async fn checks_report_their_exit_code_and_the_tail_of_their_output() {
        let folder = tempfile::tempdir().unwrap();
        let checks = [
            Check { name: "ok".into(), command: "echo fine".into(), timeout_s: 10 },
            Check { name: "bad".into(), command: "for i in $(seq 1 60); do echo line$i; done; echo oops >&2; exit 3".into(), timeout_s: 10 },
            Check { name: "slow".into(), command: "sleep 30".into(), timeout_s: 1 },
        ];
        let results = run_checks(folder.path(), &checks).await;
        assert!(results[0].passed());
        assert_eq!(results[1].exit, 3);
        assert!(results[1].tail.ends_with("line60\noops"), "{}", results[1].tail);
        assert_eq!(results[1].tail.lines().count(), TAIL_LINES);
        assert_eq!(results[2].exit, 124);
        assert!(results[2].ms < 10_000);
    }

    #[tokio::test]
    async fn a_fingerprint_changes_with_committed_content_only() {
        let repo = repository();
        let dir = repo.path();
        commit_file(dir, "camera/glare.rs", "one");
        let first = head(dir).await.unwrap();
        let paths = vec!["camera/".to_string()];
        let before = fingerprint(dir, &first, &paths).await.unwrap();
        std::fs::write(dir.join("camera/glare.rs"), "edited").unwrap();
        assert_eq!(dirty(dir, &paths).await.unwrap(), ["camera/glare.rs"]);
        assert!(dirty(dir, &["other".into()]).await.unwrap().is_empty());
        let second = commit_file(dir, "camera/glare.rs", "two");
        assert_ne!(fingerprint(dir, &second, &paths).await.unwrap(), before);
        let third = commit_file(dir, "elsewhere.rs", "x");
        assert_eq!(
            fingerprint(dir, &third, &paths).await.unwrap(),
            fingerprint(dir, &second, &paths).await.unwrap(),
            "a commit elsewhere leaves the fingerprint alone"
        );
        assert_eq!(fingerprint(dir, &third, &[]).await, fingerprint(dir, &third, &["gone/".into()]).await);
        // A folder below the top reads the same files.
        assert_eq!(fingerprint(&dir.join("camera"), &third, &paths).await, fingerprint(dir, &third, &paths).await);
    }
}
