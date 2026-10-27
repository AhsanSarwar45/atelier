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
    /// Whether new chats on this account start with the app approving their
    /// tool requests. The app's own setting, never the provider's.
    #[serde(rename = "autoApprove")]
    pub auto_approve: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OwnerSettings {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub auto_approve: bool,
}

/// Where the app keeps a default that is the app's own.
///
/// Auto-approve is not a setting Claude or Codex understands. Making it the
/// default must not put it in `settings.json` or `config.toml`: those files
/// are read by the owner's own terminal and by whatever his organisation
/// audits, and a key neither tool can parse is at best ignored and at worst a
/// broken config he did not write. It is kept beside them instead, in the same
/// account directory, so it still belongs to the account it was set under.
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
/// Whether new chats on an account directory start with auto-approve on.
///
/// An account that starred the old "Atelier automatic" mode has
/// `"permissionMode": "atelierAuto"` here instead, which meant the same thing
/// and is read as it (bw-q8ehk.1).
fn our_auto_approve_default(directory: &Path) -> bool {
    let Some(settings) = fs::read(directory.join(OUR_DEFAULTS))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return false;
    };
    settings.get("autoApprove").and_then(Value::as_bool) == Some(true)
        || settings.get("permissionMode").and_then(Value::as_str)
            == Some(super::answering::ATELIER_AUTO)
}

