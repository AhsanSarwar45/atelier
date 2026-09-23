//! What one account or one project loads beyond its settings: Claude's
//! plugins and the marketplaces they come from.
//!
//! Skills, subagents, hooks, output styles and rules are files, and the Agent
//! files screen lists and edits them; Codex has no plugin system, so it has
//! nothing here. Plugins and marketplaces are listed from Claude's own
//! records (`plugins/installed_plugins.json`, `plugins/known_marketplaces.json`)
//! and from the settings files that switch them on, so the screen shows what
//! a chat would actually load. They are moved by Claude's own CLI so its
//! records stay consistent with each other; `set_enabled_in_settings` is the
//! fallback edit for when the CLI is not there.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
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
    /// A marketplace's own address — the `owner/repo`, URL or path it was
    /// added from. What `plugin marketplace add` would be given to put the
    /// same marketplace on another account (bw-6ecp.5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindList {
    pub kind: Kind,
    pub items: Vec<Item>,
}

/// Every kind the brand has in this scope, each with what is there now.
///
/// `account_dir` is the account's own config directory. Codex has no plugins,
/// so it lists nothing.
pub fn list(brand: &str, scope: &Scope, account_dir: &Path) -> Result<Vec<KindList>, String> {
    if let Scope::Project { path } = scope {
        if !path.is_absolute() {
            return Err("projectPath must be absolute".into());
        }
    }
    Ok(match (brand, scope) {
        ("claude", Scope::Account { .. }) => {
            let settings = account_dir.join("settings.json");
            vec![
                KindList {
                    kind: Kind::Plugins,
                    items: installed_plugins(account_dir, &settings),
                },
                KindList {
                    kind: Kind::Marketplaces,
                    items: known_marketplaces(account_dir, &settings),
                },
            ]
        }
        ("claude", Scope::Project { path }) => {
            let files = [
                path.join(".claude/settings.json"),
                path.join(".claude/settings.local.json"),
            ];
            vec![
                KindList {
                    kind: Kind::Plugins,
                    items: declared_plugins(&files, account_dir),
                },
                KindList {
                    kind: Kind::Marketplaces,
                    items: declared_marketplaces(&files, account_dir),
                },
            ]
        }
        ("codex", _) => Vec::new(),
        _ => return Err("brand must be claude or codex".into()),
    })
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
        // A plugin is named by `plugin@marketplace`; only a marketplace has an
        // address of its own.
        origin: None,
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
    let kind = source.as_object()?.get("source").and_then(string_of)?;
    Some(match origin_of(source) {
        Some(place) => format!("{kind} {place}"),
        None => kind,
    })
}

/// The address the marketplace was added from, whichever key holds it.
fn origin_of(source: &Value) -> Option<String> {
    let object = source.as_object()?;
    ["repo", "url", "path"]
        .iter()
        .find_map(|key| object.get(*key).and_then(string_of))
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
        origin: object.and_then(|o| o.get("source")).and_then(origin_of),
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
        // Files the Agent files screen owns are not extensions.
        write(
            &cfg.path().join("skills/report/SKILL.md"),
            "---\nname: report\n---\nBody\n",
        );
        write(&cfg.path().join("agents/reviewer.md"), "---\nname: reviewer\n---\n");
        write(&cfg.path().join("output-styles/terse.md"), "---\nname: Terse\n---\n");

        let kinds = list("claude", &account(), cfg.path()).unwrap();
        assert_eq!(
            kinds.iter().map(|row| row.kind).collect::<Vec<_>>(),
            [Kind::Plugins, Kind::Marketplaces]
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
        // The address, apart from the prose, so the same marketplace can be
        // added on another account (bw-6ecp.5).
        assert_eq!(markets[1].origin.as_deref(), Some("anthropics/official"));
        assert_eq!(markets[0].origin.as_deref(), Some("https://x/y.git"));
        assert_eq!(plugins[2].origin, None);

        let wire = serde_json::to_value(&kinds).unwrap();
        assert_eq!(wire[0]["kind"], json!("plugins"));
        assert_eq!(wire[1]["kind"], json!("marketplaces"));
        assert_eq!(wire[0]["items"][2]["marketplace"], json!("official"));
        assert_eq!(wire[0]["items"][2]["source"], json!("user"));
        assert_eq!(wire[1]["items"][1]["origin"], json!("anthropics/official"));
        assert!(wire[0]["items"][2].get("origin").is_none());
        assert!(wire[0].get("shared").is_none());
    }

    #[test]
    fn native_workbench_services_extensions_lists_a_claude_project() {
        let cfg = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
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
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        let kinds = list("claude", &scope, cfg.path()).unwrap();
        assert_eq!(
            kinds.iter().map(|row| row.kind).collect::<Vec<_>>(),
            [Kind::Plugins, Kind::Marketplaces]
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
        assert_eq!(
            plugins[0].path,
            project.path().join(".claude/settings.json")
        );
        let markets = &kind(&kinds, Kind::Marketplaces).items;
        assert_eq!(markets.len(), 1);
        assert_eq!(markets[0].id, "m");
        assert_eq!(markets[0].description.as_deref(), Some("github o/m"));
        assert_eq!(markets[0].source, Some(Source::Project));
        assert!(list(
            "claude",
            &Scope::Project {
                path: "relative".into()
            },
            cfg.path()
        )
        .is_err());
        assert!(list("gemini", &account(), cfg.path()).is_err());
    }

    #[test]
    fn native_workbench_services_extensions_lists_nothing_for_codex() {
        let codex = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        write(
            &codex.path().join("rules/default.rules"),
            "prefix_rule(pattern=[\"bd\"], decision=\"allow\")\n",
        );
        write(&project.path().join(".codex/hooks.json"), r#"{"hooks":{}}"#);
        assert_eq!(list("codex", &account(), codex.path()).unwrap(), []);
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        assert_eq!(list("codex", &scope, codex.path()).unwrap(), []);
        assert!(list(
            "codex",
            &Scope::Project {
                path: "relative".into()
            },
            codex.path()
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
