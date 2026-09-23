//! Atomic provider-default reads and writes without a Node settings helper.

use serde::Serialize;
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProviderDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OwnerSettings {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
}

/// Where the app keeps a default that is the app's own.
///
/// "Atelier automatic" is not a word Claude or Codex understands. Starring it
/// must not put it in `settings.json` or `config.toml`: those files are read
/// by the owner's own terminal and by whatever his organisation audits, and a
/// mode neither tool can parse is at best ignored and at worst a broken
/// config he did not write. It is kept beside them instead, in the same
/// account directory, so it still belongs to the account it was starred under.
const OUR_DEFAULTS: &str = "atelier-defaults.json";

pub(crate) fn managed_claude_settings() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json");
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("ClaudeCode/managed-settings.json");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        PathBuf::from("/etc/claude-code/managed-settings.json")
    }
}

/// Claude's own settings cascade, lowest precedence first. These files are
/// read only: steering one chat must never rewrite the owner's global config.
/// The app's own starred permission mode for an account directory, if any.
fn our_permission_default(directory: &Path) -> Option<String> {
    fs::read(directory.join(OUR_DEFAULTS))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?
        .get("permissionMode")?
        .as_str()
        .filter(|mode| !mode.is_empty())
        .map(str::to_string)
}

/// Write, or clear, the app's own starred permission mode.
fn write_our_permission_default(directory: &Path, mode: Option<&str>) -> Result<(), String> {
    let path = directory.join(OUR_DEFAULTS);
    let mut settings = json_settings(&path)?;
    match mode {
        Some(mode) => {
            settings.insert("permissionMode".into(), Value::String(mode.into()));
        }
        None => {
            settings.remove("permissionMode");
        }
    }
    if settings.is_empty() {
        // Nothing of ours left to say. The file is removed rather than left
        // as an empty object, so an account that never used the app's own
        // mode looks exactly as it did before (bw-0z25.1).
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let mut bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    atomic_write(&path, &bytes)
}

pub fn read_owner_settings(claude_config: &Path, project: &Path) -> OwnerSettings {
    let layers = [
        claude_config.join("settings.json"),
        project.join(".claude/settings.json"),
        project.join(".claude/settings.local.json"),
        managed_claude_settings(),
    ];
    let mut answer = OwnerSettings::default();
    for path in layers {
        let Some(settings) = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_object().cloned())
        else {
            continue;
        };
        if let Some(value) = settings
            .get("model")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            answer.model = Some(value.to_string());
        }
        if let Some(value) = settings
            .get("effortLevel")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            answer.effort = Some(value.to_string());
        }
        if let Some(value) = settings
            .get("permissions")
            .and_then(Value::as_object)
            .and_then(|permissions| permissions.get("defaultMode"))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            answer.permission_mode = Some(value.to_string());
        }
    }
    // The app's own mode outranks the cascade. It is only ever there because
    // he starred it, and he starred it in this app; Claude's own files cannot
    // hold it to be overridden by.
    if let Some(mode) = our_permission_default(claude_config) {
        answer.permission_mode = Some(mode);
    }
    answer
}

