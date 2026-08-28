//! The Git panel's routes, exercised against the real `git` binary.
//!
//! Every case here builds a throwaway repository on disk, seeds it with real
//! commits, and calls the route handlers themselves — nothing is stubbed and
//! no git output is invented. The repositories are made under the crate's own
//! target directory, both because that is inside the home directory
//! `validate_path_security` insists on and because it is thrown away with the
//! rest of the build.

use atelier::routes::git;
use axum::body::to_bytes;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::DateTime;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tempfile::TempDir;

// ----------------------------------------------------------------------------
// Building a throwaway project
// ----------------------------------------------------------------------------

/// An empty directory that goes away with the test.
fn scratch() -> TempDir {
    let base = Path::new(env!("CARGO_TARGET_TMPDIR")).join("git-panel");
    fs::create_dir_all(&base).expect("a place to put throwaway projects");
    TempDir::new_in(base).expect("a throwaway directory")
}

/// Run git and insist it worked.
fn run(at: &Path, args: &[&str]) -> String {
    let done = Command::new("git")
        .args(args)
        .current_dir(at)
        .output()
        .expect("git is on the path");
    assert!(
        done.status.success(),
        "git {:?} failed:\n{}",
        args,
        String::from_utf8_lossy(&done.stderr)
    );
    String::from_utf8_lossy(&done.stdout).trim().to_string()
}

/// Run git and let it fail — for seeding a merge conflict on purpose.
fn run_anyway(at: &Path, args: &[&str]) {
    let _ = Command::new("git").args(args).current_dir(at).output();
}

/// Pin down everything the person running the tests might have set globally,
/// so what these cases assert comes from the repository and not from them.
fn settle(at: &Path) {
    for (key, value) in [
        ("user.name", "Atelier Tester"),
        ("user.email", "tester@atelier.test"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("pull.rebase", "false"),
        ("push.default", "simple"),
        ("push.autoSetupRemote", "false"),
        ("core.hooksPath", "hooks-that-are-not-there"),
        ("advice.detachedHead", "false"),
    ] {
        run(at, &["config", key, value]);
    }
}

/// A repository with nothing saved in it yet.
fn a_repo() -> TempDir {
    let dir = scratch();
    run(dir.path(), &["init", "-q", "-b", "main", "."]);
    settle(dir.path());
    dir
}

/// A bare repository standing in for the shared copy.
fn a_shared_copy() -> TempDir {
    let dir = scratch();
    run(dir.path(), &["init", "-q", "--bare", "-b", "main", "."]);
    dir
}

/// Write a file into the project.
fn put(at: &Path, name: &str, body: &str) {
    let file = at.join(name);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).expect("a folder for the file");
    }
    fs::write(file, body).expect("the file is written");
}

/// Save everything, under a message.
fn save_all(at: &Path, message: &str) -> String {
    run(at, &["add", "-A"]);
    run(at, &["commit", "-q", "-m", message]);
    run(at, &["rev-parse", "HEAD"])
}

/// The absolute path a route is handed.
fn here(dir: &TempDir) -> String {
    dir.path().display().to_string()
}

// ----------------------------------------------------------------------------
// Reading what a route answered
// ----------------------------------------------------------------------------

/// Unwrap a route's answer into a status and a body, whichever way it went.
async fn answered(answer: git::Answer) -> (StatusCode, Value) {
    let response = match answer {
        Ok(response) => response,
        Err(refusal) => refusal.into_response(),
    };
    let code = response.status();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("a body");
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).expect("the body is JSON")
    };
    (code, value)
}

async fn status_of(dir: &TempDir) -> (StatusCode, Value) {
    answered(git::status(Query(git::PathParams { path: here(dir) })).await).await
}

async fn branches_of(dir: &TempDir) -> (StatusCode, Value) {
    answered(git::branches(Query(git::PathParams { path: here(dir) })).await).await
}

