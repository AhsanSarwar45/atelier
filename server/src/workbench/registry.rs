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
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, RwLock};

pub type DriverFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
pub type LaunchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<LaunchedSession, String>> + Send + 'a>>;

/// A live provider behind the browser's existing command vocabulary.
pub trait ProviderDriver: Send {
    fn brand(&self) -> &'static str;
    fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a>;
    fn next<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async {
            std::future::pending::<()>().await;
            unreachable!()
        })
    }
    fn window_now<'a>(&'a mut self) -> DriverFuture<'a> {
        Box::pin(async { Err("This chat's brand cannot say what is in its window.".into()) })
    }
    fn close<'a>(&'a mut self) -> DriverFuture<'a>;
}

pub struct LaunchedSession {
    pub session_id: String,
    pub reply: Value,
    pub driver: Option<Box<dyn ProviderDriver>>,
}

/// Starts or opens a provider transactionally. It must return only after the
/// provider initialized and its database row exists. A failure must leave no
/// unexplained `starting` row: factories may roll it back or persist a durable,
/// readable error row, but never strand it between those states.
pub trait SessionFactory: Send + Sync {
    fn launch<'a>(&'a self, database: ChatDb, command: &'a Command) -> LaunchFuture<'a>;
}

/// Test seam for a build deliberately constructed without provider process
/// supervision. Production uses `NativeProviderFactory`.
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

enum DriverRequest {
    Command(Command, oneshot::Sender<Result<Value, String>>),
    WindowNow(oneshot::Sender<Result<Value, String>>),
    Close(Command, oneshot::Sender<Result<Value, String>>),
}

type Driver = mpsc::UnboundedSender<DriverRequest>;

async fn supervise_driver(
    database: ChatDb,
    session_id: String,
    mut driver: Box<dyn ProviderDriver>,
    mut requests: mpsc::UnboundedReceiver<DriverRequest>,
) {
    loop {
        match requests.try_recv() {
            Ok(DriverRequest::Command(command, reply)) => {
                let _ = reply.send(driver.command(&command).await);
                continue;
            }
            Ok(DriverRequest::WindowNow(reply)) => {
                let _ = reply.send(driver.window_now().await);
                continue;
            }
            Ok(DriverRequest::Close(command, reply)) => {
                let result = driver.command(&command).await;
                if let Err(error) = driver.close().await {
                    // Closing means Atelier has already detached this driver.
                    // A provider teardown failure is important conversation
                    // evidence, but cannot turn that completed detach into a
                    // refusal or leave the browser believing it is still live.
                    if let Ok(event) = serde_json::from_value(json!({
                        "type":"error", "sessionId":session_id, "seq":0,
                        "at":chrono::Utc::now().to_rfc3339(), "fatal":false,
                        "message":format!("the agent did not shut down cleanly: {error}")
                    })) {
                        let _ = database.append(event).await;
                    }
                }
                let _ = reply.send(result);
                return;
            }
            Err(mpsc::error::TryRecvError::Disconnected) => {
                let _ = driver.close().await;
                return;
            }
            Err(mpsc::error::TryRecvError::Empty) => {}
        }

        match tokio::time::timeout(Duration::from_millis(50), driver.next()).await {
            Ok(Ok(_)) => {}
            // A closed provider stream is terminal for this process handle.
            // Retire it; the registry's lazy prompt path will attach one fresh
            // run to the durable conversation. Keeping a dead handle around
            // makes later prompts claim to be Thinking with nobody reading.
            Ok(Err(_)) => {
                let _ = tokio::time::timeout(Duration::from_millis(250), driver.close()).await;
                return;
            }
            Err(_) => {}
        }
    }
}

pub struct WorkbenchRegistry {
    database: ChatDb,
    factory: Arc<dyn SessionFactory>,
    drivers: Arc<RwLock<HashMap<String, Driver>>>,
    paths: RegistryPaths,
    defaults: ProviderDefaultFiles,
}

