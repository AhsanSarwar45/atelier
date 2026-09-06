//! Git route handlers for reading and changing a project's repository.
//!
//! Every route is handed an absolute working directory, runs it through
//! [`validate_path_security`], and then shells out to the real `git` binary.

use axum::{
    extract::rejection::{JsonRejection, QueryRejection},
    extract::{FromRequest, FromRequestParts, Query, Request},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

use super::validate_path_security;

/// Query parameters for the branch status endpoint.
#[derive(Deserialize)]
pub struct GitStatusParams {
    /// Path to the git repository.
    pub path: String,
    /// Branch name to check status for.
    pub branch: String,
}

/// Response body for the branch status endpoint.
#[derive(Serialize)]
pub struct BranchStatusResponse {
    /// Whether the branch exists.
    pub exists: bool,
    /// Number of commits ahead of main.
    pub ahead: i32,
    /// Number of commits behind main.
    pub behind: i32,
    /// Whether there are uncommitted changes.
    pub dirty: bool,
}

/// Get the status of a git branch relative to main.
///
/// # Endpoint
///
/// `GET /api/git/branch-status?path=...&branch=...`
///
/// # Response
///
/// Returns branch existence, ahead/behind counts, and dirty status.
///
/// Older than the panel's ten routes below, and its answer keeps its own
/// older shape — but it is turned away the way they are, through [`GitQuery`]
/// and [`checked_repo`], rather than through a second hand-built `{ error }`
/// beside a rejection the framework answered in plain text (bw-8dp8.11).
pub async fn branch_status(GitQuery(params): GitQuery<GitStatusParams>) -> Answer {
    let repo = checked_repo(&params.path)?;

    // Check if branch exists
    if !check_branch_exists(&repo, &params.branch).await {
        return Ok(Json(BranchStatusResponse {
            exists: false,
            ahead: 0,
            behind: 0,
            dirty: false,
        })
        .into_response());
    }

    // Get ahead/behind counts relative to main
    let (ahead, behind) = get_ahead_behind(&repo, &params.branch).await;

    // Check for uncommitted changes
    let dirty = check_dirty(&repo).await;

    Ok(Json(BranchStatusResponse {
        exists: true,
        ahead,
        behind,
        dirty,
    })
    .into_response())
}

/// Check if a branch exists in the repository.
async fn check_branch_exists(repo: &Path, branch: &str) -> bool {
    let output = super::git_output(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .await;

    matches!(output, Ok(o) if o.status.success())
}

/// Get the number of commits ahead and behind relative to main.
async fn get_ahead_behind(repo: &Path, branch: &str) -> (i32, i32) {
    // Try both 'main' and 'master' as the base branch
    let base_branches = ["main", "master"];

    for base in base_branches {
        let output = super::git_output(
            repo,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{}...{}", base, branch),
            ],
        )
        .await;

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let parts: Vec<&str> = stdout.trim().split('\t').collect();
                if parts.len() == 2 {
                    let behind = parts[0].parse().unwrap_or(0);
                    let ahead = parts[1].parse().unwrap_or(0);
                    return (ahead, behind);
                }
            }
        }
    }

    (0, 0)
}

/// Check if the repository has uncommitted changes.
async fn check_dirty(repo: &Path) -> bool {
    let output = super::git_output(repo, &["status", "--porcelain"]).await;

    match output {
        Ok(o) => !o.stdout.is_empty(),
        Err(_) => false,
    }
}


// ============================================================================
// The Git panel's routes
//
// Everything below shells out to the real `git` binary. There is deliberately
// no git library here: the send path has to honour the keys and the
// `credential.helper` the user's own setup already carries, and libgit2 — so
// git2, nodegit and simple-git with it — never consults `credential.helper`
// at all (bw-8dp8).
// ============================================================================

/// A route's refusal: the code to answer with, and what to say.
///
/// Kept as a code and a string rather than a built response so that `?` can
/// carry it out of a helper without hauling a whole `Response` through every
/// `Result` on the way.
#[derive(Debug)]
pub struct Refused {
    code: StatusCode,
    said: String,
    /// Set only on the one refusal an SSH key passphrase could clear. The
    /// panel reads it to know that asking is worth offering; nothing else in
    /// the answer changes, and git's own words still lead.
    a_key_could_fix_it: bool,
}

impl Refused {
    /// The ordinary refusal: a code and git's own words.
    fn new(code: StatusCode, said: impl Into<String>) -> Self {
        Refused { code, said: said.into(), a_key_could_fix_it: false }
    }

    /// The refusal a locked SSH key could clear, told apart so the panel can
    /// offer to ask for the passphrase instead of leaving a dead end.
    fn wants_a_key(said: impl Into<String>) -> Self {
        Refused {
            code: StatusCode::UNAUTHORIZED,
            said: said.into(),
            a_key_could_fix_it: true,
        }
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let mut body = serde_json::json!({ "error": self.said });
        if self.a_key_could_fix_it {
            // Only ever present when true, so a reader of the answer cannot
            // mistake its absence for a considered "no".
            body["needsPassphrase"] = serde_json::Value::Bool(true);
        }
        (self.code, Json(body)).into_response()
    }
}

/// Either the answer or the refusal; axum turns whichever arrives into the
/// response, so a handler can hand back the first one it reaches.
pub type Answer = Result<Response, Refused>;

// ----------------------------------------------------------------------------
// Requests turned away before a handler runs
// ----------------------------------------------------------------------------

/// A request body, refused the way everything else in this file is refused.
///
/// Plain `Json` answers a body it cannot read with axum's own plain text, so a
/// malformed body, a missing `path` or the wrong content type reached the panel
/// as a bare status line — "Unprocessable Entity", with nothing about why —
/// while every refusal the routes themselves make carries `{ error }`. This is
/// `Json` with its rejection turned into a [`Refused`], so a request turned
/// away before a handler ever runs reads exactly like one git turned away
/// (bw-8dp8.8).
pub struct GitJson<T>(pub T);

#[axum::async_trait]
impl<S, T> FromRequest<S> for GitJson<T>
where
    S: Send + Sync,
    Json<T>: FromRequest<S, Rejection = JsonRejection>,
{
    type Rejection = Refused;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(body)| GitJson(body))
            // axum's own words for what was wrong with the request, kept as it
            // wrote them for the same reason git's are kept: they are the
            // reason, and the status it chose is the right one to answer with.
            .map_err(|turned_away| Refused::new(turned_away.status(), turned_away.body_text()))
    }
}

/// Query parameters, refused the same way — the read routes' half of
/// [`GitJson`]. `?path=` left off used to answer plain text as well.
pub struct GitQuery<T>(pub T);

#[axum::async_trait]
impl<S, T> FromRequestParts<S> for GitQuery<T>
where
    S: Send + Sync,
    Query<T>: FromRequestParts<S, Rejection = QueryRejection>,
{
    type Rejection = Refused;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(params)| GitQuery(params))
            .map_err(|turned_away| Refused::new(turned_away.status(), turned_away.body_text()))
    }
}

// ----------------------------------------------------------------------------
// One lock per repository
// ----------------------------------------------------------------------------

/// A repository's turn at being written to.
type RepoLock = Arc<AsyncMutex<()>>;

/// The lock each repository waits on, found by its canonical path.
static REPO_LOCKS: OnceLock<Mutex<HashMap<PathBuf, RepoLock>>> = OnceLock::new();

