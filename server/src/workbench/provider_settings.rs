//! One account's provider settings, read and written key by key.
//!
//! Claude keeps `settings.json`; Codex keeps `config.toml`. Each brand layers
//! a few of these files, and the browser wants to show a value and say which
//! file it came from. So a read answers every layer's whole document rather
//! than a merged view, and a write names the one layer it changes. Everything
//! the patch does not name — unknown keys, key order, comments, unrelated
//! tables — must come out of a write exactly as it went in.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{DocumentMut, InlineTable, Item, Table};

use super::provider_defaults::{atomic_write, managed_claude_settings};

/// The largest patch a write accepts, so a runaway client cannot fill a disk.
const MAX_PATCH_KEYS: usize = 500;

/// Whose settings: one account's own directory, or one project's checkout.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "scope", rename_all = "camelCase")]
pub enum Scope {
    #[serde(rename_all = "camelCase")]
    Account {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
    Project {
        #[serde(rename = "projectPath")]
        path: PathBuf,
    },
}

/// Which file inside a scope a value is in.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    /// The account's own file: `<claude>/settings.json` or `<codex>/config.toml`.
    User,
    /// Claude's machine-wide managed settings. Read only.
    Managed,
    /// The project's shared file: `.claude/settings.json` or `.codex/config.toml`.
    Project,
    /// Claude's per-checkout `.claude/settings.local.json`.
    Local,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerFile {
    pub layer: Layer,
    pub path: PathBuf,
    pub exists: bool,
    pub writable: bool,
    /// The whole document as JSON (TOML converted). `{}` when the file is
    /// missing; `null` alongside `error` when it is there but unreadable.
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsView {
    pub brand: String,
    pub files: Vec<LayerFile>,
}

/// The files one scope of one brand is made of, lowest precedence first.
/// `account_dir` is the account's own config directory and is only consulted
/// for the account scope.
pub fn layers(
    brand: &str,
    scope: &Scope,
    account_dir: &Path,
) -> Result<Vec<(Layer, PathBuf, bool)>, String> {
    Ok(match (brand, scope) {
        ("claude", Scope::Account { .. }) => vec![
            (Layer::User, account_dir.join("settings.json"), true),
            (Layer::Managed, managed_claude_settings(), false),
        ],
        ("claude", Scope::Project { path }) => vec![
            (Layer::Project, path.join(".claude/settings.json"), true),
            (Layer::Local, path.join(".claude/settings.local.json"), true),
        ],
        ("codex", Scope::Account { .. }) => {
            vec![(Layer::User, account_dir.join("config.toml"), true)]
        }
        ("codex", Scope::Project { path }) => {
            vec![(Layer::Project, path.join(".codex/config.toml"), true)]
        }
        _ => return Err("brand must be claude or codex".into()),
    })
}

/// Every layer's whole document, so the browser can work out the effective
/// value and say which file it came from.
pub fn read(
    brand: &str,
    scope: &Scope,
    account_dir: &Path,
) -> Result<ProviderSettingsView, String> {
    if let Scope::Project { path } = scope {
        if !path.is_absolute() {
            return Err("projectPath must be absolute".into());
        }
    }
    let files = layers(brand, scope, account_dir)?
        .into_iter()
        .map(|(layer, path, writable)| {
            let exists = path.is_file();
            let (value, error) = if !exists {
                (Value::Object(Map::new()), None)
            } else {
                match load(brand, &path) {
                    Ok(value) => (value, None),
                    Err(error) => (Value::Null, Some(error)),
                }
            };
            LayerFile {
                layer,
                path,
                exists,
                writable,
                value,
                error,
            }
        })
        .collect();
    Ok(ProviderSettingsView {
        brand: brand.to_string(),
        files,
    })
}

/// Change the named keys of one layer and answer the scope as it now reads.
///
/// Each patch key is a dotted path; a `null` value deletes that key and any
/// parent object or table the deletion leaves empty. A file that is there but
/// does not parse is refused and left as it is.
pub fn write(
    brand: &str,
    scope: &Scope,
    account_dir: &Path,
    layer: Layer,
    patch: &Map<String, Value>,
) -> Result<ProviderSettingsView, String> {
    if patch.len() > MAX_PATCH_KEYS {
        return Err(format!("a patch names at most {MAX_PATCH_KEYS} keys"));
    }
    let (_, path, writable) = layers(brand, scope, account_dir)?
        .into_iter()
        .find(|(candidate, _, _)| *candidate == layer)
        .ok_or_else(|| format!("{brand} has no {} layer in this scope", layer_name(layer)))?;
    if !writable {
        return Err(format!(
            "{} is managed by this machine and cannot be edited here",
            path.display()
        ));
    }
    let paths: Vec<Vec<&str>> = patch
        .keys()
        .map(|key| key.split('.').collect::<Vec<_>>())
        .collect();
    if let Some(bad) = patch
        .keys()
        .zip(&paths)
        .find(|(_, parts)| parts.iter().any(|part| part.is_empty()))
    {
        return Err(format!("\"{}\" is not a settings key", bad.0));
    }
    let existing = match fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };
    let bytes = match brand {
        "claude" => patch_json(&path, existing.as_deref(), &paths, patch)?,
        "codex" => patch_toml(&path, existing.as_deref(), &paths, patch)?,
        _ => return Err("brand must be claude or codex".into()),
    };
    if existing.is_some() {
        fs::copy(&path, backup_of(&path))
            .map_err(|error| format!("{} could not be backed up: {error}", path.display()))?;
    }
    atomic_write(&path, &bytes)?;
    read(brand, scope, account_dir)
}

/// `settings.json.bak` beside `settings.json`: the previous contents, kept
/// until the next write replaces it.
pub(crate) fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".bak");
    PathBuf::from(name)
}

