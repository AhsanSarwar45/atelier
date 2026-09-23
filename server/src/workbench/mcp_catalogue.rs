//! The catalogue of MCP servers a reader browses, and what one click adds
//! (bw-6ecp.6).
//!
//! Adding a server meant knowing the package name and the flags it wants, which
//! is fine for somebody who already read the server's README and no use at all
//! to somebody who only knows they want Notion. Two sources answer that, and
//! neither answers it alone:
//!
//!  - The official MCP registry (`registry.modelcontextprotocol.io`) is what is
//!    published: over six thousand servers, searchable, each saying which npm or
//!    PyPI package or remote endpoint actually starts it. It has no categories,
//!    no icons and no editing: every server anyone pushed is in it.
//!  - Docker's MCP catalogue is curated: a few hundred servers somebody put in a
//!    category, gave an icon and wrote a line about.
//!
//! So: browsing is the curated set, bundled with the binary so it is there
//! without a network; searching goes to the registry live, and what comes back
//! is given the curated set's category and icon wherever the two name the same
//! repository. `scripts/build-mcp-catalogue.mjs` builds the bundled half.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const BUNDLED: &str = include_str!("../../assets/mcp-catalogue.json");

/// How long to wait on the registry before answering from the bundled half.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(8);

const REGISTRY: &str = "https://registry.modelcontextprotocol.io/v0/servers";

/// A variable the reader has to supply before the server will start.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Need {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// One server as the catalogue screen draws it, and as Add uses it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The name the server is added under, unless the reader changes it.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Its name in the official registry, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_name: Option<String>,
    #[serde(default)]
    pub needs: Vec<Need>,
    /// `stdio` or `http`.
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Fixed values the server is started with, beyond what the reader supplies.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    /// It runs as a container, so the reader needs Docker for it to start.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub container: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bundled {
    #[serde(default)]
    built_at: String,
    entries: Vec<Entry>,
}

/// One category and how many of the curated servers are in it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Category {
    pub id: String,
    pub count: usize,
}

/// What the screen is shown: the rows, the shelves, and where the rows came from.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub categories: Vec<Category>,
    /// `curated`, `registry`, or `curated-only` when the registry could not be reached.
    pub source: &'static str,
    /// Why the registry was not used, for a screen that must not lie about it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable: Option<String>,
}

fn bundled() -> &'static Bundled {
    static ONCE: OnceLock<Bundled> = OnceLock::new();
    ONCE.get_or_init(|| serde_json::from_str(BUNDLED).expect("the bundled catalogue is built by scripts/build-mcp-catalogue.mjs and checked in"))
}

/// The shelves, largest first, so the browser opens on something worth reading.
fn categories(entries: &[Entry]) -> Vec<Category> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        if !entry.category.is_empty() {
            *counts.entry(entry.category.as_str()).or_default() += 1;
        }
    }
    let mut shelves: Vec<Category> = counts
        .into_iter()
        .map(|(id, count)| Category {
            id: id.to_string(),
            count,
        })
        .collect();
    shelves.sort_by(|a, b| b.count.cmp(&a.count).then(a.id.cmp(&b.id)));
    shelves
}

/// A repository URL as a key both sources agree on: host and path, nothing else.
fn repo_key(url: &str) -> Option<String> {
    let at = url
        .trim()
        .trim_end_matches(".git")
        .trim_start_matches("git+")
        .to_ascii_lowercase();
    let at = at
        .strip_prefix("https://")
        .or_else(|| at.strip_prefix("http://"))
        .unwrap_or(&at);
    let parts: Vec<&str> = at.split('/').filter(|p| !p.is_empty()).collect();
    (parts.len() >= 3).then(|| format!("{}/{}/{}", parts[0], parts[1], parts[2]))
}

/// The curated set, filtered to what the reader typed.
fn curated(search: &str) -> Vec<Entry> {
    let want = search.trim().to_ascii_lowercase();
    bundled()
        .entries
        .iter()
        .filter(|entry| {
            want.is_empty()
                || entry.id.to_ascii_lowercase().contains(&want)
                || entry.title.to_ascii_lowercase().contains(&want)
                || entry.description.to_ascii_lowercase().contains(&want)
        })
        .cloned()
        .collect()
}

