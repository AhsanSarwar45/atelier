//! One provider-neutral owner for native workbench services and live drivers.

use super::actor::ChatDb;
use super::agent_files;
use super::browser::{self, BrowserCapture, BrowserRecipe};
use super::external::{self, ProviderHold};
use super::media;
use super::protocol::{Command, CommandKind};
use super::provider_defaults::ProviderDefaultFiles;
use super::screen_check::{self, StoredCapture, StoredComparison};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

pub type DriverFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
pub type LaunchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<LaunchedSession, String>> + Send + 'a>>;

/// A live provider behind the browser's existing command vocabulary.
pub trait ProviderDriver: Send {
    fn brand(&self) -> &'static str;
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a>;
    fn close<'a>(&'a mut self) -> DriverFuture<'a>;
}

pub struct LaunchedSession {
    pub session_id: String,
    pub reply: Value,
    pub driver: Box<dyn ProviderDriver>,
}

/// Starts or opens a provider transactionally. It must return only after the
/// provider initialized and its database row exists; failures leave neither a
/// registry entry nor an orphan chat row.
pub trait SessionFactory: Send + Sync {
    fn launch<'a>(&'a self, database: ChatDb, command: &'a Command) -> LaunchFuture<'a>;
}

/// Temporary production seam while provider processes move in-process.
/// Read-only chat history and provider-independent commands remain available;
/// starting or resuming a provider reports an honest error instead of falling
/// back to the Node helper we are removing.
pub struct UnavailableFactory;

impl SessionFactory for UnavailableFactory {
    fn launch<'a>(&'a self, _: ChatDb, _: &'a Command) -> LaunchFuture<'a> {
        Box::pin(async {
            Err("native provider supervision is not ready in this build".to_string())
        })
    }
}

#[derive(Clone)]
pub struct RegistryPaths {
    pub home: PathBuf,
    pub claude_config: PathBuf,
    pub codex_home: PathBuf,
    pub media: PathBuf,
}

type Driver = Arc<Mutex<Box<dyn ProviderDriver>>>;

pub struct WorkbenchRegistry {
    database: ChatDb,
    factory: Arc<dyn SessionFactory>,
    drivers: RwLock<HashMap<String, Driver>>,
    paths: RegistryPaths,
    defaults: ProviderDefaultFiles,
}

impl WorkbenchRegistry {
    pub fn new(database: ChatDb, paths: RegistryPaths, factory: Arc<dyn SessionFactory>) -> Self {
        let defaults = ProviderDefaultFiles::new(&paths.claude_config, &paths.codex_home);
        Self {
            database,
            factory,
            drivers: RwLock::new(HashMap::new()),
            paths,
            defaults,
        }
    }

    pub fn database(&self) -> &ChatDb {
        &self.database
    }

    pub fn media_directory(&self) -> &Path {
        &self.paths.media
    }

    pub fn provider_holds(&self, proc_root: &Path, now_ms: i64) -> Vec<ProviderHold> {
        external::provider_holds(
            &self.paths.claude_config,
            proc_root,
            &self.paths.codex_home,
            now_ms,
        )
    }

    pub fn present(
        &self,
        args: &[String],
        stdin: &str,
        files: &std::collections::BTreeMap<String, Vec<u8>>,
    ) -> Result<String, String> {
        media::present_uploaded(args, stdin, files, &self.paths.media)
    }

    pub async fn capture_browser(
        &self,
        recipe: &BrowserRecipe,
        files: &std::collections::BTreeMap<String, Vec<u8>>,
    ) -> Result<BrowserCapture, String> {
        browser::capture_recipe(recipe, files).await
    }

    pub fn store_capture(
        &self,
        bytes: &[u8],
        label: &str,
        source: &str,
    ) -> Result<StoredCapture, String> {
        screen_check::store_static(bytes, label, source, &self.paths.media)
    }

    pub fn compare_captures(
        &self,
        before: &[u8],
        after: &[u8],
    ) -> Result<StoredComparison, String> {
        screen_check::compare_and_store(before, after, &self.paths.media)
    }

    pub async fn has_driver(&self, session_id: &str) -> bool {
        self.drivers.read().await.contains_key(session_id)
    }

    async fn launch(&self, command: &Command) -> Result<Value, String> {
        let launched = self.factory.launch(self.database.clone(), command).await?;
        let mut drivers = self.drivers.write().await;
        if drivers.contains_key(&launched.session_id) {
            drop(drivers);
            let mut driver = launched.driver;
            let _ = driver.close().await;
            return Err(format!("session {} is already open", launched.session_id));
        }
        drivers.insert(launched.session_id, Arc::new(Mutex::new(launched.driver)));
        Ok(launched.reply)
    }

