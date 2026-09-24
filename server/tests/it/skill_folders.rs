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
fn folder_deletion_archives_exact_scope_and_preserves_pinned_copies() {
    use atelier::workbench::skill_folders::{delete_read, delete_write};
    for local in [false, true] {
        let (data, project) = setup();
        let scope = local.then_some(project.path());
        let base = if local { project.path().join(".atelier") } else { data.path().to_path_buf() };
        put(&base, "skills/removable/SKILL.md", "Original procedure");
        put(&base, "skills/removable/assets/binary", [0, 255, 8]);
        put(&base, "skills/removable/scripts/run.py", "print('original')");
        let pinned = library::resolve(data.path(), scope).unwrap();
        let plan = delete_read(data.path(), scope, "removable").unwrap();
        assert_eq!(plan.files, 3);
        assert_eq!(plan.source, fs::canonicalize(base.join("skills/removable")).unwrap());
        assert!(delete_read(data.path(), if local { None } else { Some(project.path()) }, "removable").is_err());
        put(&base, "skills/removable/assets/binary", [0, 255, 9]);
        assert!(delete_write(data.path(), scope, "removable", &plan.revision).unwrap_err().contains("changed"));
        let plan = delete_read(data.path(), scope, "removable").unwrap();
        put(&base, "skills/removable/SKILL.md", "Updated procedure");
        assert!(delete_write(data.path(), scope, "removable", &plan.revision).is_err());
        let plan = delete_read(data.path(), scope, "removable").unwrap();
        let archive = delete_write(data.path(), scope, "removable", &plan.revision).unwrap();
        assert!(archive.starts_with(base.join("deleted-skills")));
        assert!(!base.join("skills/removable").exists());
        assert_eq!(fs::read(archive.join("assets/binary")).unwrap(), [0,255,9]);
        assert_eq!(fs::read_to_string(archive.join("scripts/run.py")).unwrap(), "print('original')");
        assert_eq!(fs::read_to_string(archive.join("SKILL.md")).unwrap(), "Updated procedure");
        assert!(library::resolve(data.path(), scope).unwrap().read_skill("removable", None).is_err());
        assert!(pinned.read_skill("removable", None).unwrap().contains("Original procedure"));
        assert_eq!(fs::read(pinned.items.iter().find(|row| row.item.id == "removable").unwrap().folder.as_ref().unwrap().directory.join("assets/binary")).unwrap(), [0,255,8]);
        assert!(delete_read(data.path(), scope, "../removable").is_err());
        assert!(delete_read(data.path(), scope, "atelier-app").is_err());
        put(&base, "skills/invalid/SKILL.md", "---\ninvalid: [");
        put(&base, "skills/invalid/atelier.json", "not JSON");
        let invalid = delete_read(data.path(), scope, "invalid").unwrap();
        let archive = delete_write(data.path(), scope, "invalid", &invalid.revision).unwrap();
        assert_eq!(fs::read_to_string(archive.join("atelier.json")).unwrap(), "not JSON");
    }
}

#[test]
#[cfg(unix)]
fn folder_deletion_never_follows_links_and_refuses_linked_roots_or_archives() {
    use atelier::workbench::skill_folders::{delete_read, delete_write};
    use std::os::unix::fs::symlink;
    let (data, project) = setup();
    put(data.path(), "skills/links/SKILL.md", "Body");
    put(project.path(), "outside", "Do not modify");
    symlink(project.path().join("outside"), data.path().join("skills/links/outside-link")).unwrap();
    symlink("SKILL.md", data.path().join("skills/links/internal-link")).unwrap();
    symlink("absent", data.path().join("skills/links/dangling-link")).unwrap();
    let plan = delete_read(data.path(), None, "links").unwrap();
    assert_eq!(plan.files, 4);
    symlink(data.path().join("skills/links"), data.path().join("skills/root-link")).unwrap();
    assert!(delete_read(data.path(), None, "root-link").is_err());
    symlink(project.path(), data.path().join("deleted-skills")).unwrap();
    assert!(delete_write(data.path(), None, "links", &plan.revision).is_err());
    fs::remove_file(data.path().join("deleted-skills")).unwrap();
    let archive = delete_write(data.path(), None, "links", &plan.revision).unwrap();
    assert_eq!(fs::read_link(archive.join("outside-link")).unwrap(), project.path().join("outside"));
    assert_eq!(fs::read_link(archive.join("internal-link")).unwrap(), Path::new("SKILL.md"));
    assert_eq!(fs::read_link(archive.join("dangling-link")).unwrap(), Path::new("absent"));
    assert_eq!(fs::read_to_string(project.path().join("outside")).unwrap(), "Do not modify");
    let alternate = tempfile::tempdir().unwrap();
    fs::create_dir_all(alternate.path().join("source/one")).unwrap();
    put(alternate.path(), "source/one/SKILL.md", "Body");
    symlink(alternate.path().join("source"), alternate.path().join("skills")).unwrap();
    assert!(delete_read(alternate.path(), None, "one").is_err());
}

