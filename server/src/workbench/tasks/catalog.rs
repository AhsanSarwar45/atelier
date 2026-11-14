//! The task types a project offers: the built-in types, the install's own
//! types and the project's, with the default items each type asks of every
//! task. Kept as guidance is: `task-types.json` in the data folder for the
//! install, and next to the project's manifest for a project, which inherits
//! the install's and may add its own or turn one off.
//!
//! The file (both scopes):
//! `{types: [{name, description, code, review}], items: {TYPE: [{id, text, checks?}]},
//!   disabled: [TYPE], disabled_items: {TYPE: [ID]}}`.
//!
//! Agents change types with `atelier task types create|edit|disable|enable`;
//! each change keeps the file as it was, so the owner can undo it. A task
//! keeps the items it was created with: changing a type never touches one.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

use super::types;

pub const FILE: &str = "task-types.json";
const HISTORY: &str = "task-types.history.json";
/// Changes kept for undo, per scope.
const HISTORY_MAX: usize = 50;

/// One type as a project sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub description: String,
    pub code: bool,
    pub review: bool,
    /// Made by the install or the project, not built in. Its tasks are
    /// planned like `general`.
    pub custom: bool,
    /// The default items every task of the type answers, `{id, text, checks?}`.
    pub items: Vec<Value>,
}

/// The types that are on, in order: built-ins, then the install's, then the
/// project's.
#[derive(Clone, Debug, PartialEq)]
pub struct Catalog {
    entries: Vec<Entry>,
    /// The types turned off, by the install or the project, in the order
    /// they would be listed.
    off: Vec<String>,
    /// Of those, the ones the install turned off: a project cannot turn
    /// them back on.
    off_install: Vec<String>,
}

impl Default for Catalog {
    /// The built-in types without their default items: what a request
    /// carries when its caller gave no catalog. The app always loads one
    /// (`Catalog::load`), which has the default items.
    fn default() -> Self {
        let entries = types::TYPES.iter().map(built_in).map(|entry| Entry { items: Vec::new(), ..entry }).collect();
        Catalog { entries, off: Vec::new(), off_install: Vec::new() }
    }
}

fn built_in(kind: &types::TaskType) -> Entry {
    Entry {
        name: kind.name.into(),
        description: kind.description.into(),
        code: kind.code,
        review: kind.review,
        custom: false,
        items: kind.items.iter().map(|(id, text)| json!({"id": id, "text": text})).collect(),
    }
}

impl Catalog {
    /// The types for the install (`project` None) or for a project.
    pub fn load(global: &Path, project: Option<&Path>) -> Result<Catalog, String> {
        let mut layers = vec![read(&global.join(FILE))?];
        if let Some(project) = project {
            layers.push(read(&project.join(FILE))?);
        }
        let mut entries: Vec<Entry> = types::TYPES.iter().map(built_in).collect();
        for layer in &layers {
            for made in layer["types"].as_array().into_iter().flatten() {
                let name = made["name"].as_str().unwrap_or_default().to_string();
                if name.is_empty() || entries.iter().any(|entry| entry.name == name) {
                    continue;
                }
                entries.push(Entry {
                    name,
                    description: made["description"].as_str().unwrap_or_default().into(),
                    code: made["code"].as_bool().unwrap_or(false),
                    review: made["review"].as_bool().unwrap_or(false),
                    custom: true,
                    items: Vec::new(),
                });
            }
        }
        for entry in &mut entries {
            for layer in &layers {
                for item in layer["items"][&entry.name].as_array().into_iter().flatten() {
                    let id = item["id"].as_str().unwrap_or_default();
                    entry.items.retain(|kept| kept["id"].as_str() != Some(id));
                    entry.items.push(item.clone());
                }
            }
            for layer in &layers {
                for off in layer["disabled_items"][&entry.name].as_array().into_iter().flatten() {
                    entry.items.retain(|kept| kept["id"] != *off);
                }
            }
        }
        let is_off = |name: &str| layers.iter().any(|layer| listed(&layer["disabled"], name));
        let off: Vec<String> = entries.iter().filter(|entry| is_off(&entry.name)).map(|entry| entry.name.clone()).collect();
        let off_install = off.iter().filter(|name| listed(&layers[0]["disabled"], name)).cloned().collect();
        entries.retain(|entry| !is_off(&entry.name));
        Ok(Catalog { entries, off, off_install })
    }