    fn field<'a>(command: &'a Command, name: &str) -> Result<&'a str, String> {
        command
            .fields
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{name} is required"))
    }

    async fn driver_command(&self, command: &Command) -> Result<Value, String> {
        let session_id = Self::field(command, "sessionId")?;
        let closing = command.kind == CommandKind::SessionClose;
        let driver = if closing {
            self.drivers.write().await.remove(session_id)
        } else {
            self.drivers.read().await.get(session_id).cloned()
        }
        .ok_or_else(|| format!("no live session {session_id}"))?;
        let mut driver = driver.lock().await;
        let result = driver.command(command).await;
        if closing {
            let closed = driver.close().await;
            result.and(closed.map(|_| json!({"ok":true})))
        } else {
            result
        }
    }

    /// Execute one already-decoded WBP command and return the exact JSON body
    /// the former helper returned. Unknown discriminators have already been
    /// refused by `protocol::Command` before they can reach this registry.
    pub async fn execute(&self, command: &Command) -> Result<Value, String> {
        match command.kind {
            CommandKind::AgentFilesList => {
                let project = Self::field(command, "projectPath")?;
                let files = agent_files::discover(
                    Some(Path::new(project)),
                    &self.paths.home,
                    Some(&self.paths.claude_config),
                    Some(&self.paths.codex_home),
                );
                Ok(json!({"files":files}))
            }
            CommandKind::AgentFilesRead => {
                let project = Self::field(command, "projectPath")?;
                let path = Self::field(command, "path")?;
                let (content, truncated) = agent_files::read(
                    Path::new(path),
                    Some(Path::new(project)),
                    &self.paths.home,
                    Some(&self.paths.claude_config),
                    Some(&self.paths.codex_home),
                )?;
                Ok(json!({"content":content,"truncated":truncated}))
            }
            CommandKind::ProviderDefaultsRead => {
                let brand = Self::field(command, "brand")?;
                serde_json::to_value(self.defaults.read(brand)?).map_err(|e| e.to_string())
            }
            CommandKind::ProviderDefaultsWrite => {
                let brand = Self::field(command, "brand")?;
                let kind = Self::field(command, "kind")?;
                let value = Self::field(command, "value")?;
                serde_json::to_value(self.defaults.write(brand, kind, value)?)
                    .map_err(|e| e.to_string())
            }
            CommandKind::SessionStart | CommandKind::SessionOpen | CommandKind::SessionResume => {
                self.launch(command).await
            }
            _ => self.driver_command(command).await,
        }
    }

    pub async fn shutdown(&self) {
        let drivers = std::mem::take(&mut *self.drivers.write().await);
        for (_, driver) in drivers {
            let mut driver = driver.lock().await;
            let _ = driver.close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeDriver {
        calls: Arc<AtomicUsize>,
    }
    impl ProviderDriver for FakeDriver {
        fn brand(&self) -> &'static str {
            "claude"
        }
        fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(match command.kind {
                    CommandKind::PromptSend => json!({"ok":true,"messageId":"message-1"}),
                    _ => json!({"ok":true}),
                })
            })
        }
        fn close<'a>(&'a mut self) -> DriverFuture<'a> {
            Box::pin(async { Ok(json!({"ok":true})) })
        }
    }

    struct FakeFactory {
        calls: Arc<AtomicUsize>,
    }
    impl SessionFactory for FakeFactory {
        fn launch<'a>(&'a self, _: ChatDb, command: &'a Command) -> LaunchFuture<'a> {
            let calls = self.calls.clone();
            Box::pin(async move {
                let brand = command.fields["brand"].as_str().unwrap_or("claude");
                if brand == "broken" {
                    return Err("provider did not initialize".into());
                }
                Ok(LaunchedSession {
                    session_id: "session-1".into(),
                    reply: json!({"id":"session-1","brand":brand}),
                    driver: Box::new(FakeDriver { calls }),
                })
            })
        }
    }

    fn command(kind: CommandKind, fields: Value) -> Command {
        Command {
            kind,
            fields: fields.as_object().cloned().unwrap_or_else(Map::new),
        }
    }

    #[tokio::test]
    async fn native_workbench_services_registry_routes_without_changing_command_replies() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let home = root.path().join("home");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(project.join("CLAUDE.md"), "project rules").unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = WorkbenchRegistry::new(
            database,
            RegistryPaths {
                home: home.clone(),
                claude_config: home.join(".claude"),
                codex_home: home.join(".codex"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: calls.clone(),
            }),
        );

        let listed = registry
            .execute(&command(
                CommandKind::AgentFilesList,
                json!({"projectPath":project}),
            ))
            .await
            .unwrap();
        assert!(listed["files"]
            .as_array()
            .is_some_and(|files| !files.is_empty()));

        registry
            .execute(&command(
                CommandKind::ProviderDefaultsWrite,
                json!({"brand":"claude","kind":"effort","value":"high"}),
            ))
            .await
            .unwrap();
        assert_eq!(
            registry
                .execute(&command(
                    CommandKind::ProviderDefaultsRead,
                    json!({"brand":"claude"}),
                ))
                .await
                .unwrap()["effort"],
            "high"
        );

        let opened = registry
            .execute(&command(
                CommandKind::SessionStart,
                json!({"brand":"claude"}),
            ))
            .await
            .unwrap();
        assert_eq!(opened, json!({"id":"session-1","brand":"claude"}));
        let sent = registry
            .execute(&command(
                CommandKind::PromptSend,
                json!({"sessionId":"session-1","text":"hello"}),
            ))
            .await
            .unwrap();
        assert_eq!(sent, json!({"ok":true,"messageId":"message-1"}));
        registry
            .execute(&command(
                CommandKind::SessionClose,
                json!({"sessionId":"session-1"}),
            ))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(!registry.has_driver("session-1").await);

        assert!(registry
            .execute(&command(
                CommandKind::SessionStart,
                json!({"brand":"broken"}),
            ))
            .await
            .is_err());
        assert!(!registry.has_driver("session-1").await);
    }
}