#[test]
fn project_skill_switches_cover_both_sources_and_storage_formats() {
    for folder in [false, true] {
        for local in [false, true] {
            for automatic in [false, true] {
                let (data, project) = setup();
                let other = tempfile::tempdir().unwrap();
                project_manifest::create(other.path(), data.path(), ManifestStorage::Repository,
                    &project_manifest::infer_virtual("Other project")).unwrap();
                let scope = local.then_some(project.path());
                if folder {
                    let base = if local { project.path().join(".atelier") } else { data.path().to_path_buf() };
                    put(&base, "skills/toggle/SKILL.md", "---\nname: Toggle\ndescription: Distinct trigger\n---\nOriginal {{value}}");
                    put(&base, "skills/toggle/references/guide.md", "Supporting resource");
                    put(&base, "skills/toggle/atelier.json", serde_json::to_vec(&serde_json::json!({
                        "automatic": automatic, "parameters": {"value": "original"}
                    })).unwrap());
                } else {
                    let held = library::read(data.path(), scope).unwrap();
                    let mut changed = held.clone();
                    changed.items.push(serde_json::from_value(serde_json::json!({
                        "id": "toggle", "name": "Toggle", "kind": "skill", "description": "Distinct trigger",
                        "content": "Original {{value}}", "automatic": automatic,
                        "parameters": {"value": "original"}, "resources": {"references/guide.md": "Supporting resource"}
                    })).unwrap());
                    library::write(data.path(), scope, &changed, &library::revision(&held)).unwrap();
                }
                let global_before = library::resolve(data.path(), None).unwrap();
                let other_before = library::resolve(data.path(), Some(other.path())).unwrap();
                let before = library::resolve(data.path(), Some(project.path())).unwrap();
                assert!(before.read_skill("toggle", None).unwrap().contains("Original original"));
                let held = library::read(data.path(), Some(project.path())).unwrap();
                let mut changed = held.clone();
                changed.overrides.insert("toggle".into(), serde_json::from_value(serde_json::json!({
                    "disabled": true, "content": "Custom {{value}}", "automatic": !automatic,
                    "parameters": {"value": "custom"}, "when": {"op": "always"}
                })).unwrap());
                library::write(data.path(), Some(project.path()), &changed, &library::revision(&held)).unwrap();
                assert!(library::read(data.path(), Some(project.path())).unwrap().overrides["toggle"].disabled);
                let off = library::resolve(data.path(), Some(project.path())).unwrap();
                assert_eq!(off.items.iter().find(|row| row.item.id == "toggle").unwrap().state, "disabled");
                assert!(!off.guidance().contains("Available skill toggle"));
                assert!(!off.commands().iter().any(|command| command["name"] == "skill:toggle"));
                assert!(off.mcp_servers().unwrap().is_empty());
                assert!(off.read_skill("toggle", None).unwrap_err().contains("disabled"));
                assert!(off.read_skill("toggle", Some("references/guide.md")).is_err());
                assert!(off.expand("/skill:toggle arguments").is_err());
                assert_eq!(library::resolve(data.path(), None).unwrap().revision, global_before.revision);
                assert_eq!(library::resolve(data.path(), Some(other.path())).unwrap().revision, other_before.revision);
                // A pre-existing connection keeps its immutable snapshot until reconnect.
                assert!(before.read_skill("toggle", None).is_ok());
                let held = library::read(data.path(), Some(project.path())).unwrap();
                let mut changed = held.clone();
                changed.overrides.get_mut("toggle").unwrap().disabled = false;
                library::write(data.path(), Some(project.path()), &changed, &library::revision(&held)).unwrap();
                let on = library::resolve(data.path(), Some(project.path())).unwrap();
                let row = on.items.iter().find(|row| row.item.id == "toggle").unwrap();
                assert_eq!(row.state, "available");
                assert_eq!(row.item.automatic, if local { automatic } else { !automatic });
                assert_eq!(on.guidance().contains("Available skill toggle"), row.item.automatic);
                assert!(on.read_skill("toggle", None).unwrap().contains(if local { "Original original" } else { "Custom custom" }));
                assert!(on.commands().iter().any(|command| command["name"] == "skill:toggle"));
                assert!(on.expand("/skill:toggle arguments").is_ok());
                assert!(on.read_skill("toggle", Some("references/guide.md")).is_ok());
            }
        }
    }
}

