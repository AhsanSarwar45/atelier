//! MCP servers per account and per project, read from and written into the
//! files the provider CLIs themselves read.
//!
//! Neither CLI gives a machine-readable list worth trusting — `claude mcp
//! list` health-checks every server and prints prose, `codex mcp list --json`
//! answers for one `CODEX_HOME` and needs a process per account — so this
//! reads the files directly and writes them the way a settings write does:
//! the whole document parsed, one entry changed, a backup kept, the file
//! replaced atomically.
//!
//! ## Where Claude Code keeps things (2.1.270, read from the docs and the binary)
//!
//! - user servers: `<cfg>/.claude.json` top-level `mcpServers`;
//! - local servers: `<cfg>/.claude.json` `projects[<path>].mcpServers`;
//! - project servers: `<project>/.mcp.json` `mcpServers`;
//! - a user or local server switched off for one project:
//!   `projects[<path>].disabledMcpServers` in `.claude.json`, which is what
//!   `/mcp` toggles;
//! - approval of `.mcp.json` servers: `enabledMcpjsonServers`,
//!   `disabledMcpjsonServers` and `enableAllProjectMcpServers` in the settings
//!   files. The interactive dialog writes its answer to
//!   `.claude/settings.local.json`, so that is where a toggle here goes too. A
//!   server in no list is *pending*: an interactive session asks, a
//!   non-interactive one (which is what a chat here is) loads it anyway, and
//!   only `disabledMcpjsonServers` stops it. So `enabled` for a project server
//!   means "not rejected", and `approval` says the rest.
//!
//! ## Where Codex keeps things (0.153.4)
//!
//! `[mcp_servers.<id>]` in `<CODEX_HOME>/config.toml`, or in a trusted
//! project's `.codex/config.toml`. `enabled = false` switches one off.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

use super::provider_settings::{
    self, item_to_json, load_json, load_toml, rewrite_json, rewrite_toml, set_toml, Scope,
};

/// How long a login is watched for the address it prints before the browser
/// is answered. The flow itself keeps running after that.
const URL_WITHIN: Duration = Duration::from_secs(3);

/// Which file a server is defined in.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The account's own file: `.claude.json` top level or `config.toml`.
    User,
    /// The project's shared file: `.mcp.json` or `.codex/config.toml`.
    Project,
    /// Claude's `.claude.json` entry for one project path.
    Local,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::User => "user",
            Source::Project => "project",
            Source::Local => "local",
        }
    }
}

/// One account's files, as the registry resolves them. `claude_json` is where
/// this account's `.claude.json` is: inside the config directory for a created
/// profile, `~/.claude.json` for the system account when no `CLAUDE_CONFIG_DIR`
/// is set, because that is where Claude itself looks.
#[derive(Clone, Debug)]
pub struct Account {
    pub dir: PathBuf,
    pub claude_json: PathBuf,
    /// True for the system account, which a spawned CLI must be left to find
    /// on its own rather than pointed at by environment.
    pub system: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub source: Source,
    /// The file the entry is in.
    pub path: PathBuf,
    pub enabled: bool,
    /// Claude project servers only: `approved`, `pending` or `rejected`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<&'static str>,
    /// `stdio`, `http`, `sse` or `ws`.
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<Map<String, Value>>,
    /// The entry exactly as the file holds it.
    pub config: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub servers: Vec<Server>,
}

/// What a login or logout answered with once it was under way.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub started: bool,
    /// The first `https://` address the command printed, when it printed one
    /// in time: the page to finish signing in on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Every server this scope of this brand can see.
pub fn list(brand: &str, scope: &Scope, account: &Account) -> Result<Listing, String> {
    check(brand, scope)?;
    let servers = match (brand, scope) {
        ("claude", Scope::Account { .. }) => claude_user(account)?,
        ("claude", Scope::Project { path }) => claude_project(account, path)?,
        ("codex", Scope::Account { .. }) => {
            codex_file(&account.dir.join("config.toml"), Source::User)?
        }
        ("codex", Scope::Project { path }) => {
            codex_file(&path.join(".codex/config.toml"), Source::Project)?
        }
        _ => unreachable!("checked above"),
    };
    Ok(Listing { servers })
}

/// Put one server into the named file and answer the scope as it now reads.
pub fn add(
    brand: &str,
    scope: &Scope,
    account: &Account,
    source: Source,
    id: &str,
    config: &Map<String, Value>,
) -> Result<Listing, String> {
    check(brand, scope)?;
    check_id(id)?;
    let has = |key: &str| {
        config
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    };
    if !has("command") && !has("url") {
        return Err("a server needs a command to run or a url to reach".into());
    }
    let path = file_for(brand, scope, account, source)?;
    match brand {
        "claude" => {
            let mut entry = config.clone();
            if !entry.contains_key("type") {
                // Claude reads an entry with a url and no type as stdio and
                // skips it, so name the transport it plainly means.
                entry.insert(
                    "type".into(),
                    json!(if has("command") { "stdio" } else { "http" }),
                );
            }
            let entry = Value::Object(entry);
            rewrite_json(&path, |root| {
                let servers = match source {
                    Source::Local => project_entry(root, scope)?,
                    _ => root,
                };
                object_at(servers, "mcpServers")?.insert(id.to_string(), entry);
                Ok(())
            })?;
        }
        _ => {
            if let Some(unknown) = config
                .keys()
                .find(|key| !CODEX_KEYS.contains(&key.as_str()))
            {
                return Err(format!(
                    "Codex does not know the server setting \"{unknown}\""
                ));
            }
            rewrite_toml(&path, |document| {
                set_toml(
                    document.as_item_mut(),
                    &["mcp_servers", id],
                    &Value::Object(config.clone()),
                )
            })?;
        }
    }
    list(brand, scope, account)
}

