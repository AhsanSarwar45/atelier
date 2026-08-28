//! Git route handlers for reading and changing a project's repository.
//!
//! Every route is handed an absolute working directory, runs it through
//! [`validate_path_security`], and then shells out to the real `git` binary.

use axum::{
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::process::Command;
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
pub async fn branch_status(Query(params): Query<GitStatusParams>) -> impl IntoResponse {
    let repo_path = Path::new(&params.path);

    if let Err(e) = validate_path_security(repo_path) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e }))).into_response();
    }

    // Validate repository path exists
    if !repo_path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Repository path does not exist: {}", params.path)
            })),
        )
            .into_response();
    }

    if !repo_path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Path is not a directory: {}", params.path)
            })),
        )
            .into_response();
    }

    // Check if branch exists
    let branch_exists = check_branch_exists(&params.path, &params.branch).await;

    if !branch_exists {
        return Json(BranchStatusResponse {
            exists: false,
            ahead: 0,
            behind: 0,
            dirty: false,
        })
        .into_response();
    }

    // Get ahead/behind counts relative to main
    let (ahead, behind) = get_ahead_behind(&params.path, &params.branch).await;

    // Check for uncommitted changes
    let dirty = check_dirty(&params.path).await;

    Json(BranchStatusResponse {
        exists: true,
        ahead,
        behind,
        dirty,
    })
    .into_response()
}

/// Check if a branch exists in the repository.
async fn check_branch_exists(repo_path: &str, branch: &str) -> bool {
    let output = Command::new("git")
        .args(["rev-parse", "--verify", branch])
        .current_dir(repo_path)
        .output()
        .await;

    matches!(output, Ok(o) if o.status.success())
}

/// Get the number of commits ahead and behind relative to main.
async fn get_ahead_behind(repo_path: &str, branch: &str) -> (i32, i32) {
    // Try both 'main' and 'master' as the base branch
    let base_branches = ["main", "master"];

    for base in base_branches {
        let output = Command::new("git")
            .args([
                "rev-list",
                "--left-right",
                "--count",
                &format!("{}...{}", base, branch),
            ])
            .current_dir(repo_path)
            .output()
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
async fn check_dirty(repo_path: &str) -> bool {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await;

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
pub struct Refused(StatusCode, String);

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

/// Either the answer or the refusal; axum turns whichever arrives into the
/// response, so a handler can hand back the first one it reaches.
pub type Answer = Result<Response, Refused>;

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
        return Err(Refused(StatusCode::FORBIDDEN, e));
    }

    if !repo.exists() {
        return Err(Refused(
            StatusCode::BAD_REQUEST,
            format!("Repository path does not exist: {}", path),
        ));
    }

    if !repo.is_dir() {
        return Err(Refused(
            StatusCode::BAD_REQUEST,
            format!("Path is not a directory: {}", path),
        ));
    }

    Ok(repo.to_path_buf())
}

/// Run git in `repo` and hand back everything it produced.
async fn run_git(repo: &Path, args: &[&str]) -> Result<Output, Refused> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .await
        .map_err(could_not_run)
}

/// Run a git command that talks to the shared copy.
///
/// `GIT_TERMINAL_PROMPT=0` is the one thing added to the environment: this
/// server has no terminal, so a credential prompt would leave the request
/// hanging for ever instead of answering. Everything else — the SSH keys,
/// ssh-agent, `credential.helper`, the whole gitconfig — is inherited
/// untouched, which is the entire reason this shells out to git.
async fn run_git_remote(repo: &Path, args: &[&str]) -> Result<Output, Refused> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(could_not_run)
}

/// git could not be started at all — a missing binary, not a git refusal.
fn could_not_run(e: std::io::Error) -> Refused {
    Refused(
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
    Refused(StatusCode::UNPROCESSABLE_ENTITY, said)
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
pub async fn status(Query(params): Query<PathParams>) -> Answer {
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
    pub files: Vec<String>,
}

/// Pick files to be saved.
///
/// # Endpoint
///
/// `POST /api/git/stage` — `{ path, files }`
pub async fn stage(Json(body): Json<FilesRequest>) -> Answer {
    change_the_index(body, &["add", "--"]).await
}

/// Put picked files back.
///
/// # Endpoint
///
/// `POST /api/git/unstage` — `{ path, files }`
pub async fn unstage(Json(body): Json<FilesRequest>) -> Answer {
    change_the_index(body, &["restore", "--staged", "--"]).await
}

async fn change_the_index(body: FilesRequest, verb: &[&str]) -> Answer {
    let repo = checked_repo(&body.path)?;

    // `git add --` with nothing after it succeeds and does nothing, which
    // would read back as a stage that worked. Say what happened instead.
    if body.files.is_empty() {
        return Err(Refused(
            StatusCode::BAD_REQUEST,
            "No files were named".to_string(),
        ));
    }

    let mut args: Vec<&str> = verb.to_vec();
    args.extend(body.files.iter().map(String::as_str));

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    spoke_or_refused(run_git(&repo, &args).await?)?;
    Ok(did_it())
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
pub async fn commit(Json(body): Json<CommitRequest>) -> Answer {
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
pub async fn fetch(Json(body): Json<PathRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    spoke_or_refused(run_git_remote(&repo, &["fetch"]).await?)?;
    let (ahead, behind) = distance_from_upstream(&repo).await;
    Ok(Json(serde_json::json!({ "ahead": ahead, "behind": behind })).into_response())
}

/// Bring in what the shared copy has.
///
/// # Endpoint
///
/// `POST /api/git/pull` — `{ path }` → `{ ok, output }`
pub async fn pull(Json(body): Json<PathRequest>) -> Answer {
    let repo = checked_repo(&body.path)?;

    let turn = repo_lock(&repo);
    let _holding = turn.lock().await;

    let output = spoke_or_refused(run_git_remote(&repo, &["pull"]).await?)?;
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
}

/// Send saved changes to the shared copy.
///
/// # Endpoint
///
/// `POST /api/git/push` — `{ path, setUpstream? }` → `{ ok, output }`
pub async fn push(Json(body): Json<PushRequest>) -> Answer {
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

    let output = spoke_or_refused(run_git_remote(&repo, &args).await?)?;
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
pub async fn branches(Query(params): Query<PathParams>) -> Answer {
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
pub async fn checkout(Json(body): Json<CheckoutRequest>) -> Answer {
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
pub async fn log(Query(params): Query<LogParams>) -> Answer {
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