/// The lock that serializes writes to one repository.
///
/// git serializes its own writes with `.git/index.lock`, so two mutating
/// commands aimed at one repository at the same moment leave the loser dead
/// with `fatal: Unable to create '.git/index.lock': File exists`. Mutating
/// routes queue behind this; the read routes never take it.
///
/// The key is the canonical path, so two spellings of one repository share a
/// lock — and, just as importantly, two different repositories never wait on
/// each other.
pub fn repo_lock(repo: &Path) -> RepoLock {
    let key = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let locks = REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(locks.entry(key).or_insert_with(|| Arc::new(AsyncMutex::new(()))))
}

// ----------------------------------------------------------------------------
// Talking to git
// ----------------------------------------------------------------------------

/// Check the working directory a route was handed before anything touches it.
fn checked_repo(path: &str) -> Result<PathBuf, Refused> {
    let repo = Path::new(path);

    if let Err(e) = validate_path_security(repo) {
        return Err(Refused::new(StatusCode::FORBIDDEN, e));
    }

    if !repo.exists() {
        return Err(Refused::new(
            StatusCode::BAD_REQUEST,
            format!("Repository path does not exist: {}", path),
        ));
    }

    if !repo.is_dir() {
        return Err(Refused::new(
            StatusCode::BAD_REQUEST,
            format!("Path is not a directory: {}", path),
        ));
    }

    Ok(repo.to_path_buf())
}

/// Run git in `repo` and hand back everything it produced.
async fn run_git(repo: &Path, args: &[&str]) -> Result<Output, Refused> {
    super::git_output(repo, args).await.map_err(could_not_run)
}

/// The ssh a remote call is made through, with its asking turned off.
///
/// `GIT_TERMINAL_PROMPT=0` covers the asking git does itself — an HTTPS
/// username and password — and nothing else. The passphrase for an SSH key is
/// asked for by `ssh`, a separate program that never sees that variable. Left
/// alone, an `ssh` that wants a passphrase reads it from whatever terminal the
/// server was started under, and the request waits for an answer nobody in
/// front of the app can give: the very hang `GIT_TERMINAL_PROMPT` was set to
/// prevent, arriving by the door it does not cover. `BatchMode=yes` is ssh's
/// own switch for this — "user interaction such as password prompts and host
/// key confirmation requests will be disabled" — so ssh gives up and says so
/// instead of waiting.
///
/// The user's own ssh command is kept underneath it. `GIT_SSH_COMMAND` beats
/// `core.sshCommand` in git's own order of precedence, so setting the variable
/// blind would quietly throw away a `core.sshCommand` somebody is relying on;
/// whichever of the two the setup already carries becomes the thing
/// `BatchMode` is added to, and plain `ssh` only when it carries neither.
async fn ssh_that_cannot_ask(repo: &Path) -> String {
    let from_env = std::env::var("GIT_SSH_COMMAND").ok();
    let from_config = match from_env {
        // Only worth asking the repository when the environment is silent,
        // since the environment would win anyway.
        Some(ref carried) if !carried.trim().is_empty() => None,
        _ => run_git(repo, &["config", "--get", "core.sshCommand"])
            .await
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string()),
    };
    with_batch_mode(from_env, from_config)
}

/// The ssh command to run, given whatever the environment and the repository
/// carry. Split out from the asking so the order of precedence can be read —
/// and tested — without a process-wide environment variable in the way.
fn with_batch_mode(from_env: Option<String>, from_config: Option<String>) -> String {
    let carried = [from_env, from_config]
        .into_iter()
        .flatten()
        .find(|carried| !carried.trim().is_empty());
    format!("{} -o BatchMode=yes", carried.as_deref().unwrap_or("ssh").trim())
}

/// The name the passphrase travels under, from this server to the helper ssh
/// runs. An environment variable and never an argument: on Linux a process's
/// command line is readable by anyone on the machine through `/proc`, while
/// its environment is readable only by its own user.
const PASSPHRASE_VARIABLE: &str = "ATELIER_SSH_PASSPHRASE";

/// The helper ssh runs to be told the passphrase.
///
/// It holds no secret itself — it reads the one in its environment and writes
/// it out — so the passphrase is never on disk. ssh calls it with the prompt
/// it would have shown as an argument, which is of no interest here.
const ASKPASS_HELPER: &str = r#"#!/bin/sh
# Written by Atelier for one git call and removed when that call ends. The
# passphrase is in this program's environment, never in the file itself.
printf '%s\n' "$ATELIER_SSH_PASSPHRASE"
"#;

/// The askpass helper for a single call, on disk only while it is held.
///
/// Dropping it takes the directory and the program inside it away, which is
/// why the call keeps hold of it until git has finished rather than letting it
/// go at the end of the branch that made it.
#[cfg(unix)]
struct AskpassForOneCall {
    /// Removed on drop, taking the program with it.
    _dir: tempfile::TempDir,
    /// What `SSH_ASKPASS` is pointed at.
    program: std::path::PathBuf,
}

/// Write the helper into a directory of its own, readable by nobody else.
#[cfg(unix)]
fn askpass_for_one_call() -> std::io::Result<AskpassForOneCall> {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::Builder::new().prefix("atelier-askpass-").tempdir()?;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;

    let program = dir.path().join("askpass");
    std::fs::write(&program, ASKPASS_HELPER)?;
    // Owner only, and executable because ssh runs it as a program.
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700))?;

    Ok(AskpassForOneCall { _dir: dir, program })
}

/// Run a git command that talks to the shared copy.
///
/// Everything added to the environment is there to keep the call from stopping
/// at a prompt this server has no terminal to answer. `GIT_TERMINAL_PROMPT=0`
/// covers git's own asking either way; what happens to ssh's asking depends on
/// whether a passphrase came with the request, and the two are exclusive:
///
/// * With no passphrase, ssh is run so it cannot ask at all
///   (`BatchMode=yes`), and a locked key comes back as a refusal.
/// * With one, ssh is given a helper to ask instead of a terminal, forced with
///   `SSH_ASKPASS_REQUIRE=force` so that a terminal is never preferred to it.
///   `BatchMode` must *not* be set here: it turns off the asking altogether,
///   helper included, and the passphrase would never be reached for.
///
/// Neither can hang. The helper answers the moment it is asked, and a wrong
/// passphrase ends in ssh giving up rather than asking a human again.
///
/// Everything else — the SSH keys, ssh-agent, `credential.helper`, the whole
/// gitconfig — is inherited untouched, which is the entire reason this shells
/// out to git. Nothing about the passphrase outlives the call: it is never
/// written down, never logged, and the helper it was read by is gone as soon
/// as git returns.
async fn run_git_remote(
    repo: &Path,
    args: &[&str],
    passphrase: Option<&str>,
) -> Result<Output, Refused> {
    let mut running = super::git_command().map_err(could_not_run)?;
    running
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0");

    // Held until git has finished; dropping it takes the helper off disk.
    let _helper = match passphrase {
        None => {
            running.env("GIT_SSH_COMMAND", ssh_that_cannot_ask(repo).await);
            None
        }
        Some(secret) => {
            let helper = askpass_when_one_is_supplied()?;
            // The ssh command itself is left alone in this branch, so a
            // `GIT_SSH_COMMAND` or `core.sshCommand` the setup carries is the
            // one git runs, exactly as it would be outside the app.
            running
                .env("SSH_ASKPASS", &helper.program)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env(PASSPHRASE_VARIABLE, secret);
            Some(helper)
        }
    };

    running.output().await.map_err(could_not_run)
}

/// The helper, or a refusal saying plainly that this platform has no way to
/// hand ssh a passphrase — better than accepting one and quietly ignoring it.
#[cfg(unix)]
fn askpass_when_one_is_supplied() -> Result<AskpassForOneCall, Refused> {
    askpass_for_one_call().map_err(|e| {
        Refused::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not make somewhere for ssh to ask for the passphrase: {}", e),
        )
    })
}