/// Take one server out of the named file and answer the scope as it now reads.
pub fn remove(
    brand: &str,
    scope: &Scope,
    account: &Account,
    source: Source,
    id: &str,
) -> Result<Listing, String> {
    check(brand, scope)?;
    check_id(id)?;
    let path = file_for(brand, scope, account, source)?;
    let missing = || format!("{} has no server called {id}", path.display());
    match brand {
        "claude" => rewrite_json(&path, |root| {
            let servers = match source {
                Source::Local => project_entry(root, scope)?,
                _ => root,
            };
            let removed = servers
                .get_mut("mcpServers")
                .and_then(Value::as_object_mut)
                .and_then(|servers| servers.shift_remove(id));
            removed.map(|_| ()).ok_or_else(missing)
        })?,
        _ => rewrite_toml(&path, |document| {
            if !codex_has(document, id) {
                return Err(missing());
            }
            set_toml(document.as_item_mut(), &["mcp_servers", id], &Value::Null)
        })?,
    }
    list(brand, scope, account)
}

/// Switch one server on or off without removing it.
///
/// Claude has no such switch on an account: a user server is always on and
/// is only ever switched off for one project. In a project, a user or local
/// server is switched through `.claude.json`'s `disabledMcpServers` for that
/// path, and a `.mcp.json` server through the approval lists in
/// `.claude/settings.local.json`. Codex sets `enabled` on the table.
pub fn set_enabled(
    brand: &str,
    scope: &Scope,
    account: &Account,
    source: Source,
    id: &str,
    enabled: bool,
) -> Result<Listing, String> {
    check(brand, scope)?;
    check_id(id)?;
    let path = file_for(brand, scope, account, source)?;
    let missing = || format!("{} has no server called {id}", path.display());
    match (brand, scope, source) {
        ("claude", Scope::Account { .. }, _) => {
            return Err(
                "Claude Code has no switch for a user server; it is on everywhere, and can only be switched off inside one project".into(),
            );
        }
        ("claude", Scope::Project { path: project }, Source::Project) => {
            if !list(brand, scope, account)?
                .servers
                .iter()
                .any(|server| server.source == Source::Project && server.id == id)
            {
                return Err(missing());
            }
            let local = project.join(".claude/settings.local.json");
            if enabled {
                // A rejection in a shared or account file outranks anything
                // written here, so say which file instead of writing a switch
                // that would change nothing.
                let files = provider_settings::read("claude", scope, &account.dir)?
                    .files
                    .into_iter()
                    .chain(
                        provider_settings::read(
                            "claude",
                            &Scope::Account { profile_id: None },
                            &account.dir,
                        )?
                        .files,
                    );
                for file in files {
                    if file.path != local
                        && names(file.value.get("disabledMcpjsonServers"))
                            .iter()
                            .any(|name| name == id)
                    {
                        return Err(format!(
                            "{} rejects {id} in disabledMcpjsonServers; take it out there first",
                            file.path.display()
                        ));
                    }
                }
            }
            rewrite_json(&local, |settings| {
                let (add_to, take_from) = if enabled {
                    ("enabledMcpjsonServers", "disabledMcpjsonServers")
                } else {
                    ("disabledMcpjsonServers", "enabledMcpjsonServers")
                };
                list_insert(settings, add_to, id);
                list_remove(settings, take_from, id);
                Ok(())
            })?;
        }
        ("claude", Scope::Project { .. }, _) => {
            if source == Source::Local && !claude_has(&path, scope, id)? {
                return Err(missing());
            }
            if source == Source::User
                && !claude_has(&path, &Scope::Account { profile_id: None }, id)?
            {
                return Err(missing());
            }
            rewrite_json(&path, |root| {
                let entry = project_entry(root, scope)?;
                if enabled {
                    list_remove(entry, "disabledMcpServers", id);
                } else {
                    list_insert(entry, "disabledMcpServers", id);
                }
                Ok(())
            })?;
        }
        _ => rewrite_toml(&path, |document| {
            if !codex_has(document, id) {
                return Err(missing());
            }
            let value = if enabled { Value::Null } else { json!(false) };
            set_toml(
                document.as_item_mut(),
                &["mcp_servers", id, "enabled"],
                &value,
            )
        })?,
    }
    list(brand, scope, account)
}

