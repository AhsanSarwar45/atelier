//! Filesystem-backed skills. Source folders are editable; session folders are
//! content-addressed copies. Discovery never executes a skill's helpers.
use super::library::{Condition, Item, Kind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::{Path, PathBuf}};

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|e| e.to_string())?.take(limit + 1)
        .read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit { return Err(format!("{} exceeds {} bytes", path.display(), limit)); }
    Ok(bytes)
}

fn frontmatter(text: &str) -> Result<(&str, &str), String> {
    let Some(rest) = text.strip_prefix("---\n") else { return Ok(("", text.trim())); };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches('\n') == "---" {
            return Ok((&rest[..offset], rest[offset + line.len()..].trim()));
        }
        offset += line.len();
    }
    Err("Unterminated skill frontmatter".into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Folder {
    pub source: PathBuf,
    pub directory: PathBuf,
    pub revision: String,
}

pub struct Source {
    pub item: Item,
    pub directory: PathBuf,
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Settings {
    when: Condition,
    requires: Vec<String>,
    parameters: BTreeMap<String, String>,
    automatic: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct Editor {
    pub item: Item,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct DeletePlan {
    pub revision: String,
    pub source: PathBuf,
    pub files: usize,
}

fn deletion_path(data: &Path, root: Option<&Path>, id: &str) -> Result<PathBuf, String> {
    if !super::library::valid_id(id) || id.starts_with("atelier-") { return Err("Invalid skill folder ID".into()); }
    let scope = super::library::library_path(data, root)?.parent().unwrap().to_path_buf();
    let path = scope.join("skills").join(id);
    for target in [&scope, &scope.join("skills"), &path] {
        let metadata = fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() { return Err("Cannot delete a symlinked or non-directory skill source".into()); }
    }
    // Invalid metadata is still removable. Never parse it or follow its links.
    fs::symlink_metadata(path.join("SKILL.md")).map_err(|_| "Skill folder not found".to_string())?;
    fs::canonicalize(path).map_err(|e| e.to_string())
}

fn deletion_plan(path: &Path) -> Result<DeletePlan, String> {
    fn walk(path: &Path, relative: &Path, hash: &mut Sha256, entries: &mut usize, files: &mut usize, total: &mut u64, depth: usize) -> Result<(), String> {
        if depth > 40 || *entries >= 4096 { return Err("Skill deletion exceeds 40 levels or 4096 entries".into()); }
        *entries += 1;
        let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        let name = relative.as_os_str().as_encoded_bytes();
        hash.update((name.len() as u64).to_le_bytes()); hash.update(name);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; hash.update(metadata.permissions().mode().to_le_bytes()); }
        if metadata.file_type().is_symlink() {
            hash.update(b"link");
            let target = fs::read_link(path).map_err(|e| e.to_string())?;
            let bytes = target.as_os_str().as_encoded_bytes();
            hash.update((bytes.len() as u64).to_le_bytes()); hash.update(bytes); *files += 1;
        } else if metadata.is_dir() {
            hash.update(b"directory");
            let mut children = fs::read_dir(path).map_err(|e| e.to_string())?
                .take(4097).map(|entry| entry.map(|entry| entry.file_name())).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            if children.len() > 4096 { return Err("Skill deletion exceeds 4096 entries".into()); }
            children.sort();
            for child in children { walk(&path.join(&child), &relative.join(&child), hash, entries, files, total, depth + 1)?; }
        } else if metadata.is_file() {
            if metadata.len() > 64 * 1024 * 1024 || *total + metadata.len() > 256 * 1024 * 1024 { return Err("Skill deletion exceeds 64 MiB/file or 256 MiB total".into()); }
            let bytes = bounded_read(path, (64 * 1024 * 1024).min(256 * 1024 * 1024 - *total))?;
            hash.update(b"file"); hash.update((bytes.len() as u64).to_le_bytes()); hash.update(&bytes);
            *total += bytes.len() as u64; *files += 1;
        } else { return Err("Cannot delete a skill containing special files".into()); }
        Ok(())
    }
    let mut hash = Sha256::new();
    let (mut entries, mut files, mut total) = (0, 0, 0);
    walk(path, Path::new(""), &mut hash, &mut entries, &mut files, &mut total, 0)?;
    Ok(DeletePlan { revision: format!("{:x}", hash.finalize()), source: path.into(), files })
}

pub fn delete_read(data: &Path, root: Option<&Path>, id: &str) -> Result<DeletePlan, String> {
    let _guard = super::library::WRITES.lock().map_err(|e| e.to_string())?;
    deletion_plan(&deletion_path(data, root, id)?)
}

pub fn delete_write(data: &Path, root: Option<&Path>, id: &str, expected: &str) -> Result<PathBuf, String> {
    let _guard = super::library::WRITES.lock().map_err(|e| e.to_string())?;
    let path = deletion_path(data, root, id)?;
    if deletion_plan(&path)?.revision != expected { return Err("Skill changed in another editor. Reload before deleting.".into()); }
    let archive_root = path.parent().unwrap().parent().unwrap().join("deleted-skills");
    match fs::create_dir(&archive_root) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(&archive_root).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() { return Err("Skill archive must be a real directory".into()); }
    let archive = tempfile::Builder::new().prefix("deleted-").tempdir_in(&archive_root).map_err(|e| e.to_string())?;
    let destination = archive.path().join(id);
    // Catch ordinary external writes during preparation as well as stale dialogs.
    if deletion_path(data, root, id)? != path || deletion_plan(&path)?.revision != expected { return Err("Skill changed in another editor. Reload before deleting.".into()); }
    fs::rename(&path, &destination).map_err(|e| e.to_string())?;
    let _ = archive.keep();
    Ok(destination)
}

fn editable_path(data: &Path, root: Option<&Path>, id: &str) -> Result<PathBuf, String> {
    if !super::library::valid_id(id) || id.starts_with("atelier-") {
        return Err("Invalid skill folder ID".into());
    }
    let scope = super::library::library_path(data, root)?.parent().unwrap().to_path_buf();
    let scope = fs::canonicalize(scope).map_err(|e| e.to_string())?;
    let path = scope.join("skills").join(id);
    // Editing a link could change an unrelated provider/source folder. Refuse
    // linked roots and files even when discovery can read them safely.
    for target in [scope.join("skills"), path.clone(), path.join("SKILL.md"), path.join("atelier.json")] {
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("Cannot edit a symlinked skill source".into()),
            Ok(meta) if target.file_name().is_some_and(|n| n == "SKILL.md" || n == "atelier.json") && !meta.is_file() => return Err("Skill metadata must be regular files".into()),
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && target == path.join("atelier.json") => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(path)
}

fn editor_at(path: &Path, id: &str) -> Result<Editor, String> {
    let source = discover(path.parent().unwrap())?.into_iter().find(|s| s.item.id == id)
        .ok_or("Skill folder not found")?;
    if let Some(error) = source.error { return Err(error); }
    let mut hash = Sha256::new();
    for name in ["SKILL.md", "atelier.json"] {
        let file = path.join(name);
        if file.exists() {
            let bytes = bounded_read(&file, 128 * 1024)?;
            hash.update([1]); hash.update((bytes.len() as u64).to_le_bytes()); hash.update(bytes);
        } else { hash.update([0]); }
    }
    Ok(Editor { item: source.item, revision: format!("{:x}", hash.finalize()) })
}

pub fn edit_read(data: &Path, root: Option<&Path>, id: &str) -> Result<Editor, String> {
    let _guard = super::library::WRITES.lock().map_err(|e| e.to_string())?;
    editor_at(&editable_path(data, root, id)?, id)
}

pub fn edit_write(data: &Path, root: Option<&Path>, id: &str, item: &Item, expected: &str) -> Result<Editor, String> {
    let _guard = super::library::WRITES.lock().map_err(|e| e.to_string())?;
    if item.id != id || item.kind != Kind::Skill || !item.resources.is_empty() || !item.bundle.is_empty() {
        return Err("Folder editing cannot change ID, kind, resources or bundle".into());
    }
    super::library::validate(&super::library::Library { items: vec![item.clone()], ..Default::default() }, root.is_some())?;
    let path = editable_path(data, root, id)?;
    if editor_at(&path, id)?.revision != expected { return Err("Skill changed in another editor. Reload before saving.".into()); }
    let original = bounded_read(&path.join("SKILL.md"), 128 * 1024)?;
    let text = String::from_utf8(original.clone()).map_err(|e| e.to_string())?.replace("\r\n", "\n");
    let (header, _) = frontmatter(&text)?;
    let mut metadata: serde_yaml::Value = serde_yaml::from_str(header).map_err(|e| e.to_string())?;
    if metadata.is_null() { metadata = serde_yaml::Value::Mapping(Default::default()); }
    let mapping = metadata.as_mapping_mut().ok_or("Skill frontmatter must be a mapping")?;
    mapping.insert("name".into(), item.name.clone().into());
    mapping.insert("description".into(), item.description.clone().into());
    let skill = format!("---\n{}---\n\n{}\n", serde_yaml::to_string(&metadata).map_err(|e| e.to_string())?, item.content);
    let settings = serde_json::to_vec_pretty(&Settings { when: item.when.clone(), requires: item.requires.clone(), parameters: item.parameters.clone(), automatic: Some(item.automatic) }).map_err(|e| e.to_string())?;
    if skill.len() > 128 * 1024 || settings.len() > 128 * 1024 { return Err("Skill metadata exceeds 128 KiB".into()); }
    // Same-filesystem temporary files are prepared before either source changes.
    // The shared resolver/writer lock hides the pair while committing; restore
    // SKILL.md if committing the sidecar fails.
    let prepare = |bytes: &[u8]| -> Result<tempfile::NamedTempFile, String> {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(&path).map_err(|e| e.to_string())?;
        file.write_all(bytes).and_then(|_| file.as_file().sync_all()).map_err(|e| e.to_string())?;
        Ok(file)
    };
    let skill_temp = prepare(skill.as_bytes())?;
    let settings_temp = prepare(&settings)?;
    // Recheck after preparing to catch ordinary external file edits.
    editable_path(data, root, id)?;
    if editor_at(&path, id)?.revision != expected { return Err("Skill changed in another editor. Reload before saving.".into()); }
    skill_temp.persist(path.join("SKILL.md")).map_err(|e| e.to_string())?;
    if let Err(error) = settings_temp.persist(path.join("atelier.json")) {
        super::provider_defaults::atomic_write(&path.join("SKILL.md"), &original)
            .map_err(|rollback| format!("{error}; restoring SKILL.md failed: {rollback}"))?;
        return Err(error.to_string());
    }
    editor_at(&path, id)
}

/// The folder name is the stable library ID. SKILL.md keeps native metadata;
/// optional atelier.json holds provider-independent availability settings.
pub fn discover(parent: &Path) -> Result<Vec<Source>, String> {
    if !parent.exists() { return Ok(vec![]); }
    let mut paths = fs::read_dir(parent).map_err(|e| e.to_string())?
        .map(|e| e.map(|e| e.path())).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    paths.sort();
    let mut result = vec![];
    for path in paths {
        if fs::symlink_metadata(path.join("SKILL.md")).is_err() { continue; }
        let parsed = (|| -> Result<Source, String> {
        let id = path.file_name().and_then(|v| v.to_str()).ok_or("Skill folder needs a UTF-8 name")?;
        if !super::library::valid_id(id) || id.starts_with("atelier-") {
            return Err(format!("Skill folder {id}: choose a lowercase kebab-case ID not starting with atelier-"));
        }
        let text = String::from_utf8(bounded_read(&path.join("SKILL.md"), 128 * 1024)?).map_err(|e| e.to_string())?;
        let normalized = text.replace("\r\n", "\n");
        let (header, body) = frontmatter(&normalized)?;
        let metadata = serde_yaml::from_str::<serde_yaml::Value>(header).map_err(|e| format!("Skill {id}: {e}"))?;
        let settings_path = path.join("atelier.json");
        let settings: Settings = if settings_path.exists() {
            serde_json::from_slice(&bounded_read(&settings_path, 128 * 1024)?)
                .map_err(|e| format!("{}: {e}", settings_path.display()))?
        } else { Settings::default() };
        let item = Item {
            id: id.into(), name: metadata["name"].as_str().unwrap_or(id).into(), kind: Kind::Skill,
            description: metadata["description"].as_str().unwrap_or("").into(), content: body.into(),
            when: settings.when, requires: settings.requires,
            automatic: settings.automatic.unwrap_or(metadata["disable-model-invocation"].as_bool() != Some(true)),
            parameters: settings.parameters, resources: BTreeMap::new(), bundle: String::new(),
        };
        super::library::validate(&super::library::Library { items: vec![item.clone()], ..Default::default() }, false)?;
        Ok(Source { directory: fs::canonicalize(&path).map_err(|e| e.to_string())?, item, error: None })
        })();
        result.push(parsed.unwrap_or_else(|error| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let id = if super::library::valid_id(&name) && !name.starts_with("atelier-") { name.to_string() }
                else { format!("invalid-folder-{:x}", Sha256::digest(name.as_bytes())) };
            Source { directory: path.clone(), error: Some(error.clone()), item: Item {
                id, name: name.chars().take(100).collect(), kind: Kind::Skill,
                description: error.chars().take(500).collect(), content: String::new(),
                when: Condition::Always, requires: vec![], automatic: true,
                parameters: BTreeMap::new(), resources: BTreeMap::new(), bundle: String::new(),
            }}
        }));
    }
    Ok(result)
}

struct File { bytes: Vec<u8>, executable: bool }
fn collect(root: &Path, path: &Path, relative: &Path, files: &mut BTreeMap<PathBuf, File>, total: &mut u64, depth: usize) -> Result<(), String> {
    if depth > 40 { return Err("Skill directory nesting or symlink cycle exceeds 40 levels".into()); }
    let real = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !real.starts_with(root) { return Err(format!("Skill link escapes its folder: {}", path.display())); }
    let meta = fs::metadata(&real).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        for entry in fs::read_dir(&real).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            // Generated interpreter caches and Git internals aren't skill assets.
            if entry.file_name() == "__pycache__" || entry.file_name() == ".git" { continue; }
            collect(root, &entry.path(), &relative.join(entry.file_name()), files, total, depth + 1)?;
        }
    } else if meta.is_file() {
        if meta.len() > 64 * 1024 * 1024 || *total + meta.len() > 256 * 1024 * 1024 || files.len() >= 4096 {
            return Err("Skill folder exceeds 64 MiB/file, 256 MiB total or 4096 files".into());
        }
        #[cfg(unix)] let executable = { use std::os::unix::fs::PermissionsExt; meta.permissions().mode() & 0o111 != 0 };
        #[cfg(not(unix))] let executable = false;
        let bytes = bounded_read(&real, (64 * 1024 * 1024).min(256 * 1024 * 1024 - *total))?;
        *total += bytes.len() as u64;
        files.insert(relative.into(), File { bytes, executable });
    } else { return Err(format!("Unsupported special file in skill: {}", path.display())); }
    Ok(())
}

pub fn pin(data: &Path, source: &Path, item: &Item) -> Result<Folder, String> {
    let mut files = BTreeMap::new();
    collect(source, source, Path::new(""), &mut files, &mut 0, 0)?;
    // The session's effective instructions (including project overrides) must
    // agree with its on-disk SKILL.md. Supporting bytes are never interpolated.
    let original = String::from_utf8(files.get(Path::new("SKILL.md")).ok_or("Missing SKILL.md")?.bytes.clone()).map_err(|e|e.to_string())?;
    let normalized = original.replace("\r\n", "\n");
    let (header, body) = frontmatter(&normalized)?;
    let header = if normalized.starts_with("---\n") { format!("---\n{header}---\n\n") } else { String::new() };
    let content = regex::Regex::new(r"\{\{([a-z0-9-]+)\}\}").unwrap().replace_all(&item.content, |caps: &regex::Captures| {
        item.parameters.get(&caps[1]).cloned().unwrap_or_else(|| caps[0].into())
    }).into_owned();
    if body != content { files.insert("SKILL.md".into(), File { bytes: format!("{header}{content}").into_bytes(), executable: false }); }
    let mut hash = Sha256::new();
    for (name, file) in &files {
        let name = name.to_str().ok_or("Skill file names must be UTF-8")?;
        hash.update((name.len() as u64).to_le_bytes()); hash.update(name);
        hash.update([u8::from(file.executable)]);
        hash.update((file.bytes.len() as u64).to_le_bytes()); hash.update(&file.bytes);
    }
    let revision = format!("{:x}", hash.finalize());
    let parent = data.join("skill-bundles");
    let directory = parent.join(&revision);
    if !directory.exists() {
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let scratch = tempfile::Builder::new().prefix(".building-").tempdir_in(&parent).map_err(|e| e.to_string())?;
        for (name, file) in &files {
            let target = scratch.path().join(name);
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(&target, &file.bytes).map_err(|e| e.to_string())?;
            #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&target, fs::Permissions::from_mode(if file.executable { 0o555 } else { 0o444 })).map_err(|e| e.to_string())?; }
        }
        if let Err(e) = fs::rename(scratch.path(), &directory) {
            if !directory.is_dir() { return Err(e.to_string()); }
        }
    }
    Ok(Folder { source: source.into(), directory, revision })
}

pub fn read(folder: &Folder, resource: &str) -> Result<String, String> {
    super::library::safe_relative(resource)?;
    let path = fs::canonicalize(folder.directory.join(resource)).map_err(|e| e.to_string())?;
    let root = fs::canonicalize(&folder.directory).map_err(|e| e.to_string())?;
    if !path.starts_with(root) { return Err("Resource escapes pinned skill folder".into()); }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 { return Err(format!("Use filesystem tools to read this resource: {}", path.display())); }
    let bytes = bounded_read(&path, 2 * 1024 * 1024)?;
    if bytes.contains(&0) { return Err(format!("Binary asset; use filesystem/image tools at {}", path.display())); }
    String::from_utf8(bytes).map_err(|_| format!("Binary asset; use filesystem/image tools at {}", path.display()))
}
