//! Locate release-bundled ACP adapter executables without a runtime package manager.

use agent_client_protocol::AcpAgentConfig;
use std::path::{Path, PathBuf};

pub const CLAUDE_ADAPTER_VERSION: &str = "0.73.0";
pub const CODEX_ADAPTER_VERSION: &str = "1.8.0";
pub const GOOSE_ADAPTER_VERSION: &str = "1.41.0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Availability {
    pub available: bool,
    pub adapter: Option<PathBuf>,
    pub reason: Option<String>,
}

fn executable_name(brand: &str) -> String {
    let brand = if brand == super::super::local::BRAND {
        "goose"
    } else {
        brand
    };
    if cfg!(windows) {
        format!("{brand}-acp.exe")
    } else {
        format!("{brand}-acp")
    }
}

fn env_name(brand: &str) -> String {
    let brand = if brand == super::super::local::BRAND {
        "goose"
    } else {
        brand
    };
    format!("ATELIER_ACP_{}_PATH", brand.to_ascii_uppercase())
}

pub fn bundled_beside(program: &Path, brand: &str) -> Option<PathBuf> {
    let directory = program.parent()?;
    let name = executable_name(brand);
    [
        directory.join("atelier-adapters").join(&name),
        directory
            .parent()
            .map(|prefix| prefix.join("libexec").join("atelier-adapters").join(&name))
            .unwrap_or_default(),
        directory
            .parent()
            .map(|prefix| prefix.join("bin").join("atelier-adapters").join(&name))
            .unwrap_or_default(),
        directory
            .parent()
            .map(|prefix| prefix.join("lib").join("atelier").join("atelier-adapters").join(&name))
            .unwrap_or_default(),
        directory.join("adapters").join(&name),
        directory.join(&name),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

pub fn find(brand: &str) -> Option<PathBuf> {
    std::env::var_os(env_name(brand))
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|program| bundled_beside(&program, brand))
        })
}

fn launch_config_at(
    executable: PathBuf,
    brand: &str,
    model: Option<&str>,
) -> Option<AcpAgentConfig> {
    let mut config = AcpAgentConfig::new(&executable);
    if brand == super::super::local::BRAND {
        let (runtime, model) = super::super::local::decode_model(model?)?;
        let root = crate::identity::data_dir()?.join("goose");
        config = config
            .args(["acp", "--with-builtin", "developer,summon"])
            .env("GOOSE_PATH_ROOT", root.to_string_lossy())
            .env("GOOSE_DISABLE_KEYRING", "true")
            .env("GOOSE_PROVIDER", runtime.provider())
            .env("GOOSE_MODEL", model);
        return Some(match runtime {
            super::super::local::Runtime::Ollama => config.env("OLLAMA_HOST", runtime.endpoint()),
            super::super::local::Runtime::OpenAiCompatible => {
                let endpoint = runtime.endpoint();
                let host = endpoint.strip_suffix("/v1").unwrap_or(&endpoint);
                config
                    .env("OPENAI_HOST", host)
                    .env("OPENAI_BASE_PATH", "v1/chat/completions")
                    .env(
                        "OPENAI_API_KEY",
                        runtime.api_key().unwrap_or_else(|| "atelier-local".into()),
                    )
            }
        });
    }
    let provider_name = match brand {
        "codex" => "codex-provider",
        "claude" => "claude-provider",
        _ => return Some(config),
    };
    let provider = executable.parent()?.join(if cfg!(windows) {
        format!("{provider_name}.exe")
    } else {
        provider_name.to_string()
    });
    if !provider.is_file() {
        return None;
    }
    if brand == "codex" {
        let code_mode_host = executable.parent()?.join(if cfg!(windows) {
            "codex-code-mode-host.exe"
        } else {
            "codex-code-mode-host"
        });
        if !code_mode_host.is_file() {
            return None;
        }
    }
    let variable = if brand == "codex" {
        "CODEX_PATH"
    } else {
        "CLAUDE_CODE_EXECUTABLE"
    };
    config = config.env(variable, provider.to_string_lossy());
    Some(config)
}

pub fn launch_config(brand: &str, model: Option<&str>) -> Option<AcpAgentConfig> {
    launch_config_at(find(brand)?, brand, model)
}