/// Start `<brand> mcp login <id>` (or `logout`) for this account, in the
/// project when one is named, and answer as soon as it has printed the page to
/// open or three seconds have passed. The command keeps running on its own:
/// an OAuth flow finishes in the browser and calls back to the command, not
/// to this server.
pub async fn login(
    brand: &str,
    scope: &Scope,
    account: &Account,
    id: &str,
    out: bool,
) -> Result<Started, String> {
    check(brand, scope)?;
    check_id(id)?;
    let program = crate::routes::find_tool(brand, &[])
        .ok_or_else(|| format!("the {brand} program was not found on this computer"))?;
    let verb = if out { "logout" } else { "login" };
    let mut command = tokio::process::Command::new(&program);
    command.args(["mcp", verb, id]);
    if let Scope::Project { path } = scope {
        command.current_dir(path);
    }
    if !account.system {
        if let Some(variable) = super::profiles::variable(brand) {
            command.env(variable, &account.dir);
        }
    }
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    let mut child = command
        .spawn()
        .map_err(|error| format!("{brand} mcp {verb} could not start: {error}"))?;
    let stdin = child.stdin.take();
    let (lines_send, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    for reader in [
        child
            .stdout
            .take()
            .map(|out| Box::pin(out) as std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>),
        child
            .stderr
            .take()
            .map(|err| Box::pin(err) as std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>),
    ]
    .into_iter()
    .flatten()
    {
        let lines_send = lines_send.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if lines_send.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(lines_send);
    let (exit_send, mut exit) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        // Keep the pipe open so a prompt for a pasted address does not hit an
        // end of file, and reap the child however it ends.
        let _stdin = stdin;
        let _ = exit_send.send(child.wait().await.ok());
    });
    let deadline = tokio::time::Instant::now() + URL_WITHIN;
    let mut said = Vec::new();
    let mut url = None;
    loop {
        tokio::select! {
            line = lines.recv() => match line {
                Some(line) => {
                    if url.is_none() {
                        url = first_url(&line);
                    }
                    said.push(line);
                    if url.is_some() {
                        break;
                    }
                }
                None => break,
            },
            status = &mut exit => {
                while let Ok(line) = lines.try_recv() {
                    if url.is_none() {
                        url = first_url(&line);
                    }
                    said.push(line);
                }
                if let Some(status) = status.ok().flatten() {
                    if !status.success() {
                        let last = said.iter().rev().find(|line| !line.trim().is_empty());
                        return Err(match last {
                            Some(line) => format!("{brand} mcp {verb} failed: {}", line.trim()),
                            None => format!("{brand} mcp {verb} failed with {status}"),
                        });
                    }
                }
                break;
            },
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
    Ok(Started { started: true, url })
}

// ----- reading -----

fn claude_user(account: &Account) -> Result<Vec<Server>, String> {
    let root = load_json(&account.claude_json)?;
    Ok(entries(root.get("mcpServers"))
        .map(|(id, config)| {
            claude_server(id, config, Source::User, &account.claude_json, true, None)
        })
        .collect())
}

fn claude_project(account: &Account, project: &Path) -> Result<Vec<Server>, String> {
    let mcp_json = project.join(".mcp.json");
    let root = load_json(&account.claude_json)?;
    let entry = root
        .get("projects")
        .and_then(|projects| projects.get(project_key(project)))
        .and_then(Value::as_object);
    let disabled = names(entry.and_then(|entry| entry.get("disabledMcpServers")));
    let settings = provider_settings::read(
        "claude",
        &Scope::Project {
            path: project.to_path_buf(),
        },
        &account.dir,
    )?
    .files
    .into_iter()
    .chain(
        provider_settings::read("claude", &Scope::Account { profile_id: None }, &account.dir)?
            .files,
    )
    .map(|file| file.value)
    .collect::<Vec<_>>();
    let rejected = settings
        .iter()
        .flat_map(|value| names(value.get("disabledMcpjsonServers")))
        .collect::<Vec<_>>();
    let approve_all = settings
        .iter()
        .any(|value| value.get("enableAllProjectMcpServers") == Some(&Value::Bool(true)));
    let approved = settings
        .iter()
        .flat_map(|value| names(value.get("enabledMcpjsonServers")))
        .collect::<Vec<_>>();
    let mut servers: Vec<Server> = entries(load_json(&mcp_json)?.get("mcpServers"))
        .map(|(id, config)| {
            let approval = if rejected.iter().any(|name| name == id) {
                "rejected"
            } else if approve_all || approved.iter().any(|name| name == id) {
                "approved"
            } else {
                "pending"
            };
            claude_server(
                id,
                config,
                Source::Project,
                &mcp_json,
                approval != "rejected",
                Some(approval),
            )
        })
        .collect();
    servers.extend(
        entries(entry.and_then(|entry| entry.get("mcpServers"))).map(|(id, config)| {
            claude_server(
                id,
                config,
                Source::Local,
                &account.claude_json,
                !disabled.iter().any(|name| name == id),
                None,
            )
        }),
    );
    Ok(servers)
}

fn claude_server(
    id: &str,
    config: &Value,
    source: Source,
    path: &Path,
    enabled: bool,
    approval: Option<&'static str>,
) -> Server {
    let kind = config.get("type").and_then(Value::as_str);
    let transport = match kind {
        Some("http") | Some("streamable-http") => "http",
        Some("sse") => "sse",
        Some("ws") => "ws",
        Some("stdio") => "stdio",
        _ if config.get("url").is_some() => "http",
        _ => "stdio",
    };
    Server {
        id: id.to_string(),
        source,
        path: path.to_path_buf(),
        enabled,
        approval,
        transport: transport.into(),
        command: text(config, "command"),
        args: strings(config.get("args")),
        url: text(config, "url"),
        env: config.get("env").and_then(Value::as_object).cloned(),
        headers: config.get("headers").and_then(Value::as_object).cloned(),
        config: config.clone(),
    }
}

fn codex_file(path: &Path, source: Source) -> Result<Vec<Server>, String> {
    let document = load_toml(path)?;
    let Some(table) = document
        .get("mcp_servers")
        .and_then(|item| item.as_table_like())
    else {
        return Ok(Vec::new());
    };
    Ok(table
        .iter()
        .map(|(id, item)| {
            let config = item_to_json(item);
            let transport = if config.get("url").is_some() {
                "http"
            } else {
                "stdio"
            };
            Server {
                id: id.to_string(),
                source,
                path: path.to_path_buf(),
                enabled: config.get("enabled") != Some(&Value::Bool(false)),
                approval: None,
                transport: transport.into(),
                command: text(&config, "command"),
                args: strings(config.get("args")),
                url: text(&config, "url"),
                env: config.get("env").and_then(Value::as_object).cloned(),
                headers: config
                    .get("http_headers")
                    .and_then(Value::as_object)
                    .cloned(),
                config,
            }
        })
        .collect())
}

// ----- shared -----

/// The keys Codex 0.153 reads under `[mcp_servers.<id>]`. Anything else makes
/// Codex refuse its whole config at start-up, which is worse than refusing
/// here.
const CODEX_KEYS: &[&str] = &[
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
    "enabled",
    "enabled_tools",
    "disabled_tools",
    "startup_timeout_sec",
    "tool_timeout_sec",
];

fn check(brand: &str, scope: &Scope) -> Result<(), String> {
    if brand != "claude" && brand != "codex" {
        return Err("brand must be claude or codex".into());
    }
    if let Scope::Project { path } = scope {
        if !path.is_absolute() {
            return Err("projectPath must be absolute".into());
        }
    }
    Ok(())
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    {
        return Err("a server id is letters, digits, dots, dashes and underscores".into());
    }
    Ok(())
}

/// Which file a source names in this scope, or why it names none.
fn file_for(
    brand: &str,
    scope: &Scope,
    account: &Account,
    source: Source,
) -> Result<PathBuf, String> {
    Ok(match (brand, scope, source) {
        ("claude", Scope::Account { .. }, Source::User) => account.claude_json.clone(),
        ("claude", Scope::Project { .. }, Source::User) => account.claude_json.clone(),
        ("claude", Scope::Project { .. }, Source::Local) => account.claude_json.clone(),
        ("claude", Scope::Project { path }, Source::Project) => path.join(".mcp.json"),
        ("codex", Scope::Account { .. }, Source::User) => account.dir.join("config.toml"),
        ("codex", Scope::Project { path }, Source::Project) => path.join(".codex/config.toml"),
        (_, Scope::Account { .. }, _) => {
            return Err(format!(
                "an account has no {} servers; use source user",
                source.name()
            ))
        }
        _ => {
            return Err(format!(
                "a {brand} project has no {} servers",
                source.name()
            ))
        }
    })
}

/// Claude keys `projects` by the path as given, so the key is the path's own
/// text with no normalizing beyond dropping a trailing slash.
fn project_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_suffix('/') {
        Some(stripped) if !stripped.is_empty() => stripped.to_string(),
        _ => text.into_owned(),
    }
}

fn project_entry<'a>(
    root: &'a mut Map<String, Value>,
    scope: &Scope,
) -> Result<&'a mut Map<String, Value>, String> {
    let Scope::Project { path } = scope else {
        return Err("a local server belongs to a project".into());
    };
    object_at(object_at(root, "projects")?, &project_key(path))
}