async fn log_of(dir: &TempDir, limit: u32) -> (StatusCode, Value) {
    answered(
        git::log(Query(git::LogParams {
            path: here(dir),
            limit,
        }))
        .await,
    )
    .await
}

async fn stage(dir: &TempDir, files: &[&str]) -> (StatusCode, Value) {
    answered(
        git::stage(Json(git::FilesRequest {
            path: here(dir),
            files: files.iter().map(|f| (*f).to_string()).collect(),
        }))
        .await,
    )
    .await
}

async fn unstage(dir: &TempDir, files: &[&str]) -> (StatusCode, Value) {
    answered(
        git::unstage(Json(git::FilesRequest {
            path: here(dir),
            files: files.iter().map(|f| (*f).to_string()).collect(),
        }))
        .await,
    )
    .await
}

async fn commit(dir: &TempDir, message: &str, amend: bool) -> (StatusCode, Value) {
    answered(
        git::commit(Json(git::CommitRequest {
            path: here(dir),
            message: message.to_string(),
            amend,
        }))
        .await,
    )
    .await
}

async fn push(dir: &TempDir, set_upstream: bool) -> (StatusCode, Value) {
    answered(
        git::push(Json(git::PushRequest {
            path: here(dir),
            set_upstream,
        }))
        .await,
    )
    .await
}

/// One file out of one of the status groups.
fn entry<'a>(body: &'a Value, group: &str, path: &str) -> Option<&'a Value> {
    body[group]
        .as_array()?
        .iter()
        .find(|file| file["path"] == path)
}

/// Every path in one of the status groups.
fn named(body: &Value, group: &str) -> Vec<String> {
    body[group]
        .as_array()
        .map(|group| {
            group
                .iter()
                .filter_map(|file| file["path"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ============================================================================
// bw-8dp8.1 — what a project has changed, and two requests not colliding
// ============================================================================

#[tokio::test]
async fn the_status_route_sorts_a_modified_a_renamed_a_staged_and_an_untracked_file() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    put(at, "moved.txt", "the same bytes either side of the move\n");
    save_all(at, "seed");

    put(at, "kept.txt", "one\ntwo\n"); // changed, not picked
    run(at, &["mv", "moved.txt", "renamed.txt"]); // moved, picked
    put(at, "added.txt", "new\n");
    run(at, &["add", "added.txt"]); // new, picked
    put(at, "untracked.txt", "loose\n"); // new, git has never heard of it

    let (code, body) = status_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["branch"], "main");
    assert_eq!(body["detached"], false);
    assert!(body["upstream"].is_null(), "there is no shared copy yet");
    assert_eq!(body["ahead"], 0);
    assert_eq!(body["behind"], 0);

    let added = entry(&body, "staged", "added.txt").expect("the new file is picked");
    assert_eq!(added["status"], "added");
    assert!(added["origPath"].is_null());

    let renamed = entry(&body, "staged", "renamed.txt").expect("the moved file is picked");
    assert_eq!(renamed["status"], "renamed");
    assert_eq!(
        renamed["origPath"], "moved.txt",
        "a rename record spends two NUL-separated fields; the second is where it came from"
    );

    let changed = entry(&body, "unstaged", "kept.txt").expect("the changed file is not picked");
    assert_eq!(changed["status"], "modified");

    assert_eq!(named(&body, "untracked"), vec!["untracked.txt"]);
    assert!(body["conflicted"].as_array().expect("a group").is_empty());

    // Each of the four lands in one group and no other.
    assert!(!named(&body, "unstaged").contains(&"added.txt".to_string()));
    assert!(!named(&body, "untracked").contains(&"added.txt".to_string()));
    assert!(!named(&body, "staged").contains(&"kept.txt".to_string()));
    assert!(!named(&body, "untracked").contains(&"kept.txt".to_string()));
    assert!(!named(&body, "untracked").contains(&"moved.txt".to_string()));
    assert!(!named(&body, "staged").contains(&"untracked.txt".to_string()));
}

#[tokio::test]
async fn every_file_under_an_untracked_folder_is_named() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    save_all(at, "seed");
    put(at, "fresh/deep/inside.txt", "hidden away\n");

    let (code, body) = status_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        named(&body, "untracked"),
        vec!["fresh/deep/inside.txt"],
        "--untracked-files=all names the file, not the folder"
    );
}

#[tokio::test]
async fn a_file_two_lines_of_work_disagree_about_lands_in_its_own_group() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "argued.txt", "how it started\n");
    save_all(at, "seed");

    run(at, &["branch", "other"]);
    put(at, "argued.txt", "what main thinks\n");
    save_all(at, "main's answer");
    run(at, &["switch", "-q", "other"]);
    put(at, "argued.txt", "what the other line thinks\n");
    save_all(at, "the other answer");
    run(at, &["switch", "-q", "main"]);
    run_anyway(at, &["merge", "other"]); // leaves a conflict on purpose

    let (code, body) = status_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(named(&body, "conflicted"), vec!["argued.txt"]);
    assert!(!named(&body, "staged").contains(&"argued.txt".to_string()));
    assert!(!named(&body, "unstaged").contains(&"argued.txt".to_string()));
}