    /// The names of the types that are on.
    pub fn names(&self) -> Vec<String> {
        self.entries.iter().map(|entry| entry.name.clone()).collect()
    }

    pub fn find(&self, name: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.name == name)
    }

    /// The ids of a type's default items that are on.
    pub fn items(&self, name: &str) -> Vec<String> {
        self.find(name)
            .map(|entry| entry.items.iter().filter_map(|item| item["id"].as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// `GET /api/workbench/task-types` and `atelier task types`.
    pub fn listing(&self) -> Value {
        json!({"types": self.entries.iter().map(|entry| {
            let shape = types::find(&entry.name);
            json!({
                "name": entry.name, "code": entry.code, "review": entry.review, "custom": entry.custom,
                "description": entry.description,
                "plan": shape.map_or(types::find("general").unwrap().plan, |kind| kind.plan),
                "result": shape.map_or(types::find("general").unwrap().result, |kind| kind.result),
                "items": entry.items,
            })
        }).collect::<Vec<_>>(), "off": self.off, "offInstall": self.off_install})
    }
}

fn listed(list: &Value, name: &str) -> bool {
    list.as_array().is_some_and(|names| names.iter().any(|value| value.as_str() == Some(name)))
}

fn read(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
            if !value.is_object() {
                return Err(format!("{} must hold an object", path.display()));
            }
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

fn write(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_string_pretty(value).unwrap() + "\n")
        .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

/// The folder a scope's file lives in.
fn folder(global: &Path, project: Option<&Path>, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "install" => Ok(global.to_path_buf()),
        "project" => project.map(Path::to_path_buf).ok_or_else(|| "scope project needs a project: run it from the project's folder".into()),
        other => Err(format!("scope must be install or project, not \"{other}\"")),
    }
}

/// A type name: lowercase letters, digits and underscores, from a letter.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn text<'a>(change: &'a Value, key: &str, what: &str) -> Result<&'a str, String> {
    change[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{key} is required: {what}"))
}

/// Default items as given: each `{id, text, checks?}`, ids unique.
fn check_items(items: &Value, at: &str) -> Result<Vec<Value>, String> {
    let list = items.as_array().ok_or_else(|| format!("{at} must be a list of {{id, text, checks?}}"))?;
    let mut seen = Vec::new();
    for (index, item) in list.iter().enumerate() {
        let path = format!("{at}[{index}]");
        let row = item.as_object().ok_or_else(|| format!("{path} must be an object {{id, text, checks?}}"))?;
        if let Some(unknown) = row.keys().find(|key| !["id", "text", "checks"].contains(&key.as_str())) {
            return Err(format!("{path}: {unknown} is not an item field (allowed: id, text, checks)"));
        }
        let id = text(item, "id", "a short id, unique in the type").map_err(|error| format!("{path}: {error}"))?;
        if !super::super::library::valid_id(id) {
            return Err(format!("{path}: id \"{id}\" must be lowercase letters, digits and dashes"));
        }
        text(item, "text", "what every task of the type must do").map_err(|error| format!("{path}: {error}"))?;
        if let Some(checks) = row.get("checks") {
            super::checks::parse_checks(checks, &format!("{path}.checks"))?;
        }
        if seen.contains(&id) {
            return Err(format!("{path}: id \"{id}\" is used twice"));
        }
        seen.push(id);
    }
    Ok(list.clone())
}

/// `atelier task types create|edit|disable|enable`: change one scope's file.
/// Returns what changed, in a sentence.
///
/// - `{action: create, scope, type: {name, description, code, review, items?}}`
/// - `{action: edit, scope, name, items?, description?, code?, review?}`: items
///   replace the scope's items for the type; the other fields change a type
///   this scope made.
/// - `{action: disable|enable, scope, name, item?}`: turn a type, or one of
///   its items, off or back on in this scope.
pub fn change(global: &Path, project: Option<&Path>, change: &Value) -> Result<String, String> {
    change_with_id(global, project, change).map(|(summary, _)| summary)
}

/// `change`, with the id of the change kept for undo; `None` when nothing
/// was different, so there is nothing to undo.
pub fn change_with_id(global: &Path, project: Option<&Path>, change: &Value) -> Result<(String, Option<String>), String> {
    let action = text(change, "action", "create, edit, disable or enable")?;
    let scope = text(change, "scope", "install or project")?;
    let dir = folder(global, project, scope)?;
    let path = dir.join(FILE);
    let before = read(&path)?;
    let mut file = before.clone();
    let row = file.as_object_mut().unwrap();
    let visible = Catalog::load(global, (scope == "project").then_some(dir.as_path()))?;
    let known = |name: &str| -> Result<(), String> {
        let exists = types::find(name).is_some()
            || visible.find(name).is_some()
            || row_has_type(&before, name);
        if exists { Ok(()) } else { Err(format!("there is no type \"{name}\" (types: {})", visible.names().join(", "))) }
    };
    let summary = match action {
        "create" => {
            let made = change.get("type").filter(|value| value.is_object()).ok_or("type is required: {name, description, code, review, items?}")?;
            if let Some(unknown) = made.as_object().unwrap().keys().find(|key| !["name", "description", "code", "review", "items"].contains(&key.as_str())) {
                return Err(format!("type.{unknown} is not a type field (allowed: name, description, code, review, items)"));
            }
            let name = text(made, "name", "lowercase letters, digits and underscores")?;
            if types::find(name).is_some() {
                return Err(format!("\"{name}\" is a built-in type; change its default items with `atelier task types edit {name}`"));
            }
            if !valid_name(name) {
                return Err(format!("type name \"{name}\" must start with a letter and use lowercase letters, digits and underscores (up to 40)"));
            }
            if visible.find(name).is_some() || row_has_type(&before, name) {
                return Err(format!("there is already a type \"{name}\"; use `atelier task types edit {name}`"));
            }
            let description = text(made, "description", "one line on when to use the type")?;
            let flag = |key: &str| -> Result<bool, String> {
                made[key].as_bool().ok_or_else(|| format!("type.{key} is required (true or false)"))
            };
            let (code, review) = (flag("code")?, flag("review")?);
            let items = match made.get("items") {
                None | Some(Value::Null) => Vec::new(),
                Some(items) => check_items(items, "type.items")?,
            };
            push(row, "types", json!({"name": name, "description": description, "code": code, "review": review}));
            if !items.is_empty() {
                set_items(row, name, items);
            }
            format!("Created type \"{name}\" for the {scope}.")
        }
        "edit" => {
            let name = text(change, "name", "the type to edit")?;
            known(name)?;
            let mut said = Vec::new();
            if let Some(items) = change.get("items").filter(|value| !value.is_null()) {
                let items = check_items(items, "items")?;
                said.push(format!("{} default item{}", items.len(), if items.len() == 1 { "" } else { "s" }));
                set_items(row, name, items);
            }
            for key in ["description", "code", "review"] {
                let Some(value) = change.get(key).filter(|value| !value.is_null()) else { continue };
                if types::find(name).is_some() {
                    return Err(format!("{key} of the built-in type \"{name}\" cannot be changed; only its default items can"));
                }
                let own = row
                    .get_mut("types")
                    .and_then(Value::as_array_mut)
                    .and_then(|made| made.iter_mut().find(|made| made["name"] == name))
                    .ok_or_else(|| format!("\"{name}\" was made by the other scope; change its {key} there"))?;
                if key == "description" && !value.as_str().is_some_and(|text| !text.trim().is_empty()) {
                    return Err("description must be one line of text".into());
                }
                if key != "description" && !value.is_boolean() {
                    return Err(format!("{key} must be true or false"));
                }
                own[key] = value.clone();
                said.push(key.to_string());
            }
            if said.is_empty() {
                return Err("nothing to change: give items, description, code or review".into());
            }
            format!("Changed type \"{name}\" for the {scope}: {}.", said.join(", "))
        }
        "disable" | "enable" => {
            let name = text(change, "name", "the type")?;
            known(name)?;
            let on = action == "enable";
            match change["item"].as_str().map(str::trim).filter(|id| !id.is_empty()) {
                Some(item) => {
                    let map = row.entry("disabled_items").or_insert_with(|| json!({}));
                    let list = map.as_object_mut().ok_or("disabled_items must be an object")?.entry(name).or_insert_with(|| json!([]));
                    toggle(list, item, on);
                    format!("Turned item \"{item}\" of \"{name}\" {} for the {scope}.", if on { "on" } else { "off" })
                }
                None => {
                    if !on && name == "general" {
                        return Err("general cannot be turned off: it is the type for work no other type fits".into());
                    }
                    let list = row.entry("disabled").or_insert_with(|| json!([]));
                    toggle(list, name, on);
                    format!("Turned type \"{name}\" {} for the {scope}.", if on { "on" } else { "off" })
                }
            }
        }
        other => return Err(format!("action must be create, edit, disable or enable, not \"{other}\"")),
    };
    if file == before {
        return Ok((format!("{summary} Nothing was different."), None));
    }
    write(&path, &file)?;
    let id = remember(&dir, &before, &summary)?;
    Ok((summary, Some(id)))
}

fn row_has_type(file: &Value, name: &str) -> bool {
    file["types"].as_array().is_some_and(|made| made.iter().any(|made| made["name"] == name))
}

fn push(row: &mut Map<String, Value>, key: &str, value: Value) {
    let list = row.entry(key).or_insert_with(|| json!([]));
    if let Some(list) = list.as_array_mut() {
        list.push(value);
    }
}

fn set_items(row: &mut Map<String, Value>, name: &str, items: Vec<Value>) {
    let map = row.entry("items").or_insert_with(|| json!({}));
    if let Some(map) = map.as_object_mut() {
        if items.is_empty() {
            map.remove(name);
        } else {
            map.insert(name.into(), json!(items));
        }
    }
}

fn toggle(list: &mut Value, name: &str, on: bool) {
    let Some(names) = list.as_array_mut() else { return };
    names.retain(|value| value.as_str() != Some(name));
    if !on {
        names.push(json!(name));
    }
}

/// Keep the file as it was before a change, for undo. Returns the change's id.
fn remember(dir: &Path, before: &Value, summary: &str) -> Result<String, String> {
    let path = dir.join(HISTORY);
    let mut file = read(&path)?;
    let mut history = file["changes"].as_array().cloned().unwrap_or_default();
    let id = new_id(&history, &file["undone"]);
    history.push(json!({"id": id, "summary": summary, "before": before}));
    if history.len() > HISTORY_MAX {
        history.drain(..history.len() - HISTORY_MAX);
    }
    file["changes"] = json!(history);
    write(&path, &file)?;
    Ok(id)
}

/// An id no change in the history has: the time in milliseconds, made
/// unique against the history.
fn new_id(history: &[Value], undone: &Value) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis());
    let taken = |id: &str| history.iter().any(|change| change["id"] == id) || listed(undone, id);
    let mut id = format!("{now:x}");
    let mut more = 1;
    while taken(&id) {
        id = format!("{now:x}-{more}");
        more += 1;
    }
    id
}

