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
use std::path::{Path, PathBuf};
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

/// The tip of the folder's base branch and the repository it is in; None
/// with no repository or no base branch.
///
/// Every done task in a list asks this of the same folder, and each asking
/// was four runs of git, so a list of sixty tasks started 260 processes each
/// time it was drawn. The answer is kept for as long as the files git keeps
/// branches in sit as they did ([`RefsStamp`]).
async fn base_tip(dir: &Path) -> Option<(String, String)> {
    static KEPT: OnceLock<Mutex<HashMap<PathBuf, (RefsStamp, Option<(String, String)>)>>> = OnceLock::new();
    let kept = KEPT.get_or_init(Default::default);
    let common = {
        let dir = dir.to_path_buf();
        tokio::task::spawn_blocking(move || crate::project_manifest::git_identity(&dir)).await.ok()?
    };
    let known = kept.lock().unwrap().get(dir).cloned();
    if let Some((stamp, answer)) = known {
        if RefsStamp::of(&common, &stamp.base).is_some_and(|now| now == stamp) {
            return answer;
        }
    }
    let base = base_branch(dir).await;
    // Taken before the tip is read: a branch that moves meanwhile leaves a
    // stamp that no longer matches, and the next asker reads again.
    let stamp = RefsStamp::of(&common, &base);
    let answer = match &base {
        Some(base) => match git(dir, &["rev-parse", "--verify", &format!("refs/heads/{base}^{{commit}}")]).await {
            Some(tip) => Some((tip, common.display().to_string())),
            None => None,
        },
        None => None,
    };
    if let Some(stamp) = stamp {
        kept.lock().unwrap().insert(dir.to_path_buf(), (stamp, answer.clone()));
    }
    answer
}

/// The files a repository keeps its branches in, as the file system
/// describes them: the base branch's own file, the packed branches, and what
/// decides which branch is the base. While none of them moved, neither did
/// the base branch or its tip.
#[derive(Clone, PartialEq)]
struct RefsStamp {
    base: Option<String>,
    files: Vec<Option<(u64, std::time::SystemTime)>>,
}

impl RefsStamp {
    /// None for a repository that keeps its branches some other way
    /// (`reftable`), whose answer is then never kept.
    fn of(common: &Path, base: &Option<String>) -> Option<Self> {
        if !common.join("refs").is_dir() || common.join("reftable").exists() {
            return None;
        }
        let seen = |name: String| {
            let meta = std::fs::metadata(common.join(name)).ok()?;
            Some((meta.len(), meta.modified().ok()?))
        };
        let mut names = vec![
            "packed-refs".to_string(),
            "refs/remotes/origin/HEAD".to_string(),
            "refs/heads/main".to_string(),
            "refs/heads/master".to_string(),
        ];
        names.extend(base.iter().map(|base| format!("refs/heads/{base}")));
        Some(Self { base: base.clone(), files: names.into_iter().map(seen).collect() })
    }
}

/// Whether every commit is in the base branch: None when there are no commits,
/// no repository or no base branch, or git could not tell.
pub async fn merged(dir: &Path, commits: &[String]) -> Option<bool> {
    if commits.is_empty() {
        return None;
    }
    let (tip, repo) = base_tip(dir).await?;
    for sha in commits {
        if !in_base(dir, &repo, &tip, sha).await? {
            return Some(false);
        }
    }
    Some(true)
}

/// The base tip each commit was last found under, by (repository, commit).
fn reached() -> &'static Mutex<HashMap<(String, String), String>> {
    static REACHED: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    REACHED.get_or_init(Default::default)
}

/// Whether the commit is in the base branch at this tip; None when git could
/// not tell.
///
/// A commit that reached the base branch stays in it while the branch only
/// moves forward. So when the tip moves, one question (is the earlier tip in
/// the new one) answers for every commit that was in the earlier tip, instead
/// of each of them being asked again. A base branch that was rewound or
/// rewritten fails that question, and each commit is then asked afresh.
async fn in_base(dir: &Path, repo: &str, tip: &str, sha: &str) -> Option<bool> {
    if let Some(answer) = asked(repo, tip, sha) {
        return Some(answer);
    }
    let earlier = reached().lock().unwrap().get(&(repo.to_string(), sha.to_string())).cloned();
    let carried = match earlier {
        Some(earlier) if earlier != tip => {
            let forward = match asked(repo, tip, &earlier) {
                Some(forward) => forward,
                None => ask(dir, repo, tip, &earlier).await.unwrap_or(false),
            };
            forward.then_some(true)
        }
        _ => None,
    };
    let answer = match carried {
        Some(answer) => {
            keep(repo, tip, sha, answer);
            answer
        }
        None => ask(dir, repo, tip, sha).await?,
    };
    if answer {
        reached().lock().unwrap().insert((repo.to_string(), sha.to_string()), tip.to_string());
    }
    Some(answer)
}

fn asked(repo: &str, tip: &str, sha: &str) -> Option<bool> {
    known().lock().unwrap().get(&(repo.to_string(), tip.to_string(), sha.to_string())).copied()
}

fn keep(repo: &str, tip: &str, sha: &str, answer: bool) {
    let mut known = known().lock().unwrap();
    if known.len() > 50_000 {
        known.clear();
    }
    known.insert((repo.to_string(), tip.to_string(), sha.to_string()), answer);
}

/// Ask git whether the commit is in the tip, and keep the answer.
async fn ask(dir: &Path, repo: &str, tip: &str, sha: &str) -> Option<bool> {
    let output = crate::routes::git_output(dir, &["merge-base", "--is-ancestor", sha, tip]).await.ok()?;
    let answer = match output.status.code() {
        Some(0) => true,
        Some(1) => false,
        _ => return None,
    };
    keep(repo, tip, sha, answer);
    Some(answer)
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
    async fn a_merged_commit_is_not_asked_about_again_when_the_base_moves_forward() {
        let (_root, main, feature, sha) = repository();
        run(&main, &["merge", "-q", "--ff-only", "feature"]);
        commit(&main, "next");
        assert_eq!(merged(&feature, &[sha.clone()]).await, Some(true));
        let repo = base_tip(&feature).await.unwrap().1;

        commit(&main, "later");
        let (tip, _) = base_tip(&feature).await.unwrap();
        assert_eq!(merged(&feature, &[sha.clone()]).await, Some(true));
        let earlier = known().lock().unwrap().keys().filter(|(r, t, _)| r == &repo && t == &tip).count();
        assert_eq!(earlier, 2, "one question for the earlier tip, and the commit's answer carried over");
        assert_eq!(reached().lock().unwrap().get(&(repo.clone(), sha.clone())), Some(&tip));

        // A base branch moved back loses the commit, and that is seen.
        run(&main, &["reset", "-q", "--hard", "HEAD~3"]);
        assert_eq!(merged(&feature, &[sha.clone()]).await, Some(false));
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
