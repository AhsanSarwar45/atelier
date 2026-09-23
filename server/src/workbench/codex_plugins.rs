//! Codex's plugins and the marketplaces they come from (bw-anxb.1).
//!
//! Codex keeps no install record of its own that a file read could trust: a
//! plugin from the remote catalogue is installed on the ChatGPT account, and
//! only its CLI asks. So the lists are its CLI's own answers —
//! `codex plugin list --json` and `codex plugin marketplace list --json` — and
//! the moves are its CLI's verbs, `plugin add`, `plugin remove` and
//! `plugin marketplace add|remove`. The one thing it has no verb for is
//! switching a plugin off: that is `[plugins."id"] enabled` in `config.toml`,
//! written here the way Codex itself writes it.
//!
//! The CLI's lists name a plugin and little else. What a reader is shown about
//! one — its title, what it does, its shelf — is read from where Codex keeps
//! that: the remote catalogue it caches under `cache/remote_plugin_catalog`,
//! each local marketplace's `marketplace.json`, and a plugin's own
//! `.codex-plugin/plugin.json`. See docs/research/codex-plugins.md.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use toml_edit::{value, DocumentMut, Item as TomlItem, Table};

use super::extensions::{self, Item, Kind, KindList, Source};
use super::plugin_catalogue::{shelves, Listing, Offered};
use super::provider_settings;

/// The variable that points `codex` at one account's home.
pub const HOME_VARIABLE: &str = "CODEX_HOME";

