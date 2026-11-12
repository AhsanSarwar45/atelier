//! What tasks read from git: the base branch work is merged into, whether a
//! finished task's commits have reached it, and what `@merge` tells the agent
//! (docs/tasks.md, "Merging").
//!
//! The base branch is the repository's default: what `origin/HEAD` points at,
//! else `main`, else `master` — whichever exists as a local branch first. A
//! task is merged when every commit it names is an ancestor of the base
//! branch's tip, so a merge commit, a fast-forward and a squash-free merge all
//! count, and a rebase that rewrote the commits does not.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

async fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = crate::routes::git_output(dir, args).await.ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn branch_exists(dir: &Path, name: &str) -> bool {
    git(dir, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")])
        .await
        .is_some()
}

/// The repository's default branch, as a local branch name.
pub async fn base_branch(dir: &Path) -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(remote) = git(dir, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).await {
        if let Some(name) = remote.strip_prefix("origin/") {
            candidates.push(name.to_string());
        }
    }
    candidates.extend(["main".to_string(), "master".to_string()]);
    for name in candidates {
        if branch_exists(dir, &name).await {
            return Some(name);
        }
    }
    None
}

/// The files the commits change, each once, in the order git names them.
/// A commit git does not know adds nothing.
pub async fn changed_files(dir: &Path, commits: &[String]) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for sha in commits {
        let Some(names) = git(dir, &["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]).await else {
            continue;
        };
        for name in names.lines().filter(|line| !line.is_empty()) {
            if !files.iter().any(|known| known == name) {
                files.push(name.to_string());
            }
        }
    }
    files
}

/// Answers already worked out, by (repository, base tip, commit). A base tip
/// that moves is a new key, so nothing here goes stale.
fn known() -> &'static Mutex<HashMap<(String, String, String), bool>> {
    static KNOWN: OnceLock<Mutex<HashMap<(String, String, String), bool>>> = OnceLock::new();
    KNOWN.get_or_init(Default::default)
}

/// Whether every commit is in the base branch: None when there are no commits,
/// no repository or no base branch, or git could not tell.
pub async fn merged(dir: &Path, commits: &[String]) -> Option<bool> {
    if commits.is_empty() {
        return None;
    }
    let base = base_branch(dir).await?;
    let tip = git(dir, &["rev-parse", "--verify", &format!("refs/heads/{base}^{{commit}}")]).await?;
    let repo = git(dir, &["rev-parse", "--git-common-dir"]).await.unwrap_or_else(|| dir.display().to_string());
    let repo = dir.join(repo).display().to_string();
    for sha in commits {
        let key = (repo.clone(), tip.clone(), sha.clone());
        let cached = known().lock().unwrap().get(&key).copied();
        let ancestor = match cached {
            Some(answer) => answer,
            None => {
                let output = crate::routes::git_output(dir, &["merge-base", "--is-ancestor", sha, &tip]).await.ok()?;
                let answer = match output.status.code() {
                    Some(0) => true,
                    Some(1) => false,
                    _ => return None,
                };
                let mut known = known().lock().unwrap();
                if known.len() > 50_000 {
                    known.clear();
                }
                known.insert(key, answer);
                answer
            }
        };
        if !ancestor {
            return Some(false);
        }
    }
    Some(true)
}

/// Where an approved task's commits stand, for what its chat is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeState {
    /// The task names no commits.
    NoCommits,
    /// Every commit is in the base branch.
    Merged { base: String },
    /// Some commit is not; `branch` is the folder's own branch when it is
    /// another than the base (None when detached or on the base itself).
    Unmerged { branch: Option<String>, base: String },
    /// No folder, no repository, no base branch, or git could not tell.
    Unknown,
}

pub async fn merge_state(dir: Option<&Path>, commits: &[String]) -> MergeState {
    if commits.is_empty() {
        return MergeState::NoCommits;
    }
    let Some(dir) = dir.filter(|dir| dir.is_dir()) else { return MergeState::Unknown };
    let (Some(merged), Some(base)) = (merged(dir, commits).await, base_branch(dir).await) else {
        return MergeState::Unknown;
    };
    if merged {
        return MergeState::Merged { base };
    }
    let branch = git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.filter(|branch| *branch != base);
    MergeState::Unmerged { branch, base }
}

/// What `@merge` needs to know about the chat's folder, worked out when the
/// message is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeFacts {
    pub cwd: String,
    pub repo: bool,
    /// The branch checked out here; None when detached.
    pub branch: Option<String>,
    pub base: Option<String>,
    /// The worktree that has the base branch checked out, if any.
    pub base_checkout: Option<String>,
    /// Whether that worktree has no uncommitted changes.
    pub base_clean: Option<bool>,
}

