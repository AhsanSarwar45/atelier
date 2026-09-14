//! What one account or one project loads beyond its settings.
//!
//! Claude reads plugins, marketplaces, skills, subagents, hooks and output
//! styles from its config directory and the project's `.claude/`; Codex reads
//! skills from `~/.agents/skills` (per home, so shared across its accounts),
//! plus hooks and rules from its home and the project's `.codex/`. Each kind
//! is listed from where the provider itself keeps it, so the screen shows
//! what a chat would actually load.
//!
//! Plugins and marketplaces are moved by Claude's own CLI so its records stay
//! consistent with each other; a skill, agent, style or rule is a file the
//! person put there and is removed as a file. Hooks live inside the settings
//! file and are only listed here — `provider_settings` edits the `hooks` key.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use super::provider_defaults::atomic_write;
use super::provider_settings::{backup_of, Scope};

/// How long a plugin install, uninstall or marketplace add may take: these
/// clone a repository.
pub const SLOW_CLI: Duration = Duration::from_secs(120);
/// How long enabling or disabling may take: a settings edit.
pub const QUICK_CLI: Duration = Duration::from_secs(30);
/// How much of a CLI's output is kept for the reader.
const MAX_OUTPUT: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Plugins,
    Marketplaces,
    Skills,
    Agents,
    Hooks,
    OutputStyles,
    Rules,
}

impl Kind {
    fn wire(self) -> &'static str {
        match self {
            Kind::Plugins => "plugins",
            Kind::Marketplaces => "marketplaces",
            Kind::Skills => "skills",
            Kind::Agents => "agents",
            Kind::Hooks => "hooks",
            Kind::OutputStyles => "outputStyles",
            Kind::Rules => "rules",
        }
    }
}

/// Which settings file declared an item: the account's own or the project's.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    User,
    Project,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindList {
    pub kind: Kind,
    /// True when the directory is per home rather than per account, so the
    /// same items show for every account of the brand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
    pub items: Vec<Item>,
}

/// Every kind the brand has in this scope, each with what is there now.
///
/// `account_dir` is the account's own config directory; `home` is the home
/// directory, for the one Codex location that is per home.
pub fn list(
    brand: &str,
    scope: &Scope,
    account_dir: &Path,
    home: &Path,
) -> Result<Vec<KindList>, String> {
    if let Scope::Project { path } = scope {
        if !path.is_absolute() {
            return Err("projectPath must be absolute".into());
        }
    }
    Ok(match (brand, scope) {
        ("claude", Scope::Account { .. }) => {
            let settings = account_dir.join("settings.json");
            vec![
                plain(Kind::Plugins, installed_plugins(account_dir, &settings)),
                plain(
                    Kind::Marketplaces,
                    known_marketplaces(account_dir, &settings),
                ),
                plain(
                    Kind::Skills,
                    skills(&account_dir.join("skills"), Source::User),
                ),
                plain(
                    Kind::Agents,
                    markdown(&account_dir.join("agents"), Source::User),
                ),
                plain(Kind::Hooks, hooks(&[(settings, Source::User)])),
                plain(
                    Kind::OutputStyles,
                    markdown(&account_dir.join("output-styles"), Source::User),
                ),
            ]
        }
        ("claude", Scope::Project { path }) => {
            let files = [
                path.join(".claude/settings.json"),
                path.join(".claude/settings.local.json"),
            ];
            vec![
                plain(Kind::Plugins, declared_plugins(&files, account_dir)),
                plain(
                    Kind::Marketplaces,
                    declared_marketplaces(&files, account_dir),
                ),
                plain(
                    Kind::Skills,
                    skills(&path.join(".claude/skills"), Source::Project),
                ),
                plain(
                    Kind::Agents,
                    markdown(&path.join(".claude/agents"), Source::Project),
                ),
                plain(
                    Kind::Hooks,
                    hooks(&files.map(|file| (file, Source::Project))),
                ),
                plain(
                    Kind::Rules,
                    markdown(&path.join(".claude/rules"), Source::Project),
                ),
            ]
        }
        ("codex", Scope::Account { .. }) => vec![
            KindList {
                kind: Kind::Skills,
                shared: Some(true),
                items: skills(&home.join(".agents/skills"), Source::User),
            },
            plain(
                Kind::Hooks,
                hooks(&[(account_dir.join("hooks.json"), Source::User)]),
            ),
            plain(
                Kind::Rules,
                rule_files(&account_dir.join("rules"), Source::User),
            ),
        ],
        ("codex", Scope::Project { path }) => vec![
            plain(
                Kind::Skills,
                skills(&path.join(".agents/skills"), Source::Project),
            ),
            plain(
                Kind::Hooks,
                hooks(&[(path.join(".codex/hooks.json"), Source::Project)]),
            ),
            plain(
                Kind::Rules,
                rule_files(&path.join(".codex/rules"), Source::Project),
            ),
        ],
        _ => return Err("brand must be claude or codex".into()),
    })
}