/// What a reader is told about one plugin, from wherever Codex keeps it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct About {
    pub title: String,
    pub description: String,
    pub category: String,
    pub keywords: Vec<String>,
    pub author: String,
    pub homepage: String,
    /// The catalogue shows it to everybody; an unlisted one is only reached
    /// by a link, so it is not put on a shelf.
    pub listed: bool,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn first(choices: &[String]) -> String {
    choices
        .iter()
        .find(|choice| !choice.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn words(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// A plugin's own `.codex-plugin/plugin.json`, in the shape a reader is shown.
pub fn about_manifest(manifest: &Value) -> About {
    let face = manifest.get("interface");
    let field = |key: &str| text(face.and_then(|f| f.get(key)));
    let author = match manifest.get("author") {
        Some(Value::String(name)) => name.trim().to_string(),
        Some(Value::Object(who)) => text(who.get("name")),
        _ => String::new(),
    };
    About {
        title: field("displayName"),
        description: first(&[field("shortDescription"), text(manifest.get("description"))]),
        category: field("category"),
        keywords: words(manifest.get("keywords")),
        author: first(&[author, field("developerName")]),
        homepage: first(&[field("websiteURL"), text(manifest.get("homepage"))]),
        listed: true,
    }
}

/// The remote catalogue Codex caches, as `name@openai-curated-remote` → what
/// it says. When there is more than one cache, the newest fetch wins.
pub fn remote_catalogue(home: &Path) -> HashMap<String, About> {
    let mut caches: Vec<(String, Value)> = fs::read_dir(home.join("cache/remote_plugin_catalog"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| read_json(&entry.path()))
        .map(|cache| (text(cache.get("fetched_at")), cache))
        .collect();
    caches.sort_by(|a, b| a.0.cmp(&b.0));
    let mut found = HashMap::new();
    for (_, cache) in caches {
        for plugin in cache.get("plugins").and_then(Value::as_array).into_iter().flatten() {
            let name = text(plugin.get("name"));
            if name.is_empty() {
                continue;
            }
            let release = plugin.get("release");
            let face = release.and_then(|r| r.get("interface"));
            let field = |key: &str| text(face.and_then(|f| f.get(key)));
            found.insert(
                format!("{name}@openai-curated-remote"),
                About {
                    title: text(release.and_then(|r| r.get("display_name"))),
                    description: first(&[
                        field("short_description"),
                        text(release.and_then(|r| r.get("description"))),
                    ]),
                    category: field("category"),
                    keywords: words(release.and_then(|r| r.get("keywords"))),
                    author: first(&[field("developer_name"), text(plugin.get("creator_name"))]),
                    homepage: field("website_url"),
                    listed: text(plugin.get("discoverability")) != "UNLISTED",
                },
            );
        }
    }
    found
}

/// The marketplace file at a marketplace root, whichever of the names Codex
/// reads it is under.
fn marketplace_manifest(root: &Path) -> Option<Value> {
    [
        ".agents/plugins/marketplace.json",
        ".agents/plugins/api_marketplace.json",
        ".claude-plugin/marketplace.json",
    ]
    .iter()
    .find_map(|file| read_json(&root.join(file)))
}

/// What each local marketplace says of its plugins, as `name@marketplace`,
/// with each plugin's own manifest filling in what the marketplace leaves out.
pub fn local_catalogue(roots: &[(String, PathBuf)]) -> HashMap<String, About> {
    let mut found = HashMap::new();
    for (market, root) in roots {
        let Some(manifest) = marketplace_manifest(root) else {
            continue;
        };
        let market = match text(manifest.get("name")) {
            named if named.is_empty() => market.clone(),
            named => named,
        };
        for entry in manifest.get("plugins").and_then(Value::as_array).into_iter().flatten() {
            let name = text(entry.get("name"));
            if name.is_empty() {
                continue;
            }
            let place = match entry.get("source") {
                Some(Value::String(path)) => path.clone(),
                Some(source) => text(source.get("path")),
                None => String::new(),
            };
            let mut about = if place.is_empty() {
                About::default()
            } else {
                read_json(&root.join(&place).join(".codex-plugin/plugin.json"))
                    .map(|own| about_manifest(&own))
                    .unwrap_or_default()
            };
            about.listed = true;
            if about.description.is_empty() {
                about.description = text(entry.get("description"));
            }
            if about.category.is_empty() {
                about.category = text(entry.get("category"));
            }
            found.insert(format!("{name}@{market}"), about);
        }
    }
    found
}

/// The plugins `codex plugin list --json` reports as installed.
pub fn installed_items(listed: &Value, home: &Path, about: &HashMap<String, About>) -> Vec<Item> {
    let mut items: Vec<Item> = listed
        .get("installed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|plugin| plugin.get("installed").and_then(Value::as_bool) != Some(false))
        .filter_map(|plugin| {
            let id = text(plugin.get("pluginId"));
            let name = text(plugin.get("name"));
            let market = text(plugin.get("marketplaceName"));
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let cache = home.join("plugins/cache").join(&market).join(&name);
            let own = about.get(&id).cloned().or_else(|| {
                let version = text(plugin.get("version"));
                read_json(&cache.join(&version).join(".codex-plugin/plugin.json"))
                    .map(|manifest| about_manifest(&manifest))
            });
            let own = own.unwrap_or_default();
            Some(Item {
                name: if own.title.is_empty() { name } else { own.title },
                description: Some(own.description).filter(|d| !d.is_empty()),
                path: cache,
                enabled: plugin.get("enabled").and_then(Value::as_bool),
                version: Some(text(plugin.get("version"))).filter(|v| !v.is_empty()),
                marketplace: Some(market).filter(|m| !m.is_empty()),
                source: Some(Source::User),
                id,
                ..Item::default()
            })
        })
        .collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

/// The marketplaces `codex plugin marketplace list --json` reports, with the
/// address each was added from as `config.toml` records it. One with no entry
/// there is one Codex ships with, and cannot be removed.
pub fn marketplace_items(listed: &Value, config: &DocumentMut) -> Vec<Item> {
    let added = config.get("marketplaces").and_then(TomlItem::as_table_like);
    let mut items: Vec<Item> = listed
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|market| {
            let name = text(market.get("name"));
            if name.is_empty() {
                return None;
            }
            let entry = added.and_then(|table| table.get(&name));
            let field = |key: &str| {
                entry
                    .and_then(|e| e.get(key))
                    .and_then(TomlItem::as_str)
                    .map(str::to_string)
                    .filter(|s| !s.is_empty())
            };
            let origin = field("source");
            let kind = field("source_type");
            Some(Item {
                id: name.clone(),
                name,
                description: match (&kind, &origin) {
                    (Some(kind), Some(origin)) => Some(format!("{kind} {origin}")),
                    (None, Some(origin)) => Some(origin.clone()),
                    _ => Some("built in".to_string()),
                },
                path: PathBuf::from(text(market.get("root"))),
                source: Some(Source::User),
                removable: entry.is_none().then_some(false),
                origin,
                ..Item::default()
            })
        })
        .collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

/// Every plugin the account could install, for the catalogue screen. What the
/// catalogue will not install (`NOT_AVAILABLE`) or does not list is left out,
/// unless the account already has it.
pub fn catalogue(available: &Value, about: &HashMap<String, About>) -> Listing {
    let mut entries: Vec<Offered> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for group in ["installed", "available"] {
        for plugin in available.get(group).and_then(Value::as_array).into_iter().flatten() {
            let id = text(plugin.get("pluginId"));
            let name = text(plugin.get("name"));
            if id.is_empty() || name.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let installed = plugin.get("installed").and_then(Value::as_bool) == Some(true);
            let own = about.get(&id).cloned().unwrap_or(About {
                listed: true,
                ..About::default()
            });
            let offered = text(plugin.get("installPolicy")) != "NOT_AVAILABLE";
            if !installed && (!offered || !own.listed) {
                continue;
            }
            entries.push(Offered {
                title: if own.title.is_empty() { name.clone() } else { own.title },
                name,
                description: own.description,
                category: own.category,
                keywords: own.keywords,
                version: text(plugin.get("version")),
                author: own.author,
                homepage: own.homepage,
                marketplace: text(plugin.get("marketplaceName")),
                // Every marketplace Codex lists from is one it already has.
                known: true,
                installed,
                id,
                origin: String::new(),
            });
        }
    }
    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Listing {
        categories: shelves(&entries, |e| &e.category),
        marketplaces: shelves(&entries, |e| &e.marketplace),
        entries,
        unreachable: Vec::new(),
    }
}

/// Switch one plugin on or off in `config.toml`, as Codex writes it:
/// `[plugins."id"] enabled = …`, the rest of the file left as it was.
pub fn set_enabled(config: &Path, id: &str, enabled: bool) -> Result<(), String> {
    provider_settings::rewrite_toml(config, |document| {
        let plugins = document
            .entry("plugins")
            .or_insert_with(|| {
                let mut table = Table::new();
                table.set_implicit(true);
                TomlItem::Table(table)
            })
            .as_table_mut()
            .ok_or("plugins in config.toml is not a table, so it was left alone")?;
        let entry = plugins
            .entry(id)
            .or_insert_with(|| TomlItem::Table(Table::new()))
            .as_table_like_mut()
            .ok_or_else(|| format!("plugins.\"{id}\" in config.toml is not a table"))?;
        entry.insert("enabled", value(enabled));
        Ok(())
    })
}

/// The marketplace roots the account has, as name → root, from the CLI's list.
fn roots(markets: &Value) -> Vec<(String, PathBuf)> {
    markets
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|m| (text(m.get("name")), PathBuf::from(text(m.get("root")))))
        .filter(|(name, root)| !name.is_empty() && !root.as_os_str().is_empty())
        .collect()
}

fn about_everything(home: &Path, markets: &Value) -> HashMap<String, About> {
    let mut about = remote_catalogue(home);
    about.extend(local_catalogue(&roots(markets)));
    about
}

/// The account's plugins and marketplaces, as its CLI reports them.
///
/// `spawn_dir` is `None` for the system account, which runs `codex` with the
/// environment as the server has it; `home` is where that account's files are.
pub async fn list(program: &Path, spawn_dir: Option<&Path>, home: &Path) -> Result<Vec<KindList>, String> {
    let plugins = extensions::run_cli_json(
        program,
        HOME_VARIABLE,
        spawn_dir,
        &["plugin", "list", "--json"],
        extensions::QUICK_CLI,
    )
    .await?;
    let markets = extensions::run_cli_json(
        program,
        HOME_VARIABLE,
        spawn_dir,
        &["plugin", "marketplace", "list", "--json"],
        extensions::QUICK_CLI,
    )
    .await?;
    let config = provider_settings::load_toml(&home.join("config.toml"))?;
    let about = about_everything(home, &markets);
    Ok(vec![
        KindList {
            kind: Kind::Plugins,
            items: installed_items(&plugins, home, &about),
        },
        KindList {
            kind: Kind::Marketplaces,
            items: marketplace_items(&markets, &config),
        },
    ])
}

/// Everything the account could install, as its CLI reports it.
pub async fn browse(program: &Path, spawn_dir: Option<&Path>, home: &Path) -> Result<Listing, String> {
    let available = extensions::run_cli_json(
        program,
        HOME_VARIABLE,
        spawn_dir,
        &["plugin", "list", "--json", "--available"],
        extensions::QUICK_CLI,
    )
    .await?;
    let markets = extensions::run_cli_json(
        program,
        HOME_VARIABLE,
        spawn_dir,
        &["plugin", "marketplace", "list", "--json"],
        extensions::QUICK_CLI,
    )
    .await?;
    Ok(catalogue(&available, &about_everything(home, &markets)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_string(value).unwrap()).unwrap();
    }

    #[test]
    fn installed_plugins_are_named_and_described_from_what_codex_keeps() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join("cache/remote_plugin_catalog/abc.json"),
            &json!({"fetched_at": "2026-09-23", "plugins": [{
                "name": "gmail", "discoverability": "LISTED",
                "release": {"display_name": "Gmail", "description": "Long",
                    "interface": {"short_description": "Read and manage Gmail", "category": "Communication"}}
            }]}),
        );
        write(
            &home.path().join("plugins/cache/local-market/notes/1.0.0/.codex-plugin/plugin.json"),
            &json!({"name": "notes", "description": "Keeps notes", "interface": {"displayName": "Notes"}}),
        );
        let listed = json!({"installed": [
            {"pluginId": "gmail@openai-curated-remote", "name": "gmail", "marketplaceName": "openai-curated-remote",
             "version": "0.1.10", "installed": true, "enabled": false},
            {"pluginId": "notes@local-market", "name": "notes", "marketplaceName": "local-market",
             "version": "1.0.0", "installed": true, "enabled": true},
        ]});
        let about = remote_catalogue(home.path());
        let items = installed_items(&listed, home.path(), &about);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "gmail@openai-curated-remote");
        assert_eq!(items[0].name, "Gmail");
        assert_eq!(items[0].description.as_deref(), Some("Read and manage Gmail"));
        assert_eq!(items[0].enabled, Some(false));
        assert_eq!(items[0].marketplace.as_deref(), Some("openai-curated-remote"));
        assert_eq!(items[1].name, "Notes");
        assert_eq!(items[1].description.as_deref(), Some("Keeps notes"));
        assert_eq!(items[1].enabled, Some(true));
        assert_eq!(items[1].version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn a_marketplace_codex_ships_with_cannot_be_removed_and_an_added_one_keeps_its_address() {
        let listed = json!({"marketplaces": [
            {"name": "openai-curated", "root": "/home/me/.codex/.tmp/plugins"},
            {"name": "debug", "root": "/home/me/.codex/.tmp/marketplaces/debug"},
        ]});
        let config: DocumentMut = "[marketplaces.debug]\nsource_type = \"git\"\nsource = \"owner/repo\"\n"
            .parse()
            .unwrap();
        let items = marketplace_items(&listed, &config);
        assert_eq!(items[0].id, "debug");
        assert_eq!(items[0].origin.as_deref(), Some("owner/repo"));
        assert_eq!(items[0].description.as_deref(), Some("git owner/repo"));
        assert_eq!(items[0].removable, None);
        assert_eq!(items[1].id, "openai-curated");
        assert_eq!(items[1].origin, None);
        assert_eq!(items[1].removable, Some(false));
    }

    #[test]
    fn the_catalogue_leaves_out_what_cannot_be_installed_or_is_not_listed() {
        let about = HashMap::from([
            (
                "gmail@openai-curated-remote".to_string(),
                About { title: "Gmail".into(), category: "Communication".into(), listed: true, ..About::default() },
            ),
            (
                "secret@openai-curated-remote".to_string(),
                About { title: "Secret".into(), listed: false, ..About::default() },
            ),
            (
                "mine@openai-curated-remote".to_string(),
                About { title: "Mine".into(), listed: false, ..About::default() },
            ),
        ]);
        let available = json!({
            "installed": [{"pluginId": "mine@openai-curated-remote", "name": "mine", "marketplaceName": "openai-curated-remote", "installed": true, "installPolicy": "AVAILABLE"}],
            "available": [
                {"pluginId": "gmail@openai-curated-remote", "name": "gmail", "marketplaceName": "openai-curated-remote", "installed": false, "installPolicy": "AVAILABLE", "version": "0.1.10"},
                {"pluginId": "secret@openai-curated-remote", "name": "secret", "marketplaceName": "openai-curated-remote", "installed": false, "installPolicy": "AVAILABLE"},
                {"pluginId": "blocked@openai-curated-remote", "name": "blocked", "marketplaceName": "openai-curated-remote", "installed": false, "installPolicy": "NOT_AVAILABLE"},
                {"pluginId": "mine@openai-curated-remote", "name": "mine", "marketplaceName": "openai-curated-remote", "installed": true, "installPolicy": "AVAILABLE"},
            ]
        });
        let listing = catalogue(&available, &about);
        let ids: Vec<&str> = listing.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["gmail@openai-curated-remote", "mine@openai-curated-remote"]);
        assert!(listing.entries.iter().all(|e| e.known));
        assert!(listing.entries[1].installed);
        assert_eq!(listing.categories[0].id, "Communication");
    }

    #[test]
    fn local_marketplaces_describe_their_plugins_from_each_plugins_own_manifest() {
        let root = tempfile::tempdir().unwrap();
        write(
            &root.path().join(".agents/plugins/marketplace.json"),
            &json!({"name": "openai-curated", "plugins": [
                {"name": "linear", "source": {"source": "local", "path": "./plugins/linear"}, "category": "Productivity"}
            ]}),
        );
        write(
            &root.path().join("plugins/linear/.codex-plugin/plugin.json"),
            &json!({"name": "linear", "interface": {"displayName": "Linear", "shortDescription": "Issues"}}),
        );
        let about = local_catalogue(&[("openai-curated".into(), root.path().to_path_buf())]);
        let linear = &about["linear@openai-curated"];
        assert_eq!(linear.title, "Linear");
        assert_eq!(linear.description, "Issues");
        assert_eq!(linear.category, "Productivity");
    }

    #[test]
    fn switching_a_plugin_off_writes_the_table_codex_reads_and_keeps_the_rest() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("config.toml");
        fs::write(&config, "# mine\nmodel = \"gpt-5\"\n").unwrap();
        set_enabled(&config, "gmail@openai-curated-remote", false).unwrap();
        let text = fs::read_to_string(&config).unwrap();
        assert!(text.starts_with("# mine\nmodel = \"gpt-5\"\n"), "{text}");
        assert!(text.contains("[plugins.\"gmail@openai-curated-remote\"]\nenabled = false"), "{text}");
        set_enabled(&config, "gmail@openai-curated-remote", true).unwrap();
        let document: DocumentMut = fs::read_to_string(&config).unwrap().parse().unwrap();
        assert_eq!(
            document["plugins"]["gmail@openai-curated-remote"]["enabled"].as_bool(),
            Some(true)
        );
    }
}
