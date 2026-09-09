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
    pub runtime: Option<PathBuf>,
    pub reason: Option<String>,
}

/// The user-owned program an ACP adapter drives.
///
/// Atelier owns and pins the protocol adapter because that is part of its wire
/// contract. It does not own the provider runtime: models, authentication and
/// capabilities belong to the provider installation the user keeps current.
struct ExternalRuntime {
    brand: &'static str,
    adapter_variable: &'static str,
}

const EXTERNAL_RUNTIMES: &[ExternalRuntime] = &[
    ExternalRuntime {
        brand: "claude",
        adapter_variable: "CLAUDE_CODE_EXECUTABLE",
    },
    ExternalRuntime {
        brand: "codex",
        adapter_variable: "CODEX_PATH",
    },
];

fn external_runtime(brand: &str) -> Option<&'static ExternalRuntime> {
    EXTERNAL_RUNTIMES
        .iter()
        .find(|runtime| runtime.brand == brand)
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
            .map(|prefix| {
                prefix
                    .join("lib")
                    .join("atelier")
                    .join("atelier-adapters")
                    .join(&name)
            })
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
    provider: Option<&Path>,
) -> Option<AcpAgentConfig> {
    let mut config = AcpAgentConfig::new(&executable);
    if brand == super::super::local::BRAND {
        let (runtime, model) = super::super::local::decode_model(model?)?;
        let root = crate::identity::data_dir()?.join("goose");
        // Put Atelier's gates where this session will look for them. Best
        // effort on purpose: a plugin that cannot be written is a session
        // without gates, which is what every local session was until now, and
        // refusing to start one instead would be a worse answer than the one
        // it replaces (bw-lbkg.1).
        if let Err(error) = crate::join::goose_plugin(&root) {
            eprintln!("atelier: could not install the Goose gate plugin: {error}");
        }
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
    let runtime = external_runtime(brand)?;
    config = config.env(runtime.adapter_variable, provider?.to_string_lossy());
    if brand == "claude" {
        // The checklist panel is drawn from ACP `plan` updates, and the adapter
        // makes one out of every TodoWrite and every TaskCreate/TaskUpdate/
        // TaskList the agent runs. The provider, though, withholds those tools
        // by default from Opus 4.8, Sonnet 5, Fable 5, Mythos 5 and anything
        // newer — so on the models anyone would actually pick, the agent had no
        // way to keep a checklist, said so in its own words, and the panel that
        // this app has built, folded and drawn all along could never appear
        // (bw-t26l.20). This is the switch the provider itself documents for
        // handing them back.
        config = config.env("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1");
    }
    Some(config)
}

pub fn launch_config(brand: &str, model: Option<&str>) -> Option<AcpAgentConfig> {
    let adapter = find(brand)?;
    let provider =
        external_runtime(brand).and_then(|runtime| crate::routes::find_tool(runtime.brand, &[]));
    launch_config_at(adapter, brand, model, provider.as_deref())
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
            runtime: None,
            reason: Some(format!("the bundled {brand} ACP adapter was not found")),
        };
    };
    if brand == super::super::local::BRAND {
        return Availability {
            available: true,
            adapter: Some(adapter),
            runtime: None,
            reason: None,
        };
    }
    let Some(runtime) = external_runtime(brand) else {
        return Availability {
            available: false,
            adapter: Some(adapter),
            runtime: None,
            reason: Some(format!("{brand} is not a registered external provider")),
        };
    };
    let Some(provider) = crate::routes::find_tool(runtime.brand, &[]) else {
        return Availability {
            available: false,
            adapter: Some(adapter),
            runtime: None,
            reason: Some(format!("the user-installed {brand} provider was not found")),
        };
    };
    Availability {
        available: true,
        adapter: Some(adapter),
        runtime: Some(provider),
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
    fn external_adapter_requires_a_user_provider_runtime() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root.path().join(executable_name("claude"));
        std::fs::write(&adapter, b"adapter").unwrap();
        assert!(launch_config_at(adapter, "claude", None, None).is_none());
    }

    /// The checklist panel needs the tools the checklist is made of.
    ///
    /// The adapter turns TodoWrite and the Task* tools into ACP `plan` updates,
    /// which is the only thing the panel is ever drawn from — and the provider
    /// withholds those tools by default on every current model, so without this
    /// the panel is unreachable through the bundled Claude runtime and the
    /// agent tells the person there is no checklist tool at all (bw-t26l.20).
    #[test]
    fn claude_adapter_keeps_the_checklist_tools_the_plan_panel_is_drawn_from() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root.path().join(executable_name("claude"));
        let provider = root.path().join(if cfg!(windows) {
            "claude-provider.exe"
        } else {
            "claude-provider"
        });
        std::fs::write(&adapter, b"adapter").unwrap();
        std::fs::write(&provider, b"provider").unwrap();
        let config = launch_config_at(adapter, "claude", None, Some(&provider)).unwrap();
        assert_eq!(
            config.environment().get("CLAUDE_CODE_ENABLE_TODO_TOOLS"),
            Some(&"1".to_string())
        );
    }

    #[test]
    fn every_external_adapter_uses_the_user_runtime_not_a_bundled_shadow() {
        let root = tempfile::tempdir().unwrap();
        for runtime in EXTERNAL_RUNTIMES {
            let adapter = root.path().join(executable_name(runtime.brand));
            let bundled_shadow = root.path().join(format!("{}-provider", runtime.brand));
            let installed = root.path().join("user-bin").join(runtime.brand);
            std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
            std::fs::write(&adapter, b"adapter").unwrap();
            std::fs::write(&bundled_shadow, b"old bundled provider").unwrap();
            std::fs::write(&installed, b"current user provider").unwrap();

            let config = launch_config_at(adapter, runtime.brand, None, Some(&installed)).unwrap();
            let expected = installed.to_string_lossy().to_string();
            assert_eq!(
                config.environment().get(runtime.adapter_variable),
                Some(&expected)
            );
            assert_ne!(
                config.environment().get(runtime.adapter_variable),
                Some(&bundled_shadow.to_string_lossy().to_string())
            );
        }
    }

    #[test]
    fn local_adapter_requires_an_explicit_runtime_model() {
        let root = tempfile::tempdir().unwrap();
        let adapter = root
            .path()
            .join(executable_name(super::super::super::local::BRAND));
        std::fs::write(&adapter, b"adapter").unwrap();
        assert!(launch_config_at(
            adapter.clone(),
            super::super::super::local::BRAND,
            None,
            None
        )
        .is_none());
        assert!(launch_config_at(
            adapter,
            super::super::super::local::BRAND,
            Some("ollama::qwen"),
            None
        )
        .is_some());
    }
}