fn json_settings(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    serde_json::from_slice::<Value>(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{} is not a settings object", path.display()))
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("settings path has no parent")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!(
        "atelier-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn top_level_toml(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.split('#').next()?.trim();
        if value.len() >= 2
            && matches!(value.as_bytes()[0], b'\'' | b'"')
            && value.as_bytes().last() == value.as_bytes().first()
        {
            return Some(value[1..value.len() - 1].to_string());
        }
    }
    None
}

fn set_top_level_toml(text: &str, key: &str, value: Option<&str>) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let table = lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len());
    if let Some(at) = lines[..table].iter().position(|line| {
        line.split_once('=')
            .is_some_and(|(name, _)| name.trim() == key)
    }) {
        lines.remove(at);
    }
    if let Some(value) = value {
        let table = lines
            .iter()
            .position(|line| line.trim_start().starts_with('['))
            .unwrap_or(lines.len());
        let encoded = serde_json::to_string(value).unwrap();
        lines.insert(table, format!("{key} = {encoded}"));
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

#[derive(Clone, Debug)]
pub struct ProviderDefaultFiles {
    claude: PathBuf,
    codex: PathBuf,
}

impl ProviderDefaultFiles {
    pub fn new(claude_config: &Path, codex_home: &Path) -> Self {
        Self {
            claude: claude_config.join("settings.json"),
            codex: codex_home.join("config.toml"),
        }
    }

    /// The files inside one account's directory. A profile belongs to a single
    /// brand, so only the matching one of these two is ever read or written;
    /// the other names a file that brand's CLI does not keep there.
    pub fn in_directory(directory: &Path) -> Self {
        Self::new(directory, directory)
    }

    /// The account directory the app keeps its own defaults in, which is the
    /// one the brand's own settings file sits in.
    fn our_directory(&self, brand: &str) -> Result<PathBuf, String> {
        let file = match brand {
            "claude" => &self.claude,
            "codex" => &self.codex,
            _ => return Err("brand must be claude or codex".into()),
        };
        file.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "settings path has no parent".to_string())
    }

    pub fn read(&self, brand: &str) -> Result<ProviderDefaults, String> {
        let mut defaults = self.read_provider(brand)?;
        if let Some(mode) = our_permission_default(&self.our_directory(brand)?) {
            defaults.permission_mode = Some(mode);
        }
        Ok(defaults)
    }

    fn read_provider(&self, brand: &str) -> Result<ProviderDefaults, String> {
        match brand {
            "claude" => {
                let settings = json_settings(&self.claude)?;
                Ok(ProviderDefaults {
                    model: settings
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    effort: settings
                        .get("effortLevel")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    permission_mode: settings
                        .get("permissions")
                        .and_then(Value::as_object)
                        .and_then(|permissions| permissions.get("defaultMode"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            }
            "codex" => {
                let text = fs::read_to_string(&self.codex).unwrap_or_default();
                Ok(ProviderDefaults {
                    model: top_level_toml(&text, "model"),
                    effort: top_level_toml(&text, "model_reasoning_effort"),
                    permission_mode: top_level_toml(&text, "approval_policy"),
                })
            }
            _ => Err("brand must be claude or codex".into()),
        }
    }

    pub fn write(&self, brand: &str, kind: &str, value: &str) -> Result<ProviderDefaults, String> {
        if !matches!(kind, "model" | "effort" | "permission")
            || value.is_empty()
            || value.len() > 200
        {
            return Err("provider default is invalid".into());
        }
        if kind == "permission" {
            let directory = self.our_directory(brand)?;
            if value == super::answering::ATELIER_AUTO {
                // The provider's own default is left exactly as it was. It is
                // what the chat runs in while the app answers, and it is what
                // the owner's terminal keeps using outside the app.
                write_our_permission_default(&directory, Some(value))?;
                return self.read(brand);
            }
            // Starring any other mode is the owner taking the app back out of
            // answering for him. Ours is cleared first, or the star would not
            // move (bw-0z25.1).
            write_our_permission_default(&directory, None)?;
        }
        match brand {
            "claude" => {
                if kind == "effort" && value == "max" {
                    return Err("Claude does not allow Max as a persisted default".into());
                }
                let mut settings = json_settings(&self.claude)?;
                let key = if kind == "model" {
                    "model"
                } else if kind == "effort" {
                    "effortLevel"
                } else {
                    "permissions"
                };
                if kind == "permission" {
                    let permissions = settings
                        .entry(key)
                        .or_insert_with(|| Value::Object(Map::new()));
                    permissions
                        .as_object_mut()
                        .ok_or("Claude permissions setting is not an object")?
                        .insert("defaultMode".into(), Value::String(value.into()));
                } else if kind == "model" && value == "default" {
                    settings.remove(key);
                } else {
                    settings.insert(key.into(), Value::String(value.into()));
                }
                let mut bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
                bytes.push(b'\n');
                atomic_write(&self.claude, &bytes)?;
            }
            "codex" => {
                let text = fs::read_to_string(&self.codex).unwrap_or_default();
                let key = if kind == "model" {
                    "model"
                } else if kind == "effort" {
                    "model_reasoning_effort"
                } else {
                    "approval_policy"
                };
                let value = (kind != "model" || value != "default").then_some(value);
                atomic_write(
                    &self.codex,
                    set_top_level_toml(&text, key, value).as_bytes(),
                )?;
            }
            _ => return Err("brand must be claude or codex".into()),
        }
        self.read(brand)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_use_the_browser_protocol_name_for_permission_mode() {
        let value = serde_json::to_value(ProviderDefaults {
            model: None,
            effort: None,
            permission_mode: Some("never".into()),
        })
        .unwrap();

        assert_eq!(value["permissionMode"], "never");
        assert!(value.get("permission_mode").is_none());
    }

    #[test]
    fn native_workbench_services_registry_preserves_provider_configuration() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        fs::create_dir_all(&codex).unwrap();
        fs::write(
            codex.join("config.toml"),
            "approval_policy = \"ask\"\n[projects.x]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();
        let defaults = ProviderDefaultFiles::new(&claude, &codex);
        defaults.write("codex", "model", "gpt-5").unwrap();
        let text = fs::read_to_string(codex.join("config.toml")).unwrap();
        assert!(text.contains("model = \"gpt-5\""));
        assert!(text.contains("approval_policy = \"ask\""));
        assert!(text.contains("[projects.x]"));
        defaults.write("claude", "effort", "high").unwrap();
        assert_eq!(
            defaults.read("claude").unwrap().effort.as_deref(),
            Some("high")
        );
        defaults
            .write("claude", "permission", "bypassPermissions")
            .unwrap();
        assert_eq!(
            defaults.read("claude").unwrap().permission_mode.as_deref(),
            Some("bypassPermissions")
        );
        defaults.write("codex", "permission", "never").unwrap();
        assert_eq!(
            defaults.read("codex").unwrap().permission_mode.as_deref(),
            Some("never")
        );
    }

    /// Starring the app's own mode leaves the provider's settings file alone.
    ///
    /// Claude reads `permissions.defaultMode` itself and has never heard of
    /// "atelierAuto"; writing it there would put a mode Claude cannot parse
    /// into the file the owner's own terminal reads.
    #[test]
    fn the_apps_own_default_is_not_written_into_the_providers_settings() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        let defaults = ProviderDefaultFiles::new(&claude, &codex);

        defaults.write("claude", "permission", "plan").unwrap();
        defaults
            .write(
                "claude",
                "permission",
                super::super::answering::ATELIER_AUTO,
            )
            .unwrap();

        let settings = fs::read_to_string(claude.join("settings.json")).unwrap();
        assert!(
            settings.contains("\"defaultMode\": \"plan\""),
            "Claude's own default was rewritten: {settings}"
        );
        assert!(!settings.contains("atelierAuto"), "{settings}");
        assert_eq!(
            defaults.read("claude").unwrap().permission_mode.as_deref(),
            Some(super::super::answering::ATELIER_AUTO)
        );
    }

    /// The star has to be able to move back off the app's own mode.
    #[test]
    fn starring_a_providers_mode_takes_the_app_back_out_of_answering() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        let defaults = ProviderDefaultFiles::new(&claude, &codex);

        defaults
            .write(
                "claude",
                "permission",
                super::super::answering::ATELIER_AUTO,
            )
            .unwrap();
        defaults
            .write("claude", "permission", "acceptEdits")
            .unwrap();

        assert_eq!(
            defaults.read("claude").unwrap().permission_mode.as_deref(),
            Some("acceptEdits")
        );
        assert!(
            !claude.join(OUR_DEFAULTS).exists(),
            "an account back on a provider mode still carries the app's file"
        );
    }

    /// A chat started on the starred mode has to start in it. New Claude chats
    /// take their mode from the settings cascade, which is why the app's own
    /// default is overlaid onto it rather than kept somewhere only the star
    /// reads.
    #[test]
    fn a_new_chat_starts_in_the_starred_mode() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let project = root.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let defaults = ProviderDefaultFiles::new(&claude, &root.path().join("codex"));
        defaults
            .write(
                "claude",
                "permission",
                super::super::answering::ATELIER_AUTO,
            )
            .unwrap();

        assert_eq!(
            read_owner_settings(&claude, &project)
                .permission_mode
                .as_deref(),
            Some(super::super::answering::ATELIER_AUTO)
        );
    }
}