fn layer_name(layer: Layer) -> &'static str {
    match layer {
        Layer::User => "user",
        Layer::Managed => "managed",
        Layer::Project => "project",
        Layer::Local => "local",
    }
}

fn load(brand: &str, path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("{} could not be read: {error}", path.display()))?;
    match brand {
        "claude" => parse_json(path, &text).map(Value::Object),
        _ => Ok(document_to_json(&parse_toml(path, &text)?)),
    }
}

fn parse_json(path: &Path, text: &str) -> Result<Map<String, Value>, String> {
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(format!(
            "{} does not hold a settings object, so it was left alone",
            path.display()
        )),
        Err(_) => Err(format!(
            "{} is not valid JSON, so it was left alone",
            path.display()
        )),
    }
}

fn parse_toml(path: &Path, text: &str) -> Result<DocumentMut, String> {
    text.parse::<DocumentMut>()
        .map_err(|_| format!("{} is not valid TOML, so it was left alone", path.display()))
}

// ----- Claude: settings.json -----

fn patch_json(
    path: &Path,
    existing: Option<&str>,
    paths: &[Vec<&str>],
    patch: &Map<String, Value>,
) -> Result<Vec<u8>, String> {
    let mut settings = match existing {
        Some(text) => parse_json(path, text)?,
        None => Map::new(),
    };
    for (parts, value) in paths.iter().zip(patch.values()) {
        set_json(&mut settings, parts, value);
    }
    let mut bytes =
        serde_json::to_vec_pretty(&Value::Object(settings)).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn set_json(object: &mut Map<String, Value>, parts: &[&str], value: &Value) {
    let Some((head, rest)) = parts.split_first() else {
        return;
    };
    if rest.is_empty() {
        if value.is_null() {
            object.shift_remove(*head);
        } else {
            object.insert(head.to_string(), value.clone());
        }
        return;
    }
    if value.is_null() {
        if let Some(Value::Object(child)) = object.get_mut(*head) {
            set_json(child, rest, value);
            if child.is_empty() {
                object.shift_remove(*head);
            }
        }
        return;
    }
    if !matches!(object.get(*head), Some(Value::Object(_))) {
        object.insert(head.to_string(), Value::Object(Map::new()));
    }
    if let Some(Value::Object(child)) = object.get_mut(*head) {
        set_json(child, rest, value);
    }
}

// ----- Codex: config.toml -----

fn patch_toml(
    path: &Path,
    existing: Option<&str>,
    paths: &[Vec<&str>],
    patch: &Map<String, Value>,
) -> Result<Vec<u8>, String> {
    let mut document = match existing {
        Some(text) => parse_toml(path, text)?,
        None => DocumentMut::new(),
    };
    let root = document.as_item_mut();
    for (parts, value) in paths.iter().zip(patch.values()) {
        set_toml(root, parts, value).map_err(|what| {
            format!("{} cannot take {}: {what}", path.display(), parts.join("."))
        })?;
    }
    let mut text = document.to_string();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text.into_bytes())
}