/// The worktree with `refs/heads/<branch>` checked out, from `git worktree list --porcelain`.
fn checkout_of(porcelain: &str, branch: &str) -> Option<String> {
    let wanted = format!("branch refs/heads/{branch}");
    porcelain.split("\n\n").find_map(|block| {
        let mut path = None;
        let mut found = false;
        for line in block.lines() {
            if let Some(at) = line.strip_prefix("worktree ") {
                path = Some(at.to_string());
            } else if line.trim() == wanted {
                found = true;
            }
        }
        if found { path } else { None }
    })
}

pub async fn merge_facts(cwd: &Path) -> MergeFacts {
    let mut facts = MergeFacts {
        cwd: cwd.display().to_string(),
        repo: false,
        branch: None,
        base: None,
        base_checkout: None,
        base_clean: None,
    };
    if git(cwd, &["rev-parse", "--is-inside-work-tree"]).await.as_deref() != Some("true") {
        return facts;
    }
    facts.repo = true;
    facts.branch = git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
    facts.base = base_branch(cwd).await;
    if let Some(base) = facts.base.as_deref() {
        if let Some(listing) = git(cwd, &["worktree", "list", "--porcelain"]).await {
            facts.base_checkout = checkout_of(&listing, base);
        }
        if let Some(checkout) = facts.base_checkout.as_deref() {
            facts.base_clean = git(Path::new(checkout), &["status", "--porcelain"]).await.map(|status| status.is_empty());
        }
    }
    facts
}

