//! One provider-neutral owner for native workbench services and live drivers.

use super::actor::ChatDb;
use super::agent_files;
use super::browser::{self, BrowserCapture, BrowserRecipe};
use super::codex_plugins;
use super::extensions;
use super::external::{self, ProviderHold};
use super::mcp_catalogue;
use super::plugin_catalogue;
use super::mcp_servers;
use super::media;
use super::profiles::Profiles;
use super::protocol::{Command, CommandKind};
use super::provider_defaults::ProviderDefaultFiles;
use super::provider_settings;
use super::screen_check::{self, StoredCapture, StoredComparison};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, RwLock};

/// One process-level ownership reading, classified at the registry boundary.
///
/// Callers must never interpret raw provider markers themselves: a marker
/// written by a provider this process started is ours even after its driver
/// channel has failed. Keeping that distinction in the type makes it
/// impossible for a command guard and the browser to disagree about who owns
/// a conversation.
#[derive(Default)]
pub struct ProviderOwnership {
    pub ours: Vec<ProviderHold>,
    pub external: Vec<ProviderHold>,
}

pub type DriverFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
pub type LaunchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<LaunchedSession, String>> + Send + 'a>>;

/// A live provider behind the browser's existing command vocabulary.
pub trait ProviderDriver: Send {
    fn brand(&self) -> &'static str;
    fn reconciler(&self) -> Option<super::status::Reconciler> {
        None
    }
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
    /// Stop this process without ending the remote conversation it had open.
    fn retire<'a>(&'a mut self) -> DriverFuture<'a> {
        self.close()
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
    /// Where created account profiles live.
    pub profiles: PathBuf,
    pub media: PathBuf,
}

enum DriverRequest {
    Command(Command, oneshot::Sender<Result<Value, String>>),
    WindowNow(oneshot::Sender<Result<Value, String>>),
    Close(Command, oneshot::Sender<Result<Value, String>>),
    Retire(oneshot::Sender<Result<Value, String>>),
}

#[derive(Clone)]
struct Driver {
    requests: mpsc::UnboundedSender<DriverRequest>,
    reconcile: Option<super::status::Reconciler>,
}
impl std::ops::Deref for Driver {
    type Target = mpsc::UnboundedSender<DriverRequest>;
    fn deref(&self) -> &Self::Target {
        &self.requests
    }
}

async fn reconcile_session(
    database: &ChatDb,
    drivers: &RwLock<HashMap<String, Driver>>,
    launching: &std::sync::atomic::AtomicUsize,
    session_id: &str,
) -> Result<Value, String> {
    // Keep attachment identity stable through publication. A retired probe
    // cannot write its outcome over a newly attached turn.
    let live = drivers.read().await;
    if let Some(driver) = live.get(session_id).filter(|driver| !driver.is_closed()) {
        if let Some(reconcile) = &driver.reconcile {
            return reconcile().await;
        }
        // Only test drivers lack an actual runtime probe.
        return Ok(Value::Null);
    }
    if launching.load(std::sync::atomic::Ordering::Acquire) != 0 {
        if database
            .get_session(session_id.to_string())
            .await?
            .is_some_and(|session| session.state == "starting")
        {
            return Ok(Value::Null);
        }
    }
    super::status::reconcile(database, session_id, None).await
}

/// The command one held message becomes when it is finally sent.
fn held_as_prompt(session_id: &str, held: &Value) -> Result<Command, String> {
    let mut fields = serde_json::Map::new();
    fields.insert("sessionId".into(), json!(session_id));
    fields.insert("text".into(), held["text"].clone());
    fields.insert("images".into(), held["images"].clone());
    if held["parts"].is_array() {
        fields.insert("parts".into(), held["parts"].clone());
    }
    serde_json::from_value(Value::Object({
        let mut map = fields;
        map.insert("type".into(), json!("prompt.send"));
        map
    }))
    .map_err(|error| error.to_string())
}

/// Note that a held message has left the queue, one way or the other.
async fn note_released(
    database: &ChatDb,
    session_id: &str,
    held_id: &str,
    reason: &str,
) -> Result<(), String> {
    let event = serde_json::from_value(json!({
        "type":"prompt.released", "sessionId":session_id, "seq":0,
        "at":chrono::Utc::now().to_rfc3339(), "heldId":held_id, "reason":reason
    }))
    .map_err(|error| error.to_string())?;
    database.append(event).await.map(|_| ())
}

/**
 * Send a message the chat was holding, and put it back if the send is refused.
 *
 * The reader wrote this line and chose to wait with it. A provider that will
 * not take it — the steering call a brand does not answer, a driver that died
 * between the claim and the send — must leave it exactly where it was, still
 * held and still sendable, rather than swallowing it (bw-r54j.3).
 */
async fn send_held(
    database: &ChatDb,
    drivers: &RwLock<HashMap<String, Driver>>,
    session_id: &str,
    held: &Value,
) -> Result<Value, String> {
    let held_id = held["id"].as_str().unwrap_or_default().to_string();
    let prompt = held_as_prompt(session_id, held)?;
    let result = {
        let live = drivers.read().await;
        let driver = live
            .get(session_id)
            .filter(|driver| !driver.is_closed())
            .cloned();
        drop(live);
        match driver {
            Some(driver) => {
                let (reply, answer) = oneshot::channel();
                match driver.send(DriverRequest::Command(prompt, reply)) {
                    Ok(()) => answer
                        .await
                        .map_err(|_| "the agent stopped before taking the message".to_string())
                        .and_then(|result| result),
                    Err(_) => Err("the agent is no longer attached to this chat".to_string()),
                }
            }
            None => Err("this chat has no agent attached to send to".to_string()),
        }
    };
    match result {
        Ok(value) => {
            database.forget_held(held_id.clone()).await?;
            note_released(database, session_id, &held_id, "sent").await?;
            Ok(value)
        }
        Err(error) => {
            database.release_held(held_id).await?;
            Err(error)
        }
    }
}

/**
 * Send the oldest held message the moment the chat has nothing in flight.
 *
 * Called after every reconciliation of an attached chat, which is what makes
 * this provider-neutral: the queue drains on the settled status every brand
 * already reports, not on any one adapter's idea of a finished turn. One
 * message per settle, in the order they were held.
 */
async fn drain_held(
    database: &ChatDb,
    drivers: &RwLock<HashMap<String, Driver>>,
    session_id: &str,
) {
    let attached = drivers
        .read()
        .await
        .get(session_id)
        .is_some_and(|driver| !driver.is_closed());
    if !attached {
        return;
    }
    let Ok(Some(session)) = database.get_session(session_id.to_string()).await else {
        return;
    };
    // Finished a turn, and nothing else. A chat that stopped, failed or went
    // to sleep has not finished one — it lost one — and pushing the reader's
    // next message into that is the opposite of holding it for them. Those
    // wait where they are until the reader sends them by hand.
    //
    // A chat waiting on a task it sent away has finished its turn: that state
    // is only ever reached once the reply is over (status::resolve). What it
    // is waiting for is its own background work, which the held message is not
    // behind and cannot be hurt by, so the queue drains here too. Holding on
    // past the end of the reply is what left a message waiting on work nobody
    // asked it to wait for (bw-ekpt.2).
    if session.state != "idle" && session.state != "waiting_for_agents" {
        return;
    }
    let Ok(Some(held)) = database.take_held(session_id.to_string(), None).await else {
        return;
    };
    if let Err(error) = send_held(database, drivers, session_id, &held).await {
        if let Ok(event) = serde_json::from_value(json!({
            "type":"error", "sessionId":session_id, "seq":0,
            "at":chrono::Utc::now().to_rfc3339(), "fatal":false,
            "message":format!("The waiting message could not be sent, and is still waiting: {error}")
        })) {
            let _ = database.append(event).await;
        }
    }
}

