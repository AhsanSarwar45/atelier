//! `atelier tool memory` against real files: one store, shared by every
//! worktree of a project, and a global store every folder reads.
use serde_json::Value;
use std::{fs, path::Path, process::{Command, Output}};

fn run(cwd: &Path, data: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_atelier"))
        .args(["tool", "memory"]).args(args).current_dir(cwd)
        .env("ATELIER_DATA_DIR", data).output().unwrap()
}
fn ok(cwd: &Path, data: &Path, args: &[&str]) -> String {
    let out = run(cwd, data, args);
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}
fn refused(cwd: &Path, data: &Path, args: &[&str]) -> String {
    let out = run(cwd, data, args);
    assert!(!out.status.success(), "{args:?} should be refused");
    String::from_utf8_lossy(&out.stderr).into_owned()
}
fn ids(cwd: &Path, data: &Path) -> Vec<(String, String)> {
    let listed: Value = serde_json::from_str(&ok(cwd, data, &["list", "--json"])).unwrap();
    listed["memories"].as_array().unwrap().iter()
        .map(|m| (m["scope"].as_str().unwrap().into(), m["id"].as_str().unwrap().into())).collect()
}
fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(root)
        .args(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test"])
        .args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn every_worktree_of_a_project_shares_its_memory_and_every_folder_shares_global_memory() {
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().join("data");
    let repo = scratch.path().join("repo");
    let elsewhere = scratch.path().join("elsewhere");
    fs::create_dir_all(&repo).unwrap();
    fs::create_dir_all(&elsewhere).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "start"]);
    git(&repo, &["worktree", "add", "-q", "-b", "job", repo.join("worktrees/job").to_str().unwrap()]);
    let worktree = repo.join("worktrees/job");

    assert!(ok(&repo, &data, &["--help"]).contains("atelier tool memory"));
    assert!(ok(&repo, &data, &["list"]).contains("No memories saved."));
    assert!(!data.exists(), "reading creates nothing");

    assert!(refused(&worktree, &data, &["add", "port", "--description", "d", "--body", "b"]).contains("--scope"));
    ok(&worktree, &data, &["add", "port", "--scope", "project", "--type", "reference", "--description", "Owner app port", "--body", "Never touch port 3008."]);
    let stdin = Command::new(env!("CARGO_BIN_EXE_atelier"))
        .args(["tool", "memory", "add", "tone", "--scope", "global", "--type", "feedback", "--description", "Plain prose", "--body", "-"])
        .current_dir(&elsewhere).env("ATELIER_DATA_DIR", &data)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .spawn().unwrap();
    use std::io::Write;
    stdin.stdin.as_ref().unwrap().write_all(b"Write short sentences.\n\nWhy: the user asked.").unwrap();
    assert!(stdin.wait_with_output().unwrap().status.success());

    // The main checkout reads what the worktree saved; an unrelated folder
    // reads only the global memory and cannot address project memory.
    assert_eq!(ids(&repo, &data), vec![("global".into(), "tone".into()), ("project".into(), "port".into())]);
    assert_eq!(ids(&elsewhere, &data), vec![("global".into(), "tone".into())]);
    assert!(refused(&elsewhere, &data, &["list", "--scope", "project"]).contains("needs a project"));
    assert!(ok(&repo, &data, &["show", "port"]).contains("Never touch port 3008."));
    let tone: Value = serde_json::from_str(&ok(&repo, &data, &["show", "tone", "--json"])).unwrap();
    assert_eq!((tone["scope"].as_str(), tone["type"].as_str()), (Some("global"), Some("feedback")));
    assert_eq!(tone["body"], "Write short sentences.\n\nWhy: the user asked.");

    // The same ID at both scopes is ambiguous until a scope is named.
    ok(&repo, &data, &["add", "tone", "--scope", "project", "--description", "Local tone", "--body", "Terse."]);
    assert!(refused(&repo, &data, &["show", "tone"]).contains("pass --scope"));
    ok(&repo, &data, &["edit", "tone", "--scope", "project", "--rename", "local-tone", "--body", "Very terse."]);
    assert!(ok(&worktree, &data, &["show", "local-tone"]).contains("Very terse."));
    assert!(refused(&repo, &data, &["edit", "local-tone"]).contains("Nothing to change"));
    assert!(refused(&repo, &data, &["add", "port", "--scope", "project", "--description", "d", "--body", "b"]).contains("already exists"));

    let locations: Value = serde_json::from_str(&ok(&worktree, &data, &["locations"])).unwrap();
    assert_eq!(locations["global"], data.join("memory").to_str().unwrap());
    let project = Path::new(locations["project"].as_str().unwrap());
    assert!(project.join("port.md").is_file());
    assert!(fs::read_to_string(project.join("port.md")).unwrap().starts_with("---\ndescription: Owner app port\ntype: reference\n---\n"));
    assert!(!repo.join(".atelier").exists() && !worktree.join(".atelier").exists(), "the repository is never written");

    ok(&worktree, &data, &["remove", "local-tone"]);
    ok(&elsewhere, &data, &["remove", "tone"]);
    assert!(refused(&repo, &data, &["remove", "tone"]).contains("No memory named tone"));
    assert_eq!(ids(&repo, &data), vec![("project".into(), "port".into())]);
}
