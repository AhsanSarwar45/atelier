use atelier::{project_manifest::{self, ManifestStorage}, workbench::library};
use std::{fs, path::Path, process::Command};

fn put(root: &Path, name: &str, bytes: impl AsRef<[u8]>) {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn setup() -> (tempfile::TempDir, tempfile::TempDir) {
    let data = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    project_manifest::create(project.path(), data.path(), ManifestStorage::Repository,
        &project_manifest::infer_virtual("Folder test")).unwrap();
    (data, project)
}

#[test]
fn complete_folders_keep_binary_large_resources_scripts_and_pinned_versions() {
    let (data, project) = setup();
    let source = data.path().join("skills/package");
    put(&source, "SKILL.md", "---\nname: Package\ndescription: Read the package\n---\nRun scripts/read.sh");
    put(&source, "scripts/read.sh", "#!/bin/sh\ncd -- \"$(dirname -- \"$0\")/..\"\ncat references/nested/message.txt\n");
    put(&source, "references/nested/message.txt", "first-version");
    put(&source, "assets/image.bin", [0, 255, 1, 0, 2]);
    put(&source, "references/large.txt", "x".repeat(200_000));
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(source.join("scripts/read.sh"), fs::Permissions::from_mode(0o755)).unwrap(); }
    let first = library::resolve(data.path(), Some(project.path())).unwrap();
    let row = first.items.iter().find(|r|r.item.id == "package").unwrap();
    assert_eq!(row.state, "available");
    let pinned = &row.folder.as_ref().unwrap().directory;
    assert_eq!(fs::read(pinned.join("assets/image.bin")).unwrap(), [0,255,1,0,2]);
    assert_eq!(first.read_skill("package", Some("references/large.txt")).unwrap().len(), 200_000);
    assert!(first.read_skill("package", Some("assets/image.bin")).unwrap_err().contains("Binary asset"));
    assert!(first.read_skill("package", Some("../../library.json")).is_err());
    assert!(first.read_skill("package", None).unwrap().contains(pinned.to_str().unwrap()));
    #[cfg(unix)] {
        let out = Command::new(pinned.join("scripts/read.sh")).current_dir(project.path()).output().unwrap();
        assert!(out.status.success()); assert_eq!(out.stdout, b"first-version");
    }
    first.persist(data.path()).unwrap();
    put(&source, "references/nested/message.txt", "second-version");
    let second = library::resolve(data.path(), Some(project.path())).unwrap();
    assert_ne!(first.revision, second.revision);
    assert_eq!(first.read_skill("package", Some("references/nested/message.txt")).unwrap(), "first-version");
    assert_eq!(second.read_skill("package", Some("references/nested/message.txt")).unwrap(), "second-version");
    assert!(!data.path().join("library.json").exists());
}

#[test]
fn project_conditions_manual_invocation_and_overrides_use_the_common_resolver() {
    let (data, project) = setup();
    let global = data.path().join("skills/shared");
    put(&global, "SKILL.md", "---\nname: Shared\ndescription: Global procedure\n---\nOriginal");
    put(project.path(), ".atelier/skills/manual/SKILL.md", "---\nname: Manual\ndisable-model-invocation: true\n---\nManual procedure");
    put(project.path(), ".atelier/skills/manual/atelier.json", r#"{"when":{"op":"file_exists","path":"package.json"}}"#);
    let held = library::read(data.path(), Some(project.path())).unwrap();
    let mut customized = held.clone();
    customized.overrides.insert("shared".into(), serde_json::from_str(r#"{"content":"Project replacement"}"#).unwrap());
    library::write(data.path(), Some(project.path()), &customized, &library::revision(&held)).unwrap();
    let snapshot = library::resolve(data.path(), Some(project.path())).unwrap();
    let shared = snapshot.items.iter().find(|r|r.item.id == "shared").unwrap();
    assert!(shared.customized);
    assert!(fs::read_to_string(shared.folder.as_ref().unwrap().directory.join("SKILL.md")).unwrap().ends_with("Project replacement"));
    assert_eq!(snapshot.items.iter().find(|r|r.item.id == "manual").unwrap().state, "not_applicable");
    put(project.path(), "package.json", "{}");
    let snapshot = library::resolve(data.path(), Some(project.path())).unwrap();
    let manual = snapshot.items.iter().find(|r|r.item.id == "manual").unwrap();
    assert_eq!(manual.state, "available"); assert!(!manual.item.automatic);
    assert!(!snapshot.guidance().contains("Available skill manual"));
    assert!(snapshot.expand("/skill:manual go").unwrap().unwrap().contains("Skill directory:"));
}

#[test]
fn folder_ids_cannot_be_shadowed_and_changes_invalidate_customization_source_revision() {
    let (data, project) = setup();
    let source = data.path().join("skills/review");
    put(&source, "SKILL.md", "Review version one");
    let previous = library::source_revision(data.path()).unwrap();
    put(&source, "SKILL.md", "Review version two");
    let local = library::read(data.path(), Some(project.path())).unwrap();
    assert!(library::write_with_source(data.path(), Some(project.path()), &local,
        &library::revision(&local), Some(&previous)).unwrap_err().contains("Global library changed"));
    let mut global = library::read(data.path(), None).unwrap();
    let rev = library::revision(&global);
    global.items.push(library::resolve(data.path(), None).unwrap().items.into_iter().find(|r|r.item.id == "review").unwrap().item);
    assert!(library::write(data.path(), None, &global, &rev).unwrap_err().contains("already owns this ID"));
}

#[test]
fn moving_project_settings_keeps_complete_skill_folders_and_refuses_collisions() {
    let (data, project) = setup();
    put(project.path(), ".atelier/skills/move-me/SKILL.md", "Read assets/data.bin");
    put(project.path(), ".atelier/skills/move-me/assets/data.bin", [0, 255, 8]);
    let destination = project_manifest::move_to(project.path(), data.path(), ManifestStorage::Personal).unwrap();
    assert!(!project.path().join(".atelier/skills").exists());
    assert_eq!(fs::read(destination.with_file_name("skills/move-me/assets/data.bin")).unwrap(), [0,255,8]);
    assert!(library::resolve(data.path(), Some(project.path())).unwrap().read_skill("move-me", None).is_ok());
    put(project.path(), ".atelier/skills/conflict/SKILL.md", "Keep me");
    assert!(project_manifest::move_to(project.path(), data.path(), ManifestStorage::Repository).unwrap_err().contains("already exist"));
    assert!(destination.exists());
}

#[test]
#[cfg(unix)]
fn internal_links_are_copied_but_escaping_links_and_cycles_fail_closed() {
    use std::os::unix::fs::symlink;
    let (data, project) = setup();
    let source = data.path().join("skills/links");
    put(&source, "SKILL.md", "Read references");
    put(&source, "references/a.txt", "internal");
    symlink("references/a.txt", source.join("copy.txt")).unwrap();
    let first = library::resolve(data.path(), Some(project.path())).unwrap();
    assert_eq!(first.read_skill("links", Some("copy.txt")).unwrap(), "internal");
    assert!(!fs::symlink_metadata(first.items.iter().find(|r|r.item.id == "links").unwrap().folder.as_ref().unwrap().directory.join("copy.txt")).unwrap().file_type().is_symlink());
    symlink(project.path(), source.join("outside")).unwrap();
    assert!(library::resolve(data.path(), Some(project.path())).unwrap_err().contains("escapes"));
    fs::remove_file(source.join("outside")).unwrap();
    symlink(".", source.join("cycle")).unwrap();
    assert!(library::resolve(data.path(), Some(project.path())).unwrap_err().contains("cycle"));
}