#[test]
fn folder_editor_preserves_native_metadata_assets_and_refuses_stale_writes() {
    use atelier::workbench::skill_folders::{edit_read, edit_write};
    let (data, project) = setup();
    let source = data.path().join("skills/editable");
    put(&source, "SKILL.md", "---\nname: Original\nallowed-tools: [Read, Bash]\ncustom: {nested: true}\n---\nUse {{name}}.");
    put(&source, "atelier.json", r#"{"parameters":{"name":"World"}}"#);
    put(&source, "assets/binary", [0, 255, 7]);
    put(&source, "scripts/run.py", "print('unchanged')");
    let before = edit_read(data.path(), None, "editable").unwrap();
    assert_eq!(before.item.content, "Use {{name}}.");
    let mut edited = before.item.clone();
    edited.name = "Edited".into(); edited.description = "Changed description".into();
    edited.content = "Updated {{name}}.".into(); edited.automatic = false;
    edited.requires = vec!["python3".into()];
    edited.when = serde_json::from_str(r#"{"op":"file_exists","path":"package.json"}"#).unwrap();
    let after = edit_write(data.path(), None, "editable", &edited, &before.revision).unwrap();
    assert_ne!(before.revision, after.revision);
    assert_eq!(after.item.content, edited.content);
    assert!(!after.item.automatic);
    assert_eq!(serde_json::to_value(&after.item.when).unwrap(), serde_json::json!({"op":"file_exists","path":"package.json"}));
    assert_eq!(after.item.requires, ["python3"]);
    assert_eq!(after.item.parameters.get("name").unwrap(), "World");
    let text = fs::read_to_string(source.join("SKILL.md")).unwrap();
    assert!(text.contains("allowed-tools:")); assert!(text.contains("nested: true"));
    assert_eq!(fs::read(source.join("assets/binary")).unwrap(), [0,255,7]);
    assert_eq!(fs::read_to_string(source.join("scripts/run.py")).unwrap(), "print('unchanged')");
    assert!(edit_write(data.path(), None, "editable", &edited, &before.revision).unwrap_err().contains("changed"));
    assert!(edit_read(data.path(), Some(project.path()), "editable").is_err(), "Project editor cannot write inherited global source");
    assert!(edit_read(data.path(), None, "../editable").is_err());
    let snapshot = library::resolve(data.path(), None).unwrap();
    assert!(!snapshot.items.iter().find(|r| r.item.id == "editable").unwrap().item.automatic);
    put(project.path(), ".atelier/skills/local/SKILL.md", "Local body");
    let local = edit_read(data.path(), Some(project.path()), "local").unwrap();
    let mut item = local.item; item.content = "Edited local".into();
    edit_write(data.path(), Some(project.path()), "local", &item, &local.revision).unwrap();
    assert!(fs::read_to_string(project.path().join(".atelier/skills/local/SKILL.md")).unwrap().contains("Edited local"));
}

#[test]
#[cfg(unix)]
fn folder_editor_refuses_symlinked_sources_and_metadata() {
    use atelier::workbench::skill_folders::edit_read;
    use std::os::unix::fs::symlink;
    let (data, project) = setup();
    put(project.path(), "outside/SKILL.md", "Outside");
    fs::create_dir_all(data.path().join("skills")).unwrap();
    symlink(project.path().join("outside"), data.path().join("skills/linked")).unwrap();
    assert!(edit_read(data.path(), None, "linked").unwrap_err().contains("symlink"));
    put(data.path(), "skills/metadata/SKILL.md", "Body");
    put(project.path(), "settings.json", "{}");
    symlink(project.path().join("settings.json"), data.path().join("skills/metadata/atelier.json")).unwrap();
    assert!(edit_read(data.path(), None, "metadata").unwrap_err().contains("symlink"));
}

#[test]
fn folder_editor_serializes_competing_writers_and_detects_native_metadata_edits() {
    use atelier::workbench::skill_folders::{edit_read, edit_write};
    let (data, _) = setup();
    put(data.path(), "skills/race/SKILL.md", "Original");
    let before = edit_read(data.path(), None, "race").unwrap();
    let results = std::thread::scope(|scope| {
        let threads: Vec<_> = ["First", "Second"].into_iter().map(|content| {
            let mut item = before.item.clone(); item.content = content.into();
            let data = data.path(); let revision = &before.revision;
            scope.spawn(move || edit_write(data, None, "race", &item, revision))
        }).collect();
        threads.into_iter().map(|thread| thread.join().unwrap()).collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let before = edit_read(data.path(), None, "race").unwrap();
    let skill = data.path().join("skills/race/SKILL.md");
    let text = fs::read_to_string(&skill).unwrap().replacen("---\n", "---\nnative-extra: preserved\n", 1);
    fs::write(&skill, text).unwrap();
    assert!(edit_write(data.path(), None, "race", &before.item, &before.revision).unwrap_err().contains("changed"));
    let before = edit_read(data.path(), None, "race").unwrap();
    let mut invalid = before.item.clone(); invalid.kind = library::Kind::Instruction;
    assert!(edit_write(data.path(), None, "race", &invalid, &before.revision).is_err());
    invalid = before.item.clone(); invalid.content = "x".repeat(128 * 1024);
    assert!(edit_write(data.path(), None, "race", &invalid, &before.revision).is_err());
    assert_eq!(edit_read(data.path(), None, "race").unwrap().revision, before.revision);
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
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), fs::read(pinned.join("SKILL.md")).unwrap());
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
    let invalid = library::resolve(data.path(), Some(project.path())).unwrap();
    assert!(invalid.items.iter().find(|r|r.item.id == "links").unwrap().evaluation.reason.contains("escapes"));
    assert!(invalid.read_skill("links", None).is_err());
    fs::remove_file(source.join("outside")).unwrap();
    symlink(".", source.join("cycle")).unwrap();
    let invalid = library::resolve(data.path(), Some(project.path())).unwrap();
    assert!(invalid.items.iter().find(|r|r.item.id == "links").unwrap().evaluation.reason.contains("cycle"));
}

#[test]
fn broken_folders_are_reported_without_disabling_valid_skills_or_library_edits() {
    let (data, project) = setup();
    put(data.path(), "skills/valid/SKILL.md", "Valid procedure");
    put(data.path(), "skills/Bad Name/SKILL.md", "Invalid folder name");
    put(data.path(), "skills/bad-yaml/SKILL.md", "---\nname: [\n---\nBad metadata");
    put(data.path(), "skills/bad-json/SKILL.md", "Bad settings");
    put(data.path(), "skills/bad-json/atelier.json", "{");
    put(data.path(), "skills/duplicate/SKILL.md", "Folder source");
    put(data.path(), "library.json", r#"{"items":[{"id":"duplicate","name":"Duplicate","kind":"skill","content":"JSON source"}]}"#);
    #[cfg(unix)] {
        put(data.path(), "skills/broken-link/SKILL.md", "Broken reference");
        std::os::unix::fs::symlink("missing", data.path().join("skills/broken-link/ref")).unwrap();
    }
    let snapshot = library::resolve(data.path(), Some(project.path())).unwrap();
    assert!(snapshot.read_skill("valid", None).unwrap().contains("Valid procedure"));
    for row in snapshot.items.iter().filter(|r|r.folder_source.is_some() && r.item.id != "valid") {
        assert_eq!(row.state, "invalid");
        assert!(row.evaluation.reason.contains("Invalid skill folder"));
        assert!(row.folder.is_none());
        assert!(snapshot.read_skill(&row.item.id, None).is_err());
    }
    let held = library::read(data.path(), None).unwrap();
    let duplicate = snapshot.items.iter().find(|r| r.item.id == "duplicate").unwrap();
    assert_eq!(duplicate.state, "invalid");
    assert!(duplicate.folder_source.is_none(), "Keep JSON editing and removal available");
    let mut edited = held.clone();
    edited.general_instructions = "Unrelated settings still save".into();
    library::write(data.path(), None, &edited, &library::revision(&held)).unwrap();
    let mut repaired = edited.clone();
    repaired.items.clear();
    library::write(data.path(), None, &repaired, &library::revision(&edited)).unwrap();
    assert!(library::resolve(data.path(), None).unwrap().read_skill("duplicate", None).is_ok());
    assert!(snapshot.guidance().contains("valid"));
    assert!(!snapshot.commands().iter().any(|c| c["name"] == "skill:bad-yaml"));
}