/// The scope's changes, newest last: `[{id, summary, before}]`.
pub fn history(global: &Path, project: Option<&Path>, scope: &str) -> Result<Vec<Value>, String> {
    let dir = folder(global, project, scope)?;
    Ok(read(&dir.join(HISTORY))?["changes"].as_array().cloned().unwrap_or_default())
}

/// The ids of the scope's changes that were undone, newest last.
pub fn undone(global: &Path, project: Option<&Path>, scope: &str) -> Result<Vec<String>, String> {
    let dir = folder(global, project, scope)?;
    Ok(read(&dir.join(HISTORY))?["undone"].as_array().into_iter().flatten().filter_map(|id| id.as_str().map(str::to_string)).collect())
}

/// The owner's undo: put the scope's file back as it was before its last
/// change. Returns what was undone.
pub fn undo(global: &Path, project: Option<&Path>, scope: &str) -> Result<String, String> {
    undo_change(global, project, scope, None)
}

/// Undo the change `id`, which must be the scope's last: a change's card
/// cannot undo the changes made after it. `None` undoes the last change.
pub fn undo_change(global: &Path, project: Option<&Path>, scope: &str, id: Option<&str>) -> Result<String, String> {
    let dir = folder(global, project, scope)?;
    let path = dir.join(HISTORY);
    let mut kept = read(&path)?;
    let mut changes = kept["changes"].as_array().cloned().unwrap_or_default();
    if let Some(id) = id {
        if !changes.iter().any(|change| change["id"] == id) {
            return Err(format!("that change to the {scope}'s task types was already undone"));
        }
        if changes.last().is_some_and(|last| last["id"] != id) {
            return Err(format!("a later change was made to the {scope}'s task types; undo that first"));
        }
    }
    let last = changes.pop().ok_or_else(|| format!("there is no change to the {scope}'s task types to undo"))?;
    let before = last["before"].clone();
    let file = dir.join(FILE);
    if before.as_object().is_some_and(Map::is_empty) {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("cannot remove {}: {error}", file.display())),
        }
    } else {
        write(&file, &before)?;
    }
    // The ids undone, so a change's card still says so after a reload.
    let mut undone = kept["undone"].as_array().cloned().unwrap_or_default();
    if let Some(id) = last["id"].as_str() {
        undone.push(json!(id));
    }
    if undone.len() > HISTORY_MAX {
        undone.drain(..undone.len() - HISTORY_MAX);
    }
    kept["changes"] = json!(changes);
    kept["undone"] = json!(undone);
    write(&path, &kept)?;
    Ok(format!("Undid: {}", last["summary"].as_str().unwrap_or("the last change")))
}

/// The chat card for a change: what changed and its id, for the owner's Undo.
pub fn widget(project: &str, scope: &str, summary: &str, id: &str) -> Result<String, String> {
    crate::workbench::media::widget_block(&json!({
        "type": "taskTypes", "projectId": project, "scope": scope, "summary": summary, "change": id,
    }))
}

/// The folder a project's file lives in: its manifest's, or for a project
/// with no settings file yet, the project's own folder in the data folder,
/// where its personal manifest would go.
pub fn project_dir(data: &Path, root: &Path) -> Option<PathBuf> {
    crate::project_manifest::locate(root, data)
        .and_then(|manifest| manifest.path.parent().map(Path::to_path_buf))
        .or_else(|| crate::project_manifest::personal_path(root, data).parent().map(Path::to_path_buf))
}

/// The types for the project in `root` (or the install's alone).
pub fn for_folder(root: Option<&Path>) -> Result<Catalog, String> {
    let data = super::super::library::data_dir()?;
    let project = root.and_then(|root| project_dir(&data, root));
    Catalog::load(&data, project.as_deref())
}