#[cfg(not(unix))]
fn askpass_when_one_is_supplied() -> Result<(), Refused> {
    Err(Refused::new(
        StatusCode::NOT_IMPLEMENTED,
        "Unlocking an SSH key from the app is not supported on this platform yet. \
         Load the key into ssh-agent and try again.",
    ))
}

/// git could not be started at all — a missing binary, not a git refusal.
fn could_not_run(e: std::io::Error) -> Refused {
    Refused::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Could not run git: {}", e),
    )
}

/// git's own words, verbatim and untruncated.
///
/// A rejected push or a merge conflict is only useful to read if it arrives in
/// the words git chose, so nothing here summarizes, trims or rewrites stderr.
/// Some refusals — `git commit` with nothing staged is the everyday one — say
/// their piece on stdout instead, so that is the fallback.
fn git_said_no(output: &Output) -> Refused {
    let mut said = String::from_utf8_lossy(&output.stderr).into_owned();
    if said.is_empty() {
        said = String::from_utf8_lossy(&output.stdout).into_owned();
    }
    if said.is_empty() {
        said = format!("git exited with {}", output.status);
    }
    if a_key_could_fix_it(&said) {
        return Refused::wants_a_key(said);
    }
    Refused::new(StatusCode::UNPROCESSABLE_ENTITY, said)
}

/// Whether a passphrase is worth offering for what ssh just said.
///
/// ssh turns a call away with the same sentence whether the key is locked,
/// missing, or simply not one the other end accepts: `Permission denied
/// (publickey)`, with nothing in its output separating the three. So this is
/// not a claim that a passphrase is what is wanted — it is the one refusal a
/// passphrase *could* clear, which is why the panel offers to ask rather than
/// announcing why the call failed. The second sentence is ssh's own answer to
/// a passphrase that was wrong, which is the same offer a second time.
///
/// Deliberately narrow. An HTTPS remote that answers `Authentication failed`
/// is not an SSH key and no passphrase will help it, so it is left to be shown
/// as the plain refusal it is.
fn a_key_could_fix_it(said: &str) -> bool {
    said.contains("Permission denied (publickey")
        || said.contains("incorrect passphrase supplied to decrypt private key")
}

/// Pass the output on, or turn a nonzero exit into git's own refusal.
fn spoke_or_refused(output: Output) -> Result<Output, Refused> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(git_said_no(&output))
    }
}

/// Everything git printed, stdout first, then stderr — where the interesting
/// half of a fetch or a push lives.
fn everything_git_printed(output: &Output) -> String {
    let mut said = String::from_utf8_lossy(&output.stdout).into_owned();
    let complaint = String::from_utf8_lossy(&output.stderr);
    if !complaint.is_empty() {
        if !said.is_empty() && !said.ends_with('\n') {
            said.push('\n');
        }
        said.push_str(&complaint);
    }
    said
}

/// `{ ok: true }`, the answer the routes that only do a thing give back.
fn did_it() -> Response {
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Whether this repository has any commits yet.
async fn has_commits(repo: &Path) -> bool {
    matches!(
        run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).await,
        Ok(o) if o.status.success()
    )
}

// ----------------------------------------------------------------------------
// GET /api/git/status
// ----------------------------------------------------------------------------

/// Query parameters for the routes that only need to be told which repository.
#[derive(Deserialize)]
pub struct PathParams {
    /// Absolute working directory of the repository.
    pub path: String,
}

/// One file git has something to say about.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// Path relative to the repository root.
    pub path: String,
    /// One of `modified`, `added`, `deleted`, `renamed`, `typechange`.
    pub status: String,
    /// Where a renamed file came from; `null` for everything else.
    #[serde(rename = "origPath")]
    pub orig_path: Option<String>,
}

/// A file named and nothing more — untracked and conflicted files.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct NamedPath {
    /// Path relative to the repository root.
    pub path: String,
}

/// What a project has changed.
#[derive(Serialize, Debug, Default)]
pub struct StatusResponse {
    /// The line of work this is on, or the short commit when HEAD is detached.
    pub branch: String,
    /// The shared copy this branch follows, if it follows one.
    pub upstream: Option<String>,
    /// Commits this branch has that its upstream does not.
    pub ahead: i32,
    /// Commits the upstream has that this branch does not.
    pub behind: i32,
    /// Whether HEAD is sitting on a commit rather than a branch.
    pub detached: bool,
    /// Files picked to be saved.
    pub staged: Vec<ChangedFile>,
    /// Files changed but not picked.
    pub unstaged: Vec<ChangedFile>,
    /// Files git has never been told about.
    pub untracked: Vec<NamedPath>,
    /// Files a merge left unresolved.
    pub conflicted: Vec<NamedPath>,
}

/// The word for one of git's status letters, or `None` when the letter means
/// "nothing happened on this side" (`.`) or "unmerged" (`U`, which arrives as
/// its own `u` record instead).
fn status_word(letter: u8) -> Option<&'static str> {
    match letter {
        b'M' => Some("modified"),
        b'T' => Some("typechange"),
        b'A' => Some("added"),
        b'D' => Some("deleted"),
        // Copy detection is off in `git status` unless the user turns it on,
        // and a copy carries an original path exactly as a rename does, so it
        // is reported with the same word rather than inventing a new one.
        b'R' | b'C' => Some("renamed"),
        _ => None,
    }
}

/// Pull the status letters and the path out of a changed-entry record, given
/// how many space-separated fields sit in front of the path.
fn entry_fields(record: &str, before_path: usize) -> Option<(&str, &str)> {
    let mut fields = record.splitn(before_path + 1, ' ');
    fields.next()?; // the record kind
    let letters = fields.next()?;
    for _ in 2..before_path {
        fields.next()?;
    }
    Some((letters, fields.next()?))
}

/// File the entry under the side or sides it belongs to.
fn file_it(status: &mut StatusResponse, letters: &str, path: &str, came_from: Option<String>) {
    let mut letters = letters.bytes();
    let picked = letters.next().unwrap_or(b'.');
    let loose = letters.next().unwrap_or(b'.');

    if let Some(word) = status_word(picked) {
        status.staged.push(ChangedFile {
            path: path.to_string(),
            status: word.to_string(),
            orig_path: came_from,
        });
    }
    if let Some(word) = status_word(loose) {
        // A rename is recorded in the index; a change on top of it in the
        // working tree is only a change to the new path, so it carries no
        // original path of its own.
        status.unstaged.push(ChangedFile {
            path: path.to_string(),
            status: word.to_string(),
            orig_path: None,
        });
    }
}

