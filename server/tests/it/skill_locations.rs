use atelier::project_manifest::{self, ManifestStorage};
use serde_json::Value;
use std::{fs, path::Path, process::{Command, Output}};

fn run(cwd: &Path, data: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_atelier"))
        .args(["tool", "skills"]).args(args).current_dir(cwd)
        .env("ATELIER_DATA_DIR", data).output().unwrap()
}
fn read(cwd: &Path, data: &Path, args: &[&str]) -> Value {
    let out = run(cwd, data, args);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}
fn register(root: &Path, data: &Path, storage: ManifestStorage) {
    project_manifest::create(root, data, storage, &project_manifest::infer_virtual("Locations test")).unwrap();
}
fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").arg("-C").arg(root)
        .args(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.test"])
        .args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn unregistered_discovery_is_read_only_and_invalid_arguments_fail() {
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().join("absent-data");
    let result = read(scratch.path(), &data, &["locations"]);
    assert_eq!(result["global"]["library"], data.join("library.json").to_str().unwrap());
    assert_eq!(result["project_registered"], false);
    assert!(result["project"].is_null());
    assert!(!data.exists());
    for args in [vec!["locations", "--project"], vec!["locations", "extra"], vec!["locations", "--project", "absent"]] {
        assert!(!run(scratch.path(), &data, &args).status.success());
    }
    assert!(run(scratch.path(), &data, &["--help"]).status.success());
    assert!(!data.exists());
}

#[test]
fn repository_sources_win_and_subfolders_find_the_existing_manifest() {
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().join("data");
    let root = scratch.path().join("project 日本語");
    fs::create_dir_all(root.join("src/nested")).unwrap();
    register(&root, &data, ManifestStorage::Personal);
    let personal = project_manifest::personal_path(&root, &data);
    fs::create_dir_all(root.join(".atelier")).unwrap();
    let manifest = root.join(".atelier/project.toml");
    fs::copy(&personal, &manifest).unwrap();
    let before = fs::read(&manifest).unwrap();
    let result = read(&root.join("src/nested"), &data, &["locations"]);
    assert_eq!(result["project"]["storage"], "repository");
    assert_eq!(result["project"]["instructions"], root.join(".atelier/instructions.md").to_str().unwrap());
    assert_eq!(result["project"]["library"], root.join(".atelier/library.json").to_str().unwrap());
    assert_eq!(fs::read(&manifest).unwrap(), before);
    assert!(!root.join(".atelier/library.json").exists());
    assert!(!root.join(".atelier/instructions.md").exists());
    assert_eq!(read(scratch.path(), &data, &["locations", "--project", root.to_str().unwrap()]), result);
}

#[test]
fn personal_sources_are_shared_by_linked_worktrees_not_guessed_from_cwd() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("repo");
    let data = scratch.path().join("data");
    fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["commit", "--allow-empty", "-qm", "fixture"]);
    register(&root, &data, ManifestStorage::Personal);
    let linked = scratch.path().join("linked");
    git(&root, &["worktree", "add", "--detach", linked.to_str().unwrap()]);
    fs::create_dir_all(linked.join("src")).unwrap();
    let original = read(&root, &data, &["locations"]);
    let copy = read(&linked.join("src"), &data, &["locations"]);
    assert_eq!(copy["project"]["storage"], "personal");
    assert_eq!(copy["project"]["library"], original["project"]["library"]);
    assert_eq!(copy["project"]["instructions"], original["project"]["instructions"]);
    assert_eq!(copy["project_root"], linked.to_str().unwrap());
    assert!(!data.join("library-snapshots").exists());
}

#[test]
fn malformed_manifest_and_file_instead_of_folder_are_reported_not_replaced() {
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().join("data");
    fs::create_dir_all(scratch.path().join(".atelier")).unwrap();
    let manifest = scratch.path().join(".atelier/project.toml");
    fs::write(&manifest, "not valid TOML").unwrap();
    assert!(!run(scratch.path(), &data, &["locations"]).status.success());
    assert!(!run(scratch.path(), &data, &["locations", "--project", manifest.to_str().unwrap()]).status.success());
    assert_eq!(fs::read_to_string(manifest).unwrap(), "not valid TOML");
    assert!(!data.exists());
}