#[tokio::test]
async fn a_detached_head_says_so_and_names_the_commit() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    let first = save_all(at, "first");
    put(at, "kept.txt", "one\ntwo\n");
    save_all(at, "second");
    run(at, &["switch", "-q", "--detach", &first]);

    let (code, body) = status_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["detached"], true);
    let named_as = body["branch"].as_str().expect("a name for the commit");
    assert!(
        first.starts_with(named_as) && !named_as.is_empty(),
        "a detached HEAD is named by its commit, got {named_as} for {first}"
    );

    let (code, listed) = branches_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    let current = listed["current"].as_str().expect("something is current");
    assert!(first.starts_with(current), "{current} is not part of {first}");
}

#[tokio::test]
async fn a_path_outside_the_home_directory_is_refused_before_git_is_run() {
    if cfg!(windows) {
        return;
    }
    let (code, body) = answered(
        git::status(Query(git::PathParams {
            path: "/etc".to_string(),
        }))
        .await,
    )
    .await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    let said = body["error"].as_str().expect("a reason");
    assert!(said.contains("denied"), "{said}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_mutating_calls_at_one_project_wait_for_each_other_instead_of_colliding() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "seed.txt", "seed\n");
    save_all(at, "seed");

    let names: Vec<String> = (0..12).map(|n| format!("file-{n}.txt")).collect();
    for name in &names {
        put(at, name, "something to pick\n");
    }

    // All at once at the same repository. Without a lock of our own, git's
    // index.lock lets one of these win and kills the rest.
    let calls = names.iter().map(|name| {
        git::stage(Json(git::FilesRequest {
            path: here(&repo),
            files: vec![name.clone()],
        }))
    });
    let answers = futures::future::join_all(calls).await;

    for answer in answers {
        let (code, body) = answered(answer).await;
        assert_eq!(code, StatusCode::OK, "a concurrent pick was refused: {body}");
    }

    let (_, body) = status_of(&repo).await;
    let picked = named(&body, "staged");
    for name in &names {
        assert!(picked.contains(name), "{name} never made it into the index");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_project_queues_while_another_carries_on() {
    let waiting = a_repo();
    let free = a_repo();
    put(free.path(), "kept.txt", "one\n");

    let turn = git::repo_lock(waiting.path());
    let holding = turn.lock().await;

    // The same project, spelled another way, finds the very same lock.
    let same = git::repo_lock(&waiting.path().join("."));
    assert!(
        same.try_lock().is_err(),
        "one project must have one lock, however its path is spelled"
    );

    // A different project is not made to wait behind it.
    let elsewhere = tokio::time::timeout(Duration::from_secs(30), stage(&free, &["kept.txt"]))
        .await
        .expect("a pick in another project must not wait on this one");
    assert_eq!(elsewhere.0, StatusCode::OK);

    drop(holding);
}

// ============================================================================
// bw-8dp8.2 — picking, putting back, and saving
// ============================================================================

#[tokio::test]
async fn a_change_is_picked_put_back_picked_again_and_saved_under_the_typed_message() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    save_all(at, "seed");
    put(at, "kept.txt", "one\ntwo\n");

    let (code, _) = stage(&repo, &["kept.txt"]).await;
    assert_eq!(code, StatusCode::OK);
    let (_, body) = status_of(&repo).await;
    assert_eq!(
        entry(&body, "staged", "kept.txt").expect("picked")["status"],
        "modified"
    );
    assert!(entry(&body, "unstaged", "kept.txt").is_none());

    let (code, _) = unstage(&repo, &["kept.txt"]).await;
    assert_eq!(code, StatusCode::OK);
    let (_, body) = status_of(&repo).await;
    assert!(entry(&body, "staged", "kept.txt").is_none(), "put back");
    assert_eq!(
        entry(&body, "unstaged", "kept.txt").expect("still changed")["status"],
        "modified"
    );

    let (code, _) = stage(&repo, &["kept.txt"]).await;
    assert_eq!(code, StatusCode::OK);

    let typed = "Say what changed, in the words the user typed";
    let (code, saved) = commit(&repo, typed, false).await;
    assert_eq!(code, StatusCode::OK, "{saved}");
    let sha = saved["sha"].as_str().expect("a commit name");
    assert_eq!(sha, run(at, &["rev-parse", "HEAD"]));

    let last = run(at, &["log", "-1", "--format=%s%n%an%n%ae%n%cn%n%ce"]);
    let mut lines = last.lines();
    assert_eq!(lines.next(), Some(typed));
    assert_eq!(lines.next(), Some("Atelier Tester"));
    assert_eq!(lines.next(), Some("tester@atelier.test"));
    assert_eq!(
        lines.next(),
        Some("Atelier Tester"),
        "the committer is the identity the repository's own config carries"
    );
    assert_eq!(lines.next(), Some("tester@atelier.test"));

    let (_, body) = status_of(&repo).await;
    assert!(body["staged"].as_array().expect("a group").is_empty());
    assert!(body["unstaged"].as_array().expect("a group").is_empty());
}

#[tokio::test]
async fn saving_nothing_arrives_in_gits_own_words_and_an_amend_rewrites_the_last_one() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    save_all(at, "seed");

    let (code, refused) = commit(&repo, "nothing was picked", false).await;
    assert!(!code.is_success(), "an empty save must not report success");
    let said = refused["error"].as_str().expect("git's own words");
    assert!(said.contains("nothing to commit"), "{said}");

    put(at, "kept.txt", "one\ntwo\n");
    stage(&repo, &["kept.txt"]).await;
    let (code, _) = commit(&repo, "first wording", false).await;
    assert_eq!(code, StatusCode::OK);
    let before = run(at, &["rev-list", "--count", "HEAD"]);

    let (code, amended) = commit(&repo, "second wording", true).await;
    assert_eq!(code, StatusCode::OK, "{amended}");
    assert_eq!(run(at, &["log", "-1", "--format=%s"]), "second wording");
    assert_eq!(
        run(at, &["rev-list", "--count", "HEAD"]),
        before,
        "an amend rewrites the last save rather than adding one"
    );
}

#[tokio::test]
async fn picking_nothing_at_all_is_refused_rather_than_quietly_doing_nothing() {
    let repo = a_repo();
    put(repo.path(), "kept.txt", "one\n");
    save_all(repo.path(), "seed");

    let (code, body) = stage(&repo, &[]).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().expect("a reason").contains("No files"));
}

