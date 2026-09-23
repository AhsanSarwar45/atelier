//! The plugins a reader browses, and what one click installs (bw-6ecp.7).
//!
//! Installing one meant knowing both halves of `name@marketplace` and having
//! added the marketplace first, which is a thing you can only do if you already
//! know what is in it. So this reads the marketplaces themselves and lists what
//! they offer: the account's own, from the copies Claude keeps on disk, and the
//! ones Anthropic publishes, fetched so they are there before anybody has added
//! anything at all.
//!
//! A marketplace is a `.claude-plugin/marketplace.json` — `name`, `owner`, and a
//! `plugins` array whose entries carry `name`, `description`, `category`,
//! `version` and the rest. That file is the whole source here; nothing is
//! guessed about a plugin that its own marketplace does not say.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// How long to wait on a published marketplace before listing without it.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(8);

/// The marketplaces Anthropic publishes, known without anybody typing them in.
///
/// Claude Code adds the first of these itself the first time it is run
/// interactively; the others are its community directory and its own demo
/// marketplace. Listing them here only means they can be BROWSED before they
/// are added — installing from one still adds it through Claude's own CLI.
pub const PUBLISHED: [&str; 3] = [
    "anthropics/claude-plugins-official",
    "anthropics/claude-plugins-community",
    "anthropics/claude-code",
];

/// Where a marketplace's manifest is fetched from, given `owner/repo`.
fn manifest_url(repo: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/HEAD/.claude-plugin/marketplace.json")
}

/// One plugin as the catalogue screen draws it, and as Install uses it.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offered {
    /// `name@marketplace`, which is what `plugin install` is given.
    pub id: String,
    pub name: String,
    /// What the marketplace calls it for a reader: `displayName`, else `name`.
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub category: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub version: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub author: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub homepage: String,
    pub marketplace: String,
    /// The `owner/repo` the marketplace was added from, when that is known.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub origin: String,
    /// The account has this marketplace already, so installing does not add it.
    pub known: bool,
    /// The account has this plugin already.
    pub installed: bool,
}

/// One shelf, and how many plugins are on it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Shelf {
    pub id: String,
    pub count: usize,
}

/// What the screen is shown: the plugins, the shelves, the marketplaces they
/// came from, and any that could not be read.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<Offered>,
    pub categories: Vec<Shelf>,
    pub marketplaces: Vec<Shelf>,
    /// A marketplace that was not read, and why, for a screen that must not
    /// quietly list less than it says it lists.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unreachable: Vec<String>,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// A person's name out of the `owner` or `author` object, or the plain string
/// some marketplaces put there instead.
fn person(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(name)) => name.trim().to_string(),
        Some(Value::Object(object)) => text(object.get("name")),
        _ => String::new(),
    }
}

fn words(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|w| w.as_str()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Every plugin one manifest offers.
///
/// A plugin with no name cannot be installed by name, so it is not offered: an
/// Install button on it would have nothing to pass to the CLI.
pub fn from_manifest(manifest: &Value, origin: &str, known: bool, installed: &HashSet<String>) -> Vec<Offered> {
    let market = text(manifest.get("name"));
    if market.is_empty() {
        return Vec::new();
    }
    let owner = person(manifest.get("owner"));
    manifest
        .get("plugins")
        .and_then(Value::as_array)
        .map(|list| list.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let name = text(entry.get("name"));
            if name.is_empty() {
                return None;
            }
            let id = format!("{name}@{market}");
            let title = match text(entry.get("displayName")) {
                shown if shown.is_empty() => name.clone(),
                shown => shown,
            };
            let author = match person(entry.get("author")) {
                who if who.is_empty() => owner.clone(),
                who => who,
            };
            let mut keywords = words(entry.get("keywords"));
            keywords.extend(words(entry.get("tags")));
            Some(Offered {
                installed: installed.contains(&id),
                id,
                name,
                title,
                description: text(entry.get("description")),
                category: text(entry.get("category")),
                keywords,
                version: text(entry.get("version")),
                author,
                homepage: text(entry.get("homepage")),
                marketplace: market.clone(),
                origin: origin.to_string(),
                known,
            })
        })
        .collect()
}

/// The marketplaces this account has, as name → (where its copy is, where it
/// was added from).
fn known_marketplaces(account_dir: &Path) -> HashMap<String, (PathBuf, String)> {
    let file = read_json(&account_dir.join("plugins/known_marketplaces.json"));
    let Some(Value::Object(object)) = file else {
        return HashMap::new();
    };
    object
        .iter()
        .map(|(name, entry)| {
            let source = entry.get("source");
            let origin = ["repo", "url", "path"]
                .iter()
                .find_map(|key| source.and_then(|s| s.get(*key)).and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            let place = text(entry.get("installLocation"));
            let path = if place.is_empty() {
                account_dir.join("plugins/marketplaces").join(name)
            } else {
                PathBuf::from(place)
            };
            (name.clone(), (path, origin))
        })
        .collect()
}

/// The ids of the plugins this account has installed, as `name@marketplace`.
fn installed_ids(account_dir: &Path) -> HashSet<String> {
    let file = read_json(&account_dir.join("plugins/installed_plugins.json"));
    match file.as_ref().and_then(|f| f.get("plugins")) {
        Some(Value::Object(object)) => object.keys().cloned().collect(),
        _ => HashSet::new(),
    }
}

fn shelves<F: Fn(&Offered) -> &str>(entries: &[Offered], of: F) -> Vec<Shelf> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        let id = of(entry);
        if !id.is_empty() {
            *counts.entry(id).or_default() += 1;
        }
    }
    let mut shelves: Vec<Shelf> = counts
        .into_iter()
        .map(|(id, count)| Shelf {
            id: id.to_string(),
            count,
        })
        .collect();
    shelves.sort_by(|a, b| b.count.cmp(&a.count).then(a.id.cmp(&b.id)));
    shelves
}