impl WorkbenchRegistry {
    pub fn new(database: ChatDb, paths: RegistryPaths, factory: Arc<dyn SessionFactory>) -> Self {
        let defaults = ProviderDefaultFiles::new(&paths.claude_config, &paths.codex_home);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let db = database.clone();
            let mut updates = database.subscribe_all();
            handle.spawn(async move {
                while let Ok(update) = updates.recv().await {
                    if update.event.kind != super::protocol::EventKind::ToolStarted { continue; }
                    let name=update.event.fields.get("name").and_then(Value::as_str).unwrap_or("");
                    let input=update.event.fields.get("input").unwrap_or(&Value::Null);
                    let candidates=super::beads_links::candidates(name,input);
                    if candidates.is_empty(){continue} let Some(session)=db.get_session(update.session_id.clone()).await.ok().flatten() else{continue};
                    let runner=super::beads_links::BdRunner::default();
                    for id in candidates {
                        if super::beads_links::issue_exists(&runner,Path::new(&session.cwd),&id).await.is_none(){continue}
                        if !super::beads_links::record_link(&runner,Path::new(&session.cwd),&id,&session.id,"workbench-tool").await{continue}
                        let event:super::protocol::Event=match serde_json::from_value(json!({"type":"link.bead","sessionId":session.id,"seq":0,"at":chrono::Utc::now().to_rfc3339(),"beadId":id,"via":"tool"})){Ok(event)=>event,Err(_)=>continue};
                        let _=db.append(event).await;
                    }
                }
            });
        }
        Self {
            database,
            factory,
            drivers: Arc::new(RwLock::new(HashMap::new())),
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

    pub fn claude_config_directory(&self) -> &Path {
        &self.paths.claude_config
    }
    pub fn codex_home_directory(&self) -> &Path {
        &self.paths.codex_home
    }

    pub fn provider_holds(&self, proc_root: &Path, now_ms: i64) -> Vec<ProviderHold> {
        external::provider_holds(
            &self.paths.claude_config,
            proc_root,
            &self.paths.codex_home,
            now_ms,
        )
    }

    pub async fn window_now(&self, session_id: &str) -> Option<Result<Value, String>> {
        let driver = self.drivers.read().await.get(session_id).cloned()?;
        let (reply, receive) = oneshot::channel();
        driver.send(DriverRequest::WindowNow(reply)).ok()?;
        Some(
            receive
                .await
                .unwrap_or_else(|_| Err("provider stopped before replying".into())),
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

    /// Reading by URL is the same operation as clicking a stored row. It does
    /// not attach a provider, but it heals stale state and starts the durable
    /// history import/follower needed by both entry paths.
    pub async fn looked_at(&self, session_id: &str) {
        let command = Command {
            kind: CommandKind::SessionOpen,
            fields: serde_json::Map::from_iter([("sessionId".into(), json!(session_id))]),
        };
        let _ = self.execute(&command).await;
    }

    async fn launch(&self, command: &Command) -> Result<Value, String> {
        let mut launched = self.factory.launch(self.database.clone(), command).await?;
        let Some(driver) = launched.driver.take() else {
            return Ok(launched.reply);
        };
        let mut drivers = self.drivers.write().await;
        if drivers.contains_key(&launched.session_id) {
            drop(drivers);
            let mut driver = driver;
            let _ = driver.close().await;
            return Err(format!("session {} is already open", launched.session_id));
        }
        let (requests, receiver) = mpsc::unbounded_channel();
        let session_id = launched.session_id;
        drivers.insert(session_id.clone(), requests);
        drop(drivers);
        let live = self.drivers.clone();
        let database = self.database.clone();
        tokio::spawn(async move {
            supervise_driver(database, session_id.clone(), driver, receiver).await;
            live.write().await.remove(&session_id);
        });
        Ok(launched.reply)
    }

    /// Opening is only a read operation. If this process already owns the
    /// conversation, its driver and durable state are the source of truth;
    /// asking the provider factory to "open" it would incorrectly demote the
    /// live row to dormant and race a second driver against the first one.
    async fn already_live_open(&self, command: &Command) -> Result<Option<Value>, String> {
        let mut session = None;
        if let Some(id) = command.fields.get("sessionId").and_then(Value::as_str) {
            session = self.database.get_session(id.to_string()).await?;
        }
        if session.is_none() {
            if let Some(id) = command.fields.get("externalId").and_then(Value::as_str) {
                session = self.database.session_by_external_id(id.to_string()).await?;
            }
        }
        let Some(session) = session else {
            return Ok(None);
        };
        if !self.has_driver(&session.id).await {
            return Ok(None);
        }
        serde_json::to_value(session)
            .map(Some)
            .map_err(|error| error.to_string())
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
        let (reply, receive) = oneshot::channel();
        let request = if closing {
            DriverRequest::Close(command.clone(), reply)
        } else {
            DriverRequest::Command(command.clone(), reply)
        };
        driver
            .send(request)
            .map_err(|_| format!("provider for {session_id} stopped"))?;
        receive
            .await
            .map_err(|_| format!("provider for {session_id} stopped before replying"))?
    }

    async fn refuse_external_owner(&self, command: &Command) -> Result<(), String> {
        let session = if let Ok(id) = Self::field(command, "sessionId") {
            self.database.get_session(id.to_string()).await?
        } else if let Ok(id) = Self::field(command, "externalId") {
            self.database.session_by_external_id(id.to_string()).await?
        } else {
            None
        };
        let external_id = session
            .as_ref()
            .and_then(|row| row.external_id.as_deref())
            .or_else(|| command.fields.get("externalId").and_then(Value::as_str));
        let Some(external_id) = external_id else {
            return Ok(());
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        if self
            .provider_holds(Path::new("/proc"), now)
            .iter()
            .any(|hold| hold.id.eq_ignore_ascii_case(external_id))
        {
            return Err("Another program has this chat open".into());
        }
        Ok(())
    }

    /// Stop only the provider processes already attributed to this exact
    /// conversation, then wait for their PIDs to disappear before attaching
    /// Atelier's driver. The browser sends `takeover` only when the ownership
    /// row it is drawing says another local program currently owns the chat.
    async fn take_over(&self, command: &Command) -> Result<(), String> {
        let session_id = Self::field(command, "sessionId")?;
        let Some(session) = self.database.get_session(session_id.to_string()).await? else {
            return Err(format!("session {session_id} does not exist"));
        };
        let Some(external_id) = session.external_id.as_deref() else {
            return Ok(());
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let own_pid = std::process::id();
        let pids = self
            .provider_holds(Path::new("/proc"), now)
            .into_iter()
            .filter(|hold| hold.id.eq_ignore_ascii_case(external_id))
            .flat_map(|hold| hold.pids)
            .filter(|pid| *pid != own_pid)
            .collect::<std::collections::BTreeSet<_>>();
        for pid in &pids {
            if let Err(error) = super::external::terminate_pid(*pid) {
                // It can release between discovery and the signal. Only a PID
                // that still exists turns that harmless race into a refusal.
                if super::external::pid_alive(*pid, Path::new("/proc")) {
                    return Err(format!(
                        "Could not stop the program holding this chat: {error}"
                    ));
                }
            }
        }
        let until = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while tokio::time::Instant::now() < until {
            if pids
                .iter()
                .all(|pid| !super::external::pid_alive(*pid, Path::new("/proc")))
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err("Chat is still active elsewhere.".into())
    }

    async fn pin_saved_session(&self, command: &Command) -> Result<Value, String> {
        let session_id = Self::field(command, "sessionId")?;
        let mut session = self
            .database
            .get_session(session_id.to_string())
            .await?
            .ok_or_else(|| format!("session {session_id} does not exist"))?;
        match command.kind {
            CommandKind::SessionMode => {
                session.permission_mode = Self::field(command, "mode")?.to_string();
            }
            CommandKind::SessionModel => {
                let model = Self::field(command, "model")?;
                let menu = self.database.steering_menu(session_id.to_string()).await?;
                if model != "default"
                    && !menu["models"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|choice| choice["value"] == model)
                {
                    return Err("that model is not in the session's advertised catalog".into());
                }
                session.model = (model != "default").then(|| model.to_string());
            }
            CommandKind::SessionEffort => {
                session.effort = Some(Self::field(command, "effort")?.to_string());
            }
            CommandKind::SessionCollaborationMode => {
                session.collaboration_mode = Some(Self::field(command, "mode")?.to_string());
            }
            CommandKind::SessionConfigOption => {
                let config_id = Self::field(command, "configId")?;
                let value = command
                    .fields
                    .get("value")
                    .filter(|value| value.is_boolean() || value.is_string())
                    .ok_or_else(|| {
                        "a session config value must be a boolean or string".to_string()
                    })?;
                let menu = self.database.steering_menu(session_id.to_string()).await?;
                let option = menu["configOptions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|option| option["id"] == config_id)
                    .ok_or_else(|| format!("session option {config_id} is not available"))?;
                match option["type"].as_str() {
                    Some("boolean") if value.is_boolean() => {}
                    Some("select")
                        if value.as_str().is_some_and(|selected| {
                            option["options"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|choice| choice["value"] == selected)
                        }) => {}
                    Some("boolean") => {
                        return Err(format!("session option {config_id} requires a boolean"))
                    }
                    Some("select") => {
                        return Err(format!(
                            "session option {config_id} does not offer that value"
                        ))
                    }
                    _ => {
                        return Err(format!(
                            "session option {config_id} has an unsupported type"
                        ))
                    }
                }
                let event: crate::workbench::protocol::Event = serde_json::from_value(json!({
                    "type":"session.pinned", "sessionId":session.id, "seq":0,
                    "at":chrono::Utc::now().to_rfc3339(), "permissionMode":Value::Null,
                    "model":Value::Null, "effort":Value::Null, "collaborationMode":Value::Null,
                    "configOptions":[{"id":config_id,"currentValue":value}]
                }))
                .map_err(|error| error.to_string())?;
                self.database.append(event).await?;
                return Ok(json!({"ok":true}));
            }
            _ => return Err("command is not a session setting".into()),
        }
        let event: crate::workbench::protocol::Event = serde_json::from_value(json!({
            "type":"session.pinned", "sessionId":session.id, "seq":0,
            "at":chrono::Utc::now().to_rfc3339(),
            "permissionMode":session.permission_mode, "model":session.model,
            "clearModel":command.kind == CommandKind::SessionModel && session.model.is_none(),
            "effort":session.effort, "collaborationMode":session.collaboration_mode
        }))
        .map_err(|error| error.to_string())?;
        self.database.append(event).await?;
        if command.kind == CommandKind::SessionModel
            && session.brand == super::local::BRAND
            && session.model.is_some()
        {
            let ready: crate::workbench::protocol::Event = serde_json::from_value(json!({
                "type":"session.state", "sessionId":session.id, "seq":0,
                "at":chrono::Utc::now().to_rfc3339(), "state":"idle", "label":"Ready"
            }))
            .map_err(|error| error.to_string())?;
            self.database.append(ready).await?;
        }
        Ok(json!({"ok":true}))
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
            CommandKind::ProvidersList => {
                let mut providers = [
                    ("claude", "Claude", "https://docs.anthropic.com/en/docs/claude-code"),
                    ("codex", "Codex", "https://developers.openai.com/codex/cli"),
                ].into_iter().map(|(brand, name, install_url)| {
                    let path = crate::routes::find_tool(brand, &[]);
                    let adapter = super::acp::adapter::find(brand);
                    let available = super::acp::adapter::launch_config(brand, None).is_some();
                    json!({"brand":brand,"name":name,"available":available,"path":path,"adapterPath":adapter,"installUrl":install_url,"models":[]})
                }).collect::<Vec<_>>();
                providers.extend(super::local::providers().await);
                Ok(json!({"providers":providers}))
            }
            CommandKind::SessionOpen => {
                if let Some(session) = self.already_live_open(command).await? {
                    return Ok(session);
                }
                self.launch(command).await
            }
            CommandKind::SessionStart | CommandKind::SessionResume => {
                self.refuse_external_owner(command).await?;
                self.launch(command).await
            }
            CommandKind::SessionClose
                if !self.has_driver(Self::field(command, "sessionId")?).await =>
            {
                self.refuse_external_owner(command).await?;
                let session_id = Self::field(command, "sessionId")?;
                let session = self
                    .database
                    .get_session(session_id.to_string())
                    .await?
                    .ok_or_else(|| format!("no session {session_id}"))?;
                if session.state != "dormant" {
                    self.database
                        .update_session(
                            session_id.to_string(),
                            crate::workbench::store::SessionPatch {
                                state: Some("dormant".into()),
                                ..Default::default()
                            },
                            None,
                        )
                        .await?;
                    let event: crate::workbench::protocol::Event = serde_json::from_value(json!({
                        "type":"session.state","sessionId":session_id,"seq":0,
                        "at":chrono::Utc::now().to_rfc3339(),"state":"dormant","label":"Asleep"
                    }))
                    .map_err(|error| error.to_string())?;
                    self.database.append(event).await?;
                }
                Ok(json!({"ok":true}))
            }
            // Opening a saved conversation is deliberately read-only. The
            // first prompt is what wakes (or resumes) its provider, so lazily
            // attach the driver here before forwarding that prompt.
            CommandKind::PromptSend
                if !self.has_driver(Self::field(command, "sessionId")?).await =>
            {
                if command.fields["takeover"] == true {
                    self.take_over(command).await?;
                } else {
                    self.refuse_external_owner(command).await?;
                }
                self.launch(command).await?;
                self.driver_command(command).await
            }
            CommandKind::SessionMode
            | CommandKind::SessionModel
            | CommandKind::SessionEffort
            | CommandKind::SessionCollaborationMode
            | CommandKind::SessionConfigOption
                if !self.has_driver(Self::field(command, "sessionId")?).await =>
            {
                self.pin_saved_session(command).await
            }
            _ => self.driver_command(command).await,
        }
    }

    pub async fn shutdown(&self) {
        let drivers = std::mem::take(&mut *self.drivers.write().await);
        for (session_id, driver) in drivers {
            let (reply, receive) = oneshot::channel();
            let command = Command {
                kind: CommandKind::SessionClose,
                fields: serde_json::Map::from_iter([("sessionId".into(), json!(session_id))]),
            };
            let _ = driver.send(DriverRequest::Close(command, reply));
            let _ = receive.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::protocol::Event;
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
                    driver: Some(Box::new(FakeDriver { calls })),
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

    #[tokio::test]
    async fn opening_a_live_session_keeps_its_driver_and_state() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        database
            .create_session(crate::workbench::store::Session {
                id: "session-1".into(),
                brand: "claude".into(),
                external_id: Some("external-1".into()),
                project_id: "project".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                model: Some("sonnet".into()),
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                title: Some("Live".into()),
                state: "streaming".into(),
                origin: "app".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                last_active_at: "2026-08-30T00:00:01Z".into(),
                last_spoke_at: None,
            })
            .await
            .unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        );
        registry
            .execute(&command(
                CommandKind::SessionStart,
                json!({"brand":"claude"}),
            ))
            .await
            .unwrap();

        let opened = registry
            .execute(&command(
                CommandKind::SessionOpen,
                json!({
                    "sessionId":"stale-client-id",
                    "externalId":"external-1",
                    "brand":"claude"
                }),
            ))
            .await
            .unwrap();

        assert_eq!(opened["id"], "session-1");
        assert_eq!(opened["state"], "streaming");
        assert!(registry.has_driver("session-1").await);
        assert_eq!(
            database
                .get_session("session-1".into())
                .await
                .unwrap()
                .unwrap()
                .state,
            "streaming"
        );
        registry.shutdown().await;
    }

    #[tokio::test]
    async fn reading_by_address_reconciles_a_stale_saved_session() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let mut session = crate::workbench::store::Session {
            id: "saved".into(),
            brand: "claude".into(),
            external_id: None,
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            title: Some("Saved".into()),
            state: "starting".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00Z".into(),
            last_active_at: "2026-08-30T00:00:01Z".into(),
            last_spoke_at: None,
        };
        database.create_session(session.clone()).await.unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                media: root.path().join("media"),
            },
            Arc::new(crate::workbench::provider::NativeProviderFactory::new(
                root.path().join("claude"),
            )),
        );

        registry.looked_at("saved").await;

        session = database.get_session("saved".into()).await.unwrap().unwrap();
        assert_eq!(session.state, "dormant");
        assert!(!registry.has_driver("saved").await);
        assert!(database
            .events_since("saved".into(), 0)
            .await
            .unwrap()
            .iter()
            .any(
                |event| event.kind == crate::workbench::protocol::EventKind::SessionState
                    && event.fields["state"] == "dormant"
            ));
    }

    #[tokio::test]
    async fn native_workbench_registry_pins_settings_without_waking_a_saved_chat() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        database
            .create_session(crate::workbench::store::Session {
                id: "saved".into(),
                brand: "claude".into(),
                external_id: Some("external".into()),
                project_id: "project".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                model: Some("opus".into()),
                permission_mode: "default".into(),
                effort: Some("high".into()),
                collaboration_mode: None,
                title: Some("Saved".into()),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                last_active_at: "2026-08-30T00:00:00Z".into(),
                last_spoke_at: None,
            })
            .await
            .unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        );

        for (kind, fields) in [
            (
                CommandKind::SessionMode,
                json!({"sessionId":"saved","mode":"plan"}),
            ),
            (
                CommandKind::SessionEffort,
                json!({"sessionId":"saved","effort":"xhigh"}),
            ),
            (
                CommandKind::SessionModel,
                json!({"sessionId":"saved","model":"default"}),
            ),
        ] {
            assert_eq!(
                registry.execute(&command(kind, fields)).await.unwrap(),
                json!({"ok":true})
            );
        }
        assert!(!registry.has_driver("saved").await);
        let saved = database.get_session("saved".into()).await.unwrap().unwrap();
        assert_eq!(saved.permission_mode, "plan");
        assert_eq!(saved.effort.as_deref(), Some("xhigh"));
        assert_eq!(saved.model, None);
        let view = crate::workbench::projection::fold_all(
            &database.view_events("saved".into()).await.unwrap(),
        );
        assert_eq!(view.view["permissionMode"], "plan");
        assert_eq!(view.view["effort"], "xhigh");
        assert!(view.view["model"].is_null());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn prompt_takeover_stops_only_the_exact_external_holder_before_launch() {
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        std::fs::create_dir_all(claude.join("sessions")).unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        database
            .create_session(crate::workbench::store::Session {
                id: "session-1".into(),
                brand: "claude".into(),
                external_id: Some("external-thread".into()),
                project_id: "project".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                model: None,
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                title: Some("External".into()),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                last_active_at: "2026-08-30T00:00:00Z".into(),
                last_spoke_at: None,
            })
            .await
            .unwrap();

        let mut holder = OwnedChild(
            std::process::Command::new("sleep")
                .arg("60")
                .spawn()
                .unwrap(),
        );
        let pid = holder.0.id();
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let close = stat.rfind(')').unwrap();
        let proc_start = stat[close + 1..].split_whitespace().nth(19).unwrap();
        std::fs::write(
            claude.join("sessions").join(format!("{pid}.json")),
            serde_json::to_vec(&json!({
                "sessionId":"external-thread", "pid":pid, "cwd":"/project",
                "startedAt":1, "procStart":proc_start, "entrypoint":"cli",
                "kind":"interactive", "status":"idle"
            }))
            .unwrap(),
        )
        .unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let registry = WorkbenchRegistry::new(
            database,
            RegistryPaths {
                home: root.path().into(),
                claude_config: claude,
                codex_home: root.path().join("codex"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: calls.clone(),
            }),
        );
        registry
            .execute(&command(
                CommandKind::PromptSend,
                json!({
                    "sessionId":"session-1", "brand":"claude",
                    "takeover":true, "text":"continue"
                }),
            ))
            .await
            .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(holder.0.try_wait().unwrap().is_some());
        registry.shutdown().await;
    }

    struct DroppedDriver {
        database: ChatDb,
        phase: usize,
    }

    struct RefusesTeardown;

    impl ProviderDriver for RefusesTeardown {
        fn brand(&self) -> &'static str {
            "claude"
        }
        fn command<'a>(&'a mut self, _: &'a Command) -> DriverFuture<'a> {
            Box::pin(async { Ok(json!({"ok":true})) })
        }
        fn close<'a>(&'a mut self) -> DriverFuture<'a> {
            Box::pin(async { Err("provider process stayed behind".into()) })
        }
    }

    fn provider_event(identity: &str, text: &str) -> Event {
        serde_json::from_value(json!({
            "type":"notice", "sessionId":"session-1", "seq":0,
            "at":"2026-08-30T00:00:00.000Z", "text":text,
            "providerEvent": {"provider":"codex","threadId":"thread-1","eventId":identity,"delivery":"live"}
        })).unwrap()
    }

    impl ProviderDriver for DroppedDriver {
        fn brand(&self) -> &'static str {
            "codex"
        }
        fn command<'a>(&'a mut self, _: &'a Command) -> DriverFuture<'a> {
            Box::pin(async { Ok(json!({"ok":true})) })
        }
        fn next<'a>(&'a mut self) -> DriverFuture<'a> {
            Box::pin(async move {
                match self.phase {
                    0 => {
                        self.database
                            .append(provider_event("same", "before drop"))
                            .await?;
                        self.phase = 1;
                        Err("stream dropped".into())
                    }
                    _ => {
                        std::future::pending::<()>().await;
                        unreachable!()
                    }
                }
            })
        }
        fn close<'a>(&'a mut self) -> DriverFuture<'a> {
            Box::pin(async { Ok(json!({"ok":true})) })
        }
    }

    #[tokio::test]
    async fn native_workbench_supervisor_retires_a_dropped_provider_stream() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let (send, receive) = mpsc::unbounded_channel();
        let task = tokio::spawn(supervise_driver(
            database.clone(),
            "session-1".into(),
            Box::new(DroppedDriver {
                database: database.clone(),
                phase: 0,
            }),
            receive,
        ));
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("a dead provider is released promptly")
            .unwrap();
        let events = database.events_since("session-1".into(), 0).await.unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.fields["seq"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(events[0].fields["text"], "before drop");
        drop(send);
    }

    #[tokio::test]
    async fn closing_detaches_even_when_provider_teardown_fails() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let (send, receive) = mpsc::unbounded_channel();
        let task = tokio::spawn(supervise_driver(
            database.clone(),
            "session-1".into(),
            Box::new(RefusesTeardown),
            receive,
        ));
        let (reply, answer) = oneshot::channel();
        send.send(DriverRequest::Close(
            command(CommandKind::SessionClose, json!({"sessionId":"session-1"})),
            reply,
        ))
        .unwrap();

        assert_eq!(answer.await.unwrap().unwrap(), json!({"ok":true}));
        task.await.unwrap();
        let events = database.events_since("session-1".into(), 0).await.unwrap();
        assert!(events.iter().any(|event| {
            event.kind == crate::workbench::protocol::EventKind::Error
                && event.fields["fatal"] == false
                && event.fields["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("provider process stayed behind"))
        }));
    }
}
