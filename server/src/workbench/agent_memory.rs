//! Atelier memory: durable facts every provider and every session shares.
//!
//! Provider memory lives in each account's own folder (Claude's
//! `projects/<slug>/memory`, Codex's `memories/`), so a fact one chat saved is
//! invisible to a chat on another provider or account. Atelier keeps one store
//! instead, at two scopes:
//!
//! - global: `<data>/memory/<id>.md`, read by every chat;
//! - project: `<data>/projects/<project id>/memory/<id>.md`, read by chats in
//!   that project. The project id is the Git common directory's digest, so
//!   every worktree of a project reads and writes the same memories, and the
//!   repository itself is never written.
//!
//! Each memory is one Markdown file with a small header:
//!
//! ```text
//! ---
//! description: one line used to judge relevance
//! type: user | feedback | project | reference
//! ---
//! body
//! ```
//!
//! The resolver (`library::resolve`) folds an index of them (one line per
//! memory) into the pinned snapshot; agents read a body when it is relevant.
use super::library::{data_dir, valid_id, WRITES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_BODY: usize = 16 * 1024;
const MAX_DESCRIPTION: usize = 300;
const MAX_PER_SCOPE: usize = 500;
pub const TYPES: [&str; 4] = ["user", "feedback", "project", "reference"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Global,
    Project,
}
impl Scope {
    pub fn name(self) -> &'static str {
        match self {
            Scope::Global => "global",
            Scope::Project => "project",
        }
    }
    fn parse(text: &str) -> Result<Scope, String> {
        match text {
            "global" => Ok(Scope::Global),
            "project" => Ok(Scope::Project),
            _ => Err(format!("Unknown scope {text}; use global or project")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Memory {
    pub id: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Stored {
    pub scope: Scope,
    #[serde(flatten)]
    pub memory: Memory,
    /// Digest of the file as read; a save or delete naming an older one is refused.
    pub revision: String,
    pub path: PathBuf,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn global_dir(data: &Path) -> PathBuf {
    data.join("memory")
}
pub fn project_dir(data: &Path, root: &Path) -> PathBuf {
    crate::project_manifest::personal_path(root, data).with_file_name("memory")
}
fn dir(data: &Path, scope: Scope, root: Option<&Path>) -> Result<PathBuf, String> {
    match (scope, root) {
        (Scope::Global, _) => Ok(global_dir(data)),
        (Scope::Project, Some(root)) => Ok(project_dir(data, root)),
        (Scope::Project, None) => Err("Project memory needs a project: run inside a Git repository or a registered project folder".into()),
    }
}

pub fn validate(memory: &Memory) -> Result<(), String> {
    if !valid_id(&memory.id) {
        return Err("Use a memory ID of lowercase letters, digits and hyphens, at most 80 characters".into());
    }
    let description = memory.description.trim();
    if description.is_empty() || description.contains('\n') || description.chars().count() > MAX_DESCRIPTION {
        return Err(format!("Give a one-line description of at most {MAX_DESCRIPTION} characters"));
    }
    if !TYPES.contains(&memory.kind.as_str()) {
        return Err(format!("Unknown memory type {}; use one of {}", memory.kind, TYPES.join(", ")));
    }
    if memory.body.trim().is_empty() {
        return Err("A memory needs a body that states the fact".into());
    }
    if memory.body.len() > MAX_BODY {
        return Err(format!("A memory body may be at most {} KiB; split it into separate facts", MAX_BODY / 1024));
    }
    Ok(())
}

fn render_file(memory: &Memory) -> String {
    format!(
        "---\ndescription: {}\ntype: {}\n---\n\n{}\n",
        memory.description.trim(),
        memory.kind,
        memory.body.trim()
    )
}

fn parse_file(id: &str, text: &str) -> Result<Memory, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").ok_or("missing the --- header")?;
    let (header, body) = rest.split_once("\n---\n").or_else(|| rest.strip_suffix("\n---").map(|h| (h, ""))).ok_or("unterminated --- header")?;
    let (mut description, mut kind) = (None, None);
    for line in header.lines().filter(|line| !line.trim().is_empty()) {
        let (key, value) = line.split_once(':').ok_or_else(|| format!("header line without a colon: {line}"))?;
        let value = value.trim().to_string();
        match key.trim() {
            "description" => description = Some(value),
            "type" => kind = Some(value),
            // Headers written by hand may carry a name or other notes; the
            // file name is the ID, so they are kept on disk but not read.
            _ => {}
        }
    }
    Ok(Memory {
        id: id.to_string(),
        description: description.ok_or("header has no description")?,
        kind: kind.unwrap_or_else(|| "project".into()),
        body: body.trim().to_string(),
    })
}

fn read_one(path: &Path, scope: Scope) -> Result<Stored, String> {
    let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    let mut bytes = vec![];
    fs::File::open(path)
        .and_then(|file| file.take(MAX_BODY as u64 * 2).read_to_end(&mut bytes))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let text = String::from_utf8(bytes.clone()).map_err(|_| format!("{} is not UTF-8", path.display()))?;
    let memory = parse_file(&id, &text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Stored { scope, memory, revision: digest(&bytes), path: path.to_path_buf() })
}

/// Every memory in one scope, sorted by ID. A malformed file is reported,
/// never silently dropped, so a hand edit cannot make a fact vanish unnoticed.
pub fn list_scope(data: &Path, scope: Scope, root: Option<&Path>) -> Result<(Vec<Stored>, Vec<String>), String> {
    let directory = dir(data, scope, root)?;
    let mut stored = vec![];
    let mut problems = vec![];
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((stored, problems)),
        Err(e) => return Err(format!("{}: {e}", directory.display())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") || !path.is_file() {
            continue;
        }
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        if !valid_id(id) {
            problems.push(format!("{} is ignored: its file name is not a valid memory ID", path.display()));
            continue;
        }
        match read_one(&path, scope) {
            Ok(one) => stored.push(one),
            Err(e) => problems.push(e),
        }
    }
    stored.sort_by(|a, b| a.memory.id.cmp(&b.memory.id));
    Ok((stored, problems))
}

pub fn find(data: &Path, scope: Scope, root: Option<&Path>, id: &str) -> Result<Option<Stored>, String> {
    if !valid_id(id) {
        return Err(format!("{id} is not a valid memory ID"));
    }
    let path = dir(data, scope, root)?.join(format!("{id}.md"));
    if !path.is_file() {
        return Ok(None);
    }
    read_one(&path, scope).map(Some)
}

/// Create or replace one memory. `previous` names the memory being edited
/// (it may differ from `memory.id` for a rename) and `expected` is the
/// revision the editor read; either being stale refuses the write.
pub fn save(
    data: &Path,
    scope: Scope,
    root: Option<&Path>,
    previous: Option<&str>,
    expected: Option<&str>,
    memory: &Memory,
) -> Result<Stored, String> {
    validate(memory)?;
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let directory = dir(data, scope, root)?;
    let target = directory.join(format!("{}.md", memory.id));
    let old = match previous {
        Some(previous) => Some(find(data, scope, root, previous)?.ok_or_else(|| {
            format!("Memory {previous} changed in another editor. Reload before saving")
        })?),
        None => None,
    };
    if let (Some(old), Some(expected)) = (&old, expected) {
        if old.revision != expected {
            return Err(format!("Memory {} changed in another editor. Reload before saving", old.memory.id));
        }
    }
    let renamed = old.as_ref().is_some_and(|old| old.memory.id != memory.id);
    if (old.is_none() || renamed) && target.exists() {
        return Err(format!("A {} memory named {} already exists; edit it instead", scope.name(), memory.id));
    }
    if old.is_none() && fs::read_dir(&directory).map(|d| d.count()).unwrap_or(0) >= MAX_PER_SCOPE {
        return Err(format!("The {} memory holds {MAX_PER_SCOPE} entries; remove stale ones first", scope.name()));
    }
    super::provider_defaults::atomic_write(&target, render_file(memory).as_bytes())?;
    if let (true, Some(old)) = (renamed, &old) {
        fs::remove_file(&old.path).map_err(|e| format!("{} was saved but {} could not be removed: {e}", target.display(), old.path.display()))?;
    }
    read_one(&target, scope)
}

pub fn remove(data: &Path, scope: Scope, root: Option<&Path>, id: &str, expected: Option<&str>) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let old = find(data, scope, root, id)?.ok_or_else(|| format!("No {} memory named {id}", scope.name()))?;
    if expected.is_some_and(|expected| expected != old.revision) {
        return Err(format!("Memory {id} changed in another editor. Reload before deleting"));
    }
    fs::remove_file(&old.path).map_err(|e| format!("{}: {e}", old.path.display()))
}

/// The index a chat receives for one scope, or None when it holds nothing.
/// Like a provider's own memory index, only one line per memory rides in
/// the instructions; the agent reads a body when its description is relevant,
/// so a large store costs a chat almost nothing. The path lets a worker
/// without a shell read the body with its file tools.
pub fn render(scope: Scope, stored: &[Stored]) -> Option<String> {
    if stored.is_empty() {
        return None;
    }
    let mut out = format!(
        "{} memory index ({} {}), saved with `atelier tool memory`. Read a memory before relying on it or when its description bears on the task: `atelier tool memory show ID --scope {}`, or read its file. Bodies are read live, so they may be newer than this list. Facts were true when saved; verify a named file, function or flag, and edit or remove an entry that is wrong or stale.\n",
        match scope { Scope::Global => "Global", Scope::Project => "Project" },
        stored.len(),
        if stored.len() == 1 { "entry" } else { "entries" },
        scope.name(),
    );
    for one in stored {
        let m = &one.memory;
        out.push_str(&format!("\n- {} ({}): {} — {}", m.id, m.kind, m.description, one.path.display()));
    }
    Some(out)
}

/// The project a folder belongs to, for project-scope memory: the Git top
/// level, else the nearest folder with a project manifest.
pub fn project_root(data: &Path, folder: &Path) -> Option<PathBuf> {
    let folder = fs::canonicalize(folder).ok()?;
    let git = std::process::Command::new("git")
        .arg("-C").arg(&folder).args(["rev-parse", "--show-toplevel"]).output();
    if let Some(root) = git.ok().filter(|out| out.status.success())
        .map(|out| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())) {
        return Some(root);
    }
    folder.ancestors().find(|dir| {
        crate::project_manifest::repository_path(dir).is_file()
            || crate::project_manifest::personal_path(dir, data).is_file()
    }).map(Path::to_path_buf)
}

const USAGE: &str = "Usage: atelier tool memory <command>

  list [--scope global|project] [--json]
  show ID [--scope global|project] [--json]
  add ID --scope global|project --description TEXT [--type TYPE] (--body TEXT | --body-file PATH | --body -)
  edit ID [--scope global|project] [--rename NEW-ID] [--description TEXT] [--type TYPE] [--body TEXT | --body-file PATH | --body -]
  remove ID [--scope global|project]
  locations

Global memory reaches every chat; project memory reaches chats in the current
project (all of its worktrees). TYPE is one of user, feedback, project,
reference (default project). IDs use lowercase letters, digits and hyphens.
Chats read memories when they start or reconnect.";

struct Flags {
    positional: Vec<String>,
    values: std::collections::BTreeMap<String, String>,
    json: bool,
}
fn flags(args: &[String]) -> Result<Flags, String> {
    let mut out = Flags { positional: vec![], values: Default::default(), json: false };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => out.json = true,
            "--scope" | "--description" | "--type" | "--body" | "--body-file" | "--rename" => {
                let value = iter.next().ok_or_else(|| format!("{arg} needs a value"))?;
                if out.values.insert(arg[2..].to_string(), value.clone()).is_some() {
                    return Err(format!("{arg} was given twice"));
                }
            }
            flag if flag.starts_with("--") => return Err(format!("Unknown option {flag}\n\n{USAGE}")),
            _ => out.positional.push(arg.clone()),
        }
    }
    Ok(out)
}
fn body(flags: &Flags) -> Result<Option<String>, String> {
    match (flags.values.get("body"), flags.values.get("body-file")) {
        (Some(_), Some(_)) => Err("Give --body or --body-file, not both".into()),
        (Some(text), None) if text == "-" => {
            let mut text = String::new();
            std::io::stdin().take(MAX_BODY as u64 + 1).read_to_string(&mut text).map_err(|e| e.to_string())?;
            Ok(Some(text))
        }
        (Some(text), None) => Ok(Some(text.clone())),
        (None, Some(path)) => fs::read_to_string(path).map(Some).map_err(|e| format!("{path}: {e}")),
        (None, None) => Ok(None),
    }
}

