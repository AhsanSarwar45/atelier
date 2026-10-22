//! What a plugin's or an MCP server's own page shows (bw-moh1k).
//!
//! A row in a list has room for a name and one line. Its page has room for the
//! rest: the README, who made it, where it comes from, and for a plugin, what
//! it adds to a chat (commands, skills, agents, hooks, MCP servers, apps).
//!
//! A plugin on this computer is read from its folder: the installed copy, or
//! the marketplace's own copy when it is not installed yet. One that is only
//! in a published marketplace is not on this computer at all, so its README is
//! fetched from GitHub, and what it adds is not known until it is installed.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

/// How long to wait on GitHub for a README before showing the page without it.
const PATIENCE: Duration = Duration::from_secs(8);
/// How long a fetched README is reused before it is asked for again.
const KEEP: Duration = Duration::from_secs(10 * 60);
/// The most of a README a page is sent.
const MAX_README: usize = 256 * 1024;
/// The most entries of one kind a page lists.
const MAX_LISTED: usize = 200;

/// One command, skill, agent or app, by name and what it says it does.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// One MCP server a plugin brings.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundled {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    /// The command line or the address it is reached at.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub target: String,
}

/// What a plugin adds to a chat.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contents {
    pub commands: Vec<Named>,
    pub skills: Vec<Named>,
    pub agents: Vec<Named>,
    /// The events its hooks run on, such as `PreToolUse`.
    pub hooks: Vec<String>,
    pub mcp_servers: Vec<Bundled>,
    pub apps: Vec<Named>,
}

/// A plugin's page.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub id: String,
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// The longer account some manifests give besides the one-line description.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub long_description: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub version: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub author: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub homepage: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub repository: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub privacy_policy: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub terms: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub license: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub category: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub marketplace: String,
    /// The folder it was read from, when it is on this computer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    /// The folder the README's relative links are written against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readme_base: Option<PathBuf>,
    /// What it adds, when its files could be read. `None` is "not known", not
    /// "nothing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contents: Option<Contents>,
    pub installed: bool,
}

/// An MCP server's page: the README of the repository it is published from.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    /// Why there is no README, when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<String>,
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub(crate) fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// A person's name out of an `author` object, or the plain string some
/// manifests put there instead.
pub(crate) fn person(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(name)) => name.trim().to_string(),
        Some(Value::Object(object)) => text(object.get("name")),
        _ => String::new(),
    }
}

/// A repository named as a string or as `{ "url": … }`.
pub(crate) fn repository(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(url)) => url.trim().to_string(),
        Some(Value::Object(object)) => text(object.get("url")),
        _ => String::new(),
    }
}

fn words(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The `name` and `description` out of a markdown file's front matter.
fn front_matter(text: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (name, description);
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        match key.trim() {
            "name" => name = value,
            "description" => description = value,
            _ => {}
        }
    }
    (name, description)
}

/// The first line of prose in a markdown file with no front matter.
fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

/// The places a manifest field names, else the conventional folder.
fn places(dir: &Path, field: Option<&Value>, default: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = match field {
        Some(Value::String(one)) => vec![dir.join(one)],
        Some(Value::Array(many)) => many.iter().filter_map(Value::as_str).map(|p| dir.join(p)).collect(),
        _ => Vec::new(),
    };
    let fallback = dir.join(default);
    if !out.contains(&fallback) {
        out.push(fallback);
    }
    out
}

/// Markdown files directly in each place (a place may also be one file).
fn markdown_files(places: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for place in places {
        if place.is_file() {
            out.push(place.clone());
            continue;
        }
        let mut found: Vec<PathBuf> = fs::read_dir(place)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
            .collect();
        found.sort();
        out.extend(found);
    }
    out
}

fn named_markdown(path: &Path) -> Named {
    let body = fs::read_to_string(path).unwrap_or_default();
    let (name, description) = front_matter(&body);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    Named {
        name: if name.is_empty() { stem } else { name },
        description: if description.is_empty() { first_line(&body) } else { description },
    }
}