/// Read `git status --porcelain=v2 -z --branch --untracked-files=all`.
///
/// The framing is the part that bites: records are terminated by NUL, not by
/// newline, and a rename (`2`) record spends TWO of them — the entry, and then
/// the path the file came from. Reading this a line at a time loses the
/// original path and then mistakes it for an entry of its own.
pub fn read_porcelain_v2(raw: &[u8]) -> StatusResponse {
    let mut status = StatusResponse::default();
    let mut head_commit = String::new();

    let records: Vec<String> = raw
        .split(|byte| *byte == 0)
        .map(|record| String::from_utf8_lossy(record).into_owned())
        .collect();

    let mut at = 0;
    while at < records.len() {
        let record = &records[at];
        at += 1;
        if record.is_empty() {
            continue;
        }

        if let Some(header) = record.strip_prefix("# ") {
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                head_commit = oid.to_string();
            } else if let Some(head) = header.strip_prefix("branch.head ") {
                if head == "(detached)" {
                    status.detached = true;
                } else {
                    status.branch = head.to_string();
                }
            } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
                status.upstream = Some(upstream.to_string());
            } else if let Some(gap) = header.strip_prefix("branch.ab ") {
                let mut counts = gap.split_whitespace();
                status.ahead = counts
                    .next()
                    .and_then(|c| c.strip_prefix('+'))
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
                status.behind = counts
                    .next()
                    .and_then(|c| c.strip_prefix('-'))
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
            }
            continue;
        }

        match record.as_bytes()[0] {
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            b'1' => {
                if let Some((letters, path)) = entry_fields(record, 8) {
                    let (letters, path) = (letters.to_string(), path.to_string());
                    file_it(&mut status, &letters, &path, None);
                }
            }
            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`, and
            // then the path it came from, in the very next record.
            b'2' => {
                let came_from = records.get(at).cloned();
                at += 1;
                if let Some((letters, path)) = entry_fields(record, 9) {
                    let (letters, path) = (letters.to_string(), path.to_string());
                    file_it(&mut status, &letters, &path, came_from);
                }
            }
            // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
            b'u' => {
                if let Some((_, path)) = entry_fields(record, 10) {
                    status.conflicted.push(NamedPath { path: path.to_string() });
                }
            }
            b'?' => {
                if let Some(path) = record.strip_prefix("? ") {
                    status.untracked.push(NamedPath { path: path.to_string() });
                }
            }
            // `!` is an ignored file; this route never asks for those.
            _ => {}
        }
    }

    // Detached HEAD has no branch to name, so it is named by its commit.
    if status.detached && status.branch.is_empty() {
        status.branch = head_commit.chars().take(7).collect();
    }

    status
}

/// What a project has changed.
///
/// # Endpoint
///
/// `GET /api/git/status?path=...`
pub async fn status(GitQuery(params): GitQuery<PathParams>) -> Answer {
    let repo = checked_repo(&params.path)?;
    let output = spoke_or_refused(
        run_git(
            &repo,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=all",
            ],
        )
        .await?,
    )?;
    Ok(Json(read_porcelain_v2(&output.stdout)).into_response())
}

// ----------------------------------------------------------------------------
// POST /api/git/stage, POST /api/git/unstage
// ----------------------------------------------------------------------------

/// Request body for the routes that pick files up and put them back.
#[derive(Deserialize)]
pub struct FilesRequest {
    /// Absolute working directory of the repository.
    pub path: String,
    /// Paths relative to the repository root.
    ///
    /// Empty is only allowed when `all` is set. Left empty without it, the
    /// call is refused rather than quietly doing nothing (bw-8dp8.1).
    #[serde(default)]
    pub files: Vec<String>,
    /// Everything the repository has, rather than the files named.
    ///
    /// The panel's bulk buttons (bw-8nwh.3). A flag rather than the caller
    /// sending every path it happens to have drawn, because the panel's list
    /// is as old as its last read and the repository is not: a stage-all built
    /// from stale paths stages the wrong set and says nothing about it.
    #[serde(default)]
    pub all: bool,
}

/// Pick files to be saved.
///
/// # Endpoint
///
/// `POST /api/git/stage` — `{ path, files?, all? }`
///
/// `all` is `git add -A`: everything changed, everything new, and every
/// deletion, which is what the panel's "Stage all" means.
pub async fn stage(GitJson(body): GitJson<FilesRequest>) -> Answer {
    change_the_index(body, &["add", "--"], &["add", "-A"]).await
}

/// Put picked files back.
///
/// # Endpoint
///
/// `POST /api/git/unstage` — `{ path, files?, all? }`
///
/// `all` is `git reset -q`, not `git restore --staged -- .`, because a
/// repository with nothing saved in it yet has no HEAD for `restore` to read
/// and it dies with `fatal: could not resolve HEAD`. `reset` puts the index
/// back in both repositories, and a project whose first commit has not been
/// made is exactly the one somebody is most likely to be picking files in and
/// out of.
pub async fn unstage(GitJson(body): GitJson<FilesRequest>) -> Answer {
    change_the_index(body, &["restore", "--staged", "--"], &["reset", "-q"]).await
}

/// Run `verb` over the named files, or `sweep` over the whole repository.
async fn change_the_index(body: FilesRequest, verb: &[&str], sweep: &[&str]) -> Answer {
    let repo = checked_repo(&body.path)?;

    let args: Vec<&str> = if body.all {
        sweep.to_vec()
    } else {
        // `git add --` with nothing after it succeeds and does nothing, which
        // would read back as a stage that worked. Say what happened instead.
        if body.files.is_empty() {
            return Err(Refused::new(
                StatusCode::BAD_REQUEST,
                "No files were named".to_string(),
            ));
        }
        let mut args: Vec<&str> = verb.to_vec();
        args.extend(body.files.iter().map(String::as_str));
        args
    };

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    spoke_or_refused(run_git(&repo, &args).await?)?;
    Ok(did_it())
}

// ----------------------------------------------------------------------------
// POST /api/git/discard, POST /api/git/remove
// ----------------------------------------------------------------------------

/// Which of the named paths git already knows about.
///
/// `git ls-files -- <paths>` answers with the ones that are in the index, so
/// the rest are files git has never been told about. The two halves are undone
/// by different commands — `restore` puts a tracked file back, and only
/// `clean` deletes an untracked one — and asking git which is which beats
/// trusting whichever group the panel happened to draw the row in.
async fn the_tracked_ones(repo: &Path, files: &[String]) -> Result<Vec<String>, Refused> {
    let mut args: Vec<&str> = vec!["ls-files", "-z", "--"];
    args.extend(files.iter().map(String::as_str));
    let listed = spoke_or_refused(run_git(repo, &args).await?)?;
    Ok(String::from_utf8_lossy(&listed.stdout)
        .split('\0')
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Throw away what has been changed and not saved.
///
/// # Endpoint
///
/// `POST /api/git/discard` — `{ path, files?, all? }`
///
/// The destructive one. What it undoes is gone: git keeps no copy of a working
/// tree edit that was never staged, so the panel asks before it calls this and
/// this does exactly what it was asked and no more.
///
/// With files named, each is put back the way its own state needs. A tracked
/// file is restored in the working tree **from the index**, not from HEAD, and
/// the index is left alone: a file that was changed, picked up, and then
/// changed again is in both groups at once, and the row being discarded is the
/// one in "Not staged", so only that half may go. `--source=HEAD` here would
/// quietly throw away the picked-up half as well. For a file that is not
/// picked up the index holds HEAD's copy anyway, so the ordinary case is the
/// same either way. An untracked file is deleted.
///
/// With `all`, everything tracked goes back to HEAD — index and working tree
/// both — and every untracked file is removed. **Ignored files are kept**:
/// `git clean -fd` without `-x` leaves them, and the difference matters,
/// because `-x` is what deletes somebody's `.env`, their `node_modules` and
/// their build. "Discard all" means the changes, never the things git was told
/// to look away from.
pub async fn discard(GitJson(body): GitJson<FilesRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    if !body.all && body.files.is_empty() {
        return Err(Refused::new(
            StatusCode::BAD_REQUEST,
            "No files were named".to_string(),
        ));
    }

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    if body.all {
        // A repository with no commits has no HEAD to go back to; putting the
        // index back and sweeping up leaves it as empty as it started.
        if has_commits(&repo).await {
            spoke_or_refused(
                run_git(
                    &repo,
                    &["restore", "--worktree", "--staged", "--source=HEAD", "--", "."],
                )
                .await?,
            )?;
        } else {
            spoke_or_refused(run_git(&repo, &["reset", "-q"]).await?)?;
        }
        spoke_or_refused(run_git(&repo, &["clean", "-fdq"]).await?)?;
        return Ok(did_it());
    }

    let tracked = the_tracked_ones(&repo, &body.files).await?;
    let untracked: Vec<&str> = body
        .files
        .iter()
        .map(String::as_str)
        .filter(|named| !tracked.iter().any(|known| known == named))
        .collect();

    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--worktree", "--"];
        args.extend(tracked.iter().map(String::as_str));
        spoke_or_refused(run_git(&repo, &args).await?)?;
    }
    if !untracked.is_empty() {
        spoke_or_refused(clean_away(&repo, &untracked).await?)?;
    }

    Ok(did_it())
}

/// Delete files git has never been told about.
///
/// # Endpoint
///
/// `POST /api/git/remove` — `{ path, files }`
///
/// Destructive, and the panel asks first. `git clean` only ever touches
/// untracked files, so a tracked path sent here by mistake is left exactly
/// where it is rather than deleted — the safe way round.
pub async fn remove(GitJson(body): GitJson<FilesRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    // No `all` here on purpose. Deleting every untracked file at once is what
    // "Discard all" is for, and it is reached by its own button and its own
    // confirmation.
    if body.files.is_empty() {
        return Err(Refused::new(
            StatusCode::BAD_REQUEST,
            "No files were named".to_string(),
        ));
    }

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    let named: Vec<&str> = body.files.iter().map(String::as_str).collect();
    spoke_or_refused(clean_away(&repo, &named).await?)?;
    Ok(did_it())
}

/// `git clean` over the named paths — never `-x`, so what the project ignores
/// stays on disk.
async fn clean_away(repo: &Path, files: &[&str]) -> Result<Output, Refused> {
    let mut args: Vec<&str> = vec!["clean", "-fdq", "--"];
    args.extend(files.iter().copied());
    run_git(repo, &args).await
}

// ----------------------------------------------------------------------------
// POST /api/git/commit
// ----------------------------------------------------------------------------

/// Request body for saving the picked files.
#[derive(Deserialize)]
pub struct CommitRequest {
    /// Absolute working directory of the repository.
    pub path: String,
    /// The message the user typed.
    pub message: String,
    /// Rewrite the last commit rather than adding one.
    #[serde(default)]
    pub amend: bool,
}

/// Save the picked files under a message.
///
/// Nothing here says who is saving or whether to sign it: `git commit` reads
/// `user.name`, `user.email` and `commit.gpgsign` from the user's own config,
/// which is the identity the rest of their tooling already uses.
///
/// # Endpoint
///
/// `POST /api/git/commit` — `{ path, message, amend? }` → `{ sha }`
pub async fn commit(GitJson(body): GitJson<CommitRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    let mut args = vec!["commit", "-m", body.message.as_str()];
    if body.amend {
        args.push("--amend");
    }
    spoke_or_refused(run_git(&repo, &args).await?)?;

    let head = spoke_or_refused(run_git(&repo, &["rev-parse", "HEAD"]).await?)?;
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    Ok(Json(serde_json::json!({ "sha": sha })).into_response())
}

// ----------------------------------------------------------------------------
// POST /api/git/fetch, /api/git/pull, /api/git/push
// ----------------------------------------------------------------------------

/// Request body for the routes that need nothing but the repository.
#[derive(Deserialize)]
pub struct PathRequest {
    /// Absolute working directory of the repository.
    pub path: String,
    /// The passphrase for the SSH key, when the reader has just been asked for
    /// one. Used for this call and this call only — never stored, never
    /// logged, and gone with the helper that read it.
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// How far the current branch sits from its upstream, or zeroes if it has none.
async fn distance_from_upstream(repo: &Path) -> (i32, i32) {
    let counted = run_git(
        repo,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .await;
    let Ok(counted) = counted else { return (0, 0) };
    if !counted.status.success() {
        return (0, 0);
    }
    let counts = String::from_utf8_lossy(&counted.stdout);
    let mut counts = counts.split_whitespace();
    let ahead = counts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = counts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

/// Ask the shared copy what it has, without taking any of it.
///
/// # Endpoint
///
/// `POST /api/git/fetch` — `{ path }` → `{ ahead, behind }`
pub async fn fetch(GitJson(body): GitJson<PathRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    spoke_or_refused(run_git_remote(&repo, &["fetch"], body.passphrase.as_deref()).await?)?;
    let (ahead, behind) = distance_from_upstream(&repo).await;
    Ok(Json(serde_json::json!({ "ahead": ahead, "behind": behind })).into_response())
}

/// Bring in what the shared copy has.
///
/// # Endpoint
///
/// `POST /api/git/pull` — `{ path }` → `{ ok, output }`
pub async fn pull(GitJson(body): GitJson<PathRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    let output =
        spoke_or_refused(run_git_remote(&repo, &["pull"], body.passphrase.as_deref()).await?)?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "output": everything_git_printed(&output),
    }))
    .into_response())
}

/// Request body for sending saved changes back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    /// Absolute working directory of the repository.
    pub path: String,
    /// Give this branch a shared copy to follow, on `origin`.
    #[serde(default)]
    pub set_upstream: bool,
    /// The passphrase for the SSH key, when the reader has just been asked for
    /// one. Used for this call and this call only — never stored, never
    /// logged, and gone with the helper that read it.
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// Send saved changes to the shared copy.
///
/// # Endpoint
///
/// `POST /api/git/push` — `{ path, setUpstream? }` → `{ ok, output }`
pub async fn push(GitJson(body): GitJson<PushRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    // `HEAD` rather than a branch name looked up first: git resolves it to the
    // branch that is checked out and gives the shared copy's branch the same
    // name — what `git push -u origin HEAD` means to anyone who types it.
    let args: Vec<&str> = if body.set_upstream {
        vec!["push", "--set-upstream", "origin", "HEAD"]
    } else {
        vec!["push"]
    };

    let output =
        spoke_or_refused(run_git_remote(&repo, &args, body.passphrase.as_deref()).await?)?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "output": everything_git_printed(&output),
    }))
    .into_response())
}

// ----------------------------------------------------------------------------
// GET /api/git/branches, POST /api/git/checkout
// ----------------------------------------------------------------------------

/// One line of work.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    /// Short name, as a person would type it.
    pub name: String,
    /// The shared copy it follows, if it follows one.
    pub upstream: Option<String>,
    /// Commits it has that its upstream does not.
    pub ahead: i32,
    /// Commits its upstream has that it does not.
    pub behind: i32,
    /// Whether this lives on the shared copy rather than here.
    pub is_remote: bool,
}

/// Every line of work a project holds, and which one it is on.
#[derive(Serialize, Debug)]
pub struct BranchesResponse {
    /// The branch that is checked out, or the short commit when detached.
    pub current: String,
    /// Every branch, local ones first as git lists them.
    pub branches: Vec<BranchEntry>,
}

/// `%(HEAD)`, the full ref, the short ref, its upstream and how far it has
/// drifted — tab separated, because a ref name can never contain a tab.
const BRANCH_FORMAT: &str =
    "--format=%(HEAD)%09%(refname)%09%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)";

/// Read `%(upstream:track,nobracket)`: `ahead 1, behind 2`, `gone`, or nothing.
fn read_drift(track: &str) -> (i32, i32) {
    let mut ahead = 0;
    let mut behind = 0;
    for piece in track.split(',') {
        let piece = piece.trim();
        if let Some(n) = piece.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = piece.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// List the lines of work a project holds.
///
/// # Endpoint
///
/// `GET /api/git/branches?path=...`
pub async fn branches(GitQuery(params): GitQuery<PathParams>) -> Answer {
    let repo = checked_repo(&params.path)?;

    let listed = spoke_or_refused(
        run_git(
            &repo,
            &["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"],
        )
        .await?,
    )?;

    let listed = String::from_utf8_lossy(&listed.stdout);
    let mut current = String::new();
    let mut branches = Vec::new();

    for line in listed.lines() {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.splitn(5, '\t');
        let head = fields.next().unwrap_or("");
        let Some(full) = fields.next() else { continue };
        let Some(name) = fields.next() else { continue };
        let upstream = fields.next().unwrap_or("");
        let track = fields.next().unwrap_or("");

        // `origin/HEAD` points at another branch; it is not a line of work.
        if full.ends_with("/HEAD") {
            continue;
        }
        if head == "*" {
            current = name.to_string();
        }

        let (ahead, behind) = read_drift(track);
        branches.push(BranchEntry {
            name: name.to_string(),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            ahead,
            behind,
            is_remote: full.starts_with("refs/remotes/"),
        });
    }

    // Nothing is marked when HEAD is detached, so name the commit instead.
    if current.is_empty() {
        if let Ok(head) = run_git(&repo, &["rev-parse", "--short", "HEAD"]).await {
            if head.status.success() {
                current = String::from_utf8_lossy(&head.stdout).trim().to_string();
            }
        }
    }

    Ok(Json(BranchesResponse { current, branches }).into_response())
}

/// Request body for switching lines of work.
#[derive(Deserialize)]
pub struct CheckoutRequest {
    /// Absolute working directory of the repository.
    pub path: String,
    /// The branch to move to.
    pub branch: String,
    /// Start it here rather than expecting it to exist.
    #[serde(default)]
    pub create: bool,
}

/// Switch to another line of work.
///
/// # Endpoint
///
/// `POST /api/git/checkout` — `{ path, branch, create? }` → `{ ok }`
pub async fn checkout(GitJson(body): GitJson<CheckoutRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    let args: Vec<&str> = if body.create {
        vec!["checkout", "-b", body.branch.as_str()]
    } else {
        vec!["checkout", body.branch.as_str()]
    };

    spoke_or_refused(run_git(&repo, &args).await?)?;
    Ok(did_it())
}

// ----------------------------------------------------------------------------
// GET /api/git/log
// ----------------------------------------------------------------------------

/// Query parameters for reading recent saved changes.
#[derive(Deserialize)]
pub struct LogParams {
    /// Absolute working directory of the repository.
    pub path: String,
    /// How many to read back.
    #[serde(default = "fifty")]
    pub limit: u32,
}

fn fifty() -> u32 {
    50
}

/// One saved change.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    /// The full commit name.
    pub sha: String,
    /// The commit name as git abbreviates it.
    pub short_sha: String,
    /// Who wrote it.
    pub author: String,
    /// Their email.
    pub email: String,
    /// When they wrote it, ISO 8601.
    pub date: String,
    /// The first line of the message.
    pub subject: String,
}

/// Recent saved changes.
#[derive(Serialize, Debug)]
pub struct LogResponse {
    /// Newest first.
    pub commits: Vec<CommitEntry>,
}

/// Tab separated for the same reason as the branch format, and NUL separated
/// between commits (`-z`) so a message can hold anything it likes.
const LOG_FORMAT: &str = "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s";

/// Read recent saved changes.
///
/// # Endpoint
///
/// `GET /api/git/log?path=...&limit=50`
pub async fn log(GitQuery(params): GitQuery<LogParams>) -> Answer {
    let repo = checked_repo(&params.path)?;

    let how_many = params.limit.clamp(1, 1000).to_string();
    let read = run_git(&repo, &["log", "-z", LOG_FORMAT, "-n", &how_many]).await?;

    if !read.status.success() {
        // A project nobody has saved anything in yet has an empty history,
        // which is not a failure worth showing anyone.
        if !has_commits(&repo).await {
            return Ok(Json(LogResponse { commits: Vec::new() }).into_response());
        }
        return Err(git_said_no(&read));
    }

    let read = String::from_utf8_lossy(&read.stdout);
    let commits = read
        .split('\0')
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let mut fields = record.splitn(6, '\t');
            Some(CommitEntry {
                sha: fields.next()?.to_string(),
                short_sha: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                email: fields.next()?.to_string(),
                date: fields.next()?.to_string(),
                subject: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect();

    Ok(Json(LogResponse { commits }).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(repo: &Path, args: &[&str]) -> String {
        let found = crate::routes::find_git().expect("git on the computer running these tests");
        let output = std::process::Command::new(found)
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn test_branch_status_response_serialization() {
        let response = BranchStatusResponse {
            exists: true,
            ahead: 5,
            behind: 2,
            dirty: false,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"exists\":true"));
        assert!(json.contains("\"ahead\":5"));
        assert!(json.contains("\"behind\":2"));
        assert!(json.contains("\"dirty\":false"));
    }

    #[tokio::test]
    async fn branch_exists_distinguishes_lines_of_work_from_other_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q"]);
        git(repo, &["config", "user.name", "Atelier test"]);
        git(repo, &["config", "user.email", "atelier@example.invalid"]);
        std::fs::write(repo.join("kept"), "one\n").unwrap();
        git(repo, &["add", "kept"]);
        git(repo, &["commit", "-qm", "first"]);
        git(repo, &["branch", "real-work"]);
        git(repo, &["tag", "release-name"]);
        let revision = git(repo, &["rev-parse", "HEAD"]);

        assert!(check_branch_exists(repo, "real-work").await);
        assert!(!check_branch_exists(repo, "release-name").await);
        assert!(!check_branch_exists(repo, &revision).await);
    }

    /// With nothing carried, the remote call still goes through ssh — the
    /// plain one — and it is the added switch that keeps it from asking.
    #[test]
    fn a_setup_that_carries_no_ssh_command_gets_a_plain_one_that_cannot_ask() {
        assert_eq!(with_batch_mode(None, None), "ssh -o BatchMode=yes");
    }

    /// A user who has told git which key to use, or which ssh to run, keeps
    /// it. Turning off the asking must not turn off their setup with it.
    #[test]
    fn an_ssh_command_the_setup_carries_is_kept_underneath_the_switch() {
        assert_eq!(
            with_batch_mode(None, Some("ssh -i /keys/deploy".to_string())),
            "ssh -i /keys/deploy -o BatchMode=yes"
        );
        assert_eq!(
            with_batch_mode(Some("ssh -F /etc/ssh_conf".to_string()), None),
            "ssh -F /etc/ssh_conf -o BatchMode=yes"
        );
    }

    /// git reads `GIT_SSH_COMMAND` ahead of `core.sshCommand`, and so does
    /// this: were it the other way round, a remote call would run an ssh git
    /// itself would not have run.
    #[test]
    fn the_environment_is_read_ahead_of_the_repositorys_own_config() {
        assert_eq!(
            with_batch_mode(
                Some("ssh -i /keys/from-env".to_string()),
                Some("ssh -i /keys/from-config".to_string()),
            ),
            "ssh -i /keys/from-env -o BatchMode=yes"
        );
    }

    /// An empty variable is not a command. Left in front, it would put a bare
    /// `-o BatchMode=yes` where the program name belongs.
    #[test]
    fn an_empty_ssh_command_is_not_mistaken_for_one() {
        assert_eq!(
            with_batch_mode(Some("   ".to_string()), Some("ssh -i /keys/real".to_string())),
            "ssh -i /keys/real -o BatchMode=yes"
        );
        assert_eq!(with_batch_mode(Some(String::new()), None), "ssh -o BatchMode=yes");
    }

    /// What a refusal put on the wire, so a test can read the answer the panel
    /// will read rather than the struct behind it.
    async fn answered(refused: Refused) -> (StatusCode, serde_json::Value) {
        let response = refused.into_response();
        let code = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (code, serde_json::from_slice(&bytes).unwrap())
    }

    /// The one refusal a passphrase could clear, in every wording ssh gives
    /// it. The parenthesis is left open on purpose: ssh lists the methods it
    /// tried, so the tail differs from setup to setup.
    #[test]
    fn a_key_refusal_is_recognised_however_ssh_lists_its_methods() {
        assert!(a_key_could_fix_it(
            "git@github.com: Permission denied (publickey)."
        ));
        assert!(a_key_could_fix_it(
            "git@example.com: Permission denied (publickey,gssapi-keyex,gssapi-with-mic)."
        ));
        assert!(a_key_could_fix_it(
            "Load key \"/home/someone/.ssh/id_ed25519\": incorrect passphrase supplied to decrypt private key"
        ));
    }

    /// Everything else keeps the refusal it had. Offering to unlock a key for
    /// a rejected push or an HTTPS password would send the reader looking for
    /// a passphrase that was never the trouble.
    #[test]
    fn the_offer_is_not_made_for_refusals_a_key_cannot_clear() {
        assert!(!a_key_could_fix_it(
            "remote: Support for password authentication was removed.\nfatal: Authentication failed for 'https://github.com/o/r.git/'"
        ));
        assert!(!a_key_could_fix_it(
            " ! [rejected]        main -> main (non-fast-forward)"
        ));
        assert!(!a_key_could_fix_it("CONFLICT (content): Merge conflict in kept"));
        assert!(!a_key_could_fix_it("nothing to commit, working tree clean"));
    }

    /// The answer the panel reads: its own status, the flag, and git's words
    /// still leading.
    #[tokio::test]
    async fn a_key_refusal_is_answered_apart_from_every_other_one() {
        let denied = "git@github.com: Permission denied (publickey).";
        let output = std::process::Output {
            status: failed_status(),
            stdout: Vec::new(),
            stderr: denied.as_bytes().to_vec(),
        };

        let (code, body) = answered(git_said_no(&output)).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert_eq!(body["needsPassphrase"], serde_json::json!(true));
        assert_eq!(body["error"], serde_json::json!(denied));
    }

    /// An ordinary refusal is untouched: the status it always had, and no flag
    /// at all rather than a `false` a reader could take for a considered no.
    #[tokio::test]
    async fn an_ordinary_refusal_carries_no_offer_of_a_passphrase() {
        let output = std::process::Output {
            status: failed_status(),
            stdout: Vec::new(),
            stderr: b" ! [rejected] main -> main (fetch first)".to_vec(),
        };

        let (code, body) = answered(git_said_no(&output)).await;
        assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body.get("needsPassphrase").is_none());
    }

    /// A nonzero exit to build the two refusals above out of.
    fn failed_status() -> std::process::ExitStatus {
        let found = crate::routes::find_git().expect("git on the computer running these tests");
        std::process::Command::new(found)
            .args(["rev-parse", "--verify", "definitely-not-a-revision"])
            .current_dir(std::env::temp_dir())
            .output()
            .unwrap()
            .status
    }

    /// The helper carries no secret of its own: it reads the one name the
    /// server puts the passphrase under. Were the two to drift apart, ssh
    /// would be handed an empty line and the unlock would fail for no visible
    /// reason.
    #[test]
    fn the_helper_reads_the_name_the_passphrase_is_sent_under() {
        assert!(ASKPASS_HELPER.contains(PASSPHRASE_VARIABLE));
    }

    /// What ssh gets when it runs the helper: the passphrase, and only the
    /// passphrase. Run as a program, the way ssh runs it, with the prompt it
    /// would have shown passed along as ssh passes it.
    #[cfg(unix)]
    #[test]
    fn the_helper_hands_ssh_the_passphrase_it_was_given() {
        let helper = askpass_for_one_call().unwrap();

        let said = std::process::Command::new(&helper.program)
            .arg("Enter passphrase for key '/home/someone/.ssh/id_ed25519': ")
            .env(PASSPHRASE_VARIABLE, "open sesame")
            .output()
            .unwrap();

        assert!(said.status.success());
        assert_eq!(String::from_utf8_lossy(&said.stdout), "open sesame\n");
    }

    /// The passphrase is never written down. The program on disk is the same
    /// bytes whatever the secret is, and it is readable by nobody but its
    /// owner — as is the directory it sits in, so no one else can put a
    /// different program there for ssh to run instead.
    #[cfg(unix)]
    #[test]
    fn nothing_of_the_passphrase_is_left_on_disk_and_nobody_else_may_look() {
        use std::os::unix::fs::PermissionsExt;

        let helper = askpass_for_one_call().unwrap();
        let written = std::fs::read_to_string(&helper.program).unwrap();
        assert_eq!(written, ASKPASS_HELPER);
        assert!(!written.contains("open sesame"));

        let mode = |at: &Path| std::fs::metadata(at).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&helper.program), 0o700);
        assert_eq!(mode(helper.program.parent().unwrap()), 0o700);
    }

    /// Letting go of the helper takes it off disk, which is what makes it last
    /// exactly one call.
    #[cfg(unix)]
    #[test]
    fn the_helper_goes_away_when_it_is_let_go() {
        let helper = askpass_for_one_call().unwrap();
        let was_at = helper.program.clone();
        assert!(was_at.exists());

        drop(helper);
        assert!(!was_at.exists());
    }

    /// The whole chain, through git and the ssh git runs: a passphrase handed
    /// to the route reaches ssh, and the helper it came through is gone by the
    /// time the call answers — even though this call fails, which is the way
    /// round that would leave it behind if it were only removed on success.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_passphrase_reaches_ssh_and_the_helper_is_gone_afterwards() {
        use std::os::unix::fs::PermissionsExt;

        if std::env::var("GIT_SSH_COMMAND").is_ok_and(|carried| !carried.trim().is_empty()) {
            eprintln!("skipped: GIT_SSH_COMMAND is set, so this test cannot choose the ssh");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q"]);

        // Stands in for ssh meeting a locked key: it asks the way ssh asks —
        // by running whatever `SSH_ASKPASS` names — writes down both the
        // answer and where it had to go for it, then refuses like ssh does.
        let told = repo.join("what-ssh-was-told");
        let fake_ssh = repo.join("ssh-that-asks");
        std::fs::write(
            &fake_ssh,
            format!(
                "#!/bin/sh\n\
                 echo \"$SSH_ASKPASS\" > {told}\n\
                 \"$SSH_ASKPASS\" 'Enter passphrase: ' >> {told}\n\
                 echo 'git@example.invalid: Permission denied (publickey).' >&2\n\
                 exit 255\n",
                told = told.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(repo, &["config", "core.sshCommand", fake_ssh.to_str().unwrap()]);
        git(repo, &["remote", "add", "origin", "git@example.invalid:some/repo.git"]);

        let answered = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            run_git_remote(repo, &["fetch", "origin"], Some("open sesame")),
        )
        .await
        .expect("the call answered rather than waiting on a prompt")
        .expect("git ran");
        assert!(!answered.status.success());

        let told = std::fs::read_to_string(&told).expect("ssh was asked to authenticate");
        let (helper_was_at, given) = told.split_once('\n').unwrap();
        assert_eq!(
            given.trim(),
            "open sesame",
            "ssh should be handed the passphrase the request carried"
        );
        assert!(
            !Path::new(helper_was_at).exists(),
            "the helper should be gone once the call is over, and this one failed"
        );
    }

    /// The two ways of running ssh are exclusive, and this is why: `BatchMode`
    /// turns off the asking altogether, the helper included, so a call that
    /// means to answer a passphrase must not carry it. The no-passphrase call
    /// sets it; the passphrase call leaves the ssh command alone.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_call_carrying_a_passphrase_does_not_also_forbid_the_asking() {
        if std::env::var("GIT_SSH_COMMAND").is_ok_and(|carried| !carried.trim().is_empty()) {
            eprintln!("skipped: GIT_SSH_COMMAND is set, so this test cannot choose the ssh");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q"]);
        git(repo, &["config", "core.sshCommand", "ssh -i /keys/theirs"]);

        // What the no-passphrase call runs.
        assert_eq!(
            ssh_that_cannot_ask(repo).await,
            "ssh -i /keys/theirs -o BatchMode=yes"
        );
    }

    /// The point of the switch: a remote call against a copy whose ssh cannot
    /// let anyone in comes back and says so, rather than sitting on a
    /// passphrase prompt that no one in front of the app can answer.
    ///
    /// The fake ssh here is the test's stand-in for a locked key: it is what
    /// `ssh` would be if it could never authenticate. Were the switch missing,
    /// a real locked key would stop at a prompt on the server's own terminal
    /// and this call would never return; the deadline is what fails the test.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_remote_call_that_cannot_get_in_answers_instead_of_waiting() {
        use std::os::unix::fs::PermissionsExt;

        // The test picks its ssh through `core.sshCommand`, which a
        // `GIT_SSH_COMMAND` in the environment running the tests would beat —
        // correctly, and the precedence tests above cover that. There is then
        // no way to say which ssh git runs, so there is nothing here to prove.
        if std::env::var("GIT_SSH_COMMAND").is_ok_and(|carried| !carried.trim().is_empty()) {
            eprintln!("skipped: GIT_SSH_COMMAND is set, so this test cannot choose the ssh");
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q"]);

        // Refuses exactly as ssh does when no key it can offer is accepted.
        let fake_ssh = repo.join("ssh-that-never-gets-in");
        std::fs::write(
            &fake_ssh,
            "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(repo, &["config", "core.sshCommand", fake_ssh.to_str().unwrap()]);
        git(repo, &["remote", "add", "origin", "git@example.invalid:some/repo.git"]);

        let answered = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            run_git_remote(repo, &["fetch", "origin"], None),
        )
        .await
        .expect("the call answered rather than waiting on a prompt")
        .expect("git ran");

        assert!(!answered.status.success());
        assert!(
            String::from_utf8_lossy(&answered.stderr).contains("Permission denied (publickey)"),
            "the reader should get ssh's own words back: {}",
            String::from_utf8_lossy(&answered.stderr)
        );
    }
}

#[cfg(test)]
mod porcelain_tests {
    use super::*;

    /// The exact framing `git status --porcelain=v2 -z` produces: NUL after
    /// every record, and a second NUL-separated record after a rename holding
    /// the path the file came from.
    const SAMPLE: &str = concat!(
        "# branch.oid 4e4cffc8ac33e870bf9f869f0b3a7e840091fcb3\0",
        "# branch.head main\0",
        "# branch.upstream origin/main\0",
        "# branch.ab +3 -4\0",
        "1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 3e75765 added.txt\0",
        "1 MM N... 100644 100644 100644 5626abf 5626abf spaced name.txt\0",
        "1 .D N... 100644 100644 000000 5626abf 5626abf gone.txt\0",
        "1 .T N... 100644 100644 120000 5626abf 5626abf now a link\0",
        "2 RM N... 100644 100644 100644 dcc2780 dcc2780 R100 new name.txt\0",
        "old name.txt\0",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc fought over.txt\0",
        "? loose file.txt\0",
        "! ignored.txt\0",
    );

    #[test]
    fn the_branch_header_is_read() {
        let status = read_porcelain_v2(SAMPLE.as_bytes());
        assert_eq!(status.branch, "main");
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 3);
        assert_eq!(status.behind, 4);
        assert!(!status.detached);
    }

    #[test]
    fn a_rename_keeps_the_path_it_came_from_and_is_not_read_as_an_entry() {
        let status = read_porcelain_v2(SAMPLE.as_bytes());

        let renamed = status
            .staged
            .iter()
            .find(|f| f.path == "new name.txt")
            .expect("the renamed file is staged");
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));

        // The second half of the rename record is a path, not an entry: it
        // must not turn up anywhere as a file of its own.
        assert!(!status.staged.iter().any(|f| f.path == "old name.txt"));
        assert!(!status.unstaged.iter().any(|f| f.path == "old name.txt"));
        assert!(!status.untracked.iter().any(|f| f.path == "old name.txt"));
    }

    #[test]
    fn each_letter_lands_on_the_side_it_belongs_to() {
        let status = read_porcelain_v2(SAMPLE.as_bytes());

        let staged: Vec<_> = status
            .staged
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert!(staged.contains(&("added.txt", "added")));
        assert!(staged.contains(&("spaced name.txt", "modified")));
        assert!(staged.contains(&("new name.txt", "renamed")));

        let unstaged: Vec<_> = status
            .unstaged
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str()))
            .collect();
        assert!(unstaged.contains(&("spaced name.txt", "modified")));
        assert!(unstaged.contains(&("gone.txt", "deleted")));
        assert!(unstaged.contains(&("now a link", "typechange")));
        // A rename lives in the index; the working-tree change on top of it
        // carries no original path.
        let also_modified = status
            .unstaged
            .iter()
            .find(|f| f.path == "new name.txt")
            .expect("the renamed file was modified afterwards");
        assert_eq!(also_modified.orig_path, None);

        // `A.` and `.D` each belong to one side only.
        assert!(!status.unstaged.iter().any(|f| f.path == "added.txt"));
        assert!(!status.staged.iter().any(|f| f.path == "gone.txt"));
    }

    #[test]
    fn unmerged_untracked_and_ignored_are_told_apart() {
        let status = read_porcelain_v2(SAMPLE.as_bytes());
        assert_eq!(
            status.conflicted,
            vec![NamedPath { path: "fought over.txt".to_string() }]
        );
        assert_eq!(
            status.untracked,
            vec![NamedPath { path: "loose file.txt".to_string() }]
        );
        // An unmerged file is not also a change on either side.
        assert!(!status.staged.iter().any(|f| f.path == "fought over.txt"));
        assert!(!status.unstaged.iter().any(|f| f.path == "fought over.txt"));
        // `!` records are ignored files and are never reported.
        assert!(!status.untracked.iter().any(|f| f.path == "ignored.txt"));
    }

    #[test]
    fn a_detached_head_is_named_by_its_commit() {
        let raw = concat!(
            "# branch.oid 4e4cffc8ac33e870bf9f869f0b3a7e840091fcb3\0",
            "# branch.head (detached)\0",
        );
        let status = read_porcelain_v2(raw.as_bytes());
        assert!(status.detached);
        assert_eq!(status.branch, "4e4cffc");
    }

    #[test]
    fn nothing_at_all_parses_to_nothing_at_all() {
        let status = read_porcelain_v2(b"");
        assert!(status.staged.is_empty());
        assert!(status.unstaged.is_empty());
        assert!(status.untracked.is_empty());
        assert!(status.conflicted.is_empty());
    }

    #[test]
    fn drift_is_read_off_the_track_field() {
        assert_eq!(read_drift("ahead 1, behind 2"), (1, 2));
        assert_eq!(read_drift("ahead 7"), (7, 0));
        assert_eq!(read_drift("behind 9"), (0, 9));
        assert_eq!(read_drift("gone"), (0, 0));
        assert_eq!(read_drift(""), (0, 0));
    }
}