/// Resolve an ID the caller did not scope: project first, then global.
fn locate(data: &Path, root: Option<&Path>, id: &str, scope: Option<Scope>) -> Result<Stored, String> {
    let scopes = match scope {
        Some(scope) => vec![scope],
        None if root.is_some() => vec![Scope::Project, Scope::Global],
        None => vec![Scope::Global],
    };
    let mut found = vec![];
    for scope in scopes {
        if let Some(one) = find(data, scope, root, id)? {
            found.push(one);
        }
    }
    match found.len() {
        0 => Err(format!("No memory named {id}{}", scope.map(|s| format!(" in {} scope", s.name())).unwrap_or_default())),
        1 => Ok(found.remove(0)),
        _ => Err(format!("{id} exists in both project and global memory; pass --scope")),
    }
}

fn print_one(one: &Stored, json: bool) -> Result<(), String> {
    if json {
        println!("{}", serde_json::to_string_pretty(one).map_err(|e| e.to_string())?);
    } else {
        println!("{} [{} {}] {}\n\n{}", one.memory.id, one.scope.name(), one.memory.kind, one.memory.description, one.memory.body);
    }
    Ok(())
}

pub fn cli(args: &[String]) -> Result<i32, String> {
    let action = args.first().map(String::as_str).unwrap_or("help");
    if matches!(action, "help" | "--help" | "-h") {
        println!("{USAGE}");
        return Ok(0);
    }
    let data = std::path::absolute(data_dir()?).map_err(|e| e.to_string())?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let root = project_root(&data, &cwd);
    let root = root.as_deref();
    let flags = flags(&args[1..])?;
    let scope = flags.values.get("scope").map(|s| Scope::parse(s)).transpose()?;
    let id = || -> Result<&str, String> {
        match flags.positional.as_slice() {
            [id] => Ok(id),
            _ => Err(format!("{action} takes one memory ID\n\n{USAGE}")),
        }
    };
    match action {
        "locations" => {
            if !flags.positional.is_empty() { return Err(USAGE.into()); }
            println!("{}", serde_json::to_string_pretty(&json!({
                "global": global_dir(&data),
                "project": root.map(|root| project_dir(&data, root)),
                "project_root": root,
                "format": "One Markdown file per memory, <id>.md, starting with a --- header holding description and type. Prefer atelier tool memory over editing files by hand.",
            })).map_err(|e| e.to_string())?);
        }
        "list" => {
            if !flags.positional.is_empty() { return Err(USAGE.into()); }
            let scopes = match scope {
                Some(scope) => vec![scope],
                None => [Scope::Global].into_iter().chain(root.map(|_| Scope::Project)).collect(),
            };
            let mut all = vec![];
            let mut problems = vec![];
            for scope in scopes {
                let (stored, mut bad) = list_scope(&data, scope, root)?;
                all.extend(stored);
                problems.append(&mut bad);
            }
            if flags.json {
                println!("{}", serde_json::to_string_pretty(&json!({"memories": all, "problems": problems})).map_err(|e| e.to_string())?);
            } else {
                if all.is_empty() { println!("No memories saved."); }
                for one in &all {
                    println!("{} [{} {}] {}", one.memory.id, one.scope.name(), one.memory.kind, one.memory.description);
                }
                for problem in &problems { eprintln!("warning: {problem}"); }
            }
        }
        "show" => print_one(&locate(&data, root, id()?, scope)?, flags.json)?,
        "add" => {
            let scope = scope.ok_or("add needs --scope global or --scope project")?;
            let memory = Memory {
                id: id()?.to_string(),
                description: flags.values.get("description").cloned().ok_or("add needs --description")?,
                kind: flags.values.get("type").cloned().unwrap_or_else(|| "project".into()),
                body: body(&flags)?.ok_or("add needs --body TEXT, --body-file PATH or --body - (stdin)")?,
            };
            let saved = save(&data, scope, root, None, None, &memory)?;
            println!("Saved {} memory {} at {}. New and reconnected chats receive it.", scope.name(), saved.memory.id, saved.path.display());
        }
        "edit" => {
            let old = locate(&data, root, id()?, scope)?;
            let mut memory = old.memory.clone();
            if let Some(new) = flags.values.get("rename") { memory.id = new.clone(); }
            if let Some(text) = flags.values.get("description") { memory.description = text.clone(); }
            if let Some(text) = flags.values.get("type") { memory.kind = text.clone(); }
            if let Some(text) = body(&flags)? { memory.body = text; }
            if memory == old.memory { return Err("Nothing to change: pass --description, --type, --body, --body-file or --rename".into()); }
            let saved = save(&data, old.scope, root, Some(&old.memory.id), Some(&old.revision), &memory)?;
            println!("Updated {} memory {}. New and reconnected chats receive it.", old.scope.name(), saved.memory.id);
        }
        "remove" => {
            let old = locate(&data, root, id()?, scope)?;
            remove(&data, old.scope, root, &old.memory.id, Some(&old.revision))?;
            println!("Removed {} memory {}.", old.scope.name(), old.memory.id);
        }
        _ => return Err(format!("Unknown memory command {action}\n\n{USAGE}")),
    }
    Ok(0)
}