fn skills(places: &[PathBuf]) -> Vec<Named> {
    let mut out = Vec::new();
    for place in places {
        let mut folders: Vec<PathBuf> = fs::read_dir(place)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.join("SKILL.md").is_file())
            .collect();
        folders.sort();
        for folder in folders {
            let mut one = named_markdown(&folder.join("SKILL.md"));
            if one.name == "SKILL" {
                one.name = folder.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            }
            out.push(one);
        }
    }
    out
}

/// The events a hooks file (or inline hooks object) runs on.
fn hook_events(dir: &Path, field: Option<&Value>) -> Vec<String> {
    let mut sources: Vec<Value> = Vec::new();
    match field {
        Some(Value::Object(_)) => sources.push(field.cloned().unwrap_or_default()),
        Some(Value::String(file)) => sources.extend(read_json(&dir.join(file))),
        Some(Value::Array(many)) => {
            for one in many {
                match one {
                    Value::String(file) => sources.extend(read_json(&dir.join(file))),
                    Value::Object(_) => sources.push(one.clone()),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    sources.extend(read_json(&dir.join("hooks/hooks.json")));
    let mut events: Vec<String> = Vec::new();
    for source in sources {
        let table = source.get("hooks").unwrap_or(&source);
        if let Some(object) = table.as_object() {
            for key in object.keys() {
                if !events.contains(key) {
                    events.push(key.clone());
                }
            }
        }
    }
    events
}

/// The servers in an MCP file or inline object, bare or under `mcpServers`.
fn servers_in(value: &Value) -> Vec<Bundled> {
    let table = value
        .get("mcpServers")
        .or_else(|| value.get("mcp_servers"))
        .unwrap_or(value);
    let Some(object) = table.as_object() else {
        return Vec::new();
    };
    let mut out: Vec<Bundled> = object
        .iter()
        .filter(|(_, config)| config.is_object())
        .map(|(name, config)| {
            let url = text(config.get("url"));
            let command = text(config.get("command"));
            let args = words(config.get("args"));
            let declared = text(config.get("type"));
            let transport = if !declared.is_empty() {
                declared
            } else if !url.is_empty() {
                "http".to_string()
            } else {
                "stdio".to_string()
            };
            let target = if !url.is_empty() {
                url
            } else {
                std::iter::once(command).chain(args).collect::<Vec<_>>().join(" ").trim().to_string()
            };
            Bundled {
                name: name.clone(),
                transport,
                target,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn bundled_servers(dir: &Path, field: Option<&Value>) -> Vec<Bundled> {
    let mut out = Vec::new();
    match field {
        Some(Value::String(file)) => {
            if let Some(value) = read_json(&dir.join(file)) {
                out.extend(servers_in(&value));
            }
        }
        Some(Value::Object(_)) => out.extend(servers_in(field.unwrap())),
        _ => {}
    }
    if let Some(value) = read_json(&dir.join(".mcp.json")) {
        for server in servers_in(&value) {
            if !out.iter().any(|one| one.name == server.name) {
                out.push(server);
            }
        }
    }
    out
}

fn apps(dir: &Path, field: Option<&Value>) -> Vec<Named> {
    let value = match field {
        Some(Value::String(file)) => read_json(&dir.join(file)),
        Some(other @ (Value::Object(_) | Value::Array(_))) => Some(other.clone()),
        _ => read_json(&dir.join(".app.json")),
    };
    let Some(value) = value else {
        return Vec::new();
    };
    let table = value.get("apps").unwrap_or(&value);
    match table {
        Value::Object(object) => object
            .iter()
            .map(|(name, app)| Named {
                name: match text(app.get("name")) {
                    shown if shown.is_empty() => name.clone(),
                    shown => shown,
                },
                description: text(app.get("description")),
            })
            .collect(),
        Value::Array(list) => list
            .iter()
            .filter_map(|app| {
                let name = match app {
                    Value::String(id) => id.clone(),
                    _ => match text(app.get("name")) {
                        shown if shown.is_empty() => text(app.get("id")),
                        shown => shown,
                    },
                };
                (!name.is_empty()).then(|| Named {
                    name,
                    description: text(app.get("description")),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A plugin's own manifest, whichever provider's layout it is in.
pub fn plugin_manifest(dir: &Path) -> Value {
    read_json(&dir.join(".claude-plugin/plugin.json"))
        .or_else(|| read_json(&dir.join(".codex-plugin/plugin.json")))
        .unwrap_or(Value::Null)
}

/// What a plugin folder adds to a chat.
pub fn contents(dir: &Path) -> Contents {
    let manifest = plugin_manifest(dir);
    let field = |key: &str| manifest.get(key);
    let mut contents = Contents {
        commands: markdown_files(&places(dir, field("commands"), "commands"))
            .iter()
            .map(|path| named_markdown(path))
            .collect(),
        skills: skills(&places(dir, field("skills"), "skills")),
        agents: markdown_files(&places(dir, field("agents"), "agents"))
            .iter()
            .map(|path| named_markdown(path))
            .collect(),
        hooks: hook_events(dir, field("hooks")),
        mcp_servers: bundled_servers(dir, field("mcpServers").or_else(|| field("mcp_servers"))),
        apps: apps(dir, field("apps")),
    };
    contents.commands.truncate(MAX_LISTED);
    contents.skills.truncate(MAX_LISTED);
    contents.agents.truncate(MAX_LISTED);
    contents
}

/// The README in a folder, under any of the spellings people use.
pub fn readme_in(dir: &Path) -> Option<String> {
    let mut found: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.to_ascii_lowercase() == "readme.md")
        })
        .collect();
    found.sort();
    let mut body = fs::read_to_string(found.first()?).ok()?;
    if body.len() > MAX_README {
        let mut cut = MAX_README;
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
    }
    Some(body)
}

/// Fills a page from the plugin's folder: its manifest over what the
/// marketplace said, its README and what it adds.
pub fn fill_from_folder(detail: &mut PluginDetail, dir: &Path) {
    let manifest = plugin_manifest(dir);
    let face = manifest.get("interface");
    let take = |slot: &mut String, value: String| {
        if !value.is_empty() {
            *slot = value;
        }
    };
    let shown = |key: &str| text(face.and_then(|f| f.get(key)));
    take(&mut detail.title, shown("displayName"));
    take(&mut detail.description, text(manifest.get("description")));
    take(&mut detail.description, shown("shortDescription"));
    take(&mut detail.long_description, shown("longDescription"));
    take(&mut detail.version, text(manifest.get("version")));
    take(&mut detail.author, shown("developerName"));
    take(&mut detail.author, person(manifest.get("author")));
    take(&mut detail.homepage, text(manifest.get("homepage")));
    take(&mut detail.homepage, shown("websiteURL"));
    take(&mut detail.privacy_policy, shown("privacyPolicyURL"));
    take(&mut detail.terms, shown("termsOfServiceURL"));
    take(&mut detail.repository, repository(manifest.get("repository")));
    take(&mut detail.license, text(manifest.get("license")));
    take(&mut detail.category, shown("category"));
    if detail.keywords.is_empty() {
        detail.keywords = words(manifest.get("keywords"));
    }
    if detail.title.is_empty() {
        detail.title = detail.name.clone();
    }
    detail.readme = readme_in(dir);
    detail.readme_base = detail.readme.as_ref().map(|_| dir.to_path_buf());
    detail.contents = Some(contents(dir));
    detail.path = Some(dir.to_path_buf());
}

/// Fills a page from a marketplace's entry for the plugin.
pub fn fill_from_entry(detail: &mut PluginDetail, entry: &Value) {
    let take = |slot: &mut String, value: String| {
        if slot.is_empty() {
            *slot = value;
        }
    };
    take(&mut detail.title, text(entry.get("displayName")));
    take(&mut detail.description, text(entry.get("description")));
    take(&mut detail.version, text(entry.get("version")));
    take(&mut detail.author, person(entry.get("author")));
    take(&mut detail.homepage, text(entry.get("homepage")));
    take(&mut detail.repository, repository(entry.get("repository")));
    take(&mut detail.license, text(entry.get("license")));
    take(&mut detail.category, text(entry.get("category")));
    if detail.keywords.is_empty() {
        detail.keywords = words(entry.get("keywords"));
        detail.keywords.extend(words(entry.get("tags")));
    }
}

/// Where a marketplace entry's files are: a folder in the marketplace's own
/// copy, or a GitHub repository (and folder in it).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Place {
    Folder(PathBuf),
    GitHub { repo: String, path: String },
    Unknown,
}

/// Where one entry of a marketplace lives. `root` is the marketplace's copy on
/// this computer, when there is one; `repo` the GitHub `owner/repo` it was
/// published from, when it was.
pub fn entry_place(entry: &Value, root: Option<&Path>, repo: Option<&str>) -> Place {
    let clean = |path: &str| path.trim().trim_start_matches("./").trim_end_matches('/').to_string();
    let relative = |path: &str| {
        let path = clean(path);
        if let Some(root) = root {
            let dir = root.join(&path);
            if dir.is_dir() {
                return Place::Folder(dir);
            }
        }
        match repo {
            Some(repo) => Place::GitHub {
                repo: repo.to_string(),
                path,
            },
            None => Place::Unknown,
        }
    };
    match entry.get("source") {
        Some(Value::String(path)) => relative(path),
        Some(source @ Value::Object(_)) => {
            let kind = text(source.get("source"));
            let sub = clean(&text(source.get("path")));
            if kind == "github" {
                let repo = text(source.get("repo"));
                if !repo.is_empty() {
                    return Place::GitHub { repo, path: sub };
                }
            }
            let url = text(source.get("url"));
            if let Some((repo, inner)) = github_repo(&url) {
                return Place::GitHub {
                    repo,
                    path: if sub.is_empty() { inner } else { sub },
                };
            }
            if !sub.is_empty() {
                return relative(&sub);
            }
            Place::Unknown
        }
        _ => Place::Unknown,
    }
}

/// `owner/repo` and the folder inside it, out of a GitHub address.
pub fn github_repo(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_start_matches("git+");
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))?;
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    let repo = format!("{}/{}", parts[0], parts[1].trim_end_matches(".git"));
    // …/tree/<branch>/<folder>
    let inner = if parts.len() > 4 && (parts[2] == "tree" || parts[2] == "blob") {
        parts[4..].join("/")
    } else {
        String::new()
    };
    Some((repo, inner))
}

/// Relative links and pictures in a README fetched from GitHub, made to point
/// at GitHub: on this computer there is no folder for them to be next to.
pub fn absolute_links(markdown: &str, repo: &str, path: &str) -> String {
    let folder = if path.is_empty() { String::new() } else { format!("{path}/") };
    let raw = format!("https://raw.githubusercontent.com/{repo}/HEAD/{folder}");
    let page = format!("https://github.com/{repo}/blob/HEAD/{folder}");
    let relative = |target: &str| {
        !(target.is_empty()
            || target.starts_with('#')
            || target.starts_with('/')
            || target.starts_with("//")
            || target.contains("://")
            || target.starts_with("mailto:")
            || target.starts_with("data:"))
    };
    static LINK: OnceLock<Regex> = OnceLock::new();
    static IMG: OnceLock<Regex> = OnceLock::new();
    let link = LINK.get_or_init(|| Regex::new(r"(!?)\[([^\]]*)\]\(\s*([^)\s]+)([^)]*)\)").unwrap());
    let img = IMG.get_or_init(|| Regex::new(r#"(<img\b[^>]*?\bsrc=)(["'])([^"']+)(["'])"#).unwrap());
    let once = link.replace_all(markdown, |caps: &regex::Captures| {
        let (bang, words, target, rest) = (&caps[1], &caps[2], &caps[3], &caps[4]);
        if !relative(target) {
            return caps[0].to_string();
        }
        let target = target.trim_start_matches("./");
        let base = if bang == "!" { &raw } else { &page };
        format!("{bang}[{words}]({base}{target}{rest})")
    });
    img.replace_all(&once, |caps: &regex::Captures| {
        let target = &caps[3];
        if !relative(target) {
            return caps[0].to_string();
        }
        format!("{}{}{raw}{}{}", &caps[1], &caps[2], target.trim_start_matches("./"), &caps[4])
    })
    .into_owned()
}

fn kept() -> &'static Mutex<HashMap<String, (Instant, Arc<Option<String>>)>> {
    static KEPT: OnceLock<Mutex<HashMap<String, (Instant, Arc<Option<String>>)>>> = OnceLock::new();
    KEPT.get_or_init(Default::default)
}

/// The README of a folder in a GitHub repository, with its links made
/// absolute. `Ok(None)` is a repository that has none.
pub async fn github_readme(repo: &str, path: &str) -> Result<Option<String>, String> {
    let key = format!("{repo}#{path}");
    if let Some((at, kept)) = kept().lock().unwrap().get(&key) {
        if at.elapsed() < KEEP {
            return Ok(kept.as_ref().clone());
        }
    }
    let client = reqwest::Client::builder()
        .timeout(PATIENCE)
        .build()
        .map_err(|e| e.to_string())?;
    let folder = if path.is_empty() { String::new() } else { format!("{path}/") };
    let mut found = None;
    for name in ["README.md", "readme.md", "Readme.md", "README.MD"] {
        let url = format!("https://raw.githubusercontent.com/{repo}/HEAD/{folder}{name}");
        let answer = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if answer.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        let answer = answer.error_for_status().map_err(|e| e.to_string())?;
        let mut body = answer.text().await.map_err(|e| e.to_string())?;
        if body.len() > MAX_README {
            let mut cut = MAX_README;
            while !body.is_char_boundary(cut) {
                cut -= 1;
            }
            body.truncate(cut);
        }
        found = Some(absolute_links(&body, repo, path));
        break;
    }
    kept()
        .lock()
        .unwrap()
        .insert(key, (Instant::now(), Arc::new(found.clone())));
    Ok(found)
}

/// An MCP server's page, from the repository it is published from.
pub async fn mcp_detail(repository: Option<&str>) -> McpDetail {
    let Some(url) = repository.map(str::trim).filter(|u| !u.is_empty()) else {
        return McpDetail {
            readme: None,
            unread: Some("No repository is known for this server".into()),
        };
    };
    let Some((repo, path)) = github_repo(url) else {
        return McpDetail {
            readme: None,
            unread: Some("Its repository is not on GitHub".into()),
        };
    };
    match github_readme(&repo, &path).await {
        Ok(Some(readme)) => McpDetail {
            readme: Some(readme),
            unread: None,
        },
        Ok(None) => McpDetail {
            readme: None,
            unread: Some("Its repository has no README".into()),
        },
        Err(why) => McpDetail {
            readme: None,
            unread: Some(format!("The README could not be fetched: {why}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn native_workbench_item_detail_lists_what_a_plugin_folder_adds() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write(&d.join(".claude-plugin/plugin.json"), r#"{"name":"tidy","version":"2.0.0","author":{"name":"Ada"},"license":"MIT","hooks":"./hooks/extra.json"}"#);
        write(&d.join("README.md"), "# Tidy\n\nKeeps things tidy.\n");
        write(&d.join("commands/sweep.md"), "---\ndescription: Sweep the floor\n---\nBody");
        write(&d.join("commands/notes.txt"), "not a command");
        write(&d.join("skills/fold/SKILL.md"), "---\nname: fold\ndescription: \"Fold laundry\"\n---\n");
        write(&d.join("agents/butler.md"), "A butler that answers the door.\n");
        write(&d.join("hooks/extra.json"), r#"{"hooks":{"PreToolUse":[]}}"#);
        write(&d.join("hooks/hooks.json"), r#"{"hooks":{"Stop":[],"PreToolUse":[]}}"#);
        write(&d.join(".mcp.json"), r#"{"mcpServers":{"slack":{"type":"http","url":"https://mcp.slack.com/mcp"},"fs":{"command":"npx","args":["-y","fs"]}}}"#);

        let mut detail = PluginDetail {
            id: "tidy@m".into(),
            name: "tidy".into(),
            ..PluginDetail::default()
        };
        fill_from_folder(&mut detail, d);
        assert_eq!(detail.title, "tidy");
        assert_eq!(detail.version, "2.0.0");
        assert_eq!(detail.author, "Ada");
        assert_eq!(detail.license, "MIT");
        assert!(detail.readme.as_deref().unwrap().contains("Keeps things tidy"));
        let c = detail.contents.unwrap();
        assert_eq!(c.commands, vec![Named { name: "sweep".into(), description: "Sweep the floor".into() }]);
        assert_eq!(c.skills, vec![Named { name: "fold".into(), description: "Fold laundry".into() }]);
        assert_eq!(c.agents, vec![Named { name: "butler".into(), description: "A butler that answers the door.".into() }]);
        assert_eq!(c.hooks, vec!["PreToolUse".to_string(), "Stop".to_string()]);
        assert_eq!(c.mcp_servers.len(), 2);
        assert_eq!(c.mcp_servers[0], Bundled { name: "fs".into(), transport: "stdio".into(), target: "npx -y fs".into() });
        assert_eq!(c.mcp_servers[1].target, "https://mcp.slack.com/mcp");
    }

    #[test]
    fn native_workbench_item_detail_reads_a_codex_plugin_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write(
            &d.join(".codex-plugin/plugin.json"),
            r#"{"name":"mail","skills":"./skills/","mcpServers":"./.mcp.json","apps":"./.app.json","interface":{"displayName":"Mail","category":"Communication"}}"#,
        );
        write(&d.join("skills/read/SKILL.md"), "---\nname: read\ndescription: Read mail\n---\n");
        write(&d.join(".mcp.json"), r#"{"mcpServers":{"mail":{"url":"https://example.test/mcp"}}}"#);
        write(&d.join(".app.json"), r#"{"apps":{"gmail":{"id":"connector_1"}}}"#);
        let mut detail = PluginDetail { name: "mail".into(), ..PluginDetail::default() };
        fill_from_folder(&mut detail, d);
        assert_eq!(detail.title, "Mail");
        assert_eq!(detail.category, "Communication");
        let c = detail.contents.unwrap();
        assert_eq!(c.skills.len(), 1);
        assert_eq!(c.mcp_servers.len(), 1);
        assert_eq!(c.mcp_servers[0].transport, "http");
        assert_eq!(c.apps, vec![Named { name: "gmail".into(), description: String::new() }]);
    }

    #[test]
    fn native_workbench_item_detail_finds_where_a_marketplace_entry_lives() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("plugins/tidy")).unwrap();
        let here = json!({"name": "tidy", "source": "./plugins/tidy"});
        assert_eq!(entry_place(&here, Some(dir.path()), None), Place::Folder(dir.path().join("plugins/tidy")));
        let elsewhere = json!({"name": "far", "source": "./plugins/far"});
        assert_eq!(
            entry_place(&elsewhere, Some(dir.path()), Some("anthropics/claude-plugins-official")),
            Place::GitHub { repo: "anthropics/claude-plugins-official".into(), path: "plugins/far".into() }
        );
        let github = json!({"name": "x", "source": {"source": "github", "repo": "owner/x"}});
        assert_eq!(entry_place(&github, None, None), Place::GitHub { repo: "owner/x".into(), path: String::new() });
        let url = json!({"name": "y", "source": {"source": "url", "url": "https://github.com/owner/y.git"}});
        assert_eq!(entry_place(&url, None, None), Place::GitHub { repo: "owner/y".into(), path: String::new() });
        assert_eq!(entry_place(&json!({"name": "z"}), None, None), Place::Unknown);
    }

    #[test]
    fn native_workbench_item_detail_points_a_fetched_readme_at_github() {
        let md = "![logo](./logo.png) see [docs](docs/a.md), [site](https://x.test) and [top](#top)\n<img src=\"img/b.png\">";
        let out = absolute_links(md, "o/r", "plugins/p");
        assert!(out.contains("![logo](https://raw.githubusercontent.com/o/r/HEAD/plugins/p/logo.png)"));
        assert!(out.contains("[docs](https://github.com/o/r/blob/HEAD/plugins/p/docs/a.md)"));
        assert!(out.contains("[site](https://x.test)"));
        assert!(out.contains("[top](#top)"));
        assert!(out.contains("<img src=\"https://raw.githubusercontent.com/o/r/HEAD/plugins/p/img/b.png\">"));
        assert_eq!(github_repo("https://github.com/o/r/tree/main/src/x"), Some(("o/r".into(), "src/x".into())));
    }
}