/// Whether this installation contains the complete pinned ACP runtime.
///
/// Provider support is an ACP bundle fact. It must not depend on whether a
/// separately installed legacy CLI happens to be on PATH, and a missing
/// companion executable must not be reported to the client as the same thing
/// as an unsupported provider.
pub fn availability(brand: &str) -> Availability {
    let Some(adapter) = find(brand) else {
        return Availability {
            available: false,
            adapter: None,
            reason: Some(format!("the bundled {brand} ACP adapter was not found")),
        };
    };
    if brand == super::super::local::BRAND {
        return Availability {
            available: true,
            adapter: Some(adapter),
            reason: None,
        };
    }
    if launch_config_at(adapter.clone(), brand, None).is_none() {
        return Availability {
            available: false,
            adapter: Some(adapter),
            reason: Some(format!("the bundled {brand} ACP runtime is incomplete")),
        };
    }
    Availability {
        available: true,
        adapter: Some(adapter),
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_adapter_is_found_without_node_or_a_package_manager() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join(if cfg!(windows) {
            "atelier.exe"
        } else {
            "atelier"
        });
        std::fs::write(&program, b"app").unwrap();
        let adapters = root.path().join("atelier-adapters");
        std::fs::create_dir(&adapters).unwrap();
        let adapter = adapters.join(executable_name("claude"));
        std::fs::write(&adapter, b"adapter").unwrap();

        assert_eq!(bundled_beside(&program, "claude"), Some(adapter));
    }

    #[test]
    fn release_adapter_is_found_from_a_libexec_server() {
        let root = tempfile::tempdir().unwrap();
        let program = root.path().join("libexec").join("atelier-server");
        std::fs::create_dir(program.parent().unwrap()).unwrap();
        std::fs::write(&program, b"app").unwrap();
        let adapters = root.path().join("bin").join("atelier-adapters");
        std::fs::create_dir_all(&adapters).unwrap();
        let adapter = adapters.join(executable_name("claude"));
        std::fs::write(&adapter, b"adapter").unwrap();

        assert_eq!(bundled_beside(&program, "claude"), Some(adapter));
    }

    #[test]
    fn versions_are_release_pinned() {
        assert_eq!(CLAUDE_ADAPTER_VERSION, "0.73.0");
        assert_eq!(CODEX_ADAPTER_VERSION, "1.8.0");
        assert_eq!(GOOSE_ADAPTER_VERSION, "1.41.0");
    }

    #[test]
    fn adapter_never_falls_back_to_an_unpinned_provider_from_path() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root.path().join(executable_name("claude"));
        std::fs::write(&adapter, b"adapter").unwrap();
        assert!(launch_config_at(adapter, "claude", None).is_none());
    }

    #[test]
    fn codex_adapter_uses_the_release_pinned_provider_binary() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root.path().join(executable_name("codex"));
        let provider = root.path().join(if cfg!(windows) {
            "codex-provider.exe"
        } else {
            "codex-provider"
        });
        let host = root.path().join(if cfg!(windows) {
            "codex-code-mode-host.exe"
        } else {
            "codex-code-mode-host"
        });
        std::fs::write(&adapter, b"adapter").unwrap();
        std::fs::write(&provider, b"provider").unwrap();
        std::fs::write(&host, b"host").unwrap();
        let config = launch_config_at(adapter, "codex", None).unwrap();
        let expected = provider.to_string_lossy().to_string();
        assert_eq!(config.environment().get("CODEX_PATH"), Some(&expected));
    }

    #[test]
    fn bundled_codex_runtime_refuses_to_start_without_its_code_mode_host() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root.path().join(executable_name("codex"));
        let provider = root.path().join(if cfg!(windows) {
            "codex-provider.exe"
        } else {
            "codex-provider"
        });
        std::fs::write(&adapter, b"adapter").unwrap();
        std::fs::write(&provider, b"provider").unwrap();
        assert!(launch_config_at(adapter, "codex", None).is_none());
    }

    #[test]
    fn local_adapter_requires_an_explicit_runtime_model() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root
            .path()
            .join(executable_name(super::super::super::local::BRAND));
        std::fs::write(&adapter, b"adapter").unwrap();
        assert!(
            launch_config_at(adapter.clone(), super::super::super::local::BRAND, None).is_none()
        );
        assert!(launch_config_at(
            adapter,
            super::super::super::local::BRAND,
            Some("ollama::qwen")
        )
        .is_some());
    }
}