/// JSON view used by the settings API.
pub fn listing(data: &Path, root: Option<&Path>) -> Result<Value, String> {
    let (global, mut problems) = list_scope(data, Scope::Global, None)?;
    let project = match root {
        Some(root) => {
            let (stored, mut bad) = list_scope(data, Scope::Project, Some(root))?;
            problems.append(&mut bad);
            Some(stored)
        }
        None => None,
    };
    Ok(json!({"global": global, "project": project, "problems": problems, "types": TYPES}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn memory(id: &str, body: &str) -> Memory {
        Memory { id: id.into(), description: format!("About {id}"), kind: "feedback".into(), body: body.into() }
    }
    #[test]
    fn a_memory_round_trips_through_its_file_and_refuses_stale_edits() {
        let data = tempfile::tempdir().unwrap();
        let saved = save(data.path(), Scope::Global, None, None, None, &memory("tabs", "Use tabs.\n\nWhy: the user said so.")).unwrap();
        assert_eq!(saved.path, data.path().join("memory/tabs.md"));
        let read = find(data.path(), Scope::Global, None, "tabs").unwrap().unwrap();
        assert_eq!(read.memory, memory("tabs", "Use tabs.\n\nWhy: the user said so."));
        assert!(save(data.path(), Scope::Global, None, None, None, &memory("tabs", "again")).unwrap_err().contains("already exists"));
        assert!(save(data.path(), Scope::Global, None, Some("tabs"), Some("stale"), &memory("tabs", "x")).unwrap_err().contains("Reload"));
        let renamed = save(data.path(), Scope::Global, None, Some("tabs"), Some(&read.revision), &memory("indent", "Use tabs.")).unwrap();
        assert!(!read.path.exists());
        assert!(remove(data.path(), Scope::Global, None, "indent", Some("stale")).is_err());
        remove(data.path(), Scope::Global, None, "indent", Some(&renamed.revision)).unwrap();
        assert!(list_scope(data.path(), Scope::Global, None).unwrap().0.is_empty());
    }
    #[test]
    fn invalid_memories_and_malformed_files_are_refused_and_reported() {
        let data = tempfile::tempdir().unwrap();
        for bad in [
            Memory { id: "Bad ID".into(), ..memory("x", "b") },
            Memory { description: "two\nlines".into(), ..memory("x", "b") },
            Memory { kind: "secret".into(), ..memory("x", "b") },
            memory("x", "  "),
            memory("x", &"a".repeat(MAX_BODY + 1)),
        ] {
            assert!(save(data.path(), Scope::Global, None, None, None, &bad).is_err());
        }
        assert!(save(data.path(), Scope::Project, None, None, None, &memory("x", "b")).unwrap_err().contains("needs a project"));
        fs::create_dir_all(data.path().join("memory")).unwrap();
        fs::write(data.path().join("memory/broken.md"), "no header").unwrap();
        fs::write(data.path().join("memory/hand.md"), "---\nname: hand\ndescription: Hand written\n---\nBody").unwrap();
        let (stored, problems) = list_scope(data.path(), Scope::Global, None).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].memory.kind, "project");
        assert_eq!(problems.len(), 1);
    }
    #[test]
    fn a_chat_receives_an_index_of_descriptions_and_paths_not_the_bodies() {
        let data = tempfile::tempdir().unwrap();
        for id in ["a", "b"] {
            save(data.path(), Scope::Global, None, None, None, &memory(id, &format!("SECRET-BODY-{id}"))).unwrap();
        }
        let (stored, _) = list_scope(data.path(), Scope::Global, None).unwrap();
        let text = render(Scope::Global, &stored).unwrap();
        assert!(text.contains("Global memory index (2 entries)"));
        assert!(text.contains(&format!("- a (feedback): About a — {}", data.path().join("memory/a.md").display())));
        assert!(text.contains("atelier tool memory show ID --scope global"));
        assert!(!text.contains("SECRET-BODY"));
        assert!(render(Scope::Global, &[]).is_none());
    }
}