/// Walk `parts` down from `item`, which must be table-like, creating tables
/// on the way when setting and pruning emptied ones on the way back when
/// deleting. An inline table only holds values, so what gets inserted below
/// one is shaped by the container, not by the patch.
fn set_toml(item: &mut Item, parts: &[&str], value: &Value) -> Result<(), String> {
    let inline = item.is_inline_table();
    let Some(table) = item.as_table_like_mut() else {
        return Err("the key above it is not a table".into());
    };
    let Some((head, rest)) = parts.split_first() else {
        return Ok(());
    };
    if rest.is_empty() {
        if value.is_null() {
            table.remove(head);
        } else if inline {
            table.insert(head, Item::Value(json_to_value(value)));
        } else {
            table.insert(head, json_to_item(value));
        }
        return Ok(());
    }
    if value.is_null() {
        if let Some(child) = table.get_mut(head) {
            if child.is_table_like() {
                set_toml(child, rest, value)?;
                if child.as_table_like().is_some_and(|child| child.is_empty()) {
                    table.remove(head);
                }
            }
        }
        return Ok(());
    }
    if !table.get(head).is_some_and(Item::is_table_like) {
        let fresh = if inline {
            Item::Value(toml_edit::Value::InlineTable(InlineTable::new()))
        } else {
            let mut fresh = Table::new();
            fresh.set_implicit(true);
            Item::Table(fresh)
        };
        table.insert(head, fresh);
    }
    let child = table.get_mut(head).ok_or("the key could not be created")?;
    set_toml(child, rest, value)
}

/// A JSON value as something that can sit at `key = ...` in a table: objects
/// become their own `[table]`, objects inside arrays become inline tables.
fn json_to_item(value: &Value) -> Item {
    match value {
        Value::Object(map) => {
            let mut table = Table::new();
            for (key, value) in map {
                table.insert(key, json_to_item(value));
            }
            Item::Table(table)
        }
        other => Item::Value(json_to_value(other)),
    }
}

/// A JSON value as a TOML value: objects become inline tables.
fn json_to_value(value: &Value) -> toml_edit::Value {
    match value {
        Value::Null => toml_edit::Value::from(""),
        Value::Bool(flag) => toml_edit::Value::from(*flag),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(int), _) => toml_edit::Value::from(int),
            (None, Some(float)) => toml_edit::Value::from(float),
            (None, None) => toml_edit::Value::from(number.to_string()),
        },
        Value::String(text) => toml_edit::Value::from(text.as_str()),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(json_to_value(item));
            }
            toml_edit::Value::Array(array)
        }
        Value::Object(map) => {
            let mut table = InlineTable::new();
            for (key, value) in map {
                table.insert(key, json_to_value(value));
            }
            toml_edit::Value::InlineTable(table)
        }
    }
}

fn document_to_json(document: &DocumentMut) -> Value {
    item_to_json(document.as_item())
}

fn item_to_json(item: &Item) -> Value {
    match item {
        Item::None => Value::Null,
        Item::Value(value) => value_to_json(value),
        Item::Table(table) => table_like_to_json(table),
        Item::ArrayOfTables(tables) => Value::Array(
            tables
                .iter()
                .map(|table| table_like_to_json(table))
                .collect(),
        ),
    }
}

fn table_like_to_json(table: &dyn toml_edit::TableLike) -> Value {
    Value::Object(
        table
            .iter()
            .map(|(key, item)| (key.to_string(), item_to_json(item)))
            .collect(),
    )
}