fn object_at<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if !object.get(key).is_some_and(Value::is_object) {
        if object.get(key).is_some_and(|value| !value.is_null()) {
            return Err(format!(
                "\"{key}\" is not an object, so the file was left alone"
            ));
        }
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("\"{key}\" could not be created"))
}

fn list_insert(object: &mut Map<String, Value>, key: &str, id: &str) {
    let list = object.entry(key).or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    if let Some(list) = list.as_array_mut() {
        if !list.iter().any(|name| name == id) {
            list.push(json!(id));
        }
    }
}

fn list_remove(object: &mut Map<String, Value>, key: &str, id: &str) {
    if let Some(list) = object.get_mut(key).and_then(Value::as_array_mut) {
        list.retain(|name| name != id);
    }
}

fn claude_has(path: &Path, scope: &Scope, id: &str) -> Result<bool, String> {
    let mut root = load_json(path)?;
    let holder = match scope {
        Scope::Project { .. } => project_entry(&mut root, scope)?,
        Scope::Account { .. } => &mut root,
    };
    Ok(holder
        .get("mcpServers")
        .and_then(Value::as_object)
        .is_some_and(|servers| servers.contains_key(id)))
}

fn codex_has(document: &toml_edit::DocumentMut, id: &str) -> bool {
    document
        .get("mcp_servers")
        .and_then(|item| item.as_table_like())
        .is_some_and(|table| table.get(id).is_some_and(|item| item.is_table_like()))
}

