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

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
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

    pub fn read(&self, brand: &str) -> Result<ProviderDefaults, String> {
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
                })
            }
            "codex" => {
                let text = fs::read_to_string(&self.codex).unwrap_or_default();
                Ok(ProviderDefaults {
                    model: top_level_toml(&text, "model"),
                    effort: top_level_toml(&text, "model_reasoning_effort"),
                })
            }
            _ => Err("brand must be claude or codex".into()),
        }
    }

    pub fn write(&self, brand: &str, kind: &str, value: &str) -> Result<ProviderDefaults, String> {
        if !matches!(kind, "model" | "effort") || value.is_empty() || value.len() > 200 {
            return Err("provider default is invalid".into());
        }
        match brand {
            "claude" => {
                if kind == "effort" && value == "max" {
                    return Err("Claude does not allow Max as a persisted default".into());
                }
                let mut settings = json_settings(&self.claude)?;
                let key = if kind == "model" {
                    "model"
                } else {
                    "effortLevel"
                };
                if kind == "model" && value == "default" {
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
                } else {
                    "model_reasoning_effort"
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
    }
}
