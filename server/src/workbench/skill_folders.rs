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
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Settings {
    when: Condition,
    requires: Vec<String>,
    parameters: BTreeMap<String, String>,
    automatic: Option<bool>,
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
        if !path.join("SKILL.md").is_file() { continue; }
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
        result.push(Source { directory: fs::canonicalize(&path).map_err(|e| e.to_string())?, item });
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