#[tokio::test]
async fn picking_a_file_that_is_not_there_arrives_in_gits_own_words() {
    let repo = a_repo();
    put(repo.path(), "kept.txt", "one\n");
    save_all(repo.path(), "seed");

    let (code, body) = stage(&repo, &["never-written.txt"]).await;
    assert!(!code.is_success());
    let said = body["error"].as_str().expect("git's own words");
    assert!(said.contains("never-written.txt"), "{said}");
    assert!(said.contains("did not match any files"), "{said}");
}

// ============================================================================
// bw-8dp8.3 — the shared copy
// ============================================================================

#[tokio::test]
async fn a_saved_change_reaches_a_bare_shared_copy_and_a_refusal_arrives_in_gits_own_words() {
    let shared = a_shared_copy();
    let shared_at = shared.path().display().to_string();

    let mine = a_repo();
    put(mine.path(), "kept.txt", "one\n");
    let first = save_all(mine.path(), "first");
    run(mine.path(), &["remote", "add", "origin", &shared_at]);

    let (code, sent) = push(&mine, true).await;
    assert_eq!(code, StatusCode::OK, "{sent}");
    assert_eq!(sent["ok"], true);
    assert!(
        !sent["output"].as_str().expect("what git printed").is_empty(),
        "git says something when it sends"
    );
    assert_eq!(
        run(shared.path(), &["rev-parse", "main"]),
        first,
        "the shared copy received the commit"
    );
    assert_eq!(
        run(mine.path(), &["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]),
        "origin/main",
        "setUpstream leaves the branch following the shared copy"
    );

    // Somebody else's copy, taken before the next change landed.
    let theirs = scratch();
    run(theirs.path(), &["clone", "-q", &shared_at, "."]);
    settle(theirs.path());

    // The shared copy moves on without them.
    put(mine.path(), "kept.txt", "one\ntwo\n");
    let second = save_all(mine.path(), "second");
    let (code, sent) = push(&mine, false).await;
    assert_eq!(code, StatusCode::OK, "{sent}");

    // They try to send their own on top of a copy they no longer have.
    put(theirs.path(), "kept.txt", "one\nsomething else\n");
    save_all(theirs.path(), "theirs");
    let (code, refused) = push(&theirs, false).await;

    assert!(!code.is_success(), "a rejected push must not report success");
    let said = refused["error"].as_str().expect("git's own words");
    assert!(said.contains("[rejected]"), "not git's own words: {said}");
    assert!(
        said.contains("Updates were rejected"),
        "not git's own words: {said}"
    );
    assert!(
        said.contains("fetch first") || said.contains("non-fast-forward"),
        "git's reason was rewritten away: {said}"
    );
    assert_eq!(
        run(shared.path(), &["rev-parse", "main"]),
        second,
        "the shared copy kept what it had"
    );
}

#[tokio::test]
async fn fetch_counts_the_gap_and_pull_closes_it() {
    let shared = a_shared_copy();
    let shared_at = shared.path().display().to_string();

    let mine = a_repo();
    put(mine.path(), "kept.txt", "one\n");
    save_all(mine.path(), "first");
    run(mine.path(), &["remote", "add", "origin", &shared_at]);
    push(&mine, true).await;

    let theirs = scratch();
    run(theirs.path(), &["clone", "-q", &shared_at, "."]);
    settle(theirs.path());

    put(mine.path(), "kept.txt", "one\ntwo\n");
    let second = save_all(mine.path(), "second");
    let (code, _) = push(&mine, false).await;
    assert_eq!(code, StatusCode::OK);

    let (code, gap) = answered(
        git::fetch(Json(git::PathRequest {
            path: here(&theirs),
        }))
        .await,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{gap}");
    assert_eq!(gap["ahead"], 0);
    assert_eq!(gap["behind"], 1);

    let (_, body) = status_of(&theirs).await;
    assert_eq!(body["upstream"], "origin/main");
    assert_eq!(body["behind"], 1);
    assert_eq!(body["ahead"], 0);

    let (code, pulled) = answered(
        git::pull(Json(git::PathRequest {
            path: here(&theirs),
        }))
        .await,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{pulled}");
    assert_eq!(pulled["ok"], true);
    assert!(!pulled["output"]
        .as_str()
        .expect("what git printed")
        .is_empty());
    assert_eq!(
        run(theirs.path(), &["rev-parse", "HEAD"]),
        second,
        "the change came in"
    );
}

#[tokio::test]
async fn sending_with_no_shared_copy_at_all_arrives_in_gits_own_words() {
    let repo = a_repo();
    put(repo.path(), "kept.txt", "one\n");
    save_all(repo.path(), "first");

    let (code, refused) = push(&repo, false).await;
    assert!(!code.is_success());
    let said = refused["error"].as_str().expect("git's own words");
    assert!(
        said.contains("origin") || said.contains("No configured push destination"),
        "{said}"
    );
}

// ============================================================================
// bw-8dp8.4 — lines of work, switching between them, and saved changes
// ============================================================================

#[tokio::test]
async fn the_lines_of_work_are_listed_switched_and_their_saved_changes_read() {
    let shared = a_shared_copy();
    let repo = a_repo();
    let at = repo.path();

    put(at, "kept.txt", "one\n");
    save_all(at, "first");
    put(at, "kept.txt", "one\ntwo\n");
    save_all(at, "second");
    put(at, "kept.txt", "one\ntwo\nthree\n");
    save_all(at, "third");

    run(
        at,
        &["remote", "add", "origin", &shared.path().display().to_string()],
    );
    let (code, _) = push(&repo, true).await;
    assert_eq!(code, StatusCode::OK);

    // One more that the shared copy has not been told about.
    put(at, "kept.txt", "one\ntwo\nthree\nfour\n");
    save_all(at, "fourth");

    run(at, &["branch", "feature-one"]);
    run(at, &["branch", "feature-two"]);

    let (code, listed) = branches_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(listed["current"], "main");
    let all = listed["branches"].as_array().expect("a list");
    let names: Vec<&str> = all
        .iter()
        .map(|b| b["name"].as_str().expect("a name"))
        .collect();
    assert!(names.contains(&"main"), "{names:?}");
    assert!(names.contains(&"feature-one"), "{names:?}");
    assert!(names.contains(&"feature-two"), "{names:?}");
    assert!(names.contains(&"origin/main"), "{names:?}");

    let on_main = all.iter().find(|b| b["name"] == "main").expect("main");
    assert_eq!(on_main["upstream"], "origin/main");
    assert_eq!(on_main["ahead"], 1, "one save the shared copy has not got");
    assert_eq!(on_main["behind"], 0);
    assert_eq!(on_main["isRemote"], false);

    let shared_main = all
        .iter()
        .find(|b| b["name"] == "origin/main")
        .expect("the shared copy's branch");
    assert_eq!(shared_main["isRemote"], true);
    assert!(shared_main["upstream"].is_null());

    let untouched = all.iter().find(|b| b["name"] == "feature-one").expect("it");
    assert!(untouched["upstream"].is_null());
    assert_eq!(untouched["ahead"], 0);

    // Switching to another line of work moves HEAD.
    let (code, _) = answered(
        git::checkout(Json(git::CheckoutRequest {
            path: here(&repo),
            branch: "feature-one".to_string(),
            create: false,
        }))
        .await,
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(run(at, &["rev-parse", "--abbrev-ref", "HEAD"]), "feature-one");
    let (_, listed) = branches_of(&repo).await;
    assert_eq!(listed["current"], "feature-one");

    // Starting one moves HEAD onto it too.
    let (code, _) = answered(
        git::checkout(Json(git::CheckoutRequest {
            path: here(&repo),
            branch: "feature-three".to_string(),
            create: true,
        }))
        .await,
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        run(at, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature-three"
    );

    // A line of work that is not there is refused in git's own words.
    let (code, refused) = answered(
        git::checkout(Json(git::CheckoutRequest {
            path: here(&repo),
            branch: "no-such-line".to_string(),
            create: false,
        }))
        .await,
    )
    .await;
    assert!(!code.is_success());
    assert!(refused["error"]
        .as_str()
        .expect("git's own words")
        .contains("no-such-line"));

    // And the saved changes read back, newest first.
    let (code, history) = log_of(&repo, 50).await;
    assert_eq!(code, StatusCode::OK);
    let commits = history["commits"].as_array().expect("a list");
    assert_eq!(commits.len(), 4);
    let subjects: Vec<&str> = commits
        .iter()
        .map(|c| c["subject"].as_str().expect("a subject"))
        .collect();
    assert_eq!(subjects, vec!["fourth", "third", "second", "first"]);

    for saved in commits {
        assert_eq!(saved["author"], "Atelier Tester");
        assert_eq!(saved["email"], "tester@atelier.test");
        let when = saved["date"].as_str().expect("a time");
        assert!(
            DateTime::parse_from_rfc3339(when).is_ok(),
            "{when} is not an ISO 8601 timestamp"
        );
        let sha = saved["sha"].as_str().expect("a commit name");
        let short = saved["shortSha"].as_str().expect("a short commit name");
        assert_eq!(sha.len(), 40);
        assert!(!short.is_empty() && sha.starts_with(short));
    }

    let (_, only_two) = log_of(&repo, 2).await;
    assert_eq!(only_two["commits"].as_array().expect("a list").len(), 2);
}

#[tokio::test]
async fn a_message_with_more_than_one_line_reads_back_as_its_first_line() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    run(at, &["add", "-A"]);
    run(
        at,
        &[
            "commit",
            "-q",
            "-m",
            "What it does",
            "-m",
            "Why it does it, at length, over a second paragraph.",
        ],
    );

    let (code, history) = log_of(&repo, 50).await;
    assert_eq!(code, StatusCode::OK);
    let commits = history["commits"].as_array().expect("a list");
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0]["subject"], "What it does");
}

#[tokio::test]
async fn a_project_with_nothing_saved_yet_has_an_empty_history_and_still_answers() {
    let repo = a_repo();

    let (code, history) = log_of(&repo, 50).await;
    assert_eq!(code, StatusCode::OK);
    assert!(history["commits"].as_array().expect("a list").is_empty());

    let (code, body) = status_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["branch"], "main");
    assert_eq!(body["detached"], false);

    let (code, listed) = branches_of(&repo).await;
    assert_eq!(code, StatusCode::OK);
    assert!(listed["branches"].as_array().expect("a list").is_empty());
}

// ============================================================================
// The route contract itself — the URLs, the methods, and the JSON a browser
// would actually receive
// ============================================================================

/// Every route the contract names, as `main.rs` is expected to register it.
const CONTRACT: [(&str, &str); 10] = [
    ("get", "/api/git/status"),
    ("post", "/api/git/stage"),
    ("post", "/api/git/unstage"),
    ("post", "/api/git/commit"),
    ("post", "/api/git/fetch"),
    ("post", "/api/git/pull"),
    ("post", "/api/git/push"),
    ("get", "/api/git/branches"),
    ("post", "/api/git/checkout"),
    ("get", "/api/git/log"),
];

#[test]
fn the_server_registers_every_route_the_contract_names() {
    let handlers = [
        "status", "stage", "unstage", "commit", "fetch", "pull", "push", "branches", "checkout",
        "log",
    ];
    let main = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("main.rs"),
    )
    .expect("the server's own wiring");

    for ((method, url), handler) in CONTRACT.iter().zip(handlers) {
        let wiring = format!("\"{url}\", {method}(routes::git::{handler})");
        assert!(
            main.contains(&wiring),
            "main.rs does not register {method} {url}"
        );
    }
}

/// Serve the git routes on a port the operating system picks, so the URLs, the
/// methods and the JSON keys are exercised over real HTTP rather than assumed.
async fn served() -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new()
        .route("/api/git/status", axum::routing::get(git::status))
        .route("/api/git/stage", axum::routing::post(git::stage))
        .route("/api/git/unstage", axum::routing::post(git::unstage))
        .route("/api/git/commit", axum::routing::post(git::commit))
        .route("/api/git/fetch", axum::routing::post(git::fetch))
        .route("/api/git/pull", axum::routing::post(git::pull))
        .route("/api/git/push", axum::routing::post(git::push))
        .route("/api/git/branches", axum::routing::get(git::branches))
        .route("/api/git/checkout", axum::routing::post(git::checkout))
        .route("/api/git/log", axum::routing::get(git::log));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port of our own");
    let at = listener.local_addr().expect("the port we were given");
    let serving = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{at}"), serving)
}