fn entries(value: Option<&Value>) -> impl Iterator<Item = (&str, &Value)> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|map| map.iter())
        .filter(|(_, config)| config.is_object())
        .map(|(id, config)| (id.as_str(), config))
}

fn names(value: Option<&Value>) -> Vec<String> {
    strings(value).unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

fn text(config: &Value, key: &str) -> Option<String> {
    config.get(key).and_then(Value::as_str).map(str::to_string)
}

fn first_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| {
            c.is_whitespace() || c.is_control() || c == '"' || c == '\'' || c == '>' || c == ')'
        })
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']);
    (url.len() > "https://".len()).then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn account_in(home: &Path) -> Account {
        Account {
            dir: home.join("claude"),
            claude_json: home.join("claude/.claude.json"),
            system: false,
        }
    }

    fn account() -> Scope {
        Scope::Account { profile_id: None }
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn native_workbench_services_mcp_claude_account_adds_lists_and_removes_user_servers() {
        let home = tempfile::tempdir().unwrap();
        let account_files = account_in(home.path());
        fs::create_dir_all(&account_files.dir).unwrap();
        fs::write(
            &account_files.claude_json,
            "{\n  \"oauthAccount\": {\"email\": \"a@b\"},\n  \"mcpServers\": {\"docs\": {\"type\": \"stdio\", \"command\": \"npx\", \"args\": [\"docs\"], \"env\": {\"K\": \"v\"}}}\n}\n",
        )
        .unwrap();
        let listing = list("claude", &account(), &account_files).unwrap();
        assert_eq!(listing.servers.len(), 1);
        let docs = &listing.servers[0];
        assert_eq!(docs.id, "docs");
        assert_eq!(docs.source, Source::User);
        assert_eq!(docs.transport, "stdio");
        assert_eq!(docs.command.as_deref(), Some("npx"));
        assert_eq!(docs.args, Some(vec!["docs".to_string()]));
        assert_eq!(docs.env, Some(object(json!({"K": "v"}))));
        assert!(docs.enabled && docs.approval.is_none());
        assert_eq!(docs.path, account_files.claude_json);

        let listing = add(
            "claude",
            &account(),
            &account_files,
            Source::User,
            "sentry",
            &object(json!({"url": "https://mcp.sentry.dev/mcp", "headers": {"X": "1"}})),
        )
        .unwrap();
        let sentry = listing.servers.iter().find(|s| s.id == "sentry").unwrap();
        assert_eq!(sentry.transport, "http");
        assert_eq!(
            sentry.config["type"],
            json!("http"),
            "a url with no type is named http"
        );
        assert_eq!(sentry.headers, Some(object(json!({"X": "1"}))));
        let text = fs::read_to_string(&account_files.claude_json).unwrap();
        assert!(
            text.contains("\"oauthAccount\""),
            "unrelated keys kept: {text}"
        );
        assert!(text.find("\"docs\"").unwrap() < text.find("\"sentry\"").unwrap());
        assert!(provider_settings::backup_of(&account_files.claude_json).exists());

        let error = set_enabled(
            "claude",
            &account(),
            &account_files,
            Source::User,
            "docs",
            false,
        )
        .unwrap_err();
        assert!(error.contains("no switch"), "{error}");

        let listing = remove("claude", &account(), &account_files, Source::User, "docs").unwrap();
        assert_eq!(
            listing
                .servers
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["sentry"]
        );
        assert!(remove("claude", &account(), &account_files, Source::User, "docs").is_err());
        assert!(add(
            "claude",
            &account(),
            &account_files,
            Source::Project,
            "x",
            &object(json!({"command": "x"}))
        )
        .is_err());
        assert!(add(
            "claude",
            &account(),
            &account_files,
            Source::User,
            "bad id",
            &object(json!({"command": "x"}))
        )
        .is_err());
        assert!(add(
            "claude",
            &account(),
            &account_files,
            Source::User,
            "noway",
            &object(json!({"args": []}))
        )
        .is_err());
        // A missing .claude.json lists nothing rather than failing.
        let empty = Account {
            dir: home.path().join("other"),
            claude_json: home.path().join("other/.claude.json"),
            system: false,
        };
        assert!(list("claude", &account(), &empty)
            .unwrap()
            .servers
            .is_empty());
    }

    #[test]
    fn native_workbench_services_mcp_claude_project_reads_mcp_json_local_entries_and_approvals() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let account_files = account_in(home.path());
        fs::create_dir_all(&account_files.dir).unwrap();
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        let key = project.path().to_string_lossy().into_owned();
        fs::write(
            &account_files.claude_json,
            serde_json::to_string_pretty(&json!({
                "mcpServers": {"user-one": {"type": "http", "url": "https://u"}},
                "projects": {
                    &key: {
                        "allowedTools": [],
                        "mcpServers": {"chrome": {"type": "stdio", "command": "npx"}},
                        "disabledMcpServers": ["chrome", "user-one"]
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            project.path().join(".mcp.json"),
            serde_json::to_string(&json!({"mcpServers": {
                "shared": {"type": "sse", "url": "https://s"},
                "rejected": {"command": "r"},
                "blessed": {"type": "streamable-http", "url": "https://b"}
            }}))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(project.path().join(".claude")).unwrap();
        fs::write(
            project.path().join(".claude/settings.json"),
            "{\"disabledMcpjsonServers\": [\"rejected\"]}",
        )
        .unwrap();
        fs::write(
            account_files.dir.join("settings.json"),
            "{\"enabledMcpjsonServers\": [\"blessed\"]}",
        )
        .unwrap();

        let listing = list("claude", &scope, &account_files).unwrap();
        let by_id = |id: &str| listing.servers.iter().find(|s| s.id == id).unwrap();
        assert_eq!(listing.servers.len(), 4, "{listing:?}");
        assert_eq!(by_id("shared").source, Source::Project);
        assert_eq!(by_id("shared").transport, "sse");
        assert_eq!(by_id("shared").approval, Some("pending"));
        assert!(
            by_id("shared").enabled,
            "a pending server still loads in a chat"
        );
        assert_eq!(by_id("rejected").approval, Some("rejected"));
        assert!(!by_id("rejected").enabled);
        assert_eq!(by_id("blessed").approval, Some("approved"));
        assert_eq!(by_id("blessed").transport, "http");
        assert_eq!(by_id("shared").path, project.path().join(".mcp.json"));
        assert_eq!(by_id("chrome").source, Source::Local);
        assert!(!by_id("chrome").enabled);
        assert_eq!(by_id("chrome").path, account_files.claude_json);

        // A rejection in the shared settings.json outranks the local file, so
        // switching that server on is refused by name rather than written for
        // nothing.
        let error = set_enabled(
            "claude",
            &scope,
            &account_files,
            Source::Project,
            "rejected",
            true,
        )
        .unwrap_err();
        assert!(
            error.contains(".claude/settings.json") && error.contains("rejected"),
            "{error}"
        );
        assert!(!project.path().join(".claude/settings.local.json").exists());
        // Switching a project server writes the lists Claude's own dialog writes.
        let listing = set_enabled(
            "claude",
            &scope,
            &account_files,
            Source::Project,
            "shared",
            false,
        )
        .unwrap();
        assert!(
            !listing
                .servers
                .iter()
                .find(|s| s.id == "shared")
                .unwrap()
                .enabled
        );
        let local: Value = serde_json::from_str(
            &fs::read_to_string(project.path().join(".claude/settings.local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(local["disabledMcpjsonServers"], json!(["shared"]));
        let listing = set_enabled(
            "claude",
            &scope,
            &account_files,
            Source::Project,
            "shared",
            true,
        )
        .unwrap();
        let shared = listing.servers.iter().find(|s| s.id == "shared").unwrap();
        assert!(shared.enabled && shared.approval == Some("approved"));
        let local: Value = serde_json::from_str(
            &fs::read_to_string(project.path().join(".claude/settings.local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(local["disabledMcpjsonServers"], json!([]));
        assert_eq!(local["enabledMcpjsonServers"], json!(["shared"]));

        // A local server is switched through .claude.json's project entry.
        let listing = set_enabled(
            "claude",
            &scope,
            &account_files,
            Source::Local,
            "chrome",
            true,
        )
        .unwrap();
        assert!(
            listing
                .servers
                .iter()
                .find(|s| s.id == "chrome")
                .unwrap()
                .enabled
        );
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&account_files.claude_json).unwrap()).unwrap();
        assert_eq!(
            root["projects"][&key]["disabledMcpServers"],
            json!(["user-one"])
        );
        assert_eq!(
            root["projects"][&key]["allowedTools"],
            json!([]),
            "other project keys kept"
        );
        assert!(set_enabled(
            "claude",
            &scope,
            &account_files,
            Source::Local,
            "nope",
            true
        )
        .is_err());
        // A user server can be switched off for this one project too.
        set_enabled(
            "claude",
            &scope,
            &account_files,
            Source::User,
            "user-one",
            true,
        )
        .unwrap();
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&account_files.claude_json).unwrap()).unwrap();
        assert_eq!(root["projects"][&key]["disabledMcpServers"], json!([]));

        // Adding and removing in each project file.
        let listing = add(
            "claude",
            &scope,
            &account_files,
            Source::Local,
            "local-two",
            &object(json!({"command": "two"})),
        )
        .unwrap();
        let two = listing
            .servers
            .iter()
            .find(|s| s.id == "local-two")
            .unwrap();
        assert_eq!(
            (two.source, two.transport.as_str()),
            (Source::Local, "stdio")
        );
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&account_files.claude_json).unwrap()).unwrap();
        assert_eq!(
            root["projects"][&key]["mcpServers"]["local-two"]["type"],
            json!("stdio")
        );
        let listing = add(
            "claude",
            &scope,
            &account_files,
            Source::Project,
            "shared-two",
            &object(json!({"type": "http", "url": "https://t"})),
        )
        .unwrap();
        assert_eq!(
            listing
                .servers
                .iter()
                .filter(|s| s.source == Source::Project)
                .count(),
            4
        );
        let listing = remove(
            "claude",
            &scope,
            &account_files,
            Source::Project,
            "shared-two",
        )
        .unwrap();
        assert_eq!(
            listing
                .servers
                .iter()
                .filter(|s| s.source == Source::Project)
                .count(),
            3
        );
        let listing = remove("claude", &scope, &account_files, Source::Local, "chrome").unwrap();
        assert!(!listing.servers.iter().any(|s| s.id == "chrome"));
        // A user server may be added from a project too; it lands at the top level.
        add(
            "claude",
            &scope,
            &account_files,
            Source::User,
            "u",
            &object(json!({"command": "u"})),
        )
        .unwrap();
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&account_files.claude_json).unwrap()).unwrap();
        assert_eq!(root["mcpServers"]["u"]["command"], json!("u"));

        // A fresh project with nothing configured lists nothing and can start a .mcp.json.
        let bare = tempfile::tempdir().unwrap();
        let bare_scope = Scope::Project {
            path: bare.path().to_path_buf(),
        };
        assert!(list("claude", &bare_scope, &account_files)
            .unwrap()
            .servers
            .is_empty());
        let listing = add(
            "claude",
            &bare_scope,
            &account_files,
            Source::Project,
            "first",
            &object(json!({"command": "f"})),
        )
        .unwrap();
        assert_eq!(listing.servers[0].approval, Some("pending"));
        assert!(bare.path().join(".mcp.json").is_file());
        assert!(list(
            "claude",
            &Scope::Project {
                path: "relative".into()
            },
            &account_files
        )
        .is_err());
    }

    #[test]
    fn native_workbench_services_mcp_codex_edits_config_toml_tables_and_keeps_comments() {
        let home = tempfile::tempdir().unwrap();
        let account_files = account_in(home.path());
        fs::create_dir_all(&account_files.dir).unwrap();
        let file = account_files.dir.join("config.toml");
        fs::write(
            &file,
            "# mine\nmodel = \"gpt-5\" # pinned\n\n[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n\n[mcp_servers.blender]\ncommand = \"blender-mcp\"\nenabled = false\n",
        )
        .unwrap();
        let listing = list("codex", &account(), &account_files).unwrap();
        assert_eq!(listing.servers.len(), 2);
        let linear = &listing.servers[0];
        assert_eq!(
            (
                linear.id.as_str(),
                linear.transport.as_str(),
                linear.enabled
            ),
            ("linear", "http", true)
        );
        assert_eq!(linear.url.as_deref(), Some("https://mcp.linear.app/mcp"));
        assert_eq!(linear.source, Source::User);
        assert_eq!(linear.path, file);
        let blender = &listing.servers[1];
        assert_eq!(
            (blender.transport.as_str(), blender.enabled),
            ("stdio", false)
        );
        assert_eq!(blender.command.as_deref(), Some("blender-mcp"));

        let listing = add(
            "codex",
            &account(),
            &account_files,
            Source::User,
            "docs",
            &object(json!({"command": "npx", "args": ["-y", "docs"], "env": {"K": "v"}, "startup_timeout_sec": 20})),
        )
        .unwrap();
        let docs = listing.servers.iter().find(|s| s.id == "docs").unwrap();
        assert_eq!(docs.args, Some(vec!["-y".to_string(), "docs".to_string()]));
        assert_eq!(docs.env, Some(object(json!({"K": "v"}))));
        assert_eq!(docs.config["startup_timeout_sec"], json!(20));
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.starts_with("# mine\nmodel = \"gpt-5\" # pinned\n"),
            "{text}"
        );
        assert!(
            text.contains("[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"-y\", \"docs\"]\n"),
            "{text}"
        );
        assert!(provider_settings::backup_of(&file).exists());

        let listing = set_enabled(
            "codex",
            &account(),
            &account_files,
            Source::User,
            "linear",
            false,
        )
        .unwrap();
        assert!(
            !listing
                .servers
                .iter()
                .find(|s| s.id == "linear")
                .unwrap()
                .enabled
        );
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.contains(
                "[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\nenabled = false\n"
            ),
            "{text}"
        );
        let listing = set_enabled(
            "codex",
            &account(),
            &account_files,
            Source::User,
            "blender",
            true,
        )
        .unwrap();
        assert!(
            listing
                .servers
                .iter()
                .find(|s| s.id == "blender")
                .unwrap()
                .enabled
        );
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.contains("[mcp_servers.blender]\ncommand = \"blender-mcp\"\n"),
            "{text}"
        );
        assert!(
            !text.contains("command = \"blender-mcp\"\nenabled"),
            "{text}"
        );
        assert!(set_enabled(
            "codex",
            &account(),
            &account_files,
            Source::User,
            "nope",
            true
        )
        .is_err());

        let listing = remove("codex", &account(), &account_files, Source::User, "linear").unwrap();
        assert_eq!(
            listing
                .servers
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["blender", "docs"]
        );
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains("linear"), "{text}");
        assert!(text.contains("# mine\n"), "{text}");
        assert!(remove("codex", &account(), &account_files, Source::User, "linear").is_err());
        let error = add(
            "codex",
            &account(),
            &account_files,
            Source::User,
            "odd",
            &object(json!({"command": "x", "type": "stdio"})),
        )
        .unwrap_err();
        assert!(error.contains("\"type\""), "{error}");
        assert!(add(
            "codex",
            &account(),
            &account_files,
            Source::Local,
            "x",
            &object(json!({"command": "x"}))
        )
        .is_err());

        // A project's own file, started from nothing.
        let project = tempfile::tempdir().unwrap();
        let scope = Scope::Project {
            path: project.path().to_path_buf(),
        };
        assert!(list("codex", &scope, &account_files)
            .unwrap()
            .servers
            .is_empty());
        let listing = add(
            "codex",
            &scope,
            &account_files,
            Source::Project,
            "here",
            &object(json!({"url": "https://h", "bearer_token_env_var": "TOKEN"})),
        )
        .unwrap();
        assert_eq!(listing.servers[0].source, Source::Project);
        assert_eq!(
            listing.servers[0].path,
            project.path().join(".codex/config.toml")
        );
        assert_eq!(
            fs::read_to_string(project.path().join(".codex/config.toml")).unwrap(),
            "[mcp_servers.here]\nurl = \"https://h\"\nbearer_token_env_var = \"TOKEN\"\n"
        );
        assert!(add(
            "codex",
            &scope,
            &account_files,
            Source::User,
            "x",
            &object(json!({"command": "x"}))
        )
        .is_err());
        // A malformed file is refused and left alone.
        fs::write(&file, "model = \n").unwrap();
        assert!(list("codex", &account(), &account_files).is_err());
        assert!(add(
            "codex",
            &account(),
            &account_files,
            Source::User,
            "x",
            &object(json!({"command": "x"}))
        )
        .is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "model = \n");
    }

    #[test]
    fn native_workbench_services_mcp_wire_shapes_and_url_reading() {
        let source: Source = serde_json::from_value(json!("local")).unwrap();
        assert_eq!(source, Source::Local);
        assert!(serde_json::from_value::<Source>(json!("managed")).is_err());
        let listing = Listing {
            servers: vec![Server {
                id: "a".into(),
                source: Source::Project,
                path: "/p/.mcp.json".into(),
                enabled: true,
                approval: Some("pending"),
                transport: "http".into(),
                command: None,
                args: None,
                url: Some("https://a".into()),
                env: None,
                headers: None,
                config: json!({"type": "http", "url": "https://a"}),
            }],
        };
        assert_eq!(
            serde_json::to_value(&listing).unwrap(),
            json!({"servers": [{"id": "a", "source": "project", "path": "/p/.mcp.json", "enabled": true, "approval": "pending", "transport": "http", "url": "https://a", "config": {"type": "http", "url": "https://a"}}]})
        );
        assert_eq!(
            serde_json::to_value(Started {
                started: true,
                url: None
            })
            .unwrap(),
            json!({"started": true})
        );
        assert_eq!(
            first_url("Open this: https://auth.example.com/authorize?x=1&y=2 and wait."),
            Some("https://auth.example.com/authorize?x=1&y=2".into())
        );
        assert_eq!(
            first_url("\u{1b}[1mhttps://a.b/c\u{1b}[0m"),
            Some("https://a.b/c".into())
        );
        assert_eq!(first_url("nothing here"), None);
        assert_eq!(first_url("https://"), None);
    }

    #[tokio::test]
    async fn native_workbench_services_mcp_login_answers_a_failed_command_with_its_last_line() {
        let home = tempfile::tempdir().unwrap();
        let account_files = account_in(home.path());
        // `codex mcp login` for a server nobody configured ends at once with an
        // error; the answer names it rather than claiming a login started.
        // Skipped when the program is not on this machine.
        if crate::routes::find_tool("codex", &[]).is_none() {
            return;
        }
        fs::create_dir_all(&account_files.dir).unwrap();
        let answer = login(
            "codex",
            &account(),
            &account_files,
            "no-such-server-here",
            false,
        )
        .await;
        match answer {
            Err(error) => assert!(error.starts_with("codex mcp login failed"), "{error}"),
            Ok(started) => assert!(started.started, "a slow start still counts as started"),
        }
        assert!(login("gemini", &account(), &account_files, "x", false)
            .await
            .is_err());
    }
}