/// Write the app's own auto-approve default, dropping the old mode that used
/// to say it.
fn write_our_auto_approve_default(directory: &Path, on: bool) -> Result<(), String> {
    let path = directory.join(OUR_DEFAULTS);
    let mut settings = json_settings(&path)?;
    settings.remove("permissionMode");
    if on {
        settings.insert("autoApprove".into(), Value::Bool(true));
    } else {
        settings.remove("autoApprove");
    }
    if settings.is_empty() {
        // Nothing of ours left to say. The file is removed rather than left
        // as an empty object, so an account that never used auto-approve
        // looks exactly as it did before (bw-0z25.1).
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
    answer.auto_approve = our_auto_approve_default(claude_config);
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
        defaults.auto_approve = our_auto_approve_default(&self.our_directory(brand)?);
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
                    permission_mode: settings.get("permissions").and_then(Value::as_object)
                        .and_then(|permissions| permissions.get("defaultMode"))
                        .and_then(Value::as_str).map(str::to_string),
                    auto_approve: false,
                })
            }
            "codex" => {
                let text = fs::read_to_string(&self.codex).unwrap_or_default();
                Ok(ProviderDefaults {
                    model: top_level_toml(&text, "model"),
                    effort: top_level_toml(&text, "model_reasoning_effort"),
                    permission_mode: top_level_toml(&text, "approval_policy"),
                    auto_approve: false,
                })
            }
            _ => Err("brand must be claude or codex".into()),
        }
    }

    pub fn write(&self, brand: &str, kind: &str, value: &str) -> Result<ProviderDefaults, String> {
        if !matches!(kind, "model" | "effort" | "permission" | "autoApprove")
            || value.is_empty()
            || value.len() > 200
        {
            return Err("provider default is invalid".into());
        }
        if kind == "autoApprove" {
            // The provider's own files are left exactly as they were: the
            // owner's terminal keeps using them outside the app.
            let on = match value {
                "on" => true,
                "off" => false,
                _ => return Err("auto-approve default must be on or off".into()),
            };
            write_our_auto_approve_default(&self.our_directory(brand)?, on)?;
            return self.read(brand);
        }
        if kind == "permission" && value == super::answering::ATELIER_AUTO {
            return Err("auto-approve is its own setting, not a permission mode".into());
        }
        if kind == "permission" {
            // An account that starred the old mode keeps auto-approve on, now
            // written as its own setting, when it stars a provider mode.
            let directory = self.our_directory(brand)?;
            write_our_auto_approve_default(&directory, our_auto_approve_default(&directory))?;
        }
        match brand {
            "claude" => {
                if kind == "effort" && value == "max" {
                    return Err("Claude does not allow Max as a persisted default".into());
                }
                let mut settings = json_settings(&self.claude)?;
                let key = if kind == "model" { "model" } else if kind == "effort" { "effortLevel" } else { "permissions" };
                if kind == "permission" {
                    let permissions = settings.entry(key).or_insert_with(|| Value::Object(Map::new()));
                    permissions.as_object_mut().ok_or("Claude permissions setting is not an object")?
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
                let key = if kind == "model" { "model" } else if kind == "effort" { "model_reasoning_effort" } else { "approval_policy" };
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
            auto_approve: false,
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
        defaults.write("claude", "permission", "bypassPermissions").unwrap();
        assert_eq!(defaults.read("claude").unwrap().permission_mode.as_deref(), Some("bypassPermissions"));
        defaults.write("codex", "permission", "never").unwrap();
        assert_eq!(defaults.read("codex").unwrap().permission_mode.as_deref(), Some("never"));
    }

    /// Making auto-approve the default leaves the provider's settings alone.
    ///
    /// Claude reads its own `settings.json` and has never heard of
    /// auto-approve; writing it there would put a key Claude cannot parse into
    /// the file the owner's own terminal reads.
    #[test]
    fn the_auto_approve_default_is_not_written_into_the_providers_settings() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        let defaults = ProviderDefaultFiles::new(&claude, &codex);

        defaults.write("claude", "permission", "plan").unwrap();
        let read = defaults.write("claude", "autoApprove", "on").unwrap();

        let settings = fs::read_to_string(claude.join("settings.json")).unwrap();
        assert!(
            settings.contains("\"defaultMode\": \"plan\""),
            "Claude's own default was rewritten: {settings}"
        );
        assert!(!settings.contains("autoApprove"), "{settings}");
        assert!(read.auto_approve);
        assert_eq!(read.permission_mode.as_deref(), Some("plan"));
    }

    /// Auto-approve and the permission mode are two defaults. Starring a mode
    /// leaves auto-approve on, and turning it off removes the app's file.
    #[test]
    fn the_mode_default_and_auto_approve_are_independent() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        let defaults = ProviderDefaultFiles::new(&claude, &codex);

        defaults.write("claude", "autoApprove", "on").unwrap();
        let read = defaults.write("claude", "permission", "acceptEdits").unwrap();
        assert!(read.auto_approve);
        assert_eq!(read.permission_mode.as_deref(), Some("acceptEdits"));

        assert!(!defaults.write("claude", "autoApprove", "off").unwrap().auto_approve);
        assert!(
            !claude.join(OUR_DEFAULTS).exists(),
            "an account with auto-approve off still carries the app's file"
        );
        assert!(defaults.write("claude", "permission", super::super::answering::ATELIER_AUTO).is_err());
    }

    /// An account that starred the old "Atelier automatic" mode keeps new
    /// chats auto-approving, and keeps the provider's own mode default.
    #[test]
    fn the_old_starred_mode_is_read_as_auto_approve() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let project = root.path().join("project");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&claude).unwrap();
        fs::write(claude.join("settings.json"), r#"{"permissions":{"defaultMode":"plan"}}"#).unwrap();
        fs::write(claude.join(OUR_DEFAULTS), r#"{"permissionMode":"atelierAuto"}"#).unwrap();

        let owner = read_owner_settings(&claude, &project);
        assert!(owner.auto_approve);
        assert_eq!(owner.permission_mode.as_deref(), Some("plan"));

        let defaults = ProviderDefaultFiles::new(&claude, &root.path().join("codex"));
        defaults.write("claude", "permission", "default").unwrap();
        let ours = fs::read_to_string(claude.join(OUR_DEFAULTS)).unwrap();
        assert!(ours.contains("\"autoApprove\": true"), "{ours}");
        assert!(!ours.contains("atelierAuto"), "{ours}");
    }
}