#[tokio::test]
async fn the_routes_answer_over_http_in_the_shape_the_contract_promises() {
    let repo = a_repo();
    let at = repo.path();
    put(at, "kept.txt", "one\n");
    save_all(at, "seed");
    put(at, "kept.txt", "one\ntwo\n");
    put(at, "loose.txt", "loose\n");

    let (base, serving) = served().await;
    let web = reqwest::Client::new();
    let path = here(&repo);

    let body: Value = web
        .get(format!("{base}/api/git/status"))
        .query(&[("path", path.as_str())])
        .send()
        .await
        .expect("an answer")
        .json()
        .await
        .expect("JSON");
    assert_eq!(body["branch"], "main");
    assert!(body["upstream"].is_null());
    assert_eq!(
        entry(&body, "unstaged", "kept.txt").expect("the changed file")["status"],
        "modified"
    );
    assert_eq!(named(&body, "untracked"), vec!["loose.txt"]);

    let answer = web
        .post(format!("{base}/api/git/stage"))
        .json(&serde_json::json!({ "path": path, "files": ["kept.txt"] }))
        .send()
        .await
        .expect("an answer");
    assert_eq!(answer.status(), 200);

    let answer = web
        .post(format!("{base}/api/git/commit"))
        .json(&serde_json::json!({ "path": path, "message": "over the wire" }))
        .send()
        .await
        .expect("an answer");
    assert_eq!(answer.status(), 200);
    let saved: Value = answer.json().await.expect("JSON");
    assert_eq!(
        saved["sha"].as_str().expect("a commit name"),
        run(at, &["rev-parse", "HEAD"])
    );

    let history: Value = web
        .get(format!("{base}/api/git/log"))
        .query(&[("path", path.as_str()), ("limit", "1")])
        .send()
        .await
        .expect("an answer")
        .json()
        .await
        .expect("JSON");
    assert_eq!(history["commits"][0]["subject"], "over the wire");
    assert!(
        history["commits"][0]["shortSha"].is_string(),
        "the browser is promised shortSha, not short_sha"
    );

    let listed: Value = web
        .get(format!("{base}/api/git/branches"))
        .query(&[("path", path.as_str())])
        .send()
        .await
        .expect("an answer")
        .json()
        .await
        .expect("JSON");
    assert_eq!(listed["current"], "main");
    assert_eq!(listed["branches"][0]["isRemote"], false);

    // `setUpstream` is read from the body as the contract spells it, and the
    // failure that follows is git's own, word for word.
    let answer = web
        .post(format!("{base}/api/git/push"))
        .json(&serde_json::json!({ "path": path, "setUpstream": true }))
        .send()
        .await
        .expect("an answer");
    assert!(!answer.status().is_success());
    let refused: Value = answer.json().await.expect("JSON");
    let said = refused["error"].as_str().expect("git's own words");
    assert!(said.contains("origin"), "{said}");

    serving.abort();
}
