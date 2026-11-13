//! A project's git worktrees (docs/agent-workbench.md, "Worktrees"): the
//! checkouts `git worktree list` knows, their size on disk and whether they
//! hold uncommitted work. The registry moves chats between them and deletes
//! them; this module only reads git and the disk.

use std::path::{Path, PathBuf};

/// One checkout of a project.
#[derive(Clone, Debug, PartialEq)]
pub struct Worktree {
    pub path: PathBuf,
    /// The branch checked out, without `refs/heads/`; None when detached.
    pub branch: Option<String>,
    /// The project's own folder: the first checkout git lists.
    pub is_main: bool,
}

async fn git(at: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::routes::git_output(at, args).await.map_err(|error| format!("git could not run: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// The checkouts of the repository at `project`, the project's own first.
pub async fn list(project: &Path) -> Result<Vec<Worktree>, String> {
    let listed = git(project, &["worktree", "list", "--porcelain"]).await?;
    let mut trees = Vec::new();
    let mut current: Option<Worktree> = None;
    for line in listed.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            trees.extend(current.take());
            current = Some(Worktree { path: PathBuf::from(path), branch: None, is_main: trees.is_empty() });
        } else if let (Some(branch), Some(tree)) = (line.strip_prefix("branch "), current.as_mut()) {
            tree.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_string());
        } else if line == "bare" {
            current = None;
        }
    }
    trees.extend(current);
    Ok(trees)
}

/// The checkout of `project` that is `folder` or holds it.
pub async fn containing(project: &Path, folder: &Path) -> Result<Option<Worktree>, String> {
    let folder = canonical(folder);
    let mut found: Option<Worktree> = None;
    for tree in list(project).await? {
        let root = canonical(&tree.path);
        let longer = found.as_ref().is_none_or(|best| root.components().count() > canonical(&best.path).components().count());
        if folder.starts_with(&root) && longer {
            found = Some(tree);
        }
    }
    Ok(found)
}

pub fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether the checkout has uncommitted changes, untracked files included.
pub async fn dirty(tree: &Path) -> bool {
    git(tree, &["status", "--porcelain"]).await.map(|status| !status.trim().is_empty()).unwrap_or(false)
}

/// The bytes the checkout's files take, without the repository's own `.git`
/// (shared by every checkout) and without following links.
pub async fn size(tree: &Path) -> u64 {
    let tree = tree.to_path_buf();
    tokio::task::spawn_blocking(move || folder_size(&tree, true)).await.unwrap_or(0)
}

fn folder_size(folder: &Path, top: bool) -> u64 {
    let Ok(entries) = std::fs::read_dir(folder) else { return 0 };
    let mut total = 0;
    for entry in entries.flatten() {
        if top && entry.file_name() == ".git" {
            continue;
        }
        let Ok(meta) = entry.path().symlink_metadata() else { continue };
        if meta.is_dir() {
            total += folder_size(&entry.path(), false);
        } else {
            total += meta.len();
        }
    }
    total
}

/// Remove the checkout (`--force` throws its uncommitted work away). Its
/// branch is kept.
pub async fn remove(project: &Path, tree: &Path, force: bool) -> Result<(), String> {
    let shown = tree.display().to_string();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&shown);
    git(project, &args).await.map(|_| ())
}

/// The folder Claude keeps a conversation under: the working folder with
/// every character that is not a letter or digit written as `-`.
pub fn claude_folder(config: &Path, cwd: &Path) -> PathBuf {
    let name: String = cwd.display().to_string().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    config.join("projects").join(name)
}