/// Everything the account can install: its own marketplaces read off disk, and
/// the published ones fetched.
pub async fn browse(account_dir: &Path) -> Listing {
    let installed = installed_ids(account_dir);
    let known = known_marketplaces(account_dir);
    let mut entries: Vec<Offered> = Vec::new();
    let mut unreachable: Vec<String> = Vec::new();
    let mut origins: HashSet<String> = HashSet::new();

    for (name, (path, origin)) in &known {
        origins.insert(origin.to_ascii_lowercase());
        let manifest = read_json(&path.join(".claude-plugin/marketplace.json"));
        match manifest {
            Some(manifest) => entries.extend(from_manifest(&manifest, origin, true, &installed)),
            // Added but never fetched, or fetched somewhere this cannot see.
            None => unreachable.push(format!("{name} has no copy on this computer yet")),
        }
    }

    for repo in PUBLISHED {
        if origins.contains(&repo.to_ascii_lowercase()) {
            continue;
        }
        match fetch(repo).await {
            Ok(manifest) => entries.extend(from_manifest(&manifest, repo, false, &installed)),
            Err(why) => unreachable.push(format!("{repo} could not be read: {why}")),
        }
    }

    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    entries.dedup_by(|a, b| a.id == b.id);
    Listing {
        categories: shelves(&entries, |e| &e.category),
        marketplaces: shelves(&entries, |e| &e.marketplace),
        entries,
        unreachable,
    }
}

async fn fetch(repo: &str) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(PATIENCE)
        .build()
        .map_err(|e| e.to_string())?;
    client
        .get(manifest_url(repo))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string(value).unwrap()).unwrap();
    }

    #[test]
    fn native_workbench_plugin_catalogue_reads_a_manifest_as_offers() {
        let manifest = json!({
            "name": "acme",
            "owner": {"name": "Acme"},
            "plugins": [
                {"name": "formatter", "displayName": "Code Formatter", "description": "Formats", "category": "productivity", "version": "2.1.0", "tags": ["style"]},
                {"name": "deploy"},
                {"description": "nameless, so not offered"}
            ]
        });
        let installed = HashSet::from(["deploy@acme".to_string()]);
        let offers = from_manifest(&manifest, "acme/tools", true, &installed);
        assert_eq!(offers.len(), 2, "the nameless entry is not offered");
        assert_eq!(offers[0].id, "formatter@acme");
        assert_eq!(offers[0].title, "Code Formatter");
        assert_eq!(offers[0].category, "productivity");
        assert_eq!(offers[0].keywords, vec!["style".to_string()]);
        // No author of its own, so the marketplace's owner answers for it.
        assert_eq!(offers[0].author, "Acme");
        assert!(!offers[0].installed);
        // No displayName, and already installed.
        assert_eq!(offers[1].title, "deploy");
        assert!(offers[1].installed);
    }

    #[tokio::test]
    async fn native_workbench_plugin_catalogue_lists_the_accounts_own_marketplaces() {
        let root = tempfile::tempdir().unwrap();
        let account = root.path();
        let copy = account.join("plugins/marketplaces/acme");
        write(
            &account.join("plugins/known_marketplaces.json"),
            &json!({"acme": {"source": {"source": "github", "repo": "acme/tools"}}}),
        );
        write(
            &account.join("plugins/installed_plugins.json"),
            &json!({"plugins": {"deploy@acme": [{"scope": "user"}]}}),
        );
        write(
            &copy.join(".claude-plugin/marketplace.json"),
            &json!({
                "name": "acme",
                "owner": {"name": "Acme"},
                "plugins": [
                    {"name": "formatter", "category": "productivity"},
                    {"name": "deploy", "category": "devops"}
                ]
            }),
        );

        let listing = browse(account).await;
        let mine: Vec<&Offered> = listing
            .entries
            .iter()
            .filter(|e| e.marketplace == "acme")
            .collect();
        assert_eq!(mine.len(), 2);
        assert!(mine.iter().all(|e| e.known), "it is already on the account");
        assert!(mine.iter().any(|e| e.id == "deploy@acme" && e.installed));
        // The shelves count what is actually offered.
        assert!(listing
            .categories
            .iter()
            .any(|s| s.id == "productivity" && s.count >= 1));
        assert!(listing.marketplaces.iter().any(|s| s.id == "acme"));
    }
}