fn value_to_json(value: &toml_edit::Value) -> Value {
    match value {
        toml_edit::Value::String(text) => Value::String(text.value().clone()),
        toml_edit::Value::Integer(int) => Value::Number((*int.value()).into()),
        toml_edit::Value::Float(float) => Number::from_f64(*float.value())
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(float.value().to_string())),
        toml_edit::Value::Boolean(flag) => Value::Bool(*flag.value()),
        toml_edit::Value::Datetime(when) => Value::String(when.value().to_string()),
        toml_edit::Value::Array(items) => Value::Array(items.iter().map(value_to_json).collect()),
        toml_edit::Value::InlineTable(table) => table_like_to_json(table),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account() -> Scope {
        Scope::Account { profile_id: None }
    }

    fn patch(pairs: Value) -> Map<String, Value> {
        pairs.as_object().cloned().unwrap()
    }

    #[test]
    fn native_workbench_services_provider_settings_scope_reads_the_wire_shape() {
        let scope: Scope =
            serde_json::from_value(json!({"scope":"account","profileId":"azeem","brand":"codex"}))
                .unwrap();
        assert_eq!(
            scope,
            Scope::Account {
                profile_id: Some("azeem".into())
            }
        );
        let scope: Scope =
            serde_json::from_value(json!({"scope":"project","projectPath":"/x"})).unwrap();
        assert_eq!(scope, Scope::Project { path: "/x".into() });
        assert!(serde_json::from_value::<Scope>(json!({"scope":"project"})).is_err());
        assert_eq!(
            serde_json::to_value(Layer::Managed).unwrap(),
            json!("managed")
        );
    }

    #[test]
    fn native_workbench_services_provider_settings_codex_write_keeps_comments_and_other_tables() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("config.toml");
        fs::write(
            &file,
            "# how I like it\nmodel = \"gpt-5\" # pinned\napproval_policy = \"ask\"\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n\n[sandbox_workspace_write]\nnetwork_access = false\n",
        )
        .unwrap();
        let view = write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"sandbox_workspace_write.network_access": true, "model_reasoning_effort": "high"})),
        )
        .unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("# how I like it\n"), "{text}");
        assert!(text.contains("model = \"gpt-5\" # pinned\n"), "{text}");
        assert!(
            text.contains("[projects.\"/x\"]\ntrust_level = \"trusted\"\n"),
            "{text}"
        );
        assert!(text.contains("network_access = true"), "{text}");
        assert!(
            text.contains("model_reasoning_effort = \"high\"\n"),
            "{text}"
        );
        assert!(text.ends_with('\n'));
        assert_eq!(
            view.files[0].value["sandbox_workspace_write"]["network_access"],
            json!(true)
        );
        assert_eq!(
            view.files[0].value["projects"]["/x"]["trust_level"],
            json!("trusted")
        );
        assert!(view.files[0].exists && view.files[0].writable);
        assert_eq!(
            fs::read_to_string(backup_of(&file))
                .unwrap()
                .matches("network_access = false")
                .count(),
            1
        );
    }

    #[test]
    fn native_workbench_services_provider_settings_codex_delete_prunes_an_emptied_table() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("config.toml");
        fs::write(
            &file,
            "model = \"gpt-5\"\n\n[mcp_servers.foo]\nenabled = true\n\n[mcp_servers.bar]\ncommand = \"bar\"\n",
        )
        .unwrap();
        write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"mcp_servers.foo.enabled": null})),
        )
        .unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains("foo"), "{text}");
        assert!(
            text.contains("[mcp_servers.bar]\ncommand = \"bar\"\n"),
            "{text}"
        );
        write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"mcp_servers.bar.command": null})),
        )
        .unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text, "model = \"gpt-5\"\n");
    }

    #[test]
    fn native_workbench_services_provider_settings_codex_nested_path_makes_tables_and_inline_tables(
    ) {
        let home = tempfile::tempdir().unwrap();
        write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({
                "mcp_servers.docs.command": "npx",
                "mcp_servers.docs.args": ["-y", "docs"],
                "profiles": {"fast": {"model": "mini"}},
                "notify": [{"kind": "bell", "loud": false}]
            })),
        )
        .unwrap();
        let text = fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(
            text.contains("[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"-y\", \"docs\"]\n"),
            "{text}"
        );
        assert!(!text.contains("[mcp_servers]\n"), "{text}");
        assert!(
            text.contains("[profiles.fast]\nmodel = \"mini\"\n"),
            "{text}"
        );
        assert!(
            text.contains("notify = [{ kind = \"bell\", loud = false }]"),
            "{text}"
        );
        let view = read("codex", &account(), home.path()).unwrap();
        assert_eq!(view.files[0].value["notify"][0]["loud"], json!(false));
        // A key under an inline table is set as a value, never as a `[table]`.
        write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"notify.0": null, "tui.theme.name": "dark"})),
        )
        .unwrap();
        fs::write(
            home.path().join("config.toml"),
            "tui = { theme = { name = \"light\" } }\n",
        )
        .unwrap();
        write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"tui.theme.name": "dark", "tui.other.x": 1})),
        )
        .unwrap();
        let text = fs::read_to_string(home.path().join("config.toml")).unwrap();
        assert!(text.starts_with("tui = {"), "{text}");
        assert!(text.contains("theme = { name = \"dark\" }"), "{text}");
        assert!(text.contains("other = { x = 1 }"), "{text}");
        assert!(!text.contains("[tui"), "{text}");
    }

    #[test]
    fn native_workbench_services_provider_settings_claude_write_keeps_unknown_keys_and_order() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("settings.json");
        fs::write(
            &file,
            "{\n  \"zeta\": 1,\n  \"permissions\": {\"allow\": [\"Bash\"], \"defaultMode\": \"plan\"},\n  \"alpha\": {\"nested\": true}\n}\n",
        )
        .unwrap();
        let view = write(
            "claude",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"permissions.defaultMode": "acceptEdits", "hooks.PreToolUse.0": "x", "model": "opus"})),
        )
        .unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            "{\n  \"zeta\": 1,\n  \"permissions\": {\n    \"allow\": [\n      \"Bash\"\n    ],\n    \"defaultMode\": \"acceptEdits\"\n  },\n  \"alpha\": {\n    \"nested\": true\n  },\n  \"hooks\": {\n    \"PreToolUse\": {\n      \"0\": \"x\"\n    }\n  },\n  \"model\": \"opus\"\n}\n"
        );
        assert_eq!(view.files[0].layer, Layer::User);
        assert_eq!(view.files[0].value["permissions"]["allow"], json!(["Bash"]));
        assert_eq!(view.files[1].layer, Layer::Managed);
        assert!(!view.files[1].writable);
        write(
            "claude",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"hooks.PreToolUse.0": null, "alpha.nested": null})),
        )
        .unwrap();
        let after: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(after.get("hooks"), None);
        assert_eq!(after.get("alpha"), None);
        assert_eq!(after["zeta"], json!(1));
    }

    #[test]
    fn native_workbench_services_provider_settings_project_scope_names_each_file() {
        let project = tempfile::tempdir().unwrap();
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        let view = write(
            "claude",
            &scope,
            Path::new("/nowhere"),
            Layer::Local,
            &patch(json!({"model": "sonnet"})),
        )
        .unwrap();
        assert_eq!(
            view.files.iter().map(|f| f.layer).collect::<Vec<_>>(),
            [Layer::Project, Layer::Local]
        );
        assert!(!view.files[0].exists);
        assert_eq!(view.files[0].value, json!({}));
        assert_eq!(
            view.files[1].path,
            project.path().join(".claude/settings.local.json")
        );
        assert_eq!(view.files[1].value, json!({"model": "sonnet"}));
        assert!(
            !backup_of(&view.files[1].path).exists(),
            "a first write has nothing to back up"
        );
        let view = write(
            "codex",
            &scope,
            Path::new("/nowhere"),
            Layer::Project,
            &patch(json!({"model": "gpt-5"})),
        )
        .unwrap();
        assert_eq!(
            view.files[0].path,
            project.path().join(".codex/config.toml")
        );
        assert_eq!(view.files[0].value, json!({"model": "gpt-5"}));
        assert!(write(
            "codex",
            &scope,
            Path::new("/nowhere"),
            Layer::Local,
            &patch(json!({}))
        )
        .is_err());
        assert!(read(
            "codex",
            &Scope::Project {
                path: "relative".into()
            },
            Path::new("/nowhere")
        )
        .is_err());
    }

    #[test]
    fn native_workbench_services_provider_settings_refuses_managed_and_malformed_files() {
        let home = tempfile::tempdir().unwrap();
        let error = write(
            "claude",
            &account(),
            home.path(),
            Layer::Managed,
            &patch(json!({"model": "x"})),
        )
        .unwrap_err();
        assert!(error.contains("managed-settings.json"), "{error}");
        let json = home.path().join("settings.json");
        fs::write(&json, "{ not json").unwrap();
        let error = write(
            "claude",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"model": "x"})),
        )
        .unwrap_err();
        assert_eq!(
            error,
            format!("{} is not valid JSON, so it was left alone", json.display())
        );
        assert_eq!(fs::read_to_string(&json).unwrap(), "{ not json");
        assert!(!backup_of(&json).exists());
        let toml = home.path().join("config.toml");
        fs::write(&toml, "model = \n").unwrap();
        let error = write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"model": "x"})),
        )
        .unwrap_err();
        assert_eq!(
            error,
            format!("{} is not valid TOML, so it was left alone", toml.display())
        );
        assert_eq!(fs::read_to_string(&toml).unwrap(), "model = \n");
        let view = read("codex", &account(), home.path()).unwrap();
        assert_eq!(view.files[0].value, Value::Null);
        assert!(view.files[0].error.is_some());
        assert!(write(
            "codex",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({"a..b": 1}))
        )
        .is_err());
        assert!(write(
            "gemini",
            &account(),
            home.path(),
            Layer::User,
            &patch(json!({}))
        )
        .is_err());
    }
}