/// One registry row, turned into a row the screen can draw and Add can use.
///
/// A published server that says nothing about how it is started is dropped: an
/// Add button on it would do nothing, which is worse than not offering it.
pub fn from_registry(server: &Value, curated_by_repo: &HashMap<String, &Entry>) -> Option<Entry> {
    let name = server.get("name")?.as_str()?.to_string();
    let repository = server
        .get("repository")
        .and_then(|r| r.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let known = repository
        .as_deref()
        .and_then(repo_key)
        .and_then(|key| curated_by_repo.get(&key).copied());
    let mut entry = Entry {
        // The wire name is `io.github.owner/thing`; a server is added under a
        // short name, and the last word of it is what the reader would type.
        id: known
            .map(|k| k.id.clone())
            .unwrap_or_else(|| short_name(&name)),
        title: server
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| known.map(|k| k.title.clone()))
            .unwrap_or_else(|| short_name(&name)),
        description: server
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        category: known.map(|k| k.category.clone()).unwrap_or_default(),
        icon: known.and_then(|k| k.icon.clone()),
        repository,
        registry_name: Some(name),
        ..Entry::default()
    };

    for package in server
        .get("packages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = package.get("registryType").and_then(Value::as_str);
        let identifier = package.get("identifier").and_then(Value::as_str);
        let (Some(kind), Some(identifier)) = (kind, identifier) else {
            continue;
        };
        let runtime: Vec<String> = package
            .get("runtimeArguments")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(|a| a.get("value").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let runner = match kind {
            "npm" => "npx",
            "pypi" => "uvx",
            _ => continue,
        };
        entry.transport = "stdio".to_string();
        entry.command = Some(runner.to_string());
        entry.args = if runner == "npx" {
            let mut args = vec!["-y".to_string()];
            args.extend(runtime);
            args.push(identifier.to_string());
            args
        } else {
            let mut args = runtime;
            args.push(identifier.to_string());
            args
        };
        entry.needs = package
            .get("environmentVariables")
            .and_then(Value::as_array)
            .map(|vars| {
                vars.iter()
                    .filter(|v| v.get("isRequired").and_then(Value::as_bool) == Some(true))
                    .filter_map(|v| {
                        Some(Need {
                            name: v.get("name")?.as_str()?.to_string(),
                            description: v
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        break;
    }

    if entry.command.is_none() {
        let remote = server
            .get("remotes")
            .and_then(Value::as_array)
            .and_then(|r| r.first())
            .and_then(|r| r.get("url"))
            .and_then(Value::as_str);
        match remote {
            Some(url) => {
                entry.transport = "http".to_string();
                entry.url = Some(url.to_string());
            }
            // Nothing runnable here, and the curated half may know the same
            // server as a container even when the registry does not.
            None => return known.cloned(),
        }
    }
    Some(entry)
}

/// `io.github.owner/chrome-devtools` is added as `chrome-devtools`.
fn short_name(name: &str) -> String {
    name.rsplit(['/', '.']).next().unwrap_or(name).to_string()
}

/// The catalogue, for a search or for browsing.
pub async fn browse(search: Option<&str>) -> Listing {
    let search = search.unwrap_or("").trim();
    if search.is_empty() {
        let entries = curated("");
        return Listing {
            categories: categories(&entries),
            entries,
            source: "curated",
            unreachable: None,
        };
    }
    let shelves = categories(&bundled().entries);
    match search_registry(search).await {
        Ok(entries) => Listing {
            entries,
            categories: shelves,
            source: "registry",
            unreachable: None,
        },
        Err(why) => Listing {
            entries: curated(search),
            categories: shelves,
            source: "curated-only",
            unreachable: Some(why),
        },
    }
}

async fn search_registry(search: &str) -> Result<Vec<Entry>, String> {
    let by_repo: HashMap<String, &Entry> = bundled()
        .entries
        .iter()
        .filter_map(|entry| Some((repo_key(entry.repository.as_deref()?)?, entry)))
        .collect();
    let client = reqwest::Client::builder()
        .timeout(PATIENCE)
        .build()
        .map_err(|e| e.to_string())?;
    let body: Value = client
        .get(REGISTRY)
        .query(&[("version", "latest"), ("limit", "50"), ("search", search)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for row in body
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(server) = row.get("server") else {
            continue;
        };
        // Two published servers can shorten to the same name — the reader would
        // see the same row twice and have no way to tell which Add was which.
        if let Some(entry) = from_registry(server, &by_repo) {
            if !entries.iter().any(|e: &Entry| e.id == entry.id) {
                entries.push(entry);
            }
        }
    }
    // What the curated half knows and the registry does not, so a search for
    // `notion` still finds the one somebody wrote a line about.
    let seen: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
    for entry in curated(search) {
        if !seen.contains(&entry.id) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// What starts a server, as a key two spellings of the same server agree on.
///
/// A server in a settings file is a command line and nothing else — no name,
/// no description, no icon, because `.claude.json` and `config.toml` hold none
/// of those. What it does hold is enough to say WHICH server it is: the npm
/// package `npx` is told to fetch, the image `docker run` is told to start, the
/// host a remote one is called at. That is what this reduces a launch to, so a
/// server already on an account can be matched back to its catalogue record
/// (bw-6ecp.16).
pub fn launch_key(command: Option<&str>, args: &[String], url: Option<&str>) -> Option<String> {
    if let Some(url) = url.map(str::trim).filter(|u| !u.is_empty()) {
        let at = url.to_ascii_lowercase();
        let at = at
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(at.as_str());
        return at.split('/').next().filter(|h| !h.is_empty()).map(str::to_string);
    }
    let program = command?.trim().rsplit('/').next()?.to_ascii_lowercase();
    // A runner is told what to run; anything else IS what runs, and its own
    // path says nothing a second copy of it would agree on.
    if !matches!(
        program.trim_end_matches(".exe"),
        "npx" | "uvx" | "pipx" | "bunx" | "pnpx" | "docker" | "podman"
    ) {
        return None;
    }
    let mut rest = args.iter().map(String::as_str);
    let mut word = rest.next();
    while let Some(token) = word {
        let skip_value = matches!(token, "-e" | "--env" | "-v" | "--volume" | "-p" | "--publish" | "--name" | "--from");
        let is_flag = token.starts_with('-');
        let is_verb = matches!(token, "run" | "exec" | "create");
        if skip_value {
            rest.next();
            word = rest.next();
        } else if is_flag || is_verb {
            word = rest.next();
        } else {
            // `mcp/duckduckgo:latest` and `mcp/duckduckgo` are one server.
            let name = token.rsplit_once(':').map_or(token, |(name, _)| name);
            return Some(name.to_ascii_lowercase());
        }
    }
    None
}

/// The curated set by what starts each of them.
fn by_launch() -> &'static HashMap<String, Entry> {
    static ONCE: OnceLock<HashMap<String, Entry>> = OnceLock::new();
    ONCE.get_or_init(|| {
        let mut index = HashMap::new();
        for entry in &bundled().entries {
            if let Some(key) = launch_key(entry.command.as_deref(), &entry.args, entry.url.as_deref()) {
                index.entry(key).or_insert_with(|| entry.clone());
            }
        }
        index
    })
}

/// The catalogue's record for a server already on an account, matched by what
/// starts it. `None` when the catalogue has never heard of it.
pub fn identify(command: Option<&str>, args: &[String], url: Option<&str>) -> Option<&'static Entry> {
    by_launch().get(&launch_key(command, args, url)?)
}

/// The entry as the provider's own config, ready for `mcp.add`.
///
/// Claude names the kind of server in the entry and Codex does not, which is the
/// one difference between the two files (`mcp_servers.rs` writes both).
pub fn config(brand: &str, entry: &Entry, supplied: &Map<String, Value>) -> Map<String, Value> {
    let mut config = Map::new();
    if entry.transport == "http" {
        if brand == "claude" {
            config.insert("type".to_string(), json!("http"));
        }
        config.insert("url".to_string(), json!(entry.url.clone().unwrap_or_default()));
    } else {
        if brand == "claude" {
            config.insert("type".to_string(), json!("stdio"));
        }
        config.insert(
            "command".to_string(),
            json!(entry.command.clone().unwrap_or_default()),
        );
        config.insert("args".to_string(), json!(entry.args));
    }
    let mut env: Map<String, Value> = entry
        .env
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    for (name, value) in supplied {
        if value.as_str().is_some_and(|v| !v.trim().is_empty()) {
            env.insert(name.clone(), value.clone());
        }
    }
    if !env.is_empty() {
        config.insert("env".to_string(), Value::Object(env));
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_workbench_catalogue_matches_a_running_server_back_to_its_record() {
        // A command line exactly as a settings file holds it.
        let args = ["run", "-i", "--rm", "mcp/duckduckgo"].map(String::from);
        let found = identify(Some("docker"), &args, None).expect("the bundled set has it");
        assert_eq!(found.id, "duckduckgo");
        // The same server, pinned to a tag and started by a full path.
        let tagged = ["run", "-i", "--rm", "-e", "NOISE=1", "mcp/duckduckgo:latest"].map(String::from);
        assert_eq!(
            identify(Some("/usr/bin/docker"), &tagged, None).map(|e| e.id.as_str()),
            Some("duckduckgo")
        );
        // A remote server is matched on the host it is called at.
        assert_eq!(
            launch_key(None, &[], Some("https://mcp.example.com/v1/sse")).as_deref(),
            Some("mcp.example.com")
        );
        // Something the catalogue has never heard of stays unnamed rather than
        // wearing somebody else's icon.
        let mine = ["./my-server.py".to_string()];
        assert!(identify(Some("python3"), &mine, None).is_none());
        assert!(identify(Some("npx"), &["-y".to_string(), "@nobody/nothing".to_string()], None).is_none());
    }

    #[test]
    fn native_workbench_catalogue_is_categorised_and_runnable() {
        let it = bundled();
        assert!(it.entries.len() > 100, "{} entries", it.entries.len());
        assert!(!it.built_at.is_empty());
        for entry in &it.entries {
            assert!(!entry.id.is_empty());
            assert!(!entry.title.is_empty());
            assert!(!entry.category.is_empty(), "{} has no category", entry.id);
            // Every row must be addable, or its Add button is a lie.
            match entry.transport.as_str() {
                "stdio" => assert!(entry.command.is_some(), "{} has no command", entry.id),
                "http" => assert!(entry.url.is_some(), "{} has no url", entry.id),
                other => panic!("{} has transport {other}", entry.id),
            }
        }
        let shelves = categories(&it.entries);
        assert!(shelves.len() > 4);
        assert!(shelves[0].count >= shelves[1].count);
    }

    #[test]
    fn native_workbench_catalogue_writes_each_brand_own_config() {
        let entry = Entry {
            id: "notion".to_string(),
            transport: "stdio".to_string(),
            command: Some("docker".to_string()),
            args: vec!["run".to_string(), "-i".to_string()],
            env: HashMap::from([("FIXED".to_string(), "1".to_string())]),
            ..Entry::default()
        };
        let mut supplied = Map::new();
        supplied.insert("TOKEN".to_string(), json!("ntn_x"));
        supplied.insert("BLANK".to_string(), json!("  "));

        let claude = config("claude", &entry, &supplied);
        assert_eq!(claude["type"], json!("stdio"));
        assert_eq!(claude["command"], json!("docker"));
        assert_eq!(claude["env"]["TOKEN"], json!("ntn_x"));
        assert_eq!(claude["env"]["FIXED"], json!("1"));
        // A box the reader left empty is not written as an empty variable.
        assert!(claude["env"].get("BLANK").is_none());

        // Codex's file has no `type`; everything else is the same.
        let codex = config("codex", &entry, &supplied);
        assert!(codex.get("type").is_none());
        assert_eq!(codex["command"], json!("docker"));

        let remote = Entry {
            transport: "http".to_string(),
            url: Some("https://x.test/mcp".to_string()),
            ..Entry::default()
        };
        assert_eq!(
            config("claude", &remote, &Map::new())["url"],
            json!("https://x.test/mcp")
        );
    }

    #[test]
    fn native_workbench_catalogue_reads_a_registry_row() {
        let curated = HashMap::new();
        let npm = json!({
            "name": "io.github.owner/chrome-devtools",
            "description": "Drives Chrome.",
            "repository": {"url": "https://github.com/owner/chrome-devtools"},
            "packages": [{
                "registryType": "npm",
                "identifier": "chrome-devtools-mcp",
                "environmentVariables": [
                    {"name": "TOKEN", "isRequired": true, "description": "A token."},
                    {"name": "MAYBE", "isRequired": false}
                ]
            }]
        });
        let entry = from_registry(&npm, &curated).unwrap();
        assert_eq!(entry.id, "chrome-devtools");
        assert_eq!(entry.command.as_deref(), Some("npx"));
        assert_eq!(entry.args, ["-y", "chrome-devtools-mcp"]);
        assert_eq!(entry.needs, [Need { name: "TOKEN".to_string(), description: "A token.".to_string() }]);

        // A row with nothing runnable and nothing curated to fall back on is
        // not offered at all.
        let bare = json!({"name": "io.github.owner/nothing"});
        assert!(from_registry(&bare, &curated).is_none());

        // …and one the curated half knows keeps that half's icon and shelf.
        let known = Entry {
            id: "notion".to_string(),
            title: "Notion".to_string(),
            category: "productivity".to_string(),
            icon: Some("https://x.test/i.png".to_string()),
            repository: Some("https://github.com/makenotion/notion-mcp-server".to_string()),
            transport: "stdio".to_string(),
            command: Some("docker".to_string()),
            ..Entry::default()
        };
        let by_repo = HashMap::from([(
            "github.com/makenotion/notion-mcp-server".to_string(),
            &known,
        )]);
        let row = json!({
            "name": "io.github.makenotion/notion-mcp-server",
            "repository": {"url": "https://github.com/makenotion/notion-mcp-server"},
            "remotes": [{"type": "streamable-http", "url": "https://mcp.notion.com/mcp"}]
        });
        let entry = from_registry(&row, &by_repo).unwrap();
        assert_eq!(entry.id, "notion");
        assert_eq!(entry.category, "productivity");
        assert_eq!(entry.icon.as_deref(), Some("https://x.test/i.png"));
        assert_eq!(entry.url.as_deref(), Some("https://mcp.notion.com/mcp"));
    }
}