/// What a bare `@merge` tells the agent.
pub fn merge_instructions(facts: &MergeFacts) -> String {
    let head = "@merge — The owner asks you to merge this chat's branch into the base branch.";
    if !facts.repo {
        return format!("{head} {} is not a git repository, so there is nothing to merge. Tell the owner so.", facts.cwd);
    }
    let Some(base) = facts.base.as_deref() else {
        return format!(
            "{head} Atelier found no base branch in {} (no origin/HEAD, main or master). Tell the owner so and ask which branch to merge into; do nothing else.",
            facts.cwd
        );
    };
    let Some(branch) = facts.branch.as_deref() else {
        return format!(
            "{head} {} is on a detached HEAD, not a branch, so there is nothing to merge. Tell the owner so.",
            facts.cwd
        );
    };
    if branch == base {
        return format!(
            "{head} {} is already on the base branch {base}, so there is nothing to merge. Tell the owner so.",
            facts.cwd
        );
    }
    let mut lines = vec![
        head.to_string(),
        "Atelier worked out:".to_string(),
        format!("- this worktree: {}", facts.cwd),
        format!("- current branch: {branch}"),
        format!("- base branch: {base}"),
    ];
    match (facts.base_checkout.as_deref(), facts.base_clean) {
        (Some(checkout), Some(true)) => lines.push(format!("- {base} is checked out at {checkout}, which is clean")),
        (Some(checkout), _) => {
            lines.push(format!("- {base} is checked out at {checkout}, which has uncommitted changes"));
            lines.push(String::new());
            lines.push(format!(
                "Do not merge. The checkout of {base} at {checkout} has uncommitted changes that are not yours to touch. Tell the owner, and stop."
            ));
            return lines.join("\n");
        }
        (None, _) => lines.push(format!("- {base} is not checked out in any worktree")),
    }
    let fast_forward = match facts.base_checkout.as_deref() {
        Some(checkout) => format!("`git -C {checkout} merge --ff-only {branch}`"),
        None => format!("`git fetch . {branch}:{base}`, run here"),
    };
    lines.extend([
        String::new(),
        "Do this, in order:".to_string(),
        "1. Commit any uncommitted work here that belongs to this chat's work; if some of it does not, tell the owner what it is.".to_string(),
        format!(
            "2. Merge {base} into {branch} here (`git merge {base}`). Never rebase: tasks name their commits, and whether a task is merged is read from commit ancestry. Resolve any conflicts, then re-run the project's tests."
        ),
        format!("3. Fast-forward {base} to {branch}: {fast_forward}. If it is refused, stop and tell the owner."),
        "4. Never push, and never touch remotes.".to_string(),
        format!("5. Report the commit {base} now points at (`git rev-parse {base}`)."),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str) -> String {
        std::fs::write(dir.join(file), file).unwrap();
        run(dir, &["add", file]);
        run(dir, &["commit", "-q", "-m", file]);
        run(dir, &["rev-parse", "HEAD"])
    }

    /// A repository on `main` with a worktree on `feature`, one commit ahead.
    fn repository() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf, String) {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        run(&main, &["init", "-q", "-b", "main"]);
        commit(&main, "a");
        let feature = root.path().join("feature");
        run(&main, &["worktree", "add", "-q", "-b", "feature", feature.to_str().unwrap()]);
        let sha = commit(&feature, "b");
        (root, main, feature, sha)
    }

    #[tokio::test]
    async fn changed_files_lists_what_each_commit_touched_once() {
        let (_held, repo, _feature, _sha) = repository();
        let change = |file: &str, text: &str| {
            let path = repo.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            run(&repo, &["add", file]);
            run(&repo, &["commit", "-q", "-m", file]);
            run(&repo, &["rev-parse", "HEAD"])
        };
        let one = change("src/card.tsx", "1");
        let two = change("src/card.tsx", "2");
        let three = change("server/a.rs", "3");
        let files = changed_files(&repo, &[one, two, three, "0000000".into()]).await;
        assert_eq!(files, vec!["src/card.tsx".to_string(), "server/a.rs".to_string()]);
    }

    #[tokio::test]
    async fn a_task_is_merged_once_its_commits_reach_the_base_branch() {
        let (_root, main, feature, sha) = repository();
        assert_eq!(base_branch(&feature).await.as_deref(), Some("main"));
        assert_eq!(merged(&feature, &[]).await, None, "no commits, nothing to say");
        assert_eq!(merged(&feature, &[sha.clone()]).await, Some(false));
        run(&main, &["merge", "-q", "--ff-only", "feature"]);
        assert_eq!(merged(&feature, &[sha.clone()]).await, Some(true));
        assert_eq!(merged(&feature, &[sha[..10].to_string()]).await, Some(true), "a short SHA is read too");
        assert_eq!(merged(&feature, &["0123456789abcdef".into()]).await, None, "an unknown commit is unknown");
    }

    #[tokio::test]
    async fn merge_state_says_where_an_approved_tasks_commits_stand() {
        let (root, main, feature, sha) = repository();
        let commits = [sha.clone()];
        assert_eq!(merge_state(Some(&feature), &[]).await, MergeState::NoCommits);
        assert_eq!(merge_state(None, &commits).await, MergeState::Unknown, "no folder");
        assert_eq!(merge_state(Some(&root.path().join("gone")), &commits).await, MergeState::Unknown, "a folder that is gone");
        assert_eq!(merge_state(Some(&feature), &["0123456789abcdef".into()]).await, MergeState::Unknown, "a commit git does not know");
        assert_eq!(
            merge_state(Some(&feature), &commits).await,
            MergeState::Unmerged { branch: Some("feature".into()), base: "main".into() }
        );
        assert_eq!(
            merge_state(Some(&main), &commits).await,
            MergeState::Unmerged { branch: None, base: "main".into() },
            "asked from the base itself there is no other branch to name"
        );
        run(&main, &["merge", "-q", "--ff-only", "feature"]);
        assert_eq!(merge_state(Some(&feature), &commits).await, MergeState::Merged { base: "main".into() });
    }

    #[tokio::test]
    async fn merge_facts_name_the_branch_the_base_and_where_the_base_is_checked_out() {
        let (_root, main, feature, _sha) = repository();
        let facts = merge_facts(&feature).await;
        let main_path = std::fs::canonicalize(&main).unwrap();
        assert!(facts.repo);
        assert_eq!(facts.branch.as_deref(), Some("feature"));
        assert_eq!(facts.base.as_deref(), Some("main"));
        assert_eq!(facts.base_checkout.as_deref().map(|p| std::fs::canonicalize(p).unwrap()), Some(main_path.clone()));
        assert_eq!(facts.base_clean, Some(true));
        let text = merge_instructions(&facts);
        for want in [
            "current branch: feature",
            "base branch: main",
            &format!("git -C {} merge --ff-only feature", facts.base_checkout.as_deref().unwrap()),
            "Never rebase",
            "re-run the project's tests",
            "Never push",
            "git rev-parse main",
        ] {
            assert!(text.contains(want), "missing {want:?}:\n{text}");
        }

        std::fs::write(main.join("a"), "changed").unwrap();
        let dirty = merge_facts(&feature).await;
        assert_eq!(dirty.base_clean, Some(false));
        let text = merge_instructions(&dirty);
        assert!(text.contains("Do not merge") && text.contains("uncommitted changes"), "{text}");
        assert!(!text.contains("--ff-only"), "{text}");

        let on_base = merge_instructions(&merge_facts(&main).await);
        assert!(on_base.contains("already on the base branch main"), "{on_base}");

        let nowhere = tempfile::tempdir().unwrap();
        let none = merge_instructions(&merge_facts(nowhere.path()).await);
        assert!(none.contains("is not a git repository"), "{none}");
    }

    #[tokio::test]
    async fn a_base_branch_checked_out_nowhere_is_fast_forwarded_with_fetch() {
        let (_root, main, feature, _sha) = repository();
        run(&main, &["checkout", "-q", "--detach"]);
        let facts = merge_facts(&feature).await;
        assert_eq!(facts.base_checkout, None);
        let text = merge_instructions(&facts);
        assert!(text.contains("git fetch . feature:main"), "{text}");
        assert!(text.contains("not checked out in any worktree"), "{text}");
    }
}