fn plain(kind: Kind, items: Vec<Item>) -> KindList {
    KindList {
        kind,
        shared: None,
        items,
    }
}

/// The directory a removable kind is listed from in this scope, or `None`
/// when the kind is not a file the person put there.
fn removable_root(
    brand: &str,
    scope: &Scope,
    account_dir: &Path,
    home: &Path,
    kind: Kind,
) -> Option<PathBuf> {
    Some(match (brand, scope, kind) {
        ("claude", Scope::Account { .. }, Kind::Skills) => account_dir.join("skills"),
        ("claude", Scope::Account { .. }, Kind::Agents) => account_dir.join("agents"),
        ("claude", Scope::Account { .. }, Kind::OutputStyles) => account_dir.join("output-styles"),
        ("claude", Scope::Project { path }, Kind::Skills) => path.join(".claude/skills"),
        ("claude", Scope::Project { path }, Kind::Agents) => path.join(".claude/agents"),
        ("claude", Scope::Project { path }, Kind::Rules) => path.join(".claude/rules"),
        ("codex", Scope::Account { .. }, Kind::Skills) => home.join(".agents/skills"),
        ("codex", Scope::Account { .. }, Kind::Rules) => account_dir.join("rules"),
        ("codex", Scope::Project { path }, Kind::Skills) => path.join(".agents/skills"),
        ("codex", Scope::Project { path }, Kind::Rules) => path.join(".codex/rules"),
        _ => return None,
    })
}

/// Delete one listed skill, agent, output style or rule.
///
/// Only something the listing found, under the directory it was found in, is
/// deleted: an id that walks elsewhere is refused before anything is touched.
/// A symlinked skill loses the link, never what it pointed at.
pub fn remove(
    brand: &str,
    scope: &Scope,
    account_dir: &Path,
    home: &Path,
    kind: Kind,
    id: &str,
) -> Result<(), String> {
    let root = removable_root(brand, scope, account_dir, home, kind)
        .ok_or_else(|| format!("{} cannot be removed here", kind.wire()))?;
    if id.is_empty()
        || Path::new(id)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "\"{id}\" is not the id of a listed {}",
            kind.wire()
        ));
    }
    let listed = list(brand, scope, account_dir, home)?
        .into_iter()
        .find(|row| row.kind == kind)
        .and_then(|row| row.items.into_iter().find(|item| item.id == id))
        .ok_or_else(|| format!("\"{id}\" is not among the listed {}", kind.wire()))?;
    if !listed.path.starts_with(&root) || listed.path == root {
        return Err(format!(
            "{} is outside {}, so it was left alone",
            listed.path.display(),
            root.display()
        ));
    }
    let meta = fs::symlink_metadata(&listed.path)
        .map_err(|error| format!("{} could not be read: {error}", listed.path.display()))?;
    let result = if meta.file_type().is_symlink() || meta.is_file() {
        fs::remove_file(&listed.path)
    } else {
        fs::remove_dir_all(&listed.path)
    };
    result.map_err(|error| format!("{} could not be removed: {error}", listed.path.display()))
}

// ----- Claude plugins and marketplaces -----