struct LaunchGuard(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for LaunchGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

async fn supervise_driver(
    database: ChatDb,
    session_id: String,
    mut driver: Box<dyn ProviderDriver>,
    mut requests: mpsc::UnboundedReceiver<DriverRequest>,
) {
    loop {
        match requests.try_recv() {
            Ok(DriverRequest::Command(command, reply)) => {
                let result = driver.command(&command).await;
                let detached = result
                    .as_ref()
                    .ok()
                    .is_some_and(|value| value["detached"] == true);
                if detached {
                    // Close before acknowledging Stop. An immediate next prompt
                    // must resume, rather than queue onto this retired driver.
                    requests.close();
                }
                let _ = reply.send(result);
                if detached {
                    return;
                }
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
            Ok(DriverRequest::Retire(reply)) => {
                let result = driver.retire().await;
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
            Ok(Err(error)) => {
                let cleanup =
                    tokio::time::timeout(Duration::from_millis(250), driver.close()).await;
                let cleanup = match cleanup {
                    Ok(Ok(_)) => "cleanup completed".to_string(),
                    Ok(Err(why)) => format!("cleanup failed: {why}"),
                    Err(_) => "cleanup timed out after 250ms".to_string(),
                };
                if let Ok(event) = serde_json::from_value(json!({
                    "type":"error", "sessionId":session_id, "seq":0,
                    "at":chrono::Utc::now().to_rfc3339(), "fatal":false,
                    "message":format!("Provider stream closed: {error}; {cleanup}")
                })) {
                    let _ = database.append(event).await;
                }
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
    launching: Arc<std::sync::atomic::AtomicUsize>,
    paths: RegistryPaths,
    defaults: ProviderDefaultFiles,
    profiles: Profiles,
    /// The sign-ins in flight, which belong to the process and not to a
    /// connection: a person who reloads the page mid-sign-in should find the
    /// same code waiting, not a new one (signin.rs).
    signins: Arc<super::signin::SignIns>,
    /// How many drivers of this process each chat has, from the launch until
    /// its stretch has been handed back — longer than the drivers map holds
    /// one, which lets go before the process is closed and done writing.
    supervising: Supervising,
}

type Supervising = Arc<tokio::sync::Mutex<HashMap<String, usize>>>;

/// Count one more driver of a chat, and mark the chat as driven where a crash
/// cannot lose the mark.
async fn begin_supervising(
    supervising: &Supervising,
    database: &ChatDb,
    paths: &RegistryPaths,
    session_id: &str,
) {
    let mut counts = supervising.lock().await;
    let count = counts.entry(session_id.to_string()).or_default();
    *count += 1;
    if *count == 1 {
        let from = super::handback::stretch_start(
            database,
            session_id,
            &paths.claude_config,
            &paths.codex_home,
        )
        .await;
        let _ = database.begin_driving(session_id.to_string(), from).await;
    }
}

/// One driver of a chat is gone and its process closed. The last one hands the
/// driven stretch back before the chat counts as undriven, so a follower never
/// sees it undriven with the stretch still ahead of its cursor.
async fn end_supervising(
    supervising: &Supervising,
    database: &ChatDb,
    paths: &RegistryPaths,
    session_id: &str,
) {
    let last = supervising.lock().await.get(session_id).copied() == Some(1);
    if last {
        super::handback::hand_back(database, session_id, &paths.claude_config, &paths.codex_home)
            .await;
    }
    let mut counts = supervising.lock().await;
    let left = counts.get(session_id).copied().unwrap_or(1).saturating_sub(1);
    if left == 0 {
        counts.remove(session_id);
        let _ = database.end_driving(session_id.to_string()).await;
    } else {
        counts.insert(session_id.to_string(), left);
    }
}

impl WorkbenchRegistry {
    pub fn new(database: ChatDb, paths: RegistryPaths, factory: Arc<dyn SessionFactory>) -> Self {
        let defaults = ProviderDefaultFiles::new(&paths.claude_config, &paths.codex_home);
        let profiles = Profiles::new(
            paths.profiles.clone(),
            paths.claude_config.clone(),
            paths.codex_home.clone(),
        );
        let drivers = Arc::new(RwLock::new(HashMap::<String, Driver>::new()));
        let launching = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let live = Arc::downgrade(&drivers);
            let starts = launching.clone();
            let db = database.clone();
            let mut events = database.subscribe_all();
            handle.spawn(async move {
                let mut sweep = tokio::time::interval(Duration::from_secs(5));
                loop {
                    let changed = tokio::select! {
                        _ = sweep.tick() => None,
                        event = events.recv() => match event {
                            Ok(event) => Some(event.session_id),
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    };
                    let Some(live) = live.upgrade() else { break };
                    if let Some(id) = changed {
                        // Initialization may publish events before the handle is
                        // registered. Attached runtimes alone own event refreshes.
                        if live.read().await.contains_key(&id) {
                            let _ = reconcile_session(&db, &live, &starts, &id).await;
                            drain_held(&db, &live, &id).await;
                        }
                    } else if let Ok(active) = db.active_session_ids().await {
                        // The chats mid-turn and the ones with a runtime
                        // attached; asking the store for the first by state
                        // rather than loading every chat ever kept every five
                        // seconds (bw-fbzd.5).
                        let mut due: Vec<String> = live.read().await.keys().cloned().collect();
                        for id in active {
                            if !due.contains(&id) {
                                due.push(id);
                            }
                        }
                        for id in due {
                            let _ = reconcile_session(&db, &live, &starts, &id).await;
                            drain_held(&db, &live, &id).await;
                        }
                    }
                }
            });
        }
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let db = database.clone();
            let mut updates = database.subscribe_all();
            handle.spawn(async move {
                while let Ok(update) = updates.recv().await {
                    let session_id = update.session_id;
                    let events = if let Some(from) = update.batch_from {
                        db.events_since(session_id.clone(), from.saturating_sub(1))
                            .await
                            .unwrap_or_default()
                    } else {
                        vec![update.event]
                    };
                    for provider_event in events {
                        if provider_event.kind != super::protocol::EventKind::ToolStarted { continue; }
                        let name=provider_event.fields.get("name").and_then(Value::as_str).unwrap_or("");
                        let input=provider_event.fields.get("input").unwrap_or(&Value::Null);
                        let candidates=super::beads_links::candidates(name,input);
                        if candidates.is_empty(){continue} let Some(session)=db.get_session(session_id.clone()).await.ok().flatten() else{continue};
                        let runner=super::beads_links::BdRunner::default();
                        for id in candidates {
                            if super::beads_links::issue_exists(&runner,Path::new(&session.cwd),&id).await.is_none(){continue}
                            if !super::beads_links::record_link(&runner,Path::new(&session.cwd),&id,&session.id,"workbench-tool").await{continue}
                            let event:super::protocol::Event=match serde_json::from_value(json!({"type":"link.bead","sessionId":session.id,"seq":0,"at":chrono::Utc::now().to_rfc3339(),"beadId":id,"via":"tool"})){Ok(event)=>event,Err(_)=>continue};
                            let _=db.append(event).await;
                        }
                    }
                }
            });
        }
        Self {
            database,
            factory,
            drivers,
            launching,
            paths,
            defaults,
            profiles,
            signins: Arc::default(),
            supervising: Arc::default(),
        }
    }

    pub fn database(&self) -> &ChatDb {
        &self.database
    }

    /// The provider's own settings files for one account.
    ///
    /// A default is a fact about the account it is saved under, so starring a
    /// model while working on the work profile must not rewrite the settings
    /// the owner's own terminal reads.
    fn defaults_for(&self, brand: &str, profile: Option<&str>) -> ProviderDefaultFiles {
        match profile.filter(|id| *id != super::profiles::SYSTEM) {
            None => self.defaults.clone(),
            Some(id) => {
                ProviderDefaultFiles::in_directory(&self.profiles.chat_dir(brand, Some(id)))
            }
        }
    }

    /// One account's own config directory for a brand: the directory the
    /// server booted with for the system account, the profile's own otherwise.
    fn account_dir(&self, brand: &str, profile: Option<&str>) -> PathBuf {
        match profile.filter(|id| *id != super::profiles::SYSTEM) {
            None => match brand {
                "codex" => self.paths.codex_home.clone(),
                _ => self.paths.claude_config.clone(),
            },
            Some(id) => self.profiles.chat_dir(brand, Some(id)),
        }
    }

    /// One account's MCP files. Claude keeps `.claude.json` inside a profile's
    /// own directory, but for the system account it is `~/.claude.json` unless
    /// `CLAUDE_CONFIG_DIR` was set when the server started — the same rule the
    /// `claude` program applies, so both read the same file.
    fn mcp_account(&self, brand: &str, profile: Option<&str>) -> super::mcp_servers::Account {
        let system = profile.is_none_or(|id| id == super::profiles::SYSTEM);
        let dir = self.account_dir(brand, profile);
        let claude_json = if system && std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
            self.paths.home.join(".claude.json")
        } else {
            dir.join(".claude.json")
        };
        super::mcp_servers::Account {
            dir,
            claude_json,
            system,
        }
    }

    /// A listing with the other accounts' servers filled in.
    ///
    /// Every MCP command answers with the whole list, and the panel draws
    /// whatever it is handed — so an add or a remove that answered without
    /// this would blank the other accounts' servers until the next read
    /// (bw-6ecp.2).
    fn with_elsewhere(
        &self,
        brand: &str,
        scope: &provider_settings::Scope,
        chosen: Option<&str>,
        mut listing: mcp_servers::Listing,
    ) -> mcp_servers::Listing {
        listing.elsewhere = self.mcp_elsewhere(brand, scope, chosen, &listing);
        listing
    }

    /// The servers this brand's OTHER accounts define, for the panel to name.
    ///
    /// Only for an account scope: a project's `.mcp.json` belongs to the
    /// project and every account reads the same one, so there is nothing to
    /// be elsewhere. A server this account already defines is left out — the
    /// point is to show what is missing here, not to list the same name twice.
    ///
    /// Each other account is read without the Codex CLI step. That step asks
    /// `codex mcp list --json` whether a sign-in is held, which costs up to
    /// five seconds per account and answers a question about signing in that
    /// nothing here asks: these entries are offered to be copied, not used.
    fn mcp_elsewhere(
        &self,
        brand: &str,
        scope: &provider_settings::Scope,
        chosen: Option<&str>,
        mine: &mcp_servers::Listing,
    ) -> Vec<mcp_servers::Elsewhere> {
        if !matches!(scope, provider_settings::Scope::Account { .. }) {
            return Vec::new();
        }
        let here = chosen.unwrap_or(super::profiles::SYSTEM);
        let no_cli: mcp_servers::CodexStatus = &|_, _| None;
        let mut out = Vec::new();
        for profile in self.profiles.list(brand) {
            if profile.id == here {
                continue;
            }
            let account = self.mcp_account(brand, Some(&profile.id));
            let Ok(listing) = mcp_servers::list_with(brand, scope, &account, no_cli) else {
                continue;
            };
            for server in listing.servers {
                if mine.servers.iter().any(|s| s.id == server.id) {
                    continue;
                }
                out.push(mcp_servers::Elsewhere {
                    account: profile.id.clone(),
                    account_name: profile.name.clone(),
                    server,
                });
            }
        }
        out
    }

    /// The Claude and Codex directories an agent-files command reads, for the
    /// account it names or the one the server booted with.
    fn agent_dirs(&self, profile: Option<&str>) -> (PathBuf, PathBuf) {
        (
            self.account_dir("claude", profile),
            self.account_dir("codex", profile),
        )
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

    /// Where one account's login lives.
    ///
    /// Deliberately `chat_dir` and not `directory`: an account that has been
    /// deleted names a path that is not there, and a read there answers empty.
    /// Falling back to the directory the server booted with would answer a
    /// question about the work account with the owner's own figures, which is
    /// the one wrong answer this whole epic exists to stop.
    pub fn profile_directory(&self, brand: &str, profile: &str) -> PathBuf {
        self.profiles.chat_dir(brand, Some(profile))
    }

    /// Every account this brand can be read on, as an id and its directory.
    pub fn every_account(&self, brand: &str) -> Vec<(String, PathBuf)> {
        self.profiles.everywhere(brand)
    }

    /// Who is holding each chat, partitioned by process provenance.
    ///
    /// A hold is found by reading a provider's own record directory, and each
    /// account keeps its own. Scanning only the directory the server booted
    /// with meant a chat open in a terminal on the work account read as
    /// nobody's (bw-5ihw.8).
    pub fn provider_ownership(&self, proc_root: &Path, now_ms: i64) -> ProviderOwnership {
        let claude = self.account_directories("claude", &self.paths.claude_config);
        let codex = self.account_directories("codex", &self.paths.codex_home);
        let mut ownership = ProviderOwnership::default();
        for hold in external::provider_holds(&claude, proc_root, &codex, now_ms) {
            let pids = hold.pids.clone();
            let mut ours = hold.clone();
            let mut outside = hold;
            ours.pids.clear();
            outside.pids.clear();
            for pid in pids {
                if external::owned_by_this_process(pid, proc_root) {
                    ours.pids.insert(pid);
                } else {
                    outside.pids.insert(pid);
                }
            }
            if !ours.pids.is_empty() {
                ownership.ours.push(ours);
            }
            if !outside.pids.is_empty() {
                ownership.external.push(outside);
            }
        }
        ownership
    }

    /// Holds outside this Atelier process. This is the only ownership view a
    /// browser or a command refusal may consume.
    pub fn provider_holds(&self, proc_root: &Path, now_ms: i64) -> Vec<ProviderHold> {
        self.provider_ownership(proc_root, now_ms).external
    }

    /// Every directory one brand's accounts live in, the boot directory alone
    /// for a brand that has no relocatable account.
    fn account_directories(&self, brand: &str, booted: &Path) -> Vec<PathBuf> {
        let known: Vec<PathBuf> = self
            .profiles
            .everywhere(brand)
            .into_iter()
            .map(|(_, directory)| directory)
            .collect();
        if known.is_empty() {
            vec![booted.to_path_buf()]
        } else {
            known
        }
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
        media: &Path,
    ) -> Result<String, String> {
        media::present_uploaded(args, stdin, files, media)
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
        media: &Path,
    ) -> Result<StoredCapture, String> {
        screen_check::store_static(bytes, label, source, media)
    }

    pub fn compare_captures(
        &self,
        before: &[u8],
        after: &[u8],
        media: &Path,
    ) -> Result<StoredComparison, String> {
        screen_check::compare_and_store(before, after, media)
    }

    /// Whether a driver of this process runs the chat, or has just gone and
    /// its stretch is not handed back yet. The record belongs to the driver
    /// for all of that time.
    pub async fn is_supervising(&self, session_id: &str) -> bool {
        self.supervising.lock().await.contains_key(session_id)
    }

    /// Hand back a chat left marked as driven by a driver that died with an
    /// earlier run of the server. A chat a driver of this process runs is not
    /// touched: its own ending hands it back.
    pub async fn hand_back_if_orphaned(&self, session_id: &str) {
        if self.is_supervising(session_id).await
            || !matches!(self.database.driven_from(session_id.to_string()).await, Ok(Some(_)))
        {
            return;
        }
        super::handback::hand_back(
            &self.database,
            session_id,
            &self.paths.claude_config,
            &self.paths.codex_home,
        )
        .await;
        let counts = self.supervising.lock().await;
        if !counts.contains_key(session_id) {
            let _ = self.database.end_driving(session_id.to_string()).await;
        }
    }

    /// Hand back every chat whose driver died with the last run of the server.
    pub async fn hand_back_the_orphaned(&self) {
        for session_id in self.database.still_driving().await.unwrap_or_default() {
            self.hand_back_if_orphaned(&session_id).await;
        }
    }

    pub async fn has_driver(&self, session_id: &str) -> bool {
        self.drivers
            .read()
            .await
            .get(session_id)
            .is_some_and(|driver| !driver.is_closed())
    }

    /// A test's stand-in for a live provider: the entry alone is what
    /// `has_driver` reads, and nothing is ever sent down it.
    #[cfg(test)]
    pub(crate) async fn pretend_driver(&self, session_id: &str) {
        let (requests, mut receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move { while receiver.recv().await.is_some() {} });
        self.drivers.write().await.insert(
            session_id.to_string(),
            Driver {
                requests,
                reconcile: None,
            },
        );
        begin_supervising(&self.supervising, &self.database, &self.paths, session_id).await;
    }

    /// The stand-in driver going as a real one does: out of the map, then its
    /// process closed, then its stretch handed back.
    #[cfg(test)]
    pub(crate) async fn let_driver_go(&self, session_id: &str) {
        self.drivers.write().await.remove(session_id);
        end_supervising(&self.supervising, &self.database, &self.paths, session_id).await;
    }

    /// The stand-in driver dying with the server: the mark stays, and nothing
    /// is handed back.
    #[cfg(test)]
    pub(crate) async fn lose_driver(&self, session_id: &str) {
        self.drivers.write().await.remove(session_id);
        self.supervising.lock().await.remove(session_id);
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
        self.launching
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        let _launch = LaunchGuard(self.launching.clone());

        let mut launched = self.factory.launch(self.database.clone(), command).await?;
        let Some(driver) = launched.driver.take() else {
            return Ok(launched.reply);
        };
        let mut drivers = self.drivers.write().await;
        if drivers
            .get(&launched.session_id)
            .is_some_and(|driver| !driver.is_closed())
        {
            drop(drivers);
            let mut driver = driver;
            let _ = driver.close().await;
            return Err(format!("session {} is already open", launched.session_id));
        }
        let (requests, receiver) = mpsc::unbounded_channel();
        let session_id = launched.session_id;
        let owner = requests.clone();
        drivers.insert(
            session_id.clone(),
            Driver {
                requests,
                reconcile: driver.reconciler(),
            },
        );
        drop(drivers);
        begin_supervising(&self.supervising, &self.database, &self.paths, &session_id).await;
        let live = self.drivers.clone();
        let database = self.database.clone();
        let supervising = self.supervising.clone();
        let paths = self.paths.clone();
        tokio::spawn(async move {
            supervise_driver(database.clone(), session_id.clone(), driver, receiver).await;
            {
                let mut live = live.write().await;
                if live
                    .get(&session_id)
                    .is_some_and(|current| current.same_channel(&owner))
                {
                    live.remove(&session_id);
                    // Even a dropped completion callback leaves no active status.
                    let _ = super::status::reconcile(&database, &session_id, None).await;
                }
            }
            end_supervising(&supervising, &database, &paths, &session_id).await;
        });
        Ok(launched.reply)
    }

    /// Opening is only a read operation. If this process already owns the
    /// conversation, its driver and durable state are the source of truth;
    /// asking the provider factory to "open" it would incorrectly demote the
    /// live row to dormant and race a second driver against the first one.
    ///
    /// A driver is the usual proof of ownership, but not the only one. A local
    /// chat that has not been told which model to use is created awake and
    /// deliberately driverless — there is nothing to start until the model is
    /// known — and reading it by address is exactly what happens next, because
    /// starting a chat navigates straight to it. Judged on the driver alone
    /// that read demoted the chat to "Asleep" 116ms after it was made, which
    /// then dropped it out of the sidebar, whose live half keeps only what is
    /// awake. The chat the person had just asked for went to sleep on arrival
    /// (bw-u6cl.2).
    ///
    /// Deliberately narrow: only a local chat that is *still awake* and has no
    /// model yet. Once it is dormant this process no longer owns it and the
    /// stale-state healing below is right again — which is what
    /// `reading_by_address_reconciles_a_stale_saved_session` holds.
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
        let awaiting_its_model = session.state != "dormant"
            && session.brand == super::local::BRAND
            && session.model.is_none();
        if !self.has_driver(&session.id).await && !awaiting_its_model {
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

    /// A field the caller may leave out. Absent and empty read the same, so a
    /// screen that has nothing to put there can omit it or send "" and get the
    /// same answer either way.
    /// The `scope`, `profileId` and `projectPath` fields as one scope.
    fn settings_scope(command: &Command) -> Result<provider_settings::Scope, String> {
        serde_json::from_value(Value::Object(command.fields.clone())).map_err(|_| {
            "scope must be account, or project with an absolute projectPath".to_string()
        })
    }

    /// The `source` field of an MCP command.
    fn mcp_source(command: &Command) -> Result<mcp_servers::Source, String> {
        serde_json::from_value(command.at("source").clone())
            .map_err(|_| "source must be user, project or local".to_string())
    }

    fn maybe<'a>(command: &'a Command, name: &str) -> Option<&'a str> {
        command
            .fields
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    }

    /// The account behind an extensions command: its brand, scope, config
    /// directory, and the directory to hand a spawned CLI (`None` for the
    /// system account, which is run with the environment as the server has
    /// it, as `signin` does).
    fn extension_account(
        &self,
        command: &Command,
    ) -> Result<(String, provider_settings::Scope, PathBuf, Option<PathBuf>), String> {
        let brand = Self::field(command, "brand")?;
        let scope = Self::settings_scope(command)?;
        let profile = Self::maybe(command, "profileId");
        let dir = self.account_dir(brand, profile);
        let spawn_dir = profile
            .filter(|id| *id != super::profiles::SYSTEM)
            .map(|_| dir.clone());
        Ok((brand.to_string(), scope, dir, spawn_dir))
    }

    fn extensions_list(
        &self,
        brand: &str,
        scope: &provider_settings::Scope,
        dir: &Path,
    ) -> Result<Value, String> {
        Ok(json!({"kinds": extensions::list(brand, scope, dir)?}))
    }

    /// The plugins and marketplaces of the account behind a command, for
    /// either brand: Claude's read off its files, Codex's asked of its CLI.
    async fn extension_kinds(&self, command: &Command) -> Result<Value, String> {
        let (brand, scope, dir, spawn_dir) = self.extension_account(command)?;
        match (brand.as_str(), &scope) {
            ("codex", provider_settings::Scope::Account { .. }) => {
                let program = Self::codex_program()?;
                Ok(json!({"kinds": codex_plugins::list(&program, spawn_dir.as_deref(), &dir).await?}))
            }
            _ => self.extensions_list(&brand, &scope, &dir),
        }
    }

    fn codex_program() -> Result<PathBuf, String> {
        crate::routes::find_tool("codex", &[]).ok_or_else(|| "codex is not installed on this machine".into())
    }

    /// The account behind a Codex plugin command. Codex plugins belong to an
    /// account; a project has none of its own to move.
    fn codex_plugin_account(&self, command: &Command) -> Result<Option<(PathBuf, Option<PathBuf>)>, String> {
        let (brand, scope, dir, spawn_dir) = self.extension_account(command)?;
        if brand != "codex" {
            return Ok(None);
        }
        if matches!(scope, provider_settings::Scope::Project { .. }) {
            return Err("Codex plugins belong to an account, not a project".into());
        }
        Ok(Some((dir, spawn_dir)))
    }

    /// Run Codex's own CLI for a plugin or marketplace command and answer its
    /// outcome with the list as it now reads.
    async fn codex_plugin_cli(
        &self,
        command: &Command,
        words: &[&str],
        within: Duration,
    ) -> Result<Value, String> {
        let program = Self::codex_program()?;
        let (dir, spawn_dir) = self
            .codex_plugin_account(command)?
            .ok_or("not a Codex account")?;
        let outcome = extensions::run_cli(
            &program,
            codex_plugins::HOME_VARIABLE,
            spawn_dir.as_deref(),
            None,
            words,
            within,
        )
        .await?;
        let mut answer = serde_json::to_value(&outcome).map_err(|e| e.to_string())?;
        answer["kinds"] = json!(codex_plugins::list(&program, spawn_dir.as_deref(), &dir).await?);
        Ok(answer)
    }

    /// Run Claude's own CLI for a plugin or marketplace command and answer
    /// its outcome with the list as it now reads.
    async fn claude_plugin_cli(
        &self,
        command: &Command,
        words: Vec<String>,
        within: Duration,
    ) -> Result<Value, String> {
        let (brand, scope, dir, spawn_dir) = self.extension_account(command)?;
        if brand != "claude" {
            return Err("plugins and marketplaces are a Claude Code feature".into());
        }
        let program = crate::routes::find_tool("claude", &[])
            .ok_or("claude is not installed on this machine")?;
        let (cwd, scope_word) = match &scope {
            provider_settings::Scope::Project { path } => (Some(path.clone()), "project"),
            provider_settings::Scope::Account { .. } => (None, "user"),
        };
        let mut args: Vec<&str> = words.iter().map(String::as_str).collect();
        let scope_flag = if args.first() == Some(&"plugin") && args.get(1) == Some(&"marketplace") {
            "--scope"
        } else {
            "-s"
        };
        args.push(scope_flag);
        args.push(scope_word);
        let outcome = extensions::run_cli(
            &program,
            "CLAUDE_CONFIG_DIR",
            spawn_dir.as_deref(),
            cwd.as_deref(),
            &args,
            within,
        )
        .await?;
        let mut answer = serde_json::to_value(&outcome).map_err(|e| e.to_string())?;
        answer["kinds"] = json!(extensions::list(&brand, &scope, &dir)?);
        Ok(answer)
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

    /// Establish the only state from which a driverless command may proceed.
    ///
    /// A genuine outside owner blocks unless the caller explicitly requested
    /// takeover. A surviving process from one of our retired drivers is not
    /// outside ownership and is reaped before a replacement is launched. Thus
    /// neither a false external refusal nor two Atelier-owned providers can be
    /// produced by a dropped driver stream.
    async fn prepare_unattached(&self, command: &Command, takeover: bool) -> Result<(), String> {
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
        let ownership = self.provider_ownership(Path::new("/proc"), now);
        let outside = ownership
            .external
            .iter()
            .filter(|hold| hold.id.eq_ignore_ascii_case(external_id))
            .flat_map(|hold| hold.pids.iter().copied())
            .collect::<std::collections::BTreeSet<_>>();
        if !outside.is_empty() && !takeover {
            return Err("Another program has this chat open".into());
        }
        let mut pids = ownership
            .ours
            .iter()
            .filter(|hold| hold.id.eq_ignore_ascii_case(external_id))
            .flat_map(|hold| hold.pids.iter().copied())
            .collect::<std::collections::BTreeSet<_>>();
        if takeover {
            pids.extend(outside);
        }
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
        Err(if takeover {
            "Chat is still active elsewhere.".into()
        } else {
            "Atelier's previous provider process is still shutting down.".into()
        })
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
                let menu = self.database.offered_menu(session_id.to_string()).await?;
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
                let menu = self.database.offered_menu(session_id.to_string()).await?;
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
        // Choosing a model makes a local chat usable, which is what this says.
        // It said it whatever the chat was doing, so picking a model in the
        // middle of a turn drew that turn as finished — the clock stopped, the
        // row left the working list, and nothing afterwards put it right
        // (bw-xfb4).
        if command.kind == CommandKind::SessionModel
            && session.brand == super::local::BRAND
            && session.model.is_some()
            && !matches!(
                session.state.as_str(),
                "thinking"
                    | "streaming"
                    | "running_tool"
                    | "waiting_for_agents"
                    | "waiting_permission"
            )
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

    /// Close the idle provider processes of every chat on one account, after
    /// that account has been signed in again.
    ///
    /// A provider program reads its login when it starts, and one whose login
    /// expired has given up on it: the chat that said "OAuth session expired"
    /// would say it again on the next message, even with a fresh login on
    /// disk. Retiring keeps the conversation, so the next message attaches a
    /// new process that resumes it on the new login. A chat mid-answer is left
    /// alone; it is not the one that failed.
    pub async fn retire_idle_on_account(&self, brand: &str, profile_id: &str) {
        let chosen = (profile_id != super::profiles::SYSTEM).then(|| profile_id.to_string());
        let ids: Vec<String> = self.drivers.read().await.keys().cloned().collect();
        for session_id in ids {
            let Ok(Some(session)) = self.database.get_session(session_id.clone()).await else {
                continue;
            };
            if session.brand != brand
                || session.profile != chosen
                || matches!(
                    session.state.as_str(),
                    "starting" | "thinking" | "streaming" | "running_tool" | "waiting_for_agents" | "waiting_permission"
                )
            {
                continue;
            }
            let Some(driver) = self.drivers.write().await.remove(&session_id) else {
                continue;
            };
            let (reply, receive) = oneshot::channel();
            if driver.send(DriverRequest::Retire(reply)).is_ok() {
                let _ = receive.await;
            }
            // The process that raised "Sign in to continue" is gone, and a new
            // one knows nothing of it, so nothing would ever take the notice
            // down. It is taken down here, and the chat says what to do now.
            if session.state == "stopped" {
                let _ = self.after_signing_in(&session, profile_id).await;
            }
        }
    }

    async fn after_signing_in(&self, session: &crate::workbench::store::Session, profile_id: &str) -> Result<(), String> {
        let resolved: crate::workbench::protocol::Event = serde_json::from_value(json!({
            "type":"provider.message", "sessionId":session.id, "seq":0, "at":chrono::Utc::now().to_rfc3339(),
            "signal":{
                "id":"condition:authentication", "kind":"authentication", "phase":"resolved",
                "severity":"info", "scope":"session"
            }
        }))
        .map_err(|error| error.to_string())?;
        self.database.append(resolved).await?;
        let name = self
            .profiles
            .list(&session.brand)
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .map(|profile| profile.name)
            .unwrap_or_else(|| profile_id.to_string());
        // His to act on, so drawn by default: an aside with no audience is
        // the app talking about itself and starts hidden.
        let notice: crate::workbench::protocol::Event = serde_json::from_value(json!({
            "type":"notice", "sessionId":session.id, "seq":0, "at":chrono::Utc::now().to_rfc3339(),
            "text":format!("Signed in to {name}. Send your message again to continue."),
            "family":"background", "audience":"you"
        }))
        .map_err(|error| error.to_string())?;
        self.database.append(notice).await?;
        self.database
            .update_session(
                session.id.clone(),
                crate::workbench::store::SessionPatch {
                    state: Some("idle".into()),
                    ..Default::default()
                },
                None,
            )
            .await?;
        let state: crate::workbench::protocol::Event = serde_json::from_value(json!({
            "type":"session.state", "sessionId":session.id, "seq":0,
            "at":chrono::Utc::now().to_rfc3339(), "state":"idle", "label":"Idle"
        }))
        .map_err(|error| error.to_string())?;
        self.database.append(state).await?;
        Ok(())
    }

    /// Move the next turn to another login while keeping this local chat.
    /// Provider CLIs choose their account from an environment variable at
    /// process startup, so this cannot be an in-process setting change.
    async fn switch_profile(&self, command: &Command) -> Result<Value, String> {
        let session_id = Self::field(command, "sessionId")?;
        let profile_id = Self::field(command, "profileId")?;
        let mut session = self
            .database
            .get_session(session_id.to_string())
            .await?
            .ok_or_else(|| format!("no session {session_id}"))?;
        if super::profiles::variable(&session.brand).is_none() {
            return Err(format!("{} has no account to switch", session.brand));
        }
        let profile = self
            .profiles
            .list(&session.brand)
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| format!("no {} profile {profile_id}", session.brand))?;
        let chosen = (!profile.system).then(|| profile.id.clone());
        if session.profile == chosen {
            return Ok(json!({"ok":true,"profile":chosen}));
        }
        if matches!(
            session.state.as_str(),
            "starting" | "thinking" | "streaming" | "running_tool" | "waiting_for_agents" | "waiting_permission"
        ) {
            return Err("Wait for the current response to finish before changing accounts.".into());
        }

        let context = self.database.account_handoff(session_id.to_string()).await?;

        // Remove first so a prompt arriving after the reply always takes the
        // lazy attach path. Retiring closes only the process; unlike Chat Close
        // it does not end the conversation or add an Asleep transition.
        if let Some(driver) = self.drivers.write().await.remove(session_id) {
            let (reply, receive) = oneshot::channel();
            driver
                .send(DriverRequest::Retire(reply))
                .map_err(|_| format!("provider for {session_id} stopped"))?;
            receive
                .await
                .map_err(|_| format!("provider for {session_id} stopped before switching"))??;
        }

        if context.is_empty() {
            self.database.clear_account_handoff(session_id.to_string()).await?;
        } else {
            self.database
                .save_account_handoff(session_id.to_string(), context)
                .await?;
        }

        session.profile = chosen.clone();
        session.external_id = None;
        session.state = "dormant".into();
        self.database
            .update_session(
                session_id.to_string(),
                crate::workbench::store::SessionPatch {
                    external_id: Some(None),
                    profile: Some(chosen.clone()),
                    state: Some("dormant".into()),
                    ..Default::default()
                },
                None,
            )
            .await?;
        super::provider::append_started(&self.database, &session, false).await?;
        super::provider::append_notice(
            &self.database,
            session_id,
            &format!("Account changed to {}. The next message continues this conversation there.", profile.name),
        )
        .await?;
        self.database
            .append(serde_json::from_value(json!({
                "type":"session.state", "sessionId":session_id, "seq":0,
                "at":chrono::Utc::now().to_rfc3339(), "state":"dormant", "label":"Asleep"
            })).map_err(|error| error.to_string())?)
            .await?;
        Ok(json!({"ok":true,"profile":chosen}))
    }

    /// Execute one already-decoded WBP command and return the exact JSON body
    /// the former helper returned. Unknown discriminators have already been
    /// refused by `protocol::Command` before they can reach this registry.
    /// Every read/interaction uses this same runtime reconciliation entrypoint.
    pub async fn reconcile_status(&self, session_id: &str) -> Result<Value, String> {
        reconcile_session(&self.database, &self.drivers, &self.launching, session_id).await
    }

    pub async fn execute(&self, command: &Command) -> Result<Value, String> {
        let id = command.fields.get("sessionId").and_then(Value::as_str);
        if command.kind != CommandKind::SessionStop {
            if let Some(id) = id {
                self.reconcile_status(id).await?;
            }
        }
        let result = self.execute_inner(command).await;
        let result_id = id.or_else(|| result.as_ref().ok().and_then(|value| value["id"].as_str()));
        if let Some(id) = result_id {
            self.reconcile_status(id).await?;
            if command.kind == CommandKind::SessionOpen && result.is_ok() {
                if let Some(session) = self.database.get_session(id.to_string()).await? {
                    return serde_json::to_value(session).map_err(|error| error.to_string());
                }
            }
        }
        result
    }

    async fn execute_inner(&self, command: &Command) -> Result<Value, String> {
        match command.kind {
            // A project is what the reader narrows to, never what he needs to
            // have: the screen opens on "Personal files only", and a machine
            // with no project registered has nothing else to offer. Requiring
            // one here answered that opening view with a refusal, so the very
            // first look at the screen showed no files at all (bw-03gc.1).
            CommandKind::AgentFilesList => {
                let project = Self::maybe(command, "projectPath");
                let (claude, codex) = self.agent_dirs(Self::maybe(command, "profileId"));
                let files = agent_files::discover(
                    project.map(Path::new),
                    &self.paths.home,
                    Some(&claude),
                    Some(&codex),
                );
                let creatable = agent_files::creatable(
                    project.map(Path::new),
                    &self.paths.home,
                    Some(&claude),
                    Some(&codex),
                );
                Ok(json!({"files":files,"creatable":creatable}))
            }
            CommandKind::AgentFilesRead => {
                let project = Self::maybe(command, "projectPath");
                let path = Self::field(command, "path")?;
                let (claude, codex) = self.agent_dirs(Self::maybe(command, "profileId"));
                let (content, truncated) = agent_files::read(
                    Path::new(path),
                    project.map(Path::new),
                    &self.paths.home,
                    Some(&claude),
                    Some(&codex),
                )?;
                Ok(json!({"content":content,"truncated":truncated}))
            }
            CommandKind::AgentFilesWrite => {
                let project = Self::maybe(command, "projectPath");
                let path = Self::field(command, "path")?;
                let content = command
                    .fields
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or("content is required")?;
                let (claude, codex) = self.agent_dirs(Self::maybe(command, "profileId"));
                let size = agent_files::write(
                    Path::new(path),
                    content,
                    project.map(Path::new),
                    &self.paths.home,
                    Some(&claude),
                    Some(&codex),
                )?;
                Ok(json!({"ok":true,"path":path,"size":size}))
            }
            CommandKind::AgentFilesDelete => {
                let project = Self::maybe(command, "projectPath");
                let path = Self::field(command, "path")?;
                let (claude, codex) = self.agent_dirs(Self::maybe(command, "profileId"));
                agent_files::delete(
                    Path::new(path),
                    project.map(Path::new),
                    &self.paths.home,
                    Some(&claude),
                    Some(&codex),
                )?;
                Ok(json!({"ok":true,"path":path}))
            }
            CommandKind::ProviderSettingsRead => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let dir = self.account_dir(brand, Self::maybe(command, "profileId"));
                serde_json::to_value(provider_settings::read(brand, &scope, &dir)?)
                    .map_err(|e| e.to_string())
            }
            CommandKind::ProviderSettingsWrite => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let layer: provider_settings::Layer = command
                    .fields
                    .get("layer")
                    .cloned()
                    .and_then(|value| serde_json::from_value(value).ok())
                    .ok_or("layer must be user, project or local")?;
                let patch = command
                    .fields
                    .get("patch")
                    .and_then(Value::as_object)
                    .ok_or("patch must be an object of dotted keys")?;
                let dir = self.account_dir(brand, Self::maybe(command, "profileId"));
                serde_json::to_value(provider_settings::write(brand, &scope, &dir, layer, patch)?)
                    .map_err(|e| e.to_string())
            }
            CommandKind::ExtensionsList => self.extension_kinds(command).await,
            CommandKind::PluginSetEnabled => {
                let id = Self::field(command, "id")?.to_string();
                let enabled = command
                    .at("enabled")
                    .as_bool()
                    .ok_or("enabled must be true or false")?;
                // Codex has no verb for this; the switch is its own table in
                // config.toml, written the way Codex writes it.
                if let Some((dir, _)) = self.codex_plugin_account(command)? {
                    let config = dir.join("config.toml");
                    codex_plugins::set_enabled(&config, &id, enabled)?;
                    let mut answer = self.extension_kinds(command).await?;
                    answer["ok"] = json!(true);
                    answer["output"] = json!(format!(
                        "{} was set in {}",
                        if enabled { "enabled" } else { "disabled" },
                        config.display()
                    ));
                    return Ok(answer);
                }
                let verb = if enabled { "enable" } else { "disable" };
                let words = vec!["plugin".to_string(), verb.to_string(), id.clone()];
                match self.claude_plugin_cli(command, words, extensions::QUICK_CLI).await {
                    Ok(answer) if answer["ok"] == json!(true) => Ok(answer),
                    // The CLI is not there or refused: the switch is one key
                    // in settings.json, so it is set there directly.
                    Ok(_) | Err(_) => {
                        let (brand, scope, dir, _) = self.extension_account(command)?;
                        if brand != "claude" {
                            return Err("plugins are a Claude Code feature".into());
                        }
                        let settings = match &scope {
                            provider_settings::Scope::Project { path } => {
                                path.join(".claude/settings.json")
                            }
                            provider_settings::Scope::Account { .. } => dir.join("settings.json"),
                        };
                        extensions::set_enabled_in_settings(&settings, &id, enabled)?;
                        let mut answer = self.extensions_list(&brand, &scope, &dir)?;
                        answer["ok"] = json!(true);
                        answer["output"] = json!(format!(
                            "{} was set in {}",
                            if enabled { "enabled" } else { "disabled" },
                            settings.display()
                        ));
                        Ok(answer)
                    }
                }
            }
            CommandKind::PluginInstall | CommandKind::PluginUninstall => {
                let id = Self::field(command, "id")?.to_string();
                let install = command.kind == CommandKind::PluginInstall;
                if self.codex_plugin_account(command)?.is_some() {
                    let verb = if install { "add" } else { "remove" };
                    return self
                        .codex_plugin_cli(command, &["plugin", verb, &id], extensions::SLOW_CLI)
                        .await;
                }
                let verb = if install { "install" } else { "uninstall" };
                let words = vec!["plugin".to_string(), verb.to_string(), id];
                self.claude_plugin_cli(command, words, extensions::SLOW_CLI)
                    .await
            }
            CommandKind::PluginCatalogue => {
                if let Some((dir, spawn_dir)) = self.codex_plugin_account(command)? {
                    let program = Self::codex_program()?;
                    let listing = codex_plugins::browse(&program, spawn_dir.as_deref(), &dir).await?;
                    return serde_json::to_value(listing).map_err(|e| e.to_string());
                }
                let (brand, _, dir, _) = self.extension_account(command)?;
                if brand != "claude" {
                    return Err("brand must be claude or codex".into());
                }
                serde_json::to_value(plugin_catalogue::browse(&dir).await).map_err(|e| e.to_string())
            }
            // Installing from the catalogue is the two commands a reader would
            // have had to run: the marketplace is added first when the account
            // does not have it, because `plugin install` cannot reach into one
            // it has never heard of.
            CommandKind::PluginInstallFromCatalogue => {
                let id = Self::field(command, "id")?.to_string();
                // Codex lists only from marketplaces it already has.
                if self.codex_plugin_account(command)?.is_some() {
                    return self
                        .codex_plugin_cli(command, &["plugin", "add", &id], extensions::SLOW_CLI)
                        .await;
                }
                let origin = Self::maybe(command, "origin").unwrap_or_default().to_string();
                let known = command.at("known").as_bool().unwrap_or(false);
                if !known && !origin.is_empty() {
                    let words = vec![
                        "plugin".to_string(),
                        "marketplace".to_string(),
                        "add".to_string(),
                        origin.clone(),
                    ];
                    let added = self
                        .claude_plugin_cli(command, words, extensions::SLOW_CLI)
                        .await?;
                    if added["ok"] != json!(true) {
                        return Ok(added);
                    }
                }
                let words = vec!["plugin".to_string(), "install".to_string(), id];
                self.claude_plugin_cli(command, words, extensions::SLOW_CLI)
                    .await
            }
            CommandKind::MarketplaceAdd => {
                let source = Self::field(command, "source")?.to_string();
                if self.codex_plugin_account(command)?.is_some() {
                    return self
                        .codex_plugin_cli(
                            command,
                            &["plugin", "marketplace", "add", &source],
                            extensions::SLOW_CLI,
                        )
                        .await;
                }
                let words = vec![
                    "plugin".to_string(),
                    "marketplace".to_string(),
                    "add".to_string(),
                    source,
                ];
                self.claude_plugin_cli(command, words, extensions::SLOW_CLI)
                    .await
            }
            CommandKind::MarketplaceRemove => {
                let name = Self::field(command, "name")?.to_string();
                if self.codex_plugin_account(command)?.is_some() {
                    return self
                        .codex_plugin_cli(
                            command,
                            &["plugin", "marketplace", "remove", &name],
                            extensions::QUICK_CLI,
                        )
                        .await;
                }
                let words = vec![
                    "plugin".to_string(),
                    "marketplace".to_string(),
                    "remove".to_string(),
                    name,
                ];
                self.claude_plugin_cli(command, words, extensions::QUICK_CLI)
                    .await
            }
            CommandKind::McpCatalogue => {
                let search = Self::maybe(command, "search");
                let listing = mcp_catalogue::browse(search).await;
                serde_json::to_value(listing).map_err(|e| e.to_string())
            }
            CommandKind::McpAddFromCatalogue => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let source = Self::mcp_source(command)?;
                let entry: mcp_catalogue::Entry =
                    serde_json::from_value(command.at("entry").clone())
                        .map_err(|e| format!("entry is not a catalogue entry: {e}"))?;
                let id = Self::maybe(command, "id").unwrap_or(&entry.id).to_string();
                let supplied = command
                    .at("env")
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                let config = mcp_catalogue::config(brand, &entry, &supplied);
                let chosen = Self::maybe(command, "profileId");
                let account = self.mcp_account(brand, chosen);
                let listing = mcp_servers::add(brand, &scope, &account, source, &id, &config)?;
                serde_json::to_value(self.with_elsewhere(brand, &scope, chosen, listing))
                    .map_err(|e| e.to_string())
            }
            CommandKind::McpList => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let chosen = Self::maybe(command, "profileId");
                let account = self.mcp_account(brand, chosen);
                let listing = mcp_servers::list(brand, &scope, &account)?;
                serde_json::to_value(self.with_elsewhere(brand, &scope, chosen, listing))
                    .map_err(|e| e.to_string())
            }
            CommandKind::McpAdd => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let source = Self::mcp_source(command)?;
                let id = Self::field(command, "id")?;
                let config = command
                    .fields
                    .get("config")
                    .and_then(Value::as_object)
                    .ok_or("config must be an object")?;
                let chosen = Self::maybe(command, "profileId");
                let account = self.mcp_account(brand, chosen);
                let listing = mcp_servers::add(brand, &scope, &account, source, id, config)?;
                serde_json::to_value(self.with_elsewhere(brand, &scope, chosen, listing))
                    .map_err(|e| e.to_string())
            }
            CommandKind::McpRemove => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let source = Self::mcp_source(command)?;
                let id = Self::field(command, "id")?;
                let chosen = Self::maybe(command, "profileId");
                let account = self.mcp_account(brand, chosen);
                let listing = mcp_servers::remove(brand, &scope, &account, source, id)?;
                serde_json::to_value(self.with_elsewhere(brand, &scope, chosen, listing))
                    .map_err(|e| e.to_string())
            }
            CommandKind::McpSetEnabled => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let source = Self::mcp_source(command)?;
                let id = Self::field(command, "id")?;
                let enabled = command
                    .at("enabled")
                    .as_bool()
                    .ok_or("enabled must be true or false")?;
                let chosen = Self::maybe(command, "profileId");
                let account = self.mcp_account(brand, chosen);
                let listing =
                    mcp_servers::set_enabled(brand, &scope, &account, source, id, enabled)?;
                serde_json::to_value(self.with_elsewhere(brand, &scope, chosen, listing))
                .map_err(|e| e.to_string())
            }
            CommandKind::McpLogin | CommandKind::McpLogout => {
                let brand = Self::field(command, "brand")?;
                let scope = Self::settings_scope(command)?;
                let id = Self::field(command, "id")?;
                let account = self.mcp_account(brand, Self::maybe(command, "profileId"));
                let out = command.kind == CommandKind::McpLogout;
                serde_json::to_value(mcp_servers::login(brand, &scope, &account, id, out).await?)
                    .map_err(|e| e.to_string())
            }
            CommandKind::ProviderDefaultsRead => {
                let brand = Self::field(command, "brand")?;
                let files = self.defaults_for(brand, Self::maybe(command, "profileId"));
                serde_json::to_value(files.read(brand)?).map_err(|e| e.to_string())
            }
            CommandKind::ProviderDefaultsWrite => {
                let brand = Self::field(command, "brand")?;
                let kind = Self::field(command, "kind")?;
                let value = Self::field(command, "value")?;
                let files = self.defaults_for(brand, Self::maybe(command, "profileId"));
                serde_json::to_value(files.write(brand, kind, value)?).map_err(|e| e.to_string())
            }
            CommandKind::ProviderAuthenticate => {
                let brand = Self::field(command, "brand")?;
                let method = Self::field(command, "methodId")?;
                super::acp::client::authenticate(brand, method).await
            }
            CommandKind::ProviderLogout => {
                let brand = Self::field(command, "brand")?;
                super::acp::client::logout(brand).await
            }
            CommandKind::ProfilesList => {
                let brand = Self::field(command, "brand")?;
                Ok(json!({"profiles":self.profiles.list(brand)}))
            }
            CommandKind::ProfileCreate => {
                let brand = Self::field(command, "brand")?;
                let name = Self::field(command, "name")?;
                let made = self.profiles.create(brand, name)?;
                Ok(json!({"profile":made,"profiles":self.profiles.list(brand)}))
            }
            CommandKind::ProfileRename => {
                let brand = Self::field(command, "brand")?;
                let id = Self::field(command, "profileId")?;
                let name = Self::field(command, "name")?;
                let renamed = self.profiles.rename(brand, id, name)?;
                Ok(json!({"profile":renamed,"profiles":self.profiles.list(brand)}))
            }
            CommandKind::ProfileDelete => {
                let brand = Self::field(command, "brand")?;
                let id = Self::field(command, "profileId")?;
                self.profiles.delete(brand, id)?;
                Ok(json!({"profiles":self.profiles.list(brand)}))
            }
            CommandKind::ProfilesStanding => {
                let brand = Self::field(command, "brand")?;
                let mut standing = serde_json::Map::new();
                for profile in self.profiles.list(brand) {
                    // The system profile is asked with the environment left
                    // alone; see `signin::standing`.
                    let directory =
                        (!profile.system).then(|| self.profiles.chat_dir(brand, Some(&profile.id)));
                    let answer = super::signin::standing(brand, directory.as_deref()).await;
                    standing.insert(
                        profile.id,
                        serde_json::to_value(answer).map_err(|why| why.to_string())?,
                    );
                }
                Ok(json!({ "standing": standing }))
            }
            CommandKind::ProfileSignInStart => {
                let brand = Self::field(command, "brand")?;
                let id = Self::field(command, "profileId")?;
                // Through the registry rather than from the id as sent, so a
                // sign-in cannot be aimed at a directory no profile names.
                // The system profile is signed into the way a terminal would
                // do it, with nothing named; see `signin::standing`.
                let named = self.profiles.directory(brand, id)?;
                let directory = (id != super::profiles::SYSTEM).then_some(named);
                let progress = self.signins.start(brand, id, directory.as_deref()).await?;
                serde_json::to_value(progress).map_err(|why| why.to_string())
            }
            CommandKind::ProfileSignInRead => {
                let brand = Self::field(command, "brand")?;
                let id = Self::field(command, "profileId")?;
                let progress = self.signins.read(brand, id).await?;
                serde_json::to_value(progress).map_err(|why| why.to_string())
            }
            CommandKind::ProfileSignInPaste => {
                let brand = Self::field(command, "brand")?;
                let id = Self::field(command, "profileId")?;
                let code = Self::field(command, "code")?;
                let progress = self.signins.paste(brand, id, code).await?;
                serde_json::to_value(progress).map_err(|why| why.to_string())
            }
            CommandKind::ProfileSignInCancel => {
                let brand = Self::field(command, "brand")?;
                let id = Self::field(command, "profileId")?;
                self.signins.cancel(brand, id)?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionProfile => self.switch_profile(command).await,
            CommandKind::SessionRename => {
                let session_id = Self::field(command, "sessionId")?;
                let title = Self::field(command, "title")?.trim();
                if title.is_empty() {
                    return Err("a chat title cannot be empty".into());
                }
                if title.chars().count() > 200 {
                    return Err("a chat title cannot be longer than 200 characters".into());
                }
                self.database
                    .get_session(session_id.to_string())
                    .await?
                    .ok_or_else(|| format!("no session {session_id}"))?;
                self.database
                    .update_session(
                        session_id.to_string(),
                        crate::workbench::store::SessionPatch {
                            title: Some(Some(title.to_string())),
                            named_by_owner: Some(true),
                            ..Default::default()
                        },
                        None,
                    )
                    .await?;
                let event: crate::workbench::protocol::Event = serde_json::from_value(json!({
                    "type":"session.pinned", "sessionId":session_id, "seq":0,
                    "at":chrono::Utc::now().to_rfc3339(), "permissionMode":Value::Null,
                    "model":Value::Null, "effort":Value::Null, "collaborationMode":Value::Null,
                    "title":title, "titleSource":"user"
                }))
                .map_err(|error| error.to_string())?;
                self.database.append(event).await?;
                Ok(json!({"ok":true,"title":title}))
            }
            CommandKind::ProvidersList => {
                let mut providers = [
                    (
                        "claude",
                        "Claude",
                        "https://docs.anthropic.com/en/docs/claude-code",
                    ),
                    ("codex", "Codex", "https://developers.openai.com/codex/cli"),
                ]
                .into_iter()
                .map(|(brand, name, install_url)| {
                    let runtime = super::acp::adapter::availability(brand);
                    json!({
                        "brand":brand,
                        "name":name,
                        "available":runtime.available,
                        "path":runtime.runtime,
                        "adapterPath":runtime.adapter,
                        "availabilityReason":runtime.reason,
                        "installUrl":install_url,
                        "models":[]
                    })
                })
                .collect::<Vec<_>>();
                providers.extend(super::local::providers().await);
                Ok(json!({"providers":providers}))
            }
            CommandKind::SessionDelete => {
                let session_id = Self::field(command, "sessionId")?;
                if self.has_driver(session_id).await {
                    return Err("close the live session before deleting it".into());
                }
                self.prepare_unattached(command, false).await?;
                let session = self
                    .database
                    .get_session(session_id.to_string())
                    .await?
                    .ok_or_else(|| format!("no session {session_id}"))?;
                super::acp::client::delete_session(&session).await?;
                self.database.delete_session(session_id.to_string()).await?;
                Ok(json!({"ok":true}))
            }
            CommandKind::SessionFork => {
                let session_id = Self::field(command, "sessionId")?;
                let source = self
                    .database
                    .get_session(session_id.to_string())
                    .await?
                    .ok_or_else(|| format!("no session {session_id}"))?;
                let response = super::acp::client::fork_session(&source).await?;
                let external_id = response["sessionId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| "ACP session/fork returned no session id".to_string())?;
                let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let mut fork = source.clone();
                fork.id = uuid::Uuid::new_v4().to_string();
                fork.external_id = Some(external_id.to_string());
                fork.title = source.title.as_ref().map(|title| format!("{title} (fork)"));
                fork.state = "dormant".into();
                fork.origin = "atelier".into();
                fork.created_at = at.clone();
                fork.last_active_at = at;
                fork.last_spoke_at = None;
                self.database.create_session(fork.clone()).await?;
                super::provider::append_started(&self.database, &fork, false).await?;
                serde_json::to_value(fork).map_err(|error| error.to_string())
            }
            CommandKind::SessionOpen => {
                if let Some(session) = self.already_live_open(command).await? {
                    return Ok(session);
                }
                self.launch(command).await
            }
            CommandKind::SessionStart | CommandKind::SessionResume => {
                if let Some(session) = self.already_live_open(command).await? {
                    return Ok(session);
                }
                self.prepare_unattached(command, false).await?;
                self.launch(command).await
            }
            // Hold a message rather than interrupt the turn with it.
            //
            // Nothing here is brand-aware, and that is the point: what the
            // reader wrote is kept by the app, and every provider gets it as
            // the ordinary prompt it would have got anyway, once its turn is
            // over (bw-r54j.1).
            CommandKind::PromptHold => {
                let session_id = Self::field(command, "sessionId")?;
                let text = command.at("text").as_str().unwrap_or_default().to_string();
                let images = match command.at("images") {
                    Value::Array(images) => Value::Array(images.clone()),
                    _ => json!([]),
                };
                if text.trim().is_empty() && images.as_array().is_some_and(Vec::is_empty) {
                    return Err("there is nothing in the message to hold".into());
                }
                if self.database.get_session(session_id.to_string()).await?.is_none() {
                    return Err(format!("no session {session_id}"));
                }
                let parts = match command.at("parts") {
                    Value::Array(parts) => Some(Value::Array(parts.clone())),
                    _ => None,
                };
                let held = self
                    .database
                    .hold_message(
                        session_id.to_string(),
                        format!("held-{}", uuid::Uuid::new_v4()),
                        text,
                        images,
                        parts,
                        chrono::Utc::now()
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    )
                    .await?;
                self.database
                    .append(
                        serde_json::from_value(json!({
                            "type":"prompt.held", "sessionId":session_id, "seq":0,
                            "at":chrono::Utc::now().to_rfc3339(), "held":held
                        }))
                        .map_err(|error| error.to_string())?,
                    )
                    .await?;
                Ok(json!({"ok":true,"held":held}))
            }
            CommandKind::PromptDrop => {
                let session_id = Self::field(command, "sessionId")?;
                let held_id = Self::field(command, "heldId")?;
                let dropped = self
                    .database
                    .drop_held(session_id.to_string(), held_id.to_string())
                    .await?;
                if dropped.is_none() {
                    return Err("that message is no longer waiting".into());
                }
                note_released(&self.database, session_id, held_id, "dropped").await?;
                Ok(json!({"ok":true}))
            }
            // Push a waiting message through now, into the running turn.
            //
            // The same road an unheld message takes: every brand's driver
            // decides for itself whether a turn is open, and steers or prompts
            // accordingly. Nothing here knows which it will be.
            CommandKind::PromptPush => {
                let session_id = Self::field(command, "sessionId")?;
                let held_id = Self::maybe(command, "heldId").map(str::to_string);
                let held = self
                    .database
                    .take_held(session_id.to_string(), held_id)
                    .await?
                    .ok_or_else(|| "that message is no longer waiting".to_string())?;
                // A chat can be held for one that went to sleep in the
                // meantime, and pushing is the reader asking for it now: the
                // first prompt wakes its provider here exactly as an unheld
                // one does.
                if !self.has_driver(session_id).await {
                    let attached = async {
                        self.prepare_unattached(command, command.at("takeover") == &json!(true))
                            .await?;
                        self.launch(command).await
                    }
                    .await;
                    if let Err(error) = attached {
                        self.database
                            .release_held(held["id"].as_str().unwrap_or_default().to_string())
                            .await?;
                        return Err(error);
                    }
                }
                send_held(&self.database, &self.drivers, session_id, &held).await
            }
            CommandKind::SessionStop
                if !self.has_driver(Self::field(command, "sessionId")?).await =>
            {
                self.prepare_unattached(command, false).await?;
                let session_id = Self::field(command, "sessionId")?;
                let session = self
                    .database
                    .get_session(session_id.to_string())
                    .await?
                    .ok_or_else(|| format!("no session {session_id}"))?;
                if session.state != "stopped" {
                    self.database.append(serde_json::from_value(json!({
                        "type":"session.state", "sessionId":session_id, "seq":0,
                        "at":chrono::Utc::now().to_rfc3339(), "state":"stopped", "label":"Stopped"
                    })).map_err(|error| error.to_string())?).await?;
                }
                Ok(json!({"ok":true,"detached":true}))
            }
            CommandKind::SessionClose
                if !self.has_driver(Self::field(command, "sessionId")?).await =>
            {
                self.prepare_unattached(command, false).await?;
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
                self.prepare_unattached(command, command.at("takeover") == &json!(true))
                    .await?;
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

    /// Put a deleted project's chats to sleep, and forget what was said about
    /// them.
    ///
    /// The chats themselves stay: the button that deletes a project says it
    /// takes the project off the list and leaves its cards and files alone, and
    /// a transcript is the owner's work rather than the list's. What must not
    /// stay is the rest of it. A chat in a project nothing can name is a chat
    /// nothing can open, so one still running is running where nobody can reach
    /// it and still streaming state at every screen; and a row recording who
    /// has heard what about a chat nothing will ever announce again is dead
    /// weight that only grows (bw-altj).
    ///
    /// Closing is the ordinary close, the same one the chat's own button sends,
    /// so a live one is shut down through its driver and a saved one merely
    /// goes to sleep. A chat that refuses to close is logged and passed over:
    /// the owner asked for the project to go, and one stuck agent may not stand
    /// in the way of the rest.
    pub async fn retire_project(&self, project_id: &str) -> Result<usize, String> {
        let sessions = self
            .database
            .list_sessions(Some(project_id.to_string()))
            .await?;
        let mut retired = 0usize;
        for session in &sessions {
            let command = Command {
                kind: CommandKind::SessionClose,
                fields: serde_json::Map::from_iter([(
                    "sessionId".into(),
                    json!(session.id.clone()),
                )]),
            };
            match self.execute(&command).await {
                Ok(_) => retired += 1,
                Err(why) => tracing::warn!(
                    "a chat in a deleted project would not close ({}): {why}",
                    session.id
                ),
            }
        }
        self.database
            .forget_notices_for_project(project_id.to_string())
            .await?;
        Ok(retired)
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
                let brand = command.at("brand").as_str().unwrap_or("claude");
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

    /// A driver that takes nothing, for the turn a provider will not accept.
    struct RefusingDriver;
    impl ProviderDriver for RefusingDriver {
        fn brand(&self) -> &'static str {
            "claude"
        }
        fn command<'a>(&'a mut self, _: &'a Command) -> DriverFuture<'a> {
            Box::pin(async { Err("this agent does not take steering".to_string()) })
        }
        fn close<'a>(&'a mut self) -> DriverFuture<'a> {
            Box::pin(async { Ok(json!({"ok":true})) })
        }
    }

    struct OneDriverFactory {
        driver: std::sync::Mutex<Option<Box<dyn ProviderDriver>>>,
    }
    impl SessionFactory for OneDriverFactory {
        fn launch<'a>(&'a self, _: ChatDb, _: &'a Command) -> LaunchFuture<'a> {
            let driver = self.driver.lock().unwrap().take();
            Box::pin(async move {
                Ok(LaunchedSession {
                    session_id: "session-1".into(),
                    reply: json!({"id":"session-1","brand":"claude"}),
                    driver,
                })
            })
        }
    }

    fn a_chat(state: &str) -> crate::workbench::store::Session {
        crate::workbench::store::Session {
            id: "session-1".into(),
            brand: "claude".into(),
            external_id: None,
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: Some("Working".into()),
            state: state.into(),
            origin: "app".into(),
            created_at: "2026-09-19T00:00:00Z".into(),
            last_active_at: "2026-09-19T00:00:00Z".into(),
            last_spoke_at: None,
            begun_by: Some("person".into()),
            named_by_owner: false,
        }
    }

    fn paths(root: &Path) -> RegistryPaths {
        RegistryPaths {
            home: root.join("home"),
            claude_config: root.join("claude"),
            codex_home: root.join("codex"),
            profiles: root.join("profiles"),
            media: root.join("media"),
        }
    }

    /// A driver that writes down every message it was handed, in order.
    struct RecordingDriver {
        sent: Arc<std::sync::Mutex<Vec<String>>>,
    }
    impl ProviderDriver for RecordingDriver {
        fn brand(&self) -> &'static str {
            "claude"
        }
        fn command<'a>(&'a mut self, command: &'a Command) -> DriverFuture<'a> {
            if command.kind == CommandKind::PromptSend {
                self.sent
                    .lock()
                    .unwrap()
                    .push(command.at("text").as_str().unwrap_or_default().to_string());
            }
            Box::pin(async { Ok(json!({"ok":true,"messageId":"message-1"})) })
        }
        fn close<'a>(&'a mut self) -> DriverFuture<'a> {
            Box::pin(async { Ok(json!({"ok":true})) })
        }
    }

    async fn say_state(database: &ChatDb, state: &str) {
        database
            .append(
                serde_json::from_value(json!({
                    "type":"session.state","sessionId":"session-1","seq":0,
                    "at":"2026-09-19T00:00:02Z","state":state,"label":state
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }

    /// Wait for the queue to empty, or give up so the test fails on the
    /// assertion that follows rather than on a timeout.
    async fn until_nothing_waits(database: &ChatDb) {
        for _ in 0..100 {
            if database
                .held_messages("session-1".into())
                .await
                .unwrap()
                .is_empty()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// bw-r54j.1, bw-r54j.2: a message written into a working chat waits, is
    /// still waiting after the server is restarted, and goes out by itself —
    /// once each, oldest first — as soon as the chat says it has settled.
    #[tokio::test]
    async fn a_held_message_outlives_a_restart_and_sends_itself_when_the_turn_ends() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("workbench.db");
        let database = ChatDb::open(&file).unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            paths(root.path()),
            Arc::new(FakeFactory { calls: Arc::new(AtomicUsize::new(0)) }),
        );
        database.create_session(a_chat("thinking")).await.unwrap();
        registry
            .execute(&command(CommandKind::SessionStart, json!({"sessionId":"session-1","brand":"claude"})))
            .await
            .unwrap();
        say_state(&database, "thinking").await;

        for text in ["first thing", "second thing"] {
            registry
                .execute(&command(CommandKind::PromptHold, json!({"sessionId":"session-1","text":text})))
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let waiting = database.held_messages("session-1".into()).await.unwrap();
        assert_eq!(waiting.len(), 2, "a working chat is not interrupted: {waiting:?}");
        assert_eq!(waiting[0]["text"], json!("first thing"));

        // The reader's own words, kept where a restart cannot lose them.
        drop(registry);
        drop(database);
        let database = ChatDb::open(&file).unwrap();
        assert_eq!(
            database.held_messages("session-1".into()).await.unwrap().len(),
            2,
            "a restarted server still holds what was written"
        );

        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        let registry = WorkbenchRegistry::new(
            database.clone(),
            paths(root.path()),
            Arc::new(OneDriverFactory {
                driver: std::sync::Mutex::new(Some(Box::new(RecordingDriver { sent: sent.clone() }))),
            }),
        );
        registry
            .execute(&command(CommandKind::SessionStart, json!({"sessionId":"session-1","brand":"claude"})))
            .await
            .unwrap();
        say_state(&database, "thinking").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(sent.lock().unwrap().is_empty(), "still working, still waiting");

        say_state(&database, "idle").await;
        until_nothing_waits(&database).await;
        assert_eq!(
            *sent.lock().unwrap(),
            vec!["first thing".to_string(), "second thing".to_string()],
            "each message sent once, oldest first, with nobody clicking anything"
        );
        let events = database.events_since("session-1".into(), 0).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == super::super::protocol::EventKind::PromptReleased
                    && event.fields.get("reason") == Some(&json!("sent")))
                .count(),
            2,
            "the queue says both messages left it"
        );
    }

    /// bw-ekpt.2: the queue drains when the reply ends, not when the last
    /// task the reply sent away ends.
    ///
    /// `waiting_for_agents` is only ever reached once the reply is over, so a
    /// message waiting behind that reply has nothing left to wait for. A chat
    /// that lost its turn is the other way round, and still keeps what was
    /// written until the reader sends it by hand.
    #[tokio::test]
    async fn a_waiting_message_goes_out_while_a_sent_away_task_is_still_running() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        let registry = WorkbenchRegistry::new(
            database.clone(),
            paths(root.path()),
            Arc::new(OneDriverFactory {
                driver: std::sync::Mutex::new(Some(Box::new(RecordingDriver { sent: sent.clone() }))),
            }),
        );
        database.create_session(a_chat("thinking")).await.unwrap();
        registry
            .execute(&command(CommandKind::SessionStart, json!({"sessionId":"session-1","brand":"claude"})))
            .await
            .unwrap();
        say_state(&database, "thinking").await;
        registry
            .execute(&command(CommandKind::PromptHold, json!({"sessionId":"session-1","text":"one more thing"})))
            .await
            .unwrap();

        // Lost its turn: what was written stays where it is.
        say_state(&database, "stopped").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            sent.lock().unwrap().is_empty(),
            "a chat that lost its turn does not have the reader's next message pushed into it"
        );

        say_state(&database, "waiting_for_agents").await;
        until_nothing_waits(&database).await;
        assert_eq!(
            *sent.lock().unwrap(),
            vec!["one more thing".to_string()],
            "the reply is over, so the message goes, though a task it started is still running"
        );
    }

    /// bw-r54j.3: a provider that refuses the message leaves it waiting, not
    /// stranded with nothing under it.
    #[tokio::test]
    async fn a_refused_push_leaves_the_message_waiting() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            paths(root.path()),
            Arc::new(OneDriverFactory {
                driver: std::sync::Mutex::new(Some(Box::new(RefusingDriver))),
            }),
        );
        database.create_session(a_chat("thinking")).await.unwrap();
        registry
            .execute(&command(CommandKind::SessionStart, json!({"sessionId":"session-1","brand":"claude"})))
            .await
            .unwrap();
        let held = registry
            .execute(&command(CommandKind::PromptHold, json!({"sessionId":"session-1","text":"say this now"})))
            .await
            .unwrap();
        let held_id = held["held"]["id"].as_str().unwrap().to_string();

        let refused = registry
            .execute(&command(CommandKind::PromptPush, json!({"sessionId":"session-1","heldId":held_id})))
            .await;
        assert!(refused.is_err(), "the refusal is the reader's to see: {refused:?}");
        let waiting = database.held_messages("session-1".into()).await.unwrap();
        assert_eq!(waiting.len(), 1, "it is still waiting, and still sendable");
        assert_eq!(waiting[0]["text"], json!("say this now"));

        // And it can still be dropped, which a claimed message could not be.
        registry
            .execute(&command(CommandKind::PromptDrop, json!({"sessionId":"session-1","heldId":held_id})))
            .await
            .unwrap();
        assert!(database.held_messages("session-1".into()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn extensions_commands_read_and_change_the_named_accounts_files() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let registry = WorkbenchRegistry::new(
            database,
            RegistryPaths {
                home: root.path().join("home"),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory { calls: Arc::new(AtomicUsize::new(0)) }),
        );
        let market = root.path().join("claude/plugins/known_marketplaces.json");
        std::fs::create_dir_all(market.parent().unwrap()).unwrap();
        std::fs::write(&market, r#"{"official":{"source":{"source":"github","repo":"anthropics/official"}}}"#).unwrap();

        // The system account reads the directory the server booted with.
        let listed = registry
            .execute(&command(CommandKind::ExtensionsList, json!({"brand":"claude","scope":"account"})))
            .await
            .unwrap();
        assert_eq!(listed["kinds"][0]["kind"], json!("plugins"));
        assert_eq!(listed["kinds"][1]["kind"], json!("marketplaces"));
        assert_eq!(listed["kinds"][1]["items"][0]["id"], json!("official"));
        assert_eq!(listed["kinds"][1]["items"][0]["description"], json!("github anthropics/official"));
        // Codex plugins belong to an account: a project has none to list, and
        // none to move. (An account's are its CLI's answers, codex_plugins.)
        let project = root.path().join("project");
        let listed = registry
            .execute(&command(CommandKind::ExtensionsList, json!({"brand":"codex","scope":"project","projectPath":project})))
            .await
            .unwrap();
        assert_eq!(listed["kinds"], json!([]));
        let refused = registry
            .execute(&command(CommandKind::PluginInstall, json!({"brand":"codex","scope":"project","projectPath":project,"id":"gmail@openai-curated-remote"})))
            .await;
        assert!(refused.unwrap_err().contains("account"));

        // A created account reads its own directory, which starts empty.
        let made = registry
            .execute(&command(CommandKind::ProfileCreate, json!({"brand":"claude","name":"Work"})))
            .await
            .unwrap();
        let profile = made["profile"]["id"].as_str().unwrap().to_string();
        let listed = registry
            .execute(&command(CommandKind::ExtensionsList, json!({"brand":"claude","scope":"account","profileId":profile})))
            .await
            .unwrap();
        assert_eq!(listed["kinds"][1]["items"], json!([]));

        // Switching a plugin on lands in that account's settings.json, whether
        // Claude's CLI did it or the fallback edit did.
        let answer = registry
            .execute(&command(
                CommandKind::PluginSetEnabled,
                json!({"brand":"claude","scope":"account","profileId":profile,"id":"notion@official","enabled":true}),
            ))
            .await
            .unwrap();
        assert_eq!(answer["ok"], json!(true), "{answer}");
        let settings: Value = serde_json::from_str(
            &std::fs::read_to_string(registry.profile_directory("claude", &profile).join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(settings["enabledPlugins"]["notion@official"], json!(true));
        assert_eq!(answer["kinds"][0]["items"][0]["id"], json!("notion@official"));
        assert_eq!(answer["kinds"][0]["items"][0]["enabled"], json!(true));
        assert!(!root.path().join("claude/settings.json").exists(), "the system account was left alone");

        assert!(registry
            .execute(&command(CommandKind::ExtensionsList, json!({"brand":"claude","scope":"project","projectPath":"relative"})))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn changing_account_keeps_the_chat_and_hands_its_words_to_the_next_process() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().join("home"),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory { calls: Arc::new(AtomicUsize::new(0)) }),
        );
        database.create_session(crate::workbench::store::Session {
            id: "session-1".into(),
            brand: "claude".into(),
            external_id: Some("old-thread".into()),
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: None,
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: Some("Existing chat".into()),
            state: "idle".into(),
            origin: "app".into(),
            created_at: "2026-09-13T00:00:00Z".into(),
            last_active_at: "2026-09-13T00:00:00Z".into(),
            last_spoke_at: None,
            begun_by: Some("person".into()),
            named_by_owner: false,
        }).await.unwrap();
        for value in [
            json!({"type":"message.started","sessionId":"session-1","seq":0,"at":"2026-09-13T00:00:01Z","messageId":"u1","role":"user"}),
            json!({"type":"text.delta","sessionId":"session-1","seq":0,"at":"2026-09-13T00:00:01Z","messageId":"u1","text":"remember the blue door"}),
            json!({"type":"message.completed","sessionId":"session-1","seq":0,"at":"2026-09-13T00:00:01Z","messageId":"u1"}),
        ] {
            database.append(serde_json::from_value(value).unwrap()).await.unwrap();
        }
        let made = registry.execute(&command(
            CommandKind::ProfileCreate,
            json!({"brand":"claude","name":"Work"}),
        )).await.unwrap();
        let profile = made["profile"]["id"].as_str().unwrap();

        registry.execute(&command(
            CommandKind::SessionProfile,
            json!({"sessionId":"session-1","profileId":profile}),
        )).await.unwrap();

        let stored = database.get_session("session-1".into()).await.unwrap().unwrap();
        assert_eq!(stored.profile.as_deref(), Some(profile));
        assert_eq!(stored.external_id, None, "the old account's remote id is not reused");
        assert_eq!(stored.state, "dormant");
        let handoff = database.saved_account_handoff("session-1".into()).await.unwrap().unwrap();
        assert!(handoff.contains("User: remember the blue door"), "{handoff}");
        assert!(database.timeline_count("session-1".into()).await.unwrap() >= 1);
    }

    #[tokio::test]
    async fn native_workbench_services_registry_routes_without_changing_command_replies() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let home = root.path().join("home");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(project.join("CLAUDE.md"), "project rules").unwrap();
        std::fs::write(home.join(".claude/CLAUDE.md"), "personal rules").unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = WorkbenchRegistry::new(
            database,
            RegistryPaths {
                home: home.clone(),
                claude_config: home.join(".claude"),
                codex_home: home.join(".codex"),
                profiles: root.path().join("profiles"),
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

        // Naming no project is the screen's opening view, not a mistake: the
        // personal files are still there to read, and a machine with nothing
        // registered has only those.
        let personal = registry
            .execute(&command(CommandKind::AgentFilesList, json!({})))
            .await
            .unwrap();
        let own = home.join(".claude/CLAUDE.md");
        assert!(personal["files"]
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file["path"] == json!(own))));
        assert_eq!(
            registry
                .execute(&command(CommandKind::AgentFilesRead, json!({"path":own}),))
                .await
                .unwrap()["content"],
            json!("personal rules")
        );

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

    /// A default is a fact about the account it is saved under.
    ///
    /// Starring a model while working on the work profile writes the work
    /// account's settings file. The owner's own directory — the one their
    /// terminal reads — must be left exactly as it was, or a preference set
    /// inside one account would silently follow them into the other.
    #[tokio::test]
    async fn a_default_is_written_to_the_account_the_chat_runs_on() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let paths = RegistryPaths {
            home: home.clone(),
            claude_config: home.join(".claude"),
            codex_home: home.join(".codex"),
            profiles: root.path().join("profiles"),
            media: root.path().join("media"),
        };
        let profiles = Profiles::new(
            paths.profiles.clone(),
            paths.claude_config.clone(),
            paths.codex_home.clone(),
        );
        let work = profiles.create("claude", "Work").unwrap();
        let registry = WorkbenchRegistry::new(
            database,
            paths,
            Arc::new(FakeFactory {
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        );

        registry
            .execute(&command(
                CommandKind::ProviderDefaultsWrite,
                json!({"brand":"claude","kind":"effort","value":"high","profileId":work.id}),
            ))
            .await
            .unwrap();

        assert_eq!(
            registry
                .execute(&command(
                    CommandKind::ProviderDefaultsRead,
                    json!({"brand":"claude","profileId":work.id}),
                ))
                .await
                .unwrap()["effort"],
            "high"
        );
        assert_eq!(
            registry
                .execute(&command(
                    CommandKind::ProviderDefaultsRead,
                    json!({"brand":"claude"}),
                ))
                .await
                .unwrap()["effort"],
            Value::Null,
            "the account the server booted with is untouched"
        );
        assert!(
            !home.join(".claude/settings.json").exists(),
            "the owner's own settings file was not even created"
        );
        assert!(profiles
            .chat_dir("claude", Some(&work.id))
            .join("settings.json")
            .is_file());
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
                profile: None,
                title: Some("Live".into()),
                state: "streaming".into(),
                origin: "app".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                last_active_at: "2026-08-30T00:00:01Z".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
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
            profile: None,
            title: Some("Saved".into()),
            state: "starting".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00Z".into(),
            last_active_at: "2026-08-30T00:00:01Z".into(),
            last_spoke_at: None,
            begun_by: None,
            named_by_owner: false,
        };
        database.create_session(session.clone()).await.unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
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

    /// Reading a brand-new local chat by address does not put it to sleep.
    ///
    /// Starting a chat navigates straight to it, so this read happens within a
    /// breath of the chat being made. A local chat waiting to be told its
    /// model has no driver on purpose, and judging it on the driver alone
    /// filed it as "Asleep" — after which the sidebar dropped it, because the
    /// live half of that list keeps only what is awake (bw-u6cl.2).
    #[tokio::test]
    async fn reading_a_new_local_chat_by_address_leaves_it_awake() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        database
            .create_session(crate::workbench::store::Session {
                id: "waiting".into(),
                brand: super::super::local::BRAND.into(),
                external_id: None,
                project_id: "project".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                // No model yet: this is the whole shape under test.
                model: None,
                permission_mode: "on-request".into(),
                effort: None,
                collaboration_mode: None,
                profile: None,
                title: None,
                state: "idle".into(),
                origin: "app".into(),
                created_at: "2026-09-04T00:00:00Z".into(),
                last_active_at: "2026-09-04T00:00:00Z".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
                media: root.path().join("media"),
            },
            Arc::new(crate::workbench::provider::NativeProviderFactory::new(
                root.path().join("claude"),
            )),
        );

        registry.looked_at("waiting").await;

        let session = database
            .get_session("waiting".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.state, "idle");
        assert!(!registry.has_driver("waiting").await);
        assert!(
            !database
                .events_since("waiting".into(), 0)
                .await
                .unwrap()
                .iter()
                .any(
                    |event| event.kind == crate::workbench::protocol::EventKind::SessionState
                        && event.fields["state"] == "dormant"
                ),
            "reading a chat that is waiting for its model must not file it as asleep"
        );
    }

    /// Choosing a model for a local chat does not draw its turn as finished.
    ///
    /// Picking a model makes such a chat usable, and this said so by publishing
    /// Ready — whatever the chat was doing. Done mid-turn it stopped the clock
    /// and dropped the row out of the working list, with the turn still running
    /// and nothing after it to put either right. The manager: "some chats are
    /// straight up showing as idle even they are are working" (bw-xfb4).
    #[tokio::test]
    async fn native_workbench_registry_repairs_stale_local_activity_before_model_selection() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
        let chat = |id: &str, state: &str| crate::workbench::store::Session {
            id: id.into(),
            brand: super::super::local::BRAND.into(),
            external_id: None,
            project_id: "project".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: Some("qwen3".into()),
            permission_mode: "default".into(),
            effort: None,
            collaboration_mode: None,
            profile: None,
            title: Some("Local".into()),
            state: state.into(),
            origin: "app".into(),
            created_at: "2026-09-05T00:00:00Z".into(),
            last_active_at: "2026-09-05T00:00:00Z".into(),
            last_spoke_at: None,
            begun_by: None,
            named_by_owner: false,
        };
        database
            .create_session(chat("working", "running_tool"))
            .await
            .unwrap();
        database
            .create_session(chat("resting", "idle"))
            .await
            .unwrap();
        // A model can only be pinned if the chat advertises it, so both are
        // handed the catalogue the pin is checked against.
        for id in ["working", "resting"] {
            let menu: crate::workbench::protocol::Event = serde_json::from_value(json!({
                "type":"session.menu","sessionId":id,"seq":0,"at":"2026-09-05T00:00:01Z",
                "models":[{"value":"qwen3","label":"Qwen 3"}]
            }))
            .unwrap();
            database.append(menu).await.unwrap();
        }
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        );

        // Another provider initializing must not postpone recovery of this
        // chat's stale Answering/Running state.
        registry.launching.store(1, Ordering::Release);

        let ready_events = |id: &'static str| {
            let database = database.clone();
            async move {
                database
                    .view_events(id.into())
                    .await
                    .unwrap()
                    .iter()
                    .map(|event| serde_json::to_value(event).unwrap())
                    .filter(|event| event["type"] == "session.state")
                    .map(|event| event["state"].as_str().unwrap_or_default().to_string())
                    .collect::<Vec<_>>()
            }
        };

        for id in ["working", "resting"] {
            registry
                .execute(&command(
                    CommandKind::SessionModel,
                    json!({"sessionId":id,"model":"qwen3"}),
                ))
                .await
                .unwrap();
        }
        assert_eq!(
            ready_events("working").await,
            vec!["idle".to_string()],
            "a driverless cached running state must not pretend that a turn exists"
        );
        // And a chat at rest is still told it is ready, which is what this
        // write is for.
        assert_eq!(ready_events("resting").await, vec!["idle"]);
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
                profile: None,
                title: Some("Saved".into()),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                last_active_at: "2026-08-30T00:00:00Z".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        let registry = WorkbenchRegistry::new(
            database.clone(),
            RegistryPaths {
                home: root.path().into(),
                claude_config: root.path().join("claude"),
                codex_home: root.path().join("codex"),
                profiles: root.path().join("profiles"),
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
    async fn dropped_driver_child_is_reaped_and_can_never_be_an_external_owner() {
        use std::io::BufRead as _;
        use std::os::unix::process::CommandExt as _;

        struct OwnedGroup(std::process::Child);
        impl Drop for OwnedGroup {
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
                external_id: Some("owned-thread".into()),
                project_id: "project".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                model: None,
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                profile: None,
                title: Some("Owned orphan".into()),
                state: "dormant".into(),
                origin: "app".into(),
                created_at: "2026-09-13T00:00:00Z".into(),
                last_active_at: "2026-09-13T00:00:00Z".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();

        // The ACP adapter is the group leader and its provider is a member.
        // The registry process is the adapter's parent, exactly as in production.
        let mut adapter = OwnedGroup(
            std::process::Command::new("sh")
                .args(["-c", "sleep 60 & echo $!; wait"])
                .env(external::OWNER_ENV, external::owner_token())
                .process_group(0)
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        std::io::BufReader::new(adapter.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let provider_pid: u32 = line.trim().parse().unwrap();
        let token_ready = std::time::Instant::now() + Duration::from_secs(1);
        while !external::owned_by_this_process(provider_pid, Path::new("/proc"))
            && std::time::Instant::now() < token_ready
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(external::owned_by_this_process(
            provider_pid,
            Path::new("/proc")
        ));
        // The in-memory driver is absent, while both adapter and provider
        // processes remain: the exact shape of the reported failure.
        let stat = std::fs::read_to_string(format!("/proc/{provider_pid}/stat")).unwrap();
        let close = stat.rfind(')').unwrap();
        let proc_start = stat[close + 1..].split_whitespace().nth(19).unwrap();
        std::fs::write(
            claude.join("sessions").join(format!("{provider_pid}.json")),
            serde_json::to_vec(&json!({
                "sessionId":"owned-thread", "pid":provider_pid, "cwd":"/project",
                "startedAt":1, "procStart":proc_start, "entrypoint":"sdk-ts",
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
                profiles: root.path().join("profiles"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: calls.clone(),
            }),
        );

        let ownership = registry.provider_ownership(Path::new("/proc"), 1_000);
        assert_eq!(ownership.ours.len(), 1);
        assert!(ownership.ours[0].pids.contains(&provider_pid));
        // /proc also contains unrelated live terminal agents. This fixture
        // proves that its owned provider is never classified as external.
        assert!(ownership.external.iter().all(|hold| !hold.pids.contains(&provider_pid)));
        let sent = registry
            .execute(&command(
                CommandKind::PromptSend,
                json!({"sessionId":"session-1", "brand":"claude", "text":"continue"}),
            ))
            .await
            .unwrap();
        assert_eq!(sent, json!({"ok":true,"messageId":"message-1"}));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!external::pid_alive(provider_pid, Path::new("/proc")));
        registry.shutdown().await;
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
                profile: None,
                title: Some("External".into()),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: "2026-08-30T00:00:00Z".into(),
                last_active_at: "2026-08-30T00:00:00Z".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
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
                profiles: root.path().join("profiles"),
                media: root.path().join("media"),
            },
            Arc::new(FakeFactory {
                calls: calls.clone(),
            }),
        );
        let refused = registry
            .execute(&command(
                CommandKind::PromptSend,
                json!({"sessionId":"session-1", "brand":"claude", "text":"continue"}),
            ))
            .await
            .unwrap_err();
        assert_eq!(refused, "Another program has this chat open");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(external::pid_alive(pid, Path::new("/proc")));

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
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].fields["text"], "before drop");
        assert_eq!(events[1].kind, crate::workbench::protocol::EventKind::Error);
        assert!(events[1].fields["message"]
            .as_str()
            .unwrap()
            .contains("Provider stream closed: stream dropped; cleanup completed"));
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