fn read_object(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn string_of(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// The name and description a plugin gives itself in its manifest.
fn plugin_manifest(install_path: &Path) -> (Option<String>, Option<String>) {
    let manifest = read_object(&install_path.join(".claude-plugin/plugin.json"));
    (
        manifest.get("name").and_then(string_of),
        manifest.get("description").and_then(string_of),
    )
}

/// `installed_plugins.json` version 2: `{ plugins: { "<id>": [ { scope,
/// installPath, version } ] } }`. Lower versions keep the same keys under
/// `plugins`, with one object instead of a list.
fn installed_records(account_dir: &Path) -> Vec<(String, Map<String, Value>)> {
    let file = read_object(&account_dir.join("plugins/installed_plugins.json"));
    let Some(Value::Object(plugins)) = file.get("plugins") else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for (id, records) in plugins {
        match records {
            Value::Array(items) => {
                for record in items {
                    if let Value::Object(record) = record {
                        rows.push((id.clone(), record.clone()));
                    }
                }
            }
            Value::Object(record) => rows.push((id.clone(), record.clone())),
            _ => {}
        }
    }
    rows
}

fn enabled_plugins(settings: &Map<String, Value>) -> Map<String, Value> {
    match settings.get("enabledPlugins") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn plugin_item(
    id: &str,
    record: Option<&Map<String, Value>>,
    enabled: Option<bool>,
    source: Source,
    fallback_path: PathBuf,
) -> Item {
    let (short, marketplace) = match id.split_once('@') {
        Some((short, marketplace)) => (short.to_string(), Some(marketplace.to_string())),
        None => (id.to_string(), None),
    };
    let install_path = record
        .and_then(|record| record.get("installPath"))
        .and_then(string_of)
        .map(PathBuf::from);
    let (name, description) = install_path
        .as_deref()
        .map(plugin_manifest)
        .unwrap_or((None, None));
    Item {
        id: id.to_string(),
        name: name.unwrap_or(short),
        description,
        path: install_path.unwrap_or(fallback_path),
        enabled,
        version: record
            .and_then(|record| record.get("version"))
            .and_then(string_of),
        marketplace,
        source: Some(source),
        ..Item::default()
    }
}

/// Installed plugins with whether the account's settings enable them. A
/// plugin that is installed but not named in `enabledPlugins` is off, which
/// is how `claude plugin list` reads it too.
fn installed_plugins(account_dir: &Path, settings: &Path) -> Vec<Item> {
    let enabled = enabled_plugins(&read_object(settings));
    let plugins_dir = account_dir.join("plugins");
    let mut items = Vec::new();
    for (id, record) in installed_records(account_dir) {
        let source = match record.get("scope").and_then(Value::as_str) {
            Some("user") | None => Source::User,
            _ => Source::Project,
        };
        let on = enabled.get(&id).and_then(Value::as_bool).unwrap_or(false);
        items.push(plugin_item(
            &id,
            Some(&record),
            Some(on),
            source,
            plugins_dir.clone(),
        ));
    }
    // A plugin the settings switch on or off that is not installed here is
    // still a fact about this account, so it is shown without a version.
    for (id, flag) in &enabled {
        if items.iter().any(|item| item.id == *id) {
            continue;
        }
        items.push(plugin_item(
            id,
            None,
            flag.as_bool(),
            Source::User,
            plugins_dir.clone(),
        ));
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

/// Plugins the project's own settings files switch on or off, with what the
/// account has installed for each.
fn declared_plugins(files: &[PathBuf], account_dir: &Path) -> Vec<Item> {
    let installed = installed_records(account_dir);
    let plugins_dir = account_dir.join("plugins");
    let mut items: Vec<Item> = Vec::new();
    for file in files {
        for (id, flag) in enabled_plugins(&read_object(file)) {
            let record = installed
                .iter()
                .find(|(known, _)| *known == id)
                .map(|(_, r)| r);
            let mut item = plugin_item(
                &id,
                record,
                flag.as_bool(),
                Source::Project,
                plugins_dir.clone(),
            );
            if record.is_none() {
                item.path = file.clone();
            }
            // settings.local.json is read after settings.json, so a later
            // flag for the same id is the one that wins.
            match items.iter_mut().find(|known| known.id == item.id) {
                Some(known) => known.enabled = item.enabled,
                None => items.push(item),
            }
        }
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

fn describe_source(source: &Value) -> Option<String> {
    let object = source.as_object()?;
    let kind = object.get("source").and_then(string_of)?;
    let place = ["repo", "url", "path"]
        .iter()
        .find_map(|key| object.get(*key).and_then(string_of));
    Some(match place {
        Some(place) => format!("{kind} {place}"),
        None => kind,
    })
}

fn marketplace_item(name: &str, entry: &Value, source: Source, fallback_path: PathBuf) -> Item {
    let object = entry.as_object();
    Item {
        id: name.to_string(),
        name: name.to_string(),
        description: object
            .and_then(|o| o.get("source"))
            .and_then(describe_source),
        path: object
            .and_then(|o| o.get("installLocation"))
            .and_then(string_of)
            .map(PathBuf::from)
            .unwrap_or(fallback_path),
        source: Some(source),
        ..Item::default()
    }
}

/// Marketplaces the account has added (`known_marketplaces.json`), plus any
/// its settings declare in `extraKnownMarketplaces` but has not fetched yet.
fn known_marketplaces(account_dir: &Path, settings: &Path) -> Vec<Item> {
    let marketplaces = account_dir.join("plugins/marketplaces");
    let mut items: Vec<Item> = read_object(&account_dir.join("plugins/known_marketplaces.json"))
        .iter()
        .map(|(name, entry)| marketplace_item(name, entry, Source::User, marketplaces.join(name)))
        .collect();
    if let Some(Value::Object(extra)) = read_object(settings).get("extraKnownMarketplaces") {
        for (name, entry) in extra {
            if !items.iter().any(|item| item.id == *name) {
                items.push(marketplace_item(
                    name,
                    entry,
                    Source::User,
                    marketplaces.join(name),
                ));
            }
        }
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

fn declared_marketplaces(files: &[PathBuf], account_dir: &Path) -> Vec<Item> {
    let known = read_object(&account_dir.join("plugins/known_marketplaces.json"));
    let marketplaces = account_dir.join("plugins/marketplaces");
    let mut items: Vec<Item> = Vec::new();
    for file in files {
        if let Some(Value::Object(extra)) = read_object(file).get("extraKnownMarketplaces") {
            for (name, entry) in extra {
                if items.iter().any(|item| item.id == *name) {
                    continue;
                }
                let mut item =
                    marketplace_item(name, entry, Source::Project, marketplaces.join(name));
                if let Some(fetched) = known
                    .get(name)
                    .and_then(|k| k.get("installLocation"))
                    .and_then(string_of)
                {
                    item.path = PathBuf::from(fetched);
                }
                items.push(item);
            }
        }
    }
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

// ----- Files: skills, agents, output styles, rules -----

/// The `name` and `description` a markdown file's YAML frontmatter gives it.
fn frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = fs::read_to_string(path) else {
        return (None, None);
    };
    let Some(rest) = text
        .strip_prefix("---")
        .and_then(|rest| rest.strip_prefix(['\n', '\r']))
    else {
        return (None, None);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let Ok(serde_yaml::Value::Mapping(map)) =
        serde_yaml::from_str::<serde_yaml::Value>(&rest[..end])
    else {
        return (None, None);
    };
    let field = |key: &str| {
        map.get(serde_yaml::Value::String(key.to_string()))
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    (field("name"), field("description"))
}

fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    paths
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// One skill per directory holding a `SKILL.md`, named by its frontmatter.
fn skills(dir: &Path, source: Source) -> Vec<Item> {
    sorted_entries(dir)
        .into_iter()
        .filter(|path| path.is_dir() && path.join("SKILL.md").is_file())
        .map(|path| {
            let id = file_name(&path);
            let (name, description) = frontmatter(&path.join("SKILL.md"));
            Item {
                id: id.clone(),
                name: name.unwrap_or(id),
                description,
                path,
                source: Some(source),
                ..Item::default()
            }
        })
        .collect()
}

/// Every `.md` under `dir`, including subdirectories, as an item whose id is
/// its path inside `dir`.
fn markdown(dir: &Path, source: Source) -> Vec<Item> {
    files_with(dir, "md", source)
}

/// Every `.rules` under `dir`.
fn rule_files(dir: &Path, source: Source) -> Vec<Item> {
    files_with(dir, "rules", source)
}

fn files_with(dir: &Path, extension: &str, source: Source) -> Vec<Item> {
    let mut items = Vec::new();
    walk(dir, dir, extension, source, &mut items, 0);
    items
}

fn walk(
    root: &Path,
    dir: &Path,
    extension: &str,
    source: Source,
    items: &mut Vec<Item>,
    depth: usize,
) {
    if depth > 8 {
        return;
    }
    for path in sorted_entries(dir) {
        if path.is_dir() {
            walk(root, &path, extension, source, items, depth + 1);
            continue;
        }
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some(extension) {
            continue;
        }
        let id = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let (name, description) = if extension == "md" {
            frontmatter(&path)
        } else {
            (None, None)
        };
        let stem = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        items.push(Item {
            id,
            name: name.unwrap_or(stem),
            description,
            path,
            source: Some(source),
            ..Item::default()
        });
    }
}

// ----- Hooks -----

/// Every hook in each settings file's `hooks` key, flattened: `{ "<Event>":
/// [ { matcher?, hooks: [ { type, command } ] } ] }` becomes one item per
/// innermost hook, with the id naming where it sits.
fn hooks(files: &[(PathBuf, Source)]) -> Vec<Item> {
    let mut items = Vec::new();
    for (file, source) in files {
        let Some(Value::Object(events)) = read_object(file).get("hooks").cloned() else {
            continue;
        };
        for (event, groups) in &events {
            let Some(groups) = groups.as_array() else {
                continue;
            };
            for (gi, group) in groups.iter().enumerate() {
                let matcher = group.get("matcher").and_then(string_of);
                let inner = group.get("hooks").and_then(Value::as_array);
                let Some(inner) = inner else {
                    continue;
                };
                for (hi, hook) in inner.iter().enumerate() {
                    let command = hook.get("command").and_then(string_of);
                    let kind = hook.get("type").and_then(string_of);
                    let prompt = hook.get("prompt").and_then(string_of);
                    items.push(Item {
                        id: format!("{event}/{gi}/{hi}"),
                        name: command
                            .clone()
                            .or(prompt)
                            .or_else(|| kind.clone())
                            .unwrap_or_else(|| event.clone()),
                        description: kind,
                        path: file.clone(),
                        source: Some(*source),
                        event: Some(event.clone()),
                        matcher: matcher.clone(),
                        command,
                        ..Item::default()
                    });
                }
            }
        }
    }
    items
}

// ----- Writes -----

/// Switch one plugin on or off in a settings file directly, for when Claude's
/// CLI is not there or refused. The file's other keys are kept as they are.
pub fn set_enabled_in_settings(settings: &Path, id: &str, enabled: bool) -> Result<(), String> {
    let existing = match fs::read_to_string(settings) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("{} could not be read: {error}", settings.display())),
    };
    let mut object = match existing.as_deref().map(str::trim) {
        None | Some("") => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            _ => {
                return Err(format!(
                    "{} is not valid JSON, so it was left alone",
                    settings.display()
                ))
            }
        },
    };
    if !matches!(object.get("enabledPlugins"), Some(Value::Object(_))) {
        object.insert("enabledPlugins".into(), Value::Object(Map::new()));
    }
    if let Some(Value::Object(plugins)) = object.get_mut("enabledPlugins") {
        plugins.insert(id.to_string(), Value::Bool(enabled));
    }
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(object)).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if existing.is_some() {
        fs::copy(settings, backup_of(settings))
            .map_err(|error| format!("{} could not be backed up: {error}", settings.display()))?;
    }
    atomic_write(settings, &bytes)
}

/// What one run of the provider's CLI came back with.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub ok: bool,
    pub output: String,
}

/// Run `claude <args>` for one account.
///
/// `config_dir` is `None` for the system account, which is run with the
/// environment exactly as the server has it — the same as the command typed
/// into a terminal. `cwd` is the project for a project-scoped command. The
/// output is stdout and stderr together, trimmed, with terminal colour off.
pub async fn run_cli(
    program: &Path,
    variable: &str,
    config_dir: Option<&Path>,
    cwd: Option<&Path>,
    args: &[&str],
    within: Duration,
) -> Result<Outcome, String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = config_dir {
        command.env(variable, dir);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("{} could not be started: {error}", program.display()))?;
    let finished = tokio::time::timeout(within, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "{} {} did not finish within {} seconds",
                program.display(),
                args.join(" "),
                within.as_secs()
            )
        })?
        .map_err(|error| format!("{} could not be waited for: {error}", program.display()))?;
    let mut output = String::from_utf8_lossy(&finished.stdout).trim().to_string();
    let errors = String::from_utf8_lossy(&finished.stderr).trim().to_string();
    if !errors.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&errors);
    }
    if output.len() > MAX_OUTPUT {
        let cut = output
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|i| *i <= MAX_OUTPUT)
            .last()
            .unwrap_or(0);
        output.truncate(cut);
        output.push_str("\n…");
    }
    Ok(Outcome {
        ok: finished.status.success(),
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::symlink;

    fn account() -> Scope {
        Scope::Account { profile_id: None }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn kind(kinds: &[KindList], want: Kind) -> &KindList {
        kinds.iter().find(|row| row.kind == want).unwrap()
    }

    #[test]
    fn native_workbench_services_extensions_lists_a_claude_account() {
        let cfg = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cache = cfg.path().join("plugins/cache/official/notion/0.1.0");
        write(
            &cache.join(".claude-plugin/plugin.json"),
            r#"{"name":"Notion","description":"Notion tools."}"#,
        );
        write(
            &cfg.path().join("plugins/installed_plugins.json"),
            &json!({"version": 2, "plugins": {
                "notion@official": [{"scope": "user", "installPath": cache, "version": "0.1.0"}],
                "lsp@official": [{"scope": "user", "installPath": "/nowhere", "version": "1.0.0"}]
            }})
            .to_string(),
        );
        write(
            &cfg.path().join("plugins/known_marketplaces.json"),
            &json!({"official": {"source": {"source": "github", "repo": "anthropics/official"},
                "installLocation": cfg.path().join("plugins/marketplaces/official")}})
            .to_string(),
        );
        write(
            &cfg.path().join("settings.json"),
            &json!({
                "enabledPlugins": {"notion@official": true, "gone@official": false},
                "extraKnownMarketplaces": {"mine": {"source": {"source": "git", "url": "https://x/y.git"}}},
                "hooks": {"Stop": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "say done"}]}]}
            })
            .to_string(),
        );
        write(
            &cfg.path().join("skills/report/SKILL.md"),
            "---\nname: report\ndescription: Writes the report.\n---\nBody\n",
        );
        write(&cfg.path().join("skills/notes.md"), "not a skill");
        write(
            &cfg.path().join("agents/reviewer.md"),
            "---\nname: reviewer\ndescription: >\n  Reviews\n  code.\nmodel: opus\n---\n",
        );
        write(
            &cfg.path().join("output-styles/terse.md"),
            "---\nname: Terse\n---\n",
        );

        let kinds = list("claude", &account(), cfg.path(), home.path()).unwrap();
        assert_eq!(
            kinds.iter().map(|row| row.kind).collect::<Vec<_>>(),
            [
                Kind::Plugins,
                Kind::Marketplaces,
                Kind::Skills,
                Kind::Agents,
                Kind::Hooks,
                Kind::OutputStyles
            ]
        );
        let plugins = &kind(&kinds, Kind::Plugins).items;
        assert_eq!(
            plugins
                .iter()
                .map(|p| (p.id.as_str(), p.enabled))
                .collect::<Vec<_>>(),
            [
                ("gone@official", Some(false)),
                ("lsp@official", Some(false)),
                ("notion@official", Some(true))
            ]
        );
        let notion = &plugins[2];
        assert_eq!(notion.name, "Notion");
        assert_eq!(notion.description.as_deref(), Some("Notion tools."));
        assert_eq!(notion.version.as_deref(), Some("0.1.0"));
        assert_eq!(notion.marketplace.as_deref(), Some("official"));
        assert_eq!(notion.path, cache);
        assert_eq!(notion.source, Some(Source::User));
        assert_eq!(plugins[1].name, "lsp");
        assert_eq!(plugins[0].version, None);

        let markets = &kind(&kinds, Kind::Marketplaces).items;
        assert_eq!(
            markets.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["mine", "official"]
        );
        assert_eq!(
            markets[1].description.as_deref(),
            Some("github anthropics/official")
        );
        assert_eq!(
            markets[0].description.as_deref(),
            Some("git https://x/y.git")
        );
        assert_eq!(
            markets[0].path,
            cfg.path().join("plugins/marketplaces/mine")
        );

        let skills = &kind(&kinds, Kind::Skills).items;
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "report");
        assert_eq!(skills[0].description.as_deref(), Some("Writes the report."));
        assert_eq!(skills[0].path, cfg.path().join("skills/report"));

        let agents = &kind(&kinds, Kind::Agents).items;
        assert_eq!(agents[0].id, "reviewer.md");
        assert_eq!(agents[0].name, "reviewer");
        assert_eq!(agents[0].description.as_deref(), Some("Reviews code."));

        let hooks = &kind(&kinds, Kind::Hooks).items;
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].id, "Stop/0/0");
        assert_eq!(hooks[0].event.as_deref(), Some("Stop"));
        assert_eq!(hooks[0].matcher.as_deref(), Some("Bash"));
        assert_eq!(hooks[0].command.as_deref(), Some("say done"));
        assert_eq!(hooks[0].path, cfg.path().join("settings.json"));

        let styles = &kind(&kinds, Kind::OutputStyles).items;
        assert_eq!(styles[0].name, "Terse");
        assert_eq!(styles[0].id, "terse.md");

        let wire = serde_json::to_value(&kinds).unwrap();
        assert_eq!(wire[0]["kind"], json!("plugins"));
        assert_eq!(wire[5]["kind"], json!("outputStyles"));
        assert_eq!(wire[0]["items"][2]["marketplace"], json!("official"));
        assert!(wire[0].get("shared").is_none());
    }

    #[test]
    fn native_workbench_services_extensions_lists_a_claude_project() {
        let cfg = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            &project.path().join(".claude/settings.json"),
            &json!({"enabledPlugins": {"a@m": true}, "extraKnownMarketplaces": {"m": {"source": {"source": "github", "repo": "o/m"}}},
                "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "lint"}]}]}})
            .to_string(),
        );
        write(
            &project.path().join(".claude/settings.local.json"),
            &json!({"enabledPlugins": {"a@m": false, "b@m": true}}).to_string(),
        );
        write(
            &project.path().join(".claude/rules/style/rust.md"),
            "---\ndescription: Rust style\n---\n",
        );
        write(
            &project.path().join(".claude/skills/deploy/SKILL.md"),
            "---\nname: deploy\n---\n",
        );
        write(
            &project.path().join(".claude/agents/tester.md"),
            "no frontmatter",
        );
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        let kinds = list("claude", &scope, cfg.path(), home.path()).unwrap();
        assert_eq!(
            kinds.iter().map(|row| row.kind).collect::<Vec<_>>(),
            [
                Kind::Plugins,
                Kind::Marketplaces,
                Kind::Skills,
                Kind::Agents,
                Kind::Hooks,
                Kind::Rules
            ]
        );
        let plugins = &kind(&kinds, Kind::Plugins).items;
        assert_eq!(
            plugins
                .iter()
                .map(|p| (p.id.as_str(), p.enabled, p.source))
                .collect::<Vec<_>>(),
            [
                ("a@m", Some(false), Some(Source::Project)),
                ("b@m", Some(true), Some(Source::Project))
            ]
        );
        assert_eq!(kind(&kinds, Kind::Marketplaces).items[0].id, "m");
        let rules = &kind(&kinds, Kind::Rules).items;
        assert_eq!(rules[0].id, "style/rust.md");
        assert_eq!(rules[0].name, "rust");
        assert_eq!(rules[0].description.as_deref(), Some("Rust style"));
        assert_eq!(kind(&kinds, Kind::Skills).items[0].id, "deploy");
        assert_eq!(kind(&kinds, Kind::Agents).items[0].name, "tester");
        assert_eq!(
            kind(&kinds, Kind::Hooks).items[0].command.as_deref(),
            Some("lint")
        );
        assert_eq!(kind(&kinds, Kind::Hooks).items[0].matcher, None);
        assert!(list(
            "claude",
            &Scope::Project {
                path: "relative".into()
            },
            cfg.path(),
            home.path()
        )
        .is_err());
        assert!(list("gemini", &account(), cfg.path(), home.path()).is_err());
    }

    #[test]
    fn native_workbench_services_extensions_lists_a_codex_account_and_project() {
        let codex = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".agents/skills/composio/SKILL.md"),
            "---\nname: composio-cli\ndescription: Drives composio.\n---\n",
        );
        write(
            &codex.path().join("hooks.json"),
            r#"{"hooks":{"SessionStart":[],"Stop":[{"hooks":[{"type":"command","command":"notify"}]}]}}"#,
        );
        write(
            &codex.path().join("rules/default.rules"),
            "prefix_rule(pattern=[\"bd\"], decision=\"allow\")\n",
        );
        write(&codex.path().join("rules/readme.txt"), "not a rule");
        let kinds = list("codex", &account(), codex.path(), home.path()).unwrap();
        assert_eq!(
            kinds.iter().map(|row| row.kind).collect::<Vec<_>>(),
            [Kind::Skills, Kind::Hooks, Kind::Rules]
        );
        assert_eq!(kinds[0].shared, Some(true));
        assert_eq!(kinds[0].items[0].id, "composio");
        assert_eq!(kinds[0].items[0].name, "composio-cli");
        assert_eq!(kinds[1].shared, None);
        assert_eq!(kinds[1].items.len(), 1);
        assert_eq!(kinds[1].items[0].id, "Stop/0/0");
        assert_eq!(kinds[2].items.len(), 1);
        assert_eq!(kinds[2].items[0].id, "default.rules");
        assert_eq!(
            kinds[2].items[0].path,
            codex.path().join("rules/default.rules")
        );
        let wire = serde_json::to_value(&kinds).unwrap();
        assert_eq!(wire[0]["shared"], json!(true));

        write(&project.path().join(".codex/rules/team.rules"), "");
        write(&project.path().join(".codex/hooks.json"), r#"{"hooks":{}}"#);
        write(
            &project.path().join(".agents/skills/local/SKILL.md"),
            "---\nname: local\n---\n",
        );
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        let kinds = list("codex", &scope, codex.path(), home.path()).unwrap();
        assert_eq!(kinds[0].items[0].source, Some(Source::Project));
        assert_eq!(kinds[0].shared, None);
        assert!(kinds[1].items.is_empty());
        assert_eq!(kinds[2].items[0].id, "team.rules");
    }

    #[test]
    fn native_workbench_services_extensions_remove_deletes_only_what_was_listed() {
        let cfg = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        write(
            &cfg.path().join("skills/mine/SKILL.md"),
            "---\nname: mine\n---\n",
        );
        write(
            &elsewhere.path().join("linked/SKILL.md"),
            "---\nname: linked\n---\n",
        );
        symlink(
            elsewhere.path().join("linked"),
            cfg.path().join("skills/linked"),
        )
        .unwrap();
        write(&cfg.path().join("agents/a.md"), "");
        write(&cfg.path().join("secret.md"), "");
        write(
            &cfg.path().join("settings.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}"#,
        );

        for bad in [
            "../secret.md",
            "/etc/passwd",
            "",
            "..",
            "mine/../../secret.md",
        ] {
            let error = remove(
                "claude",
                &account(),
                cfg.path(),
                home.path(),
                Kind::Agents,
                bad,
            )
            .unwrap_err();
            assert!(error.contains("not"), "{bad}: {error}");
        }
        assert!(cfg.path().join("secret.md").is_file());
        assert!(remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Skills,
            "nope"
        )
        .is_err());
        assert!(remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Hooks,
            "Stop/0/0"
        )
        .is_err());
        assert!(remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Plugins,
            "a@b"
        )
        .is_err());
        assert!(remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Rules,
            "a.md"
        )
        .is_err());
        assert!(cfg.path().join("settings.json").is_file());

        remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Skills,
            "linked",
        )
        .unwrap();
        assert!(!cfg.path().join("skills/linked").exists());
        assert!(
            elsewhere.path().join("linked/SKILL.md").is_file(),
            "the link's target is kept"
        );
        remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Skills,
            "mine",
        )
        .unwrap();
        assert!(!cfg.path().join("skills/mine").exists());
        remove(
            "claude",
            &account(),
            cfg.path(),
            home.path(),
            Kind::Agents,
            "a.md",
        )
        .unwrap();
        assert!(!cfg.path().join("agents/a.md").exists());
        assert!(cfg.path().join("agents").is_dir());

        let codex = tempfile::tempdir().unwrap();
        write(&codex.path().join("rules/x.rules"), "");
        remove(
            "codex",
            &account(),
            codex.path(),
            home.path(),
            Kind::Rules,
            "x.rules",
        )
        .unwrap();
        assert!(!codex.path().join("rules/x.rules").exists());
        assert!(remove(
            "codex",
            &account(),
            codex.path(),
            home.path(),
            Kind::Agents,
            "a.md"
        )
        .is_err());
    }

    #[test]
    fn native_workbench_services_extensions_set_enabled_edits_settings_and_keeps_the_rest() {
        let cfg = tempfile::tempdir().unwrap();
        let settings = cfg.path().join("settings.json");
        set_enabled_in_settings(&settings, "a@m", true).unwrap();
        assert_eq!(
            fs::read_to_string(&settings).unwrap(),
            "{\n  \"enabledPlugins\": {\n    \"a@m\": true\n  }\n}\n"
        );
        write(
            &settings,
            "{\n  \"model\": \"opus\",\n  \"enabledPlugins\": {\"a@m\": true, \"b@m\": true}\n}\n",
        );
        set_enabled_in_settings(&settings, "a@m", false).unwrap();
        let after: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            after,
            json!({"model": "opus", "enabledPlugins": {"a@m": false, "b@m": true}})
        );
        assert!(fs::read_to_string(&settings)
            .unwrap()
            .starts_with("{\n  \"model\""));
        assert!(backup_of(&settings).is_file());
        write(&settings, "{ nope");
        assert!(set_enabled_in_settings(&settings, "a@m", true).is_err());
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{ nope");
    }

    #[tokio::test]
    async fn native_workbench_services_extensions_run_cli_reports_exit_output_and_env() {
        let outcome = run_cli(
            Path::new("sh"),
            "CLAUDE_CONFIG_DIR",
            Some(Path::new("/cfg")),
            None,
            &["-c", "echo \"$CLAUDE_CONFIG_DIR\"; echo oops >&2; exit 3"],
            QUICK_CLI,
        )
        .await
        .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.output, "/cfg\noops");
        let outcome = run_cli(
            Path::new("sh"),
            "CLAUDE_CONFIG_DIR",
            None,
            None,
            &["-c", "true"],
            QUICK_CLI,
        )
        .await
        .unwrap();
        assert!(outcome.ok && outcome.output.is_empty());
        let error = run_cli(
            Path::new("sh"),
            "X",
            None,
            None,
            &["-c", "sleep 5"],
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert!(error.contains("did not finish"), "{error}");
        assert!(run_cli(
            Path::new("/nonexistent/claude"),
            "X",
            None,
            None,
            &[],
            QUICK_CLI
        )
        .await
        .is_err());
    }
}
