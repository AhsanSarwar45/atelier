//! Native browser routes for the agent workbench.
//!
//! These routes deliberately open the existing SQLite chat database, so the
//! native implementation preserves every saved conversation across the
//! runtime cutover.

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{Response, StatusCode},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use futures::{stream, Stream, StreamExt};
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{convert::Infallible, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::broadcast;

mod ai_search;

use crate::workbench::{
    actor::ChatDb,
    projection::fold_all,
    protocol::{Command, Event},
    registry::WorkbenchRegistry,
    store::Session,
};

pub type EventStream = Pin<Box<dyn Stream<Item = Result<SseEvent, Infallible>> + Send>>;

/// One usage connection per Claude account, keyed by profile id.
type ClaudeReaders =
    Arc<tokio::sync::Mutex<HashMap<String, crate::workbench::claude::transport::ClaudeTransport>>>;

/// One Codex app-server per working directory and account directory.
type CodexReaders = Arc<
    tokio::sync::Mutex<
        HashMap<
            (std::path::PathBuf, Option<std::path::PathBuf>),
            crate::workbench::codex::transport::CodexTransport,
        >,
    >,
>;

#[derive(Clone)]
pub struct WorkbenchState {
    registry: Arc<WorkbenchRegistry>,
    hold_memory: Arc<tokio::sync::Mutex<HoldMemory>>,
    usage_cache: Arc<tokio::sync::Mutex<HashMap<String, (std::time::Instant, Value)>>>,
    usage_refreshes: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    discovery_cache: Arc<tokio::sync::Mutex<HashMap<String, (std::time::Instant, Vec<Value>)>>>,
    discoveries: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    listing_refused: Arc<tokio::sync::Mutex<HashMap<String, std::time::Instant>>>,
    listings: Listings,
    /// One usage connection per Claude account, keyed by profile id.
    claude_usage_readers: ClaudeReaders,
    /// One Codex app-server per working directory and account. `None` for the
    /// account the server booted with, which is read with the environment it
    /// already has.
    codex_readers: CodexReaders,
    codex_records: Arc<std::sync::Mutex<HashMap<String, std::path::PathBuf>>>,
    claim_sweeps: Arc<tokio::sync::Mutex<HashMap<std::path::PathBuf, std::time::Instant>>>,
    watch_polls: broadcast::Sender<Value>,
    watch_pollers: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
    watch_poll_subscribers: Arc<AtomicUsize>,
    watch_poll_wake: Arc<tokio::sync::Notify>,
    /// The hold set as the browsers last heard it, so a reading taken outside
    /// the beat — see `publish_holds` — is measured against the same last word
    /// the beat measures its own against.
    published_holds: Arc<tokio::sync::Mutex<Value>>,
    chat_followers: Arc<tokio::sync::Mutex<HashMap<String, Arc<ChatFollowControl>>>>,
    /// The last reading of who is working in what, and when it was taken.
    ///
    /// The fast half of the restore is drawn before provider discovery and may
    /// not go to the process table for this; it used to answer "nobody" for
    /// every row instead, which is not "we have not looked" but a positive no,
    /// and it is the first thing a reader sees on every reload and project
    /// switch. The hold beat already takes this reading every two seconds, so
    /// the fast path can have the last one for free (bw-t26l.22).
    last_holds: Arc<
        tokio::sync::RwLock<
            Option<(
                std::time::Instant,
                Vec<crate::workbench::external::ProviderHold>,
            )>,
        >,
    >,
    /// Every chat's words, indexed apart from the chat database. `None` where
    /// no index was opened, as in most tests; search then reads the chat
    /// database's own message table as it always did.
    search: Option<crate::workbench::search_index::SearchIndex>,
    /// The projects the board knows, so a search can name one by its name.
    projects: Option<Arc<crate::db::Database>>,
}

#[derive(Default)]
struct HoldMemory {
    bursts: HashMap<String, i64>,
    summaries: crate::workbench::summary::SummaryTracker,
}

pub(crate) struct WatchPollLease {
    subscribers: Arc<AtomicUsize>,
    wake: Arc<tokio::sync::Notify>,
}

pub(crate) struct ChatFollowControl {
    viewers: AtomicUsize,
    wake: tokio::sync::Notify,
}

pub(crate) struct ChatFollowLease {
    control: Arc<ChatFollowControl>,
}

impl Drop for ChatFollowLease {
    fn drop(&mut self) {
        self.control.viewers.fetch_sub(1, Ordering::AcqRel);
        self.control.wake.notify_one();
    }
}

impl ChatFollowControl {
    pub(crate) async fn stopped(&self) {
        while self.viewers.load(Ordering::Acquire) > 0 {
            self.wake.notified().await;
        }
    }
}

impl Drop for WatchPollLease {
    fn drop(&mut self) {
        self.subscribers.fetch_sub(1, Ordering::AcqRel);
        self.wake.notify_one();
    }
}

impl WorkbenchState {
    pub fn new(registry: WorkbenchRegistry) -> Self {
        let (watch_polls, _) = broadcast::channel(16);
        Self {
            registry: Arc::new(registry),
            hold_memory: Arc::new(tokio::sync::Mutex::new(HoldMemory::default())),
            usage_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            usage_refreshes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            discovery_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            discoveries: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            listing_refused: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            listings: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            claude_usage_readers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            codex_readers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            codex_records: Arc::new(std::sync::Mutex::new(HashMap::new())),
            claim_sweeps: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            watch_polls,
            last_holds: Arc::new(tokio::sync::RwLock::new(None)),
            watch_pollers: Arc::new(tokio::sync::Mutex::new(None)),
            watch_poll_subscribers: Arc::new(AtomicUsize::new(0)),
            watch_poll_wake: Arc::new(tokio::sync::Notify::new()),
            published_holds: Arc::new(tokio::sync::Mutex::new(Value::Null)),
            chat_followers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            search: None,
            projects: None,
        }
    }

    pub fn with_projects(mut self, projects: Arc<crate::db::Database>) -> Self {
        self.projects = Some(projects);
        self
    }

    pub fn with_search(mut self, index: crate::workbench::search_index::SearchIndex) -> Self {
        self.search = Some(index);
        self
    }

    async fn begin_claim_sweep(&self, cwd: &std::path::Path) -> bool {
        const EVERY: Duration = Duration::from_secs(60);
        let now = std::time::Instant::now();
        let mut swept = self.claim_sweeps.lock().await;
        if swept
            .get(cwd)
            .is_some_and(|previous| now.duration_since(*previous) < EVERY)
        {
            return false;
        }
        swept.insert(cwd.to_path_buf(), now);
        true
    }
    /// The registry itself, for the one watcher that acts on chats without a
    /// browser asking it to (workbench/memory_limit.rs).
    pub fn registry(&self) -> &Arc<WorkbenchRegistry> {
        &self.registry
    }
    pub fn database(&self) -> &ChatDb {
        self.registry.database()
    }
    /// Put a deleted project's chats to sleep and forget what was said about
    /// them. See [`WorkbenchRegistry::retire_project`].
    pub async fn retire_project(&self, project_id: &str) -> Result<usize, String> {
        self.registry.retire_project(project_id).await
    }
    /// The project list, when this server has one. It is the other half of
    /// every question about what a chat is worth saying: a chat in a project
    /// that has been deleted, archived or registered by a test is not news, and
    /// only this can tell which of those a chat is in.
    pub fn projects(&self) -> Option<&crate::db::Database> {
        self.projects.as_deref()
    }
    pub(crate) async fn reconcile_status(&self, session_id: &str) -> Result<Value, String> {
        self.registry.reconcile_status(session_id).await
    }
    pub(crate) async fn is_supervising(&self, session_id: &str) -> bool {
        self.registry.is_supervising(session_id).await
    }
    pub(crate) async fn hand_back_if_orphaned(&self, session_id: &str) {
        self.registry.hand_back_if_orphaned(session_id).await
    }
    #[cfg(test)]
    pub(crate) async fn let_driver_go(&self, session_id: &str) {
        self.registry.let_driver_go(session_id).await
    }
    #[cfg(test)]
    pub(crate) async fn lose_driver(&self, session_id: &str) {
        self.registry.lose_driver(session_id).await
    }
    #[cfg(test)]
    pub(crate) async fn pretend_driver(&self, session_id: &str) {
        self.registry.pretend_driver(session_id).await
    }
    pub(crate) async fn looked_at(&self, session_id: &str) {
        self.registry.looked_at(session_id).await
    }
    pub(crate) fn claude_config_directory(&self) -> &std::path::Path {
        self.registry.claude_config_directory()
    }
    pub(crate) fn codex_home_directory(&self) -> &std::path::Path {
        self.registry.codex_home_directory()
    }
    /// Every directory one brand's accounts keep their records in, for the
    /// scans that read files rather than spawn a CLI.
    fn account_directories(&self, brand: &str) -> Vec<std::path::PathBuf> {
        let known: Vec<std::path::PathBuf> = self
            .registry
            .every_account(brand)
            .into_iter()
            .map(|(_, directory)| directory)
            .collect();
        if known.is_empty() {
            vec![match brand {
                "claude" => self.claude_config_directory().to_path_buf(),
                _ => self.codex_home_directory().to_path_buf(),
            }]
        } else {
            known
        }
    }

    /// Every account a Codex app-server can be pointed at, the system one as
    /// `None` so its process is left the environment it already has.
    fn codex_account_homes(&self) -> Vec<Option<std::path::PathBuf>> {
        let accounts = self.registry.every_account("codex");
        if accounts.is_empty() {
            return vec![None];
        }
        accounts
            .into_iter()
            .map(|(id, directory)| (id != crate::workbench::profiles::SYSTEM).then_some(directory))
            .collect()
    }
    /// The rollout file for one Codex chat, looked for under the account that
    /// chat runs on.
    pub(crate) fn codex_record(
        &self,
        id: &str,
        profile: Option<&str>,
    ) -> Option<std::path::PathBuf> {
        // Two accounts each keep their own sessions directory, so the memo has
        // to remember which one a path was found under.
        let home = crate::workbench::profiles::chat_dir(
            "codex",
            profile,
            self.registry.codex_home_directory(),
        );
        let key = format!(
            "{}/{}",
            profile.unwrap_or(crate::workbench::profiles::SYSTEM),
            id.to_lowercase()
        );
        if let Some(path) = self
            .codex_records
            .lock()
            .ok()
            .and_then(|records| records.get(&key).filter(|path| path.is_file()).cloned())
        {
            return Some(path);
        }
        let found = crate::workbench::handback::find_codex_record(&home, id);
        if let Some(path) = &found {
            if let Ok(mut records) = self.codex_records.lock() {
                records.insert(key, path.clone());
            }
        }
        found
    }

    /// The rollout file for one Codex chat under whichever account keeps it.
    pub(crate) fn codex_record_anywhere(&self, id: &str) -> Option<std::path::PathBuf> {
        self.registry
            .every_account("codex")
            .into_iter()
            .map(|(id, _)| id)
            .chain(std::iter::once(
                crate::workbench::profiles::SYSTEM.to_string(),
            ))
            .find_map(|profile| {
                let named =
                    (profile != crate::workbench::profiles::SYSTEM).then_some(profile.as_str());
                self.codex_record(id, named)
            })
    }

    fn enrich_unknown_codex_hold(&self, hold: &mut crate::workbench::external::ProviderHold) {
        if hold.doing != crate::workbench::external::HeldDoing::Unknown {
            return;
        }
        // Under whichever account keeps it. A chat held open in a terminal on
        // the work account has its rollout there and nowhere else, and looking
        // only under the system account left it reading "Unknown" (bw-5ihw.8).
        let found = self
            .registry
            .every_account("codex")
            .into_iter()
            .map(|(id, _)| id)
            .chain(std::iter::once(
                crate::workbench::profiles::SYSTEM.to_string(),
            ))
            .find_map(|profile| {
                let named =
                    (profile != crate::workbench::profiles::SYSTEM).then_some(profile.as_str());
                self.codex_record(&hold.id, named)
            });
        if let Some(path) = found {
            let activity = crate::workbench::external::codex_activity_from_path(&path);
            hold.doing = activity.doing;
            hold.detail = activity.detail;
            hold.since = activity.since;
            hold.turn_since = activity.turn_since;
        }
    }

    /// One read-only app-server per working directory and account.
    ///
    /// Initializing Codex is expensive; list, metadata and usage reads must
    /// share it just as the former sidecar's reader cache did. The account is
    /// part of the key because an app-server answers for the `CODEX_HOME` it
    /// was started with and nothing else: one reader per folder would have
    /// answered the work account's allowance with the personal account's
    /// (bw-5ihw.8).
    async fn codex_reader(
        &self,
        cwd: &std::path::Path,
        home: Option<&std::path::Path>,
    ) -> Result<crate::workbench::codex::transport::CodexTransport, String> {
        let key = (cwd.to_path_buf(), home.map(std::path::Path::to_path_buf));
        let mut readers = self.codex_readers.lock().await;
        if let Some(reader) = readers.get(&key) {
            return Ok(reader.clone());
        }
        let mut config = crate::workbench::codex::transport::CodexTransportConfig::app_server(cwd);
        if let Some(home) = home {
            config
                .environment
                .push(("CODEX_HOME".into(), home.to_string_lossy().into_owned()));
        }
        if let Some(executable) = crate::routes::find_tool("codex", &[]) {
            config.executable = executable;
        }
        let reader = crate::workbench::codex::transport::CodexTransport::start(config)
            .await
            .map_err(|error| error.to_string())?;
        // A read-only client does not consume provider notifications. Drain
        // them so a long-lived cached reader has bounded memory.
        if let Some(mut inbound) = reader.take_inbound() {
            tokio::spawn(async move { while inbound.recv().await.is_some() {} });
        }
        readers.insert(key, reader.clone());
        Ok(reader)
    }

    async fn forget_codex_reader(
        &self,
        cwd: &std::path::Path,
        home: Option<&std::path::Path>,
        failed: &crate::workbench::codex::transport::CodexTransport,
    ) {
        let key = (cwd.to_path_buf(), home.map(std::path::Path::to_path_buf));
        let removed = {
            let mut readers = self.codex_readers.lock().await;
            if readers
                .get(&key)
                .is_some_and(|reader| reader.child_id() == failed.child_id())
            {
                readers.remove(&key)
            } else {
                None
            }
        };
        if let Some(reader) = removed {
            reader.close().await;
        }
    }

    async fn discovery(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut running = self.discoveries.lock().await;
        running
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn usage_refresh(&self, brand: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut refreshes = self.usage_refreshes.lock().await;
        refreshes
            .entry(brand.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// The connection plan usage is read over, one per account.
    ///
    /// `directory` is where that account's login lives, or `None` for the one
    /// the computer itself is signed in with — which is asked with the
    /// environment left alone, because `CLAUDE_CONFIG_DIR=~/.claude` makes
    /// Claude look for `~/.claude/.claude.json` and answer for nobody.
    async fn claude_usage_reader(
        &self,
        profile: &str,
        directory: Option<&std::path::Path>,
    ) -> Result<crate::workbench::claude::transport::ClaudeTransport, String> {
        let mut readers = self.claude_usage_readers.lock().await;
        if let Some(transport) = readers.get(profile) {
            return Ok(transport.clone());
        }
        let options = crate::workbench::claude::transport::ClaudeSessionOptions {
            cwd: std::env::current_dir().map_err(|error| error.to_string())?,
            resume: None,
            model: None,
            permission_mode: Some("default".into()),
            effort: None,
            instructions: String::new(),
            // Reading the plan window needs no tools; starting every
            // configured MCP server for it would be slow and noisy.
            without_mcp_servers: true,
        };
        let mut config =
            crate::workbench::claude::transport::ClaudeTransportConfig::session(&options);
        if let Some(directory) = directory {
            config.environment.push((
                "CLAUDE_CONFIG_DIR".into(),
                directory.to_string_lossy().into_owned(),
            ));
        }
        if let Some(executable) = crate::routes::find_tool("claude", &[]) {
            config.executable = executable;
        }
        let transport = crate::workbench::claude::transport::ClaudeTransport::start(config)
            .await
            .map_err(|error| error.to_string())?;
        // A usage-only connection does not consume provider notifications.
        // Drain them so the one reused reader cannot accumulate an unbounded
        // inbound queue between its thirty-second requests.
        if let Some(mut inbound) = transport.take_inbound() {
            tokio::spawn(async move { while inbound.recv().await.is_some() {} });
        }
        readers.insert(profile.to_string(), transport.clone());
        Ok(transport)
    }

    async fn forget_claude_usage_reader(
        &self,
        profile: &str,
        failed: &crate::workbench::claude::transport::ClaudeTransport,
    ) {
        let removed = {
            let mut readers = self.claude_usage_readers.lock().await;
            if readers
                .get(profile)
                .is_some_and(|current| current.child_id() == failed.child_id())
            {
                readers.remove(profile)
            } else {
                None
            }
        };
        if let Some(transport) = removed {
            transport.close().await;
        }
    }

    /// Read every account of every brand, each on its own task, and send each
    /// reading the moment it lands.
    ///
    /// An allowance belongs to a login, and the browser keeps them apart by
    /// the profile named here (bw-5ihw.8). The readings used to be taken one
    /// after another and sent together, so Codex waited behind every Claude
    /// account's native request, and a wake of the poller in the middle threw
    /// the whole round away. A reading already cached comes back at once, and
    /// the per-account refresh lock keeps two rounds from asking twice
    /// (bw-kde0.1).
    fn spread_usage(&self) {
        for brand in ["claude", "codex"] {
            for (profile, _) in self.registry.every_account(brand) {
                let state = self.clone();
                tokio::spawn(async move {
                    if let Ok(usage) = state.account_usage(brand, Some(&profile)).await {
                        let _ = state.watch_polls.send(
                            json!({"kind":"usage","brand":brand,"profile":profile,"usage":usage}),
                        );
                    }
                });
            }
        }
    }

    pub(crate) async fn watch_poll_subscription(
        &self,
    ) -> (broadcast::Receiver<Value>, WatchPollLease) {
        let receiver = self.watch_polls.subscribe();
        self.watch_poll_subscribers.fetch_add(1, Ordering::AcqRel);
        let lease = WatchPollLease {
            subscribers: self.watch_poll_subscribers.clone(),
            wake: self.watch_poll_wake.clone(),
        };
        let mut poller = self.watch_pollers.lock().await;
        let running = poller.as_ref().is_some_and(|task| !task.is_finished());
        if !running {
            let state = self.clone();
            *poller = Some(tokio::spawn(async move { state.run_watch_poller().await }));
        } else {
            // A page that joins a running poller would otherwise draw no plan
            // chip until its next beat, up to half a minute away. The first
            // beat of a new poller already does this.
            self.spread_usage();
        }
        (receiver, lease)
    }

    /// One external-record follower per chat, however many browser windows
    /// currently read it. The first subscriber starts the task; the last lease
    /// wakes it to stop.
    pub(crate) async fn chat_follow_subscription(
        &self,
        session_id: &str,
    ) -> (ChatFollowLease, Option<Arc<ChatFollowControl>>) {
        let mut followers = self.chat_followers.lock().await;
        if let Some(control) = followers.get(session_id) {
            control.viewers.fetch_add(1, Ordering::AcqRel);
            return (
                ChatFollowLease {
                    control: control.clone(),
                },
                None,
            );
        }
        let control = Arc::new(ChatFollowControl {
            viewers: AtomicUsize::new(1),
            wake: tokio::sync::Notify::new(),
        });
        followers.insert(session_id.to_string(), control.clone());
        (
            ChatFollowLease {
                control: control.clone(),
            },
            Some(control),
        )
    }

    pub(crate) async fn finish_chat_follow(
        &self,
        session_id: &str,
        control: &Arc<ChatFollowControl>,
    ) {
        let mut followers = self.chat_followers.lock().await;
        if followers
            .get(session_id)
            .is_some_and(|current| Arc::ptr_eq(current, control))
        {
            followers.remove(session_id);
        }
    }

    #[cfg(test)]
    pub(crate) async fn has_chat_follower(&self, session_id: &str) -> bool {
        self.chat_followers.lock().await.contains_key(session_id)
    }

    async fn run_watch_poller(self) {
        // The snapshot every subscriber is sent on joining carries this same
        // reading, so it is the last word without being sent again here.
        *self.published_holds.lock().await =
            serde_json::to_value(self.provider_holds().await).unwrap_or_default();
        let mut hold_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(2),
            Duration::from_secs(2),
        );
        let mut usage_tick = tokio::time::interval(Duration::from_secs(30));
        let (external_tx, mut external_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut external_watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    let _ = external_tx.send(event.paths);
                }
            })
            .ok();
        // One watch per account's record directory. Watching only the boot
        // account's meant a chat worked on elsewhere under another account
        // never moved anything on screen (bw-5ihw.8).
        let claude_projects: Vec<std::path::PathBuf> = self
            .account_directories("claude")
            .into_iter()
            .map(|directory| directory.join("projects"))
            .collect();
        let codex_sessions: Vec<std::path::PathBuf> = self
            .account_directories("codex")
            .into_iter()
            .map(|directory| directory.join("sessions"))
            .collect();
        if let Some(watcher) = external_watcher.as_mut() {
            for root in claude_projects.iter().chain(codex_sessions.iter()) {
                let _ = watcher.watch(root, RecursiveMode::Recursive);
            }
        }
        let mut external_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_secs(1),
        );
        let mut external_dirty = HashSet::new();
        let mut external_cwds = HashMap::new();
        // The chats being worked in elsewhere that this task is keeping read.
        // Held here rather than in the state: the leases must be dropped when
        // this task ends, and its ending is what says nobody has the app open.
        let mut followed: HashMap<String, ChatFollowLease> = HashMap::new();
        loop {
            if self.watch_poll_subscribers.load(Ordering::Acquire) == 0 {
                return;
            }
            tokio::select! {
                _ = self.watch_poll_wake.notified() => {},
                changed = external_rx.recv(), if external_watcher.is_some() => {
                    if let Some(paths) = changed {
                        external_dirty.extend(paths);
                    }
                },
                _ = external_tick.tick() => {
                    if !external_dirty.is_empty() {
                        let paths = std::mem::take(&mut external_dirty);
                        let folders = crate::workbench::external::changed_record_folders(
                            &paths,
                            &claude_projects,
                            &codex_sessions,
                            &mut external_cwds,
                        )
                        .unwrap_or_default();
                        let _ = self.watch_polls.send(json!({"kind":"outside","folders":folders}));
                    }
                },
                _ = hold_tick.tick() => {
                    let holds = self.publish_holds().await;
                    self.keep_following_the_worked_in(&holds, &mut followed).await;
                },
                _ = usage_tick.tick() => self.spread_usage(),
            }
        }
    }

    /**
     * Keep reading every chat somebody else is working in right now.
     *
     * A chat another program holds is read by tailing that program's own
     * record file, and until now that reading started when a browser opened
     * the chat and stopped when it looked away. So a terminal chat went on
     * working while this app knew nothing about it, and switching to it paid
     * for all of it at once: the byte cursor is remembered, so the whole
     * silent stretch arrived as one import — the "stops streaming, then
     * streams massive amounts of messages at once" the owner reported, and
     * the reason switching was never instant (bw-t26l.20).
     *
     * The set is the holds, not the list: a chat nobody is working in is not
     * growing, so there is nothing to miss by not reading it. A follower this
     * keeps alive is the same one a browser opens — the lease is counted, so
     * neither can stop the other's reading.
     */
    async fn keep_following_the_worked_in(
        &self,
        holds: &[crate::workbench::external::ProviderHold],
        followed: &mut HashMap<String, ChatFollowLease>,
    ) {
        let mut worked_in = HashSet::new();
        for hold in holds {
            let Ok(Some(session)) = self
                .database()
                .session_by_external_id(hold.id.clone())
                .await
            else {
                continue;
            };
            worked_in.insert(session.id.clone());
            if followed.contains_key(&session.id) {
                continue;
            }
            let (lease, start) = self.chat_follow_subscription(&session.id).await;
            if let Some(control) = start {
                let state = self.clone();
                let id = session.id.clone();
                tokio::spawn(async move {
                    crate::routes::live::follow_native_record(state, id, control).await;
                });
            }
            followed.insert(session.id, lease);
        }
        // A chat nobody is working in any more is let go. The reader may still
        // have it open; that lease is their own and is not this one.
        followed.retain(|id, _| worked_in.contains(id));
    }

    pub(crate) async fn provider_holds(&self) -> Vec<crate::workbench::external::ProviderHold> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let mut holds = self
            .registry
            .provider_holds(std::path::Path::new("/proc"), now);
        // `codex resume` usually has neither the thread id in argv nor its
        // rollout held open. Its process log supplies ownership, and the
        // indexed rollout path supplies the rich activity word. Keep the path
        // after the first lookup so the two-second hold beat stays a bounded
        // tail read rather than a repeated history scan.
        for hold in &mut holds {
            self.enrich_unknown_codex_hold(hold);
        }
        // Only a hold needs its chat looked up, and on most beats nothing is
        // held; reading every chat ever kept every two seconds to match none
        // was most of what an idle server did (bw-fbzd.5).
        let sessions = if holds.is_empty() {
            Vec::new()
        } else {
            self.database().list_sessions(None).await.unwrap_or_default()
        };
        // Process provenance is classified once inside WorkbenchRegistry.
        // `holds` is therefore external by construction; this presentation
        // layer must not keep a second ownership rule that command guards can
        // drift away from.
        let by_external: HashMap<_, _> = sessions
            .iter()
            .filter_map(|s| s.external_id.as_ref().map(|id| (id.to_lowercase(), s)))
            .collect();
        let mut memory = self.hold_memory.lock().await;
        let mut beats = Vec::with_capacity(holds.len());
        let mut present = std::collections::HashSet::new();
        for hold in &mut holds {
            present.insert(hold.id.to_lowercase());
            let busy = !matches!(
                hold.doing,
                crate::workbench::external::HeldDoing::Idle
                    | crate::workbench::external::HeldDoing::Unknown
            );
            let key = hold.id.to_lowercase();
            if busy {
                let began = *memory
                    .bursts
                    .entry(key.clone())
                    .or_insert(hold.since.unwrap_or(now));
                hold.turn_since = Some(began);
            } else {
                memory.bursts.remove(&key);
            }
            let project = by_external
                .get(&key)
                .map(|s| s.project_path.clone())
                .unwrap_or_default();
            beats.push(crate::workbench::summary::Beat {
                id: hold.id.clone(),
                project: project.clone(),
                summarising: hold.doing == crate::workbench::external::HeldDoing::Summarising,
                since: hold.since,
            });
            if hold.doing == crate::workbench::external::HeldDoing::Summarising
                && !project.is_empty()
            {
                let runs = self
                    .database()
                    .summary_runs(project, 20)
                    .await
                    .unwrap_or_default();
                hold.typical_ms = crate::workbench::summary::median(
                    &runs,
                    crate::workbench::summary::RUNS_ENOUGH,
                );
            }
        }
        memory.bursts.retain(|id, _| present.contains(id));
        let finished = memory.summaries.observe(&beats, now);
        drop(memory);
        for run in finished {
            if !run.project.is_empty() {
                let _ = self
                    .database()
                    .note_summary_run(
                        run.project,
                        run.session_id,
                        chrono::Utc::now().to_rfc3339(),
                        run.ms,
                    )
                    .await;
            }
        }
        *self.last_holds.write().await = Some((std::time::Instant::now(), holds.clone()));
        holds
    }

    /// Take the reading now and tell every browser if it changed.
    ///
    /// The beat takes it every two seconds, and two seconds is longer than
    /// starting a chat: the provider process this app spawns writes its own
    /// marker as it starts, and a beat that lands before its driver is
    /// registered and its id is written down publishes it as a chat somebody
    /// ELSE is in. The browser then opens the new chat, learns its id, and
    /// draws the held-elsewhere line over it until the next beat — a blue
    /// flash where the writing box should be, on every chat started from the
    /// app (bw-cwap). So the command that attaches a driver takes the reading
    /// itself before it replies, and the reading that says the chat is ours
    /// is on the stream before the browser has a chat to draw.
    pub(crate) async fn publish_holds(&self) -> Vec<crate::workbench::external::ProviderHold> {
        let holds = self.provider_holds().await;
        let current = serde_json::to_value(&holds).unwrap_or_default();
        let mut published = self.published_holds.lock().await;
        if current != *published {
            *published = current.clone();
            let _ = self
                .watch_polls
                .send(json!({"kind":"running","holds":current}));
        }
        holds
    }

    /// The last reading, if one was taken recently enough to still be true.
    ///
    /// Stale is worse than absent here: a hold that has been sitting in this
    /// cache since the poller stopped would draw "somebody is working in it"
    /// over a chat nobody has touched for an hour, and that word has to mean
    /// something. Nothing older than three beats.
    async fn holds_lately(&self) -> Vec<crate::workbench::external::ProviderHold> {
        match self.last_holds.read().await.as_ref() {
            Some((taken, holds)) if taken.elapsed() < Duration::from_secs(6) => holds.clone(),
            _ => Vec::new(),
        }
    }

    /// What one account has left of its plan.
    ///
    /// Keyed by brand and account, everywhere: the cache, the in-flight
    /// refresh, and the connection it is read over. An allowance belongs to a
    /// login, so a single reading per brand meant a chat on the work account
    /// drew the owner's own remaining hours (bw-5ihw.8).
    pub(crate) async fn account_usage(
        &self,
        brand: &str,
        profile: Option<&str>,
    ) -> Result<Value, String> {
        let profile = profile.unwrap_or(crate::workbench::profiles::SYSTEM);
        let key = usage_key(brand, profile);
        if let Some(value) = fresh_usage(&self.usage_cache, &key).await {
            return Ok(value);
        }
        // Only callers for this account share an in-flight refresh. Claude and
        // Codex must never wait behind each other's fifteen-second native
        // allowance request, and neither must two accounts of one brand.
        let refresh = self.usage_refresh(&key).await;
        let _refresh = refresh.lock().await;
        if let Some(value) = fresh_usage(&self.usage_cache, &key).await {
            return Ok(value);
        }
        // Where the account's login lives. The system account is read with the
        // environment the server already has, which is the one thing that
        // cannot be spelled out; see `claude_usage_reader`.
        let named = (profile != crate::workbench::profiles::SYSTEM)
            .then(|| self.registry.profile_directory(brand, profile));
        let at = chrono::Utc::now().to_rfc3339();
        let value = if brand == "codex" {
            let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
            let transport = self.codex_reader(&cwd, named.as_deref()).await?;
            let result = crate::workbench::usage::read_codex(&transport, at).await;
            if result.is_err() {
                self.forget_codex_reader(&cwd, named.as_deref(), &transport)
                    .await;
            }
            serde_json::to_value(result?).map_err(|e| e.to_string())?
        } else if brand == "claude" {
            let transport = self.claude_usage_reader(profile, named.as_deref()).await?;
            let result = crate::workbench::usage::read_claude(&transport, at).await;
            if result.is_err() {
                self.forget_claude_usage_reader(profile, &transport).await;
            }
            let mut usage = result?;
            // The control channel says nothing about resets, so they are read
            // from the account API with the same login. A failure there costs
            // the resets, never the figure.
            if usage.available {
                let directory = self.registry.profile_directory(brand, profile);
                usage.resets = crate::workbench::usage::read_claude_resets(&directory)
                    .await
                    .ok()
                    .flatten();
            }
            serde_json::to_value(usage).map_err(|e| e.to_string())?
        } else {
            return Err(format!("unknown usage provider {brand}"));
        };
        let mut cache = self.usage_cache.lock().await;
        cache.insert(key, (std::time::Instant::now(), value.clone()));
        Ok(value)
    }
    /// Use one usage reset, then read the account again so every page sees
    /// the refilled windows at once.
    pub(crate) async fn use_usage_reset(
        &self,
        brand: &str,
        profile: Option<&str>,
        id: &str,
        attempt: &str,
    ) -> Result<crate::workbench::usage::ResetOutcome, String> {
        let profile = profile.unwrap_or(crate::workbench::profiles::SYSTEM);
        let key = usage_key(brand, profile);
        // Held for the whole attempt, so a beat of the poller cannot cache a
        // reading taken half-way through it.
        let refresh = self.usage_refresh(&key).await;
        let outcome = {
            let _refresh = refresh.lock().await;
            let outcome = if brand == "codex" {
                let named = (profile != crate::workbench::profiles::SYSTEM)
                    .then(|| self.registry.profile_directory(brand, profile));
                let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
                let transport = self.codex_reader(&cwd, named.as_deref()).await?;
                crate::workbench::usage::use_codex_reset(&transport, id, attempt).await
            } else if brand == "claude" {
                let directory = self.registry.profile_directory(brand, profile);
                crate::workbench::usage::use_claude_reset(&directory, id, attempt).await
            } else {
                return Err(format!("unknown usage provider {brand}"));
            };
            self.usage_cache.lock().await.remove(&key);
            outcome
        };
        if let Ok(usage) = self.account_usage(brand, Some(profile)).await {
            let _ = self.watch_polls.send(
                json!({"kind":"usage","brand":brand,"profile":profile,"usage":usage}),
            );
        }
        Ok(outcome)
    }
    async fn window_now(&self, session: &str) -> Option<Result<Value, String>> {
        self.registry.window_now(session).await
    }
}

/// One account's allowance, under the brand it belongs to.
///
/// Exercised on its own so that the shape the cache and the refresh lock share
/// cannot drift apart (bw-5ihw.8).
pub(crate) fn usage_key(brand: &str, profile: &str) -> String {
    format!("{brand}/{profile}")
}

async fn fresh_usage(
    cache: &tokio::sync::Mutex<HashMap<String, (std::time::Instant, Value)>>,
    key: &str,
) -> Option<Value> {
    cache
        .lock()
        .await
        .get(key)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(30))
        .map(|(_, value)| value.clone())
}

pub fn router(state: WorkbenchState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/sessions", get(sessions))
        .route("/notifications", get(notifications))
        .route("/notifications/read", post(notifications_read))
        .route("/restore", get(restore))
        .route("/session/:id", get(session))
        .route("/search", get(search))
        .route("/search/chats", get(search_chats))
        .route("/search/ask", post(ai_search::ask))
        .route("/tool", get(tool))
        .route("/spend", get(spend))
        .route("/usage", get(usage))
        .route("/usage/reset", post(usage_reset))
        .route("/chat-name/preview", post(chat_name_preview))
        .route("/memory", get(memory))
        .route("/memory/terminate", post(terminate_memory_process))
        .route("/tokens", get(tokens))
        .route("/links/bead/:id", get(chats_for_bead))
        .route("/links/session/:id", get(beads_for_chat))
        .route("/history", get(history))
        .route("/events", get(events))
        .route("/present", post(present))
        .route("/screen-check", post(screen_check))
        .route("/command", post(command))
        .route("/attachment", post(attachment))
        // A prompt carries its pictures inline, as base64 inside the JSON, and
        // there is no ceiling on how many a person may attach to one message.
        // Axum otherwise buffers every body under a 2 MiB default nobody here
        // chose, which refuses the request in the extractor before any handler
        // sees it and hands the page a bare `413 Failed to buffer the request
        // body` (bw-ad3r.2). These three routes are the ones that carry
        // attachments, and the browser talking to them is on the loopback
        // address of the same machine: the bytes are already resident in the
        // page that is sending them, so buffering them here costs a copy, not
        // an opening for a stranger.
        .layer(DefaultBodyLimit::disable())
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({"status":"ok","workbench":"native"}))
}

async fn memory(State(state): State<WorkbenchState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(serde_json::to_value(crate::workbench::memory::report(state.database()).await?)
        .map_err(|error| error.to_string())?))
}

async fn terminate_memory_process(
    Json(request): Json<crate::workbench::memory::TerminateRequest>,
) -> Result<Json<Value>, ApiError> {
    let stopped = tokio::task::spawn_blocking(move || crate::workbench::memory::terminate(request))
        .await
        .map_err(|error| format!("process termination failed: {error}"))??;
    Ok(Json(json!({"stopped": stopped})))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}
async fn search(
    State(state): State<WorkbenchState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Value>, ApiError> {
    // Trimmed at the start only: a space after the last word says the word
    // is finished, and the index stops reading it as a prefix.
    let q = query.q.unwrap_or_default().trim_start().to_string();
    if q.trim().is_empty() {
        return Ok(Json(json!([])));
    }
    let hits = match state.search.clone() {
        // Off the async runtime and off the chat database's worker: a search
        // is a read of its own file and waits on neither.
        Some(index) => tokio::task::spawn_blocking(move || index.search(&q, 100))
            .await
            .map_err(|error| error.to_string())??,
        None => state.database().search(q.trim().to_string(), 100).await?,
    };
    Ok(Json(serde_json::to_value(hits).map_err(|e| e.to_string())?))
}

#[derive(Deserialize)]
struct ChatSearchQuery {
    q: Option<String>,
    sort: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
}

/// Chats, each once, with the places in it that matched. The words typed are
/// read for keys (`title:`, `me:`, `project:`, `after:` and the rest), so the
/// panel's controls and the box are one query.
async fn search_chats(
    State(state): State<WorkbenchState>,
    Query(query): Query<ChatSearchQuery>,
) -> Result<Json<Value>, ApiError> {
    use crate::workbench::search_index::Sort;
    let Some(index) = state.search.clone() else {
        return Err(ApiError::unavailable("the search index is not open".into()));
    };
    let typed = query.q.unwrap_or_default();
    let parsed = crate::workbench::search_query::parse(typed.trim_start(), chrono::Local::now());
    let sort = match query.sort.as_deref() {
        Some("newest") => Sort::Newest,
        _ => Sort::Relevance,
    };
    let offset = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(30).clamp(1, 100);
    let projects = state.projects.clone();
    let mut reply = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let project_ids = match (&projects, parsed.projects.is_empty()) {
            (Some(projects), false) => projects_named(projects, &parsed.projects),
            _ => Vec::new(),
        };
        let page = index.search_chats(&parsed, &project_ids, sort, offset, limit)?;
        let mut reply = serde_json::to_value(page).map_err(|e| e.to_string())?;
        reply["ignored"] = json!(parsed.ignored);
        Ok(reply)
    })
    .await
    .map_err(|error| error.to_string())??;
    name_the_chats(reply["chats"].as_array_mut());
    Ok(Json(reply))
}

/// Name every chat in an answer that knows a project path and not a directory.
///
/// The one naming rule (`chat_name`), fed what this particular answer knows.
/// With no title and no template, a chat in a worktree is named by its
/// project here rather than by the worktree — the same word the rail would use
/// if the chat sat in the project itself, and in every case a name rather than
/// the "Untitled chat" this screen used to write for itself (bw-altj.7).
fn name_the_chats(chats: Option<&mut Vec<Value>>) {
    let Some(chats) = chats else { return };
    for chat in chats {
        let folder = chat["projectPath"]
            .as_str()
            .and_then(crate::workbench::notice::folder_of);
        let name = crate::workbench::chat_name::name_of(&crate::workbench::chat_name::Chat {
            title: chat["title"].as_str(),
            named_by_owner: chat["namedByOwner"].as_bool().unwrap_or(false),
            cwd: chat["cwd"].as_str(),
            project_path: chat["projectPath"].as_str().unwrap_or_default(),
            folder: folder.as_deref(),
            brand: chat["brand"].as_str().unwrap_or_default(),
        });
        chat["name"] = json!(name);
    }
}

/// The ids of the projects a name picks out: its name exactly, or failing
/// that, every project whose name starts with it.
fn projects_named(projects: &crate::db::Database, names: &[String]) -> Vec<String> {
    let Ok(known) = projects.get_projects_with_tags_filtered(true, true) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for name in names {
        let name = name.to_lowercase();
        let exact = known
            .iter()
            .filter(|project| project.name.to_lowercase() == name)
            .collect::<Vec<_>>();
        let chosen = if exact.is_empty() {
            known
                .iter()
                .filter(|project| project.name.to_lowercase().starts_with(&name))
                .collect()
        } else {
            exact
        };
        ids.extend(chosen.into_iter().map(|project| project.id.clone()));
    }
    ids
}

#[derive(Deserialize)]
struct ToolQuery {
    session: String,
    tool: String,
}
async fn tool(
    State(state): State<WorkbenchState>,
    Query(query): Query<ToolQuery>,
) -> Result<Json<Value>, ApiError> {
    state
        .database()
        .tool_details(query.session, query.tool)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such tool call".into()))
}

async fn spend(State(state): State<WorkbenchState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        serde_json::to_value(state.database().spend().await?).map_err(|e| e.to_string())?,
    ))
}

#[derive(Deserialize)]
struct UsageQuery {
    brand: Option<String>,
    /// Which account to ask. Absent means the one the computer is signed in
    /// with, which is what every caller meant before accounts existed.
    profile: Option<String>,
}
async fn usage(
    State(state): State<WorkbenchState>,
    Query(query): Query<UsageQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        state
            .account_usage(
                query.brand.as_deref().unwrap_or("claude"),
                query.profile.as_deref(),
            )
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageResetBody {
    brand: String,
    profile: Option<String>,
    /// The reset's own id, as the usage reading gave it.
    #[serde(default)]
    id: String,
    /// One per attempt the reader confirmed. A retry sends the same one, so
    /// the provider uses at most one reset for it.
    attempt: String,
}
async fn usage_reset(
    State(state): State<WorkbenchState>,
    Json(body): Json<UsageResetBody>,
) -> Result<Json<crate::workbench::usage::ResetOutcome>, ApiError> {
    // An empty reset id is allowed: Codex then uses its next credit.
    if body.attempt.trim().is_empty() {
        return Err(ApiError::from("an attempt id is required".to_string()));
    }
    Ok(Json(
        state
            .use_usage_reset(&body.brand, body.profile.as_deref(), &body.id, &body.attempt)
            .await?,
    ))
}

#[derive(Deserialize)]
struct TokensQuery {
    session: String,
}
async fn tokens(
    State(state): State<WorkbenchState>,
    Query(query): Query<TokensQuery>,
) -> Result<Json<Value>, ApiError> {
    let session = state
        .database()
        .get_session(query.session.clone())
        .await?
        .ok_or_else(|| ApiError::not_found("no such session".into()))?;
    let stats = state.database().token_stats(query.session).await?;
    let record = session
        .external_id
        .as_deref()
        .filter(|_| session.brand == "claude")
        .and_then(|id| {
            let config = crate::workbench::profiles::chat_dir(
                "claude",
                session.profile.as_deref(),
                state.claude_config_directory(),
            );
            crate::workbench::claude::history::find_record(&config, id)
        });
    let spent = record.as_deref().and_then(crate::workbench::claude::history::token_spend).or_else(||stats.cost.as_ref().map(|cost| {
        let own = json!({"input":cost["input"],"cacheWrite":0,"cacheRead":0,"output":cost["output"],"thinking":0,"total":cost["total"]});
        json!({"own":own,"helpers":{"input":0,"cacheWrite":0,"cacheRead":0,"output":0,"thinking":0,"total":0},"total":own,
            "turns":stats.turns,"toolCalls":stats.tool_calls,"forgettings":stats.forgettings,"helperCount":stats.helper_count,"models":[{"model":session.model.unwrap_or_else(||"unnamed".into()),"spend":own,"turns":stats.turns}]})
    }));
    let (window, window_note) = match state.window_now(&session.id).await {
        None => (
            Value::Null,
            json!("Context details are unavailable for archived chats."),
        ),
        Some(Ok(raw)) => match crate::workbench::usage::window_now(&raw) {
            Some(window) => (window, Value::Null),
            None => (
                Value::Null,
                json!("The program driving this chat did not say what is in its window."),
            ),
        },
        Some(Err(_)) => (
            Value::Null,
            json!("This chat could not be asked what is in its window just now."),
        ),
    };
    Ok(Json(json!({"window":window,"windowNote":window_note,
        "spent":spent,"spentNote":if spent.is_some(){Value::Null}else if record.is_none(){json!("This chat has no record on disk yet.")}else{json!("This chat's record could not be read.")}})))
}

#[derive(Deserialize)]
struct LinkQuery {
    path: Option<String>,
}
async fn chats_for_bead(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
    Query(query): Query<LinkQuery>,
) -> Result<Json<Value>, ApiError> {
    let cached = state.database().sessions_for_bead(id.clone()).await?;
    let board = if let Some(path) = query.path {
        crate::workbench::beads_links::sessions_for_issue(
            &Default::default(),
            std::path::Path::new(&path),
            &id,
        )
        .await
    } else {
        vec![]
    };
    let wanted = if board.is_empty() {
        cached.iter().map(|s| s.id.clone()).collect()
    } else {
        board
    };
    Ok(Json(json!(wanted.into_iter().map(|session_id| {
        let row = cached.iter().find(|s|s.id == session_id);
        json!({"sessionId":session_id,"title":row.and_then(|s|s.title.clone()),
            // Named the one way, from the chat's own record, which this
            // answer has in hand (chat_name, bw-altj.7).
            "name":row.map(crate::workbench::chat_name::name_session)
            // The board can link a card to a chat this app has no record of.
            // Nothing is known about it, so the rule's own last word names it,
            // rather than a second word invented on the screen that draws it.
            .unwrap_or_else(||crate::workbench::notice::naming(None,None,"")),
            "brand":row.map(|s|s.brand.clone()),"lastActiveAt":row.map(|s|s.last_active_at.clone()),"projectId":row.map(|s|s.project_id.clone())})
    }).collect::<Vec<_>>())))
}

async fn beads_for_chat(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut beads = state.database().beads_for_session(id.clone()).await?;
    if let Some(session) = state.database().get_session(id.clone()).await? {
        beads.extend(
            crate::workbench::beads_links::issues_for_session(
                &Default::default(),
                std::path::Path::new(&session.cwd),
                &id,
            )
            .await,
        );
    }
    beads.sort();
    beads.dedup();
    Ok(Json(json!(beads)))
}

#[derive(Deserialize)]
struct SessionsQuery {
    project: Option<String>,
}

#[derive(Deserialize)]
struct NotificationsQuery {
    /// Test projects are hidden for the same reason the project list hides
    /// them, and shown here on the same terms: a case proving this endpoint
    /// has any business naming them.
    ///
    /// Spelled the way `/api/projects` spells it, and deliberately not in the
    /// camel case the bodies on this router use. It is the same word about the
    /// same projects, so a caller that knows one spelling knows both — and a
    /// second spelling is not a second meaning, it is a parameter that silently
    /// does nothing, which is exactly how this went out wrong the first time.
    include_test: Option<bool>,
}

/// Everything the app has to say to its owner right now.
///
/// The whole answer, settled here: which chats are worth a row, which project
/// each belongs to by name, and what has already been read. The page used to
/// work this out itself from a list of chats and a separate list of projects,
/// which is why a chat whose project had been deleted drew a permanent row
/// reading "Unknown project" that no amount of clearing removed (bw-altj).
async fn notifications(
    State(state): State<WorkbenchState>,
    Query(query): Query<NotificationsQuery>,
) -> Result<Json<Vec<crate::workbench::notice::Row>>, ApiError> {
    let projects = state.projects.as_ref().ok_or_else(|| {
        ApiError::unavailable("this server has no project list to name chats against".to_string())
    })?;
    Ok(Json(
        crate::workbench::notice::worth_saying(
            state.database(),
            projects,
            query.include_test.unwrap_or(false),
        )
        .await?,
    ))
}

/// One chat the owner says he has read, in the state he read it in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadChat {
    id: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest {
    chats: Vec<ReadChat>,
}

/// The owner has read these, in the states they were in when he read them.
///
/// The state travels with each chat rather than being looked up here, so that
/// what gets written down is what he actually saw. A chat that moved on between
/// the tray drawing it and his thumb landing is then still unread — which is
/// the safe way to be wrong, because the alternative silences something he was
/// never shown.
async fn notifications_read(
    State(state): State<WorkbenchState>,
    Json(request): Json<ReadRequest>,
) -> Result<StatusCode, ApiError> {
    let at = chrono::Utc::now().to_rfc3339();
    state
        .database()
        .mark_read(
            request
                .chats
                .into_iter()
                .map(|chat| (chat.id, chat.state))
                .collect(),
            at,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn sessions(
    State(state): State<WorkbenchState>,
    Query(query): Query<SessionsQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    Ok(Json(
        session_summaries(state.database(), query.project).await?,
    ))
}

pub(crate) async fn session_summaries(
    database: &ChatDb,
    project: Option<String>,
) -> Result<Vec<Value>, String> {
    let sessions = database.list_sessions(project).await?;
    let ids = sessions.iter().map(|session| session.id.clone()).collect();
    let mut beads = database.beads_for_sessions(ids).await?;
    let mut activities = database.session_activities().await?;
    let mut values = Vec::with_capacity(sessions.len());
    for session in sessions {
        let linked = beads.remove(&session.id).unwrap_or_default();
        let activity =
            activities
                .remove(&session.id)
                .unwrap_or(crate::workbench::store::SessionActivity {
                    label: String::new(),
                    detail: String::new(),
                    call: Value::Null,
                    busy_since: None,
                });
        let name = crate::workbench::chat_name::name_session(&session);
        let mut value = serde_json::to_value(session).map_err(|error| error.to_string())?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| "session was not an object".to_string())?;
        // What the rail calls it, by the one rule, so a chat that has just
        // been titled is not drawn by its bare title for a moment (chat_name).
        object.insert("name".into(), json!(name));
        object.insert("activity".into(), json!(activity.label));
        // What it is doing, in the words of its own call. Beside the
        // activity rather than inside it: the row draws its own word for
        // the standing and this after it (bw-xfb4).
        object.insert("activityDetail".into(), json!(activity.detail));
        // The call itself, so the rail draws the sentence the call's own card
        // draws rather than the wire's words for it (bw-gci9).
        object.insert("activityCall".into(), activity.call.clone());
        object.insert("busySince".into(), json!(activity.busy_since));
        object.insert("beads".into(), json!(linked));
        values.push(value);
    }
    Ok(values)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatNamePreviewInput {
    project_id: String,
    chat_name: crate::project_manifest::ChatNameSettings,
}

/// How many of a project's chats the name preview shows.
const PREVIEWED_CHATS: usize = 6;

/// What a template that has not been saved would call this project's most
/// recent chats, beside what they are called now, and what is wrong with any
/// of its parts. The same code names the real rows, so the preview cannot say
/// one thing and the rail another (bw-mv45).
async fn chat_name_preview(
    State(state): State<WorkbenchState>,
    Json(input): Json<ChatNamePreviewInput>,
) -> Result<Json<Value>, ApiError> {
    use crate::workbench::chat_name;
    let problems = chat_name::problems(&input.chat_name);
    let sessions = state
        .database()
        .list_restore_sessions(Some(input.project_id), false, registered_roots(&state))
        .await?;
    let draft = input.chat_name;
    let chats = tokio::task::spawn_blocking(move || {
        let template = chat_name::compile(&draft);
        sessions
            .iter()
            .take(PREVIEWED_CHATS)
            .map(|session| {
                let folder = folder_of(&session.cwd);
                let chat = chat_name::Chat::of(session, folder.as_deref());
                json!({
                    "sessionId": session.id,
                    "now": chat_name::name_of(&chat),
                    "then": chat_name::name_by(template.as_ref(), &chat),
                    "namedByOwner": session.named_by_owner,
                })
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(Json(json!({ "problems": problems, "chats": chats })))
}

#[derive(Deserialize)]
struct RestoreQuery {
    project: Option<String>,
    path: Option<String>,
    all: Option<String>,
    local: Option<String>,
}

fn folder_of(path: &str) -> Option<String> {
    crate::workbench::notice::folder_of(path)
}

/// What each of these chats is called, settled once for the whole answer.
///
/// Last, because a row's folder is corrected after it is built — by git, which
/// knows a worktree from a directory — and the name is drawn from the folder
/// the reader will actually see. One pass rather than one per builder: there
/// are four places above that make a restore row, and a name missing from any
/// of them would put "Untitled chat" back on the rail for exactly those chats.
///
/// A row built from the database carries its project's path; one found only
/// in a provider's listing is in the project the answer was asked about.
fn name_the_rows(rows: &mut [Value], project_path: Option<&str>) {
    for row in rows {
        let name = crate::workbench::chat_name::name_of(&crate::workbench::chat_name::Chat {
            title: row["title"].as_str(),
            named_by_owner: row["namedByOwner"].as_bool().unwrap_or(false),
            cwd: row["cwdHint"].as_str(),
            project_path: row["projectPath"].as_str().or(project_path).unwrap_or_default(),
            folder: row["folder"].as_str(),
            brand: row["brand"].as_str().unwrap_or_default(),
        });
        row["name"] = json!(name);
    }
}

/// What checkout each of these working directories is in.
///
/// A chat's chip names the worktree it is working in, which git has to be
/// asked for — the folder alone cannot say whether it is a worktree, whose it
/// is, or what branch it has out (bw-ov7a.4). One question per distinct
/// directory, all asked at once: a list of thirty chats in the same worktree
/// asks once.
async fn checkouts_of<'a>(
    cwds: impl Iterator<Item = &'a str>,
) -> HashMap<String, crate::routes::git::Checkout> {
    let mut asking: Vec<String> = cwds.map(str::to_string).collect();
    asking.sort();
    asking.dedup();
    let answers = futures::future::join_all(asking.into_iter().map(|cwd| async move {
        let found = crate::routes::git::checkout_at(std::path::Path::new(&cwd)).await;
        (cwd, found)
    }))
    .await;
    answers
        .into_iter()
        .filter_map(|(cwd, found)| Some((cwd, found?)))
        .collect()
}

fn restore_row(
    session: Session,
    beads: Vec<String>,
    holds: &[crate::workbench::external::ProviderHold],
    checkouts: &HashMap<String, crate::routes::git::Checkout>,
) -> Value {
    let checkout = checkouts.get(&session.cwd);
    let folder = checkout
        .map(|it| it.folder.clone())
        .or_else(|| folder_of(&session.cwd));
    let branch = checkout.and_then(|it| it.branch.clone());
    let held = session
        .external_id
        .as_deref()
        .and_then(|id| holds.iter().find(|hold| hold.id.eq_ignore_ascii_case(id)));
    json!({
        "sessionId": session.id, "externalId": session.external_id, "brand": session.brand, "model":session.model,
        "title": session.title, "lastActiveAt": session.last_active_at,
        "lastSpokeAt": session.last_spoke_at, "state": session.state, "origin": session.origin,
        "begunBy": session.begun_by,
        "projectId": session.project_id, "projectPath": session.project_path,
        "namedByOwner": session.named_by_owner, "cwdHint": session.cwd, "folder": folder,
        "branch": branch, "beads": beads, "runningElsewhere": held.is_some(), "held": held,
    })
}

fn restore_clock(row: &Value) -> &str {
    row["lastSpokeAt"]
        .as_str()
        .or_else(|| row["lastActiveAt"].as_str())
        .unwrap_or_default()
}

/// How long one discovery answer serves every reader who asks for the same
/// folder. Discovery is not a database read: it starts an ACP adapter for each
/// provider, waits out its handshake, pages `session/list`, and reads the
/// provider's own record beside it. The sidebar asks on open, on focus and on
/// every project switch, so the answers overlapped — each one paying that price
/// again, and each one holding a connection open while the others did.
const DISCOVERY_FRESH: Duration = Duration::from_secs(5);

/// Every saved chat a provider knows about, asked once for everyone.
///
/// Callers asking about the same folder in the same breath wait on one another
/// rather than starting their own adapters, and the one that runs leaves its
/// answer behind for the rest of the window. This is also what keeps a chat to
/// one row: two overlapping discoveries each saw a chat no row matched, and
/// each cached a row for it (bw-t26l.20).
async fn provider_sessions_shared(state: &WorkbenchState, project: Option<&str>) -> Vec<Value> {
    // One answer serves the switch either way: everyone's chats are listed,
    // each saying who began it, and `restore` applies the switch (bw-p61.17).
    let key = project.unwrap_or_default().to_string();
    if let Some(rows) = fresh_discovery(&state.discovery_cache, &key).await {
        return rows;
    }
    let running = state.discovery(&key).await;
    let _running = running.lock().await;
    if let Some(rows) = fresh_discovery(&state.discovery_cache, &key).await {
        return rows;
    }
    let rows = provider_sessions(state, project).await;
    state
        .discovery_cache
        .lock()
        .await
        .insert(key, (std::time::Instant::now(), rows.clone()));
    rows
}

/// The same answer, but only if it is already in hand.
///
/// A chat's own facts are asked for the moment it is opened, and everything in
/// them except the branch is already in this app's own records. Waiting for
/// both providers to list every saved chat before saying any of it put the
/// whole discovery on the reader's path: measured against the owner's data,
/// the chat-facts request was the slowest thing on a chat open, and a provider
/// that has to start an adapter to answer can hold it for the whole eight
/// seconds discovery is allowed. So the reader is given what is known and the
/// listing is fetched behind them, for whoever opens next. The folder and the
/// provider's own name for the chat correct themselves on the next open, which
/// is within the same page load: the sidebar's own restore asks for the very
/// same listing at the very same moment (bw-550g.1).
async fn provider_sessions_in_hand(state: &WorkbenchState, project: Option<&str>) -> Vec<Value> {
    let key = project.unwrap_or_default().to_string();
    if let Some(rows) = fresh_discovery(&state.discovery_cache, &key).await {
        return rows;
    }
    let behind = state.clone();
    let project = project.map(str::to_string);
    tokio::spawn(async move {
        provider_sessions_shared(&behind, project.as_deref()).await;
    });
    Vec::new()
}

async fn fresh_discovery(
    cache: &tokio::sync::Mutex<HashMap<String, (std::time::Instant, Vec<Value>)>>,
    key: &str,
) -> Option<Vec<Value>> {
    cache
        .lock()
        .await
        .get(key)
        .filter(|(at, _)| at.elapsed() < DISCOVERY_FRESH)
        .map(|(_, rows)| rows.clone())
}

/// How long a provider that cannot answer `session/list` is left alone.
///
/// Starting an adapter to be told "Authentication required" costs the same as
/// starting one that answers, and a provider that is not signed in says it
/// every time. Measured on a run of this app's own tests: seventeen of them,
/// one per discovery, each paying for a process that could not help.
const LISTING_REFUSED_FOR: Duration = Duration::from_secs(60);

/// How long a provider's `session/list` answer stands for the same folder.
///
/// Every answer starts one adapter process per account, and each of those
/// loads the provider's plugins and MCP servers before it can reply — hundreds
/// of megabytes for a list the record scan beside it already mostly holds. The
/// chat list asks whenever a record moves, which in a busy session is every few
/// seconds. A chat begun since the last answer is still listed at once, from
/// the record scan; only the adapter's own guesses about it wait (bw-69sa.2).
const LISTING_FRESH: Duration = Duration::from_secs(60);

type Listings = Arc<
    tokio::sync::Mutex<
        HashMap<
            (String, Option<std::path::PathBuf>),
            (std::time::Instant, Vec<crate::workbench::acp::client::ListedSession>),
        >,
    >,
>;

/// Ask one provider for its saved chats, unless it has just refused or just
/// answered.
async fn ask_provider_to_list(
    state: &WorkbenchState,
    brand: &str,
    filter: Option<&std::path::Path>,
) -> Result<Vec<crate::workbench::acp::client::ListedSession>, String> {
    if let Some(refused) = state.listing_refused.lock().await.get(brand) {
        if refused.elapsed() < LISTING_REFUSED_FOR {
            return Err(format!("{brand} refused session/list a moment ago"));
        }
    }
    let key = (brand.to_string(), filter.map(std::path::Path::to_path_buf));
    if let Some((at, sessions)) = state.listings.lock().await.get(&key) {
        if at.elapsed() < LISTING_FRESH {
            return Ok(sessions.clone());
        }
    }
    // Each account answers for its own saved chats, so every account is asked
    // and the answers put together. One refusal does not speak for the others:
    // an account that is signed out refuses while the signed-in one answers,
    // and the list is only refused when nothing answered (bw-5ihw.8).
    let mut listed: Result<Vec<crate::workbench::acp::client::ListedSession>, String> =
        Err(format!("no {brand} account answered session/list"));
    // A brand with no relocatable account — the local one — has no accounts to
    // walk and is asked once, the way it always was.
    let accounts = match state.registry.every_account(brand) {
        empty if empty.is_empty() => vec![crate::workbench::profiles::SYSTEM.to_string()],
        known => known.into_iter().map(|(id, _)| id).collect(),
    };
    for profile in accounts {
        let named = (profile != crate::workbench::profiles::SYSTEM).then_some(profile.as_str());
        let answer = crate::workbench::acp::client::list_sessions(brand, filter, named).await;
        match (answer, &mut listed) {
            (Ok(sessions), Ok(known)) => known.extend(sessions),
            (Ok(sessions), slot) => *slot = Ok(sessions),
            (Err(why), Err(first)) => *first = why,
            (Err(_), Ok(_)) => {}
        }
    }
    let mut refusals = state.listing_refused.lock().await;
    match &listed {
        Err(_) => {
            refusals.insert(brand.to_string(), std::time::Instant::now());
        }
        Ok(sessions) => {
            refusals.remove(brand);
            state
                .listings
                .lock()
                .await
                .insert(key, (std::time::Instant::now(), sessions.clone()));
        }
    }
    // What the list learned is worth telling the transcript, which opens next
    // and would otherwise start the same adapter to hear the same refusal.
    crate::workbench::acp::client::note_adapter_answer(brand, listed.is_err()).await;
    listed
}

/// Every saved chat a provider knows about, however it is asked.
///
/// ACP `session/list` is the standard way to ask and is asked first, but the
/// answer is thinner than the record: an id, a folder, a clock, and a title the
/// adapter guessed. The restore list also draws the branch a chat ran on and
/// names it the app's own way — by what was first asked of it, not by what the
/// agent answered ("Reply with exactly: READY", where the adapter offers
/// "Ready"). Neither is a field `session/list` has. So the record is read
/// alongside, and lends those two to every chat the adapter listed; the clock
/// stays the adapter's, and a chat only the record knows is still listed
/// (bw-t26l.20).
///
/// Asking starts an adapter process per provider and waits for it to read its
/// records: a second when the machine is quiet, half a minute or more when the
/// file cache is cold. The chat list asks every time a record moves on disk
/// and every opened chat asks again, so an adapter that has not answered in
/// eight seconds is let go for the record scan that already stands in when
/// there is no adapter at all (bw-uxoe). The local list is drawn before any of
/// this, and a chat begun elsewhere still arrives on the live feed.
async fn provider_sessions(state: &WorkbenchState, project: Option<&str>) -> Vec<Value> {
    const ANSWER_WITHIN: Duration = Duration::from_secs(8);
    let project_path = project.map(std::path::Path::new);
    // The folder is not what the switch widens. The switch adds the agents'
    // own chats to the kinds offered; it has never meant chats held somewhere
    // else on the machine, and the record scan beside this one has always kept
    // the folder whichever way the switch was set (bw-t9no.1).
    let filter = project_path;
    // Every checkout of the project, not only its own folder: git may keep a
    // worktree anywhere, and a chat held in one is this project's (bw-ggbj.1).
    let folders = match project {
        Some(project) => {
            let named = std::path::PathBuf::from(project);
            let asked = named.clone();
            Some(
                tokio::task::spawn_blocking(move || crate::workbench::provider::folders_of(&asked))
                    .await
                    .unwrap_or_else(|_| vec![named]),
            )
        }
        None => None,
    };
    let ask = |brand: &'static str| async move {
        match tokio::time::timeout(ANSWER_WITHIN, ask_provider_to_list(state, brand, filter)).await
        {
            Ok(answer) => answer,
            Err(_) => Err(format!(
                "no session/list answer within {}s",
                ANSWER_WITHIN.as_secs()
            )),
        }
    };
    let (claude_acp, codex_acp) = tokio::join!(ask("claude"), ask("codex"));
    let mut rows = Vec::new();
    for (brand, result) in [("claude", claude_acp), ("codex", codex_acp)] {
        let recorded = recorded_sessions(state, brand, project_path).await;
        match result {
            Ok(sessions) => {
                let mut recorded: std::collections::HashMap<String, Value> = recorded
                    .into_iter()
                    .filter_map(|row| Some((row["externalId"].as_str()?.to_lowercase(), row)))
                    .collect();
                for session in sessions {
                    let known = recorded.remove(&session.session_id.to_lowercase());
                    let mut row = json!({
                        "brand":brand,
                        "externalId":session.session_id,
                        "lastActiveAt":session.updated_at,
                        "lastSpokeAt":Value::Null,
                        "name":session.title,
                        "cwd":session.cwd,
                        "branch":Value::Null,
                        "acpMeta":session.meta,
                        // `session/list` has no field for who began a chat.
                        // The record beside it says, or nobody does.
                        "begunBy":"unknown",
                    });
                    if let Some(known) = known {
                        // The clocks too, when the record has them. The
                        // adapter reports what the filesystem says a chat's
                        // file was last written; the record reports the last
                        // thing that happened inside it, and knows the one
                        // clock this list is actually dated by — when the
                        // person last spoke, which `session/list` has no field
                        // for at all (bw-zhs9, `whenHeSpoke`). Without it a
                        // chat whose last word is 10:00 AM sits under 10:14 PM,
                        // the minute its file happened to be written, and only
                        // when the adapter is the one answering (bw-t26l.20).
                        // And the folder: the record names the one the chat
                        // was begun in, which is the one it is resumed from
                        // and the project it belongs to (bw-6twt.1).
                        for field in ["name", "cwd", "branch", "lastActiveAt", "lastSpokeAt", "begunBy"] {
                            match known.get(field) {
                                Some(value) if !value.is_null() => {
                                    row[field] = value.clone();
                                }
                                _ => {}
                            }
                        }
                    }
                    rows.push(row);
                }
                // A chat the adapter did not name is still a chat on disk.
                rows.extend(recorded.into_values());
            }
            Err(error) => {
                tracing::warn!(provider = brand, %error, "ACP session/list unavailable; using compatibility discovery");
                rows.extend(recorded);
            }
        }
    }
    // `session/list` is asked for one folder, but the answer is the adapter's
    // to scope and neither provider's honours the ask: measured against the
    // owner's own machine, 455 of the 643 chats filed under one project were
    // held in other checkouts, in /tmp and in the home folder, and each one
    // was adopted into that project on sight. The folder a chat says it is in
    // is the only thing that decides which project lists it (bw-t9no.1).
    // The record's folder is the one a chat was begun in, and every saved row
    // is put back there before any list is drawn from the saved rows: a row
    // adopted while a chat's last `cd` named its folder is otherwise listed in
    // the project it once visited (bw-6twt.1).
    let found: Vec<(String, String, String)> = rows
        .iter()
        .filter_map(|row| {
            Some((
                row["brand"].as_str()?.to_string(),
                row["externalId"].as_str()?.to_string(),
                row["cwd"].as_str().filter(|cwd| !cwd.is_empty())?.to_string(),
            ))
        })
        .collect();
    if let Err(error) = state.database().correct_folders(found).await {
        tracing::warn!(%error, "could not put saved chats back in their own folders");
    }
    let others = registered_roots(state);
    only_in_this_folder(&mut rows, folders.as_deref(), &others);
    // Everyone's, whichever way the switch is set, each saying who began it.
    // The switch is applied by `restore`, after the saved rows have been
    // corrected by what is listed here: applied any earlier, a saved row an
    // agent began is never told so, and stays on the list (bw-p61.17).
    rows
}

/// Drop every listed chat that is not held in one of this project's checkouts.
///
/// A chat placed nowhere at all is dropped with them: an unplaceable chat
/// belongs to no project, and the reader asked for one. So is a chat inside a
/// project nested in this one — one of `others`, or a folder with its own
/// `.atelier` — which that project lists instead (bw-6twt.1).
fn only_in_this_folder(
    rows: &mut Vec<Value>,
    folders: Option<&[std::path::PathBuf]>,
    others: &[std::path::PathBuf],
) {
    let Some(folders) = folders else {
        return;
    };
    rows.retain(|row| {
        row["cwd"].as_str().is_some_and(|cwd| {
            crate::workbench::provider::held_in(std::path::Path::new(cwd), folders, others)
        })
    });
}

/// The roots of every registered project, archived and test ones included:
/// each keeps its own chats out of any project it sits inside (bw-6twt.1).
fn registered_roots(state: &WorkbenchState) -> Vec<std::path::PathBuf> {
    let Some(projects) = state.projects() else {
        return Vec::new();
    };
    let Ok(known) = projects.get_projects_filtered(true, true) else {
        return Vec::new();
    };
    crate::workbench::provider::project_roots(known.iter().flat_map(|project| {
        std::iter::once(project.path.as_str()).chain(project.local_path.as_deref())
    }))
}

/// What the provider's own record says about the saved chats.
///
/// Neither scan is narrowed to the project's folder here. A worktree outside
/// that folder is still the project's, and `provider_sessions` drops what is
/// held in none of its checkouts once, for every source (bw-ggbj.1).
async fn recorded_sessions(
    state: &WorkbenchState,
    brand: &str,
    project_path: Option<&std::path::Path>,
) -> Vec<Value> {
    if brand == "claude" {
        // Every account's record directory. A chat saved on the work account
        // lives under the work account and was simply missing from this list
        // before (bw-5ihw.8).
        let directories = state.account_directories("claude");
        return tokio::task::spawn_blocking(move || {
            directories
            .iter()
            .flat_map(|claude_config| {
                crate::workbench::claude::history::list_sessions(
                    claude_config,
                    None,
                    // Everyone's, each saying who began it. The switch is
                    // applied once by the caller, after the adapter's answer
                    // is merged in: a chat that is out of the list still has
                    // to be recognised as the agents' own, or the row saved
                    // for it before there was such a rule is never corrected,
                    // and the adapter's answer for it is adopted as a person's
                    // (bw-p61.17).
                    true,
                )
            })
            .map(|session| json!({
                "brand":"claude", "externalId":session.session_id, "lastActiveAt":session.last_modified,
                "name":session.name, "cwd":session.cwd, "branch":session.git_branch,
                "lastSpokeAt":session.last_spoke_at,
                "begunBy": if session.programmatic { "agent" } else { "person" },
            }))
            .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
    }
    let cwd = project_path.unwrap_or_else(|| std::path::Path::new("."));
    // One app-server per account: a thread list answers for the CODEX_HOME it
    // was started with, so the accounts are asked one after another and their
    // answers put together (bw-5ihw.8).
    let mut threads: Vec<Value> = Vec::new();
    for home in state.codex_account_homes() {
        let stamp = codex_listing_stamp(home.as_deref());
        if let Some(listed) = listed_threads(home.as_deref(), &stamp) {
            threads.extend(listed);
            continue;
        }
        let Ok(transport) = state.codex_reader(cwd, home.as_deref()).await else {
            continue;
        };
        // Every source kind, for the same reason as the Claude record above:
        // a subagent's thread left unlisted is a thread the adapter's answer
        // then adopts as a person's (bw-p61.17).
        match crate::workbench::codex::history::list_threads(&transport, None, true)
            .await
        {
            Ok(listed) => {
                remember_threads(home.as_deref(), stamp, &listed);
                threads.extend(listed)
            }
            Err(_) => {
                state
                    .forget_codex_reader(cwd, home.as_deref(), &transport)
                    .await
            }
        }
    }
    let rows = threads
        .into_iter()
        .filter_map(|thread| {
            let id = thread["id"].as_str()?;
            // The record's own last word first, and the reader's index only
            // for a thread whose file we cannot read. The index dates a thread
            // by when its file was written, which is not when anything
            // happened in the chat (bw-t26l.22).
            let updated = thread["path"]
                .as_str()
                .and_then(|path| {
                    crate::workbench::codex::history::last_happened_at(std::path::Path::new(path))
                })
                .or_else(|| {
                    thread["updatedAt"].as_i64().and_then(|seconds| {
                        chrono::DateTime::from_timestamp(seconds, 0).map(|at| at.to_rfc3339())
                    })
                });
            let preview = thread["preview"].as_str().unwrap_or_default();
            let begun_by = crate::workbench::codex::history::begun_by(&thread);
            Some(json!({"brand":"codex","externalId":id,"lastActiveAt":updated,"begunBy":begun_by,
                "name":thread.get("name").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(crate::workbench::metadata::conversation_title(preview))),
                "cwd":thread["cwd"],"branch":thread["gitInfo"]["branch"],"lastSpokeAt":thread["path"].as_str().and_then(|path|crate::workbench::codex::history::last_spoke_at(std::path::Path::new(path)))}))
        })
        .collect::<Vec<_>>();
    let _ = tokio::task::spawn_blocking(crate::workbench::codex::history::saved_answers).await;
    rows
}

/// How long a Codex thread list stands while nothing it is drawn from moved.
const THREADS_KEPT: Duration = Duration::from_secs(300);

type ListedThreads =
    HashMap<Option<std::path::PathBuf>, (String, std::time::Instant, Vec<Value>)>;

static LISTED_THREADS: std::sync::LazyLock<std::sync::Mutex<ListedThreads>> =
    std::sync::LazyLock::new(Default::default);

/// What a Codex account's thread list is drawn from, as sizes and clocks:
/// its state database and the folders a new thread's rollout lands in. When
/// none moved there is no new thread, no renamed one and none deleted, and
/// asking the app-server to page through every thread again learns nothing.
/// A thread's own clocks are read from its rollout on every discovery
/// regardless (bw-sppo.2).
fn codex_listing_stamp(home: Option<&std::path::Path>) -> String {
    let Some(home) = home
        .map(std::path::Path::to_path_buf)
        .or_else(|| crate::workbench::profiles::system_dir("codex"))
    else {
        return String::new();
    };
    let mut places: Vec<std::path::PathBuf> = std::fs::read_dir(&home)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("state") || name.starts_with("session_index"))
        })
        .collect();
    let today = chrono::Local::now().date_naive();
    for day in [today, today - chrono::Days::new(1)] {
        places.push(home.join("sessions").join(day.format("%Y/%m/%d").to_string()));
    }
    places.sort();
    places
        .iter()
        .map(|place| match std::fs::metadata(place) {
            Ok(meta) => format!(
                "{}:{}:{:?}",
                place.display(),
                meta.len(),
                meta.modified().ok()
            ),
            Err(_) => format!("{}:-", place.display()),
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn listed_threads(home: Option<&std::path::Path>, stamp: &str) -> Option<Vec<Value>> {
    let listed = LISTED_THREADS.lock().unwrap_or_else(|e| e.into_inner());
    let (known, at, threads) = listed.get(&home.map(std::path::Path::to_path_buf))?;
    (!stamp.is_empty() && known == stamp && at.elapsed() < THREADS_KEPT).then(|| threads.clone())
}

fn remember_threads(home: Option<&std::path::Path>, stamp: String, threads: &[Value]) {
    LISTED_THREADS.lock().unwrap_or_else(|e| e.into_inner()).insert(
        home.map(std::path::Path::to_path_buf),
        (stamp, std::time::Instant::now(), threads.to_vec()),
    );
}

async fn restore(
    State(state): State<WorkbenchState>,
    Query(query): Query<RestoreQuery>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let everything = query.all.is_some();
    // The full answer asks the providers first: discovery puts each saved row
    // back in the folder its chat was begun in, and a row read before that is
    // drawn in the project it wandered into for one more load (bw-6twt.1).
    let known_sessions = if query.local.is_some() {
        Vec::new()
    } else {
        provider_sessions_shared(&state, query.path.as_deref()).await
    };
    let sessions = state
        .database()
        .list_restore_sessions(query.project.clone(), everything, registered_roots(&state))
        .await?;
    let ids = sessions.iter().map(|session| session.id.clone()).collect();
    let mut beads = state.database().beads_for_sessions(ids).await?;
    // This first response exists solely to put durable rows on screen while
    // provider discovery continues in the concurrent full request. Do not put
    // process-table and provider-marker discovery back on its critical path —
    // but do not answer "nobody is working in any of these" either, which is
    // what an empty hold set says and is not what we know. The hold beat's
    // last reading costs nothing and is at most a couple of seconds old
    // (bw-t26l.22).
    if query.local.is_some() {
        let lately = state.holds_lately().await;
        let checkouts = checkouts_of(sessions.iter().map(|session| session.cwd.as_str())).await;
        let mut rows: Vec<Value> = sessions
            .into_iter()
            .map(|session| {
                let linked = beads.remove(&session.id).unwrap_or_default();
                restore_row(session, linked, &lately, &checkouts)
            })
            .collect();
        name_the_rows(&mut rows, query.path.as_deref());
        rows.sort_by(|a, b| restore_clock(b).cmp(restore_clock(a)));
        return Ok(Json(rows));
    }

    let holds = state.provider_holds().await;
    let checkouts = checkouts_of(sessions.iter().map(|session| session.cwd.as_str())).await;
    let mut rows: Vec<Value> = sessions
        .into_iter()
        .map(|session| {
            let linked = beads.remove(&session.id).unwrap_or_default();
            restore_row(session, linked, &holds, &checkouts)
        })
        .collect();
    for known in known_sessions {
        let key = format!(
            "{}:{}",
            known["brand"].as_str().unwrap_or_default(),
            known["externalId"].as_str().unwrap_or_default()
        );
        let held = known["externalId"]
            .as_str()
            .and_then(|id| holds.iter().find(|hold| hold.id.eq_ignore_ascii_case(id)));
        if let Some(row) = rows.iter_mut().find(|row| {
            format!(
                "{}:{}",
                row["brand"].as_str().unwrap_or_default(),
                row["externalId"].as_str().unwrap_or_default()
            ) == key
        }) {
            let pinned_title = row["sessionId"]
                .as_str()
                .map(str::to_string)
                .map(|session_id| state.database().steering_menu(session_id));
            let pinned_title = match pinned_title {
                Some(answer) => answer.await?["title"].as_str().map(str::to_string),
                None => None,
            };
            if let Some(title) = pinned_title.as_deref().or_else(|| known["name"]
                .as_str()
                .filter(|title| !title.trim().is_empty()))
            {
                if row["title"].as_str() != Some(title) {
                    row["title"] = json!(title);
                    if let Some(session_id) = row["sessionId"].as_str() {
                        // The local response is deliberately drawn before this
                        // provider reconciliation. Keep its next answer
                        // identical: otherwise every refresh alternates the
                        // stored generated title and the provider's canonical
                        // title while the two requests finish.
                        state
                            .database()
                            .update_session(
                                session_id.to_string(),
                                crate::workbench::store::SessionPatch {
                                    title: Some(Some(title.to_string())),
                                    ..crate::workbench::store::SessionPatch::default()
                                },
                                None,
                            )
                            .await?;
                    }
                }
            }
            if known["lastActiveAt"].as_str() > row["lastActiveAt"].as_str() {
                let latest = known["lastActiveAt"].as_str().map(str::to_string);
                row["lastActiveAt"] = known["lastActiveAt"].clone();
                if let (Some(session_id), Some(latest)) = (row["sessionId"].as_str(), latest) {
                    // The fast durable response is painted before provider
                    // discovery. Persist its clock just like its title and
                    // human clock, or every refresh briefly moves the row to
                    // its old day and then back to the provider's current day.
                    state
                        .database()
                        .update_session(
                            session_id.to_string(),
                            crate::workbench::store::SessionPatch::default(),
                            Some(latest),
                        )
                        .await?;
                }
            }
            if known["lastSpokeAt"].as_str() > row["lastSpokeAt"].as_str() {
                row["lastSpokeAt"] = known["lastSpokeAt"].clone();
                if let (Some(session_id), Some(at)) =
                    (row["sessionId"].as_str(), known["lastSpokeAt"].as_str())
                {
                    // Provider discovery is also reconciliation. Persist the
                    // human clock so the next fast local restore draws the
                    // same group and order instead of flickering until this
                    // slower request finishes.
                    state
                        .database()
                        .mark_spoke(session_id.to_string(), at.to_string())
                        .await?;
                }
            }
            if !known["cwd"].is_null() {
                row["cwdHint"] = known["cwd"].clone();
                row["folder"] = json!(known["cwd"].as_str().and_then(folder_of));
            }
            row["branch"] = known["branch"].clone();
            row["runningElsewhere"] = json!(held.is_some());
            row["held"] = json!(held);
            // The record has just said who began this chat. The local answer
            // is drawn from the database alone and cannot read records, so
            // keep it — this is what corrects the rows adopted before there
            // was any such rule, one project's worth per load (bw-p61.17).
            if let Some(who) = known["begunBy"]
                .as_str()
                .filter(|who| *who == "person" || *who == "agent")
            {
                if row["begunBy"].as_str() != Some(who) {
                    row["begunBy"] = json!(who);
                    if let Some(session_id) = row["sessionId"].as_str() {
                        state
                            .database()
                            .mark_begun_by(session_id.to_string(), who.to_string())
                            .await?;
                    }
                }
            }
            continue;
        }
        // A chat nobody is known to have begun by hand is not offered until
        // the switch asks for it, and is not adopted into the saved rows
        // either. Each discovery path used to apply the switch for itself and
        // the adapter's never did, so every review and guardian chat was
        // adopted on every load, titled, and drawn with the switch off for
        // good — 501 of them in the owner's own database by 2026-09-13. A chat
        // only the adapter names, with no record to say who began it, is not
        // a person's on a guess (bw-p61.17).
        if !everything && known["begunBy"] != "person" {
            continue;
        }
        // A provider thread whose writable rollout disappeared can remain in
        // session/list after this chat has continued on a replacement thread.
        // Its durable alias resolves to the already-drawn local row; never
        // adopt that abandoned provider ID as a second dead conversation.
        if let (Some(external_id), Some(brand)) =
            (known["externalId"].as_str(), known["brand"].as_str())
        {
            if let Some(cached) = state
                .database()
                .session_by_external_id(external_id.to_string())
                .await?
                .filter(|session| session.brand == brand)
            {
                if rows
                    .iter()
                    .any(|row| row["sessionId"].as_str() == Some(cached.id.as_str()))
                {
                    continue;
                }
            }
        }
        let durable_id = if let (Some(project_id), Some(external_id), Some(brand), Some(cwd)) = (
            query.project.as_deref(),
            known["externalId"].as_str(),
            known["brand"].as_str(),
            known["cwd"].as_str(),
        ) {
            let at = known["lastActiveAt"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            let session = Session {
                id: uuid::Uuid::new_v4().to_string(),
                brand: brand.to_string(),
                external_id: Some(external_id.to_string()),
                project_id: project_id.to_string(),
                project_path: query.path.clone().unwrap_or_else(|| cwd.to_string()),
                cwd: cwd.to_string(),
                model: None,
                permission_mode: if brand == "claude" {
                    "default"
                } else {
                    "on-request"
                }
                .into(),
                effort: None,
                collaboration_mode: None,
                profile: None,
                title: known["name"].as_str().map(str::to_string),
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: at.clone(),
                last_active_at: at,
                last_spoke_at: known["lastSpokeAt"].as_str().map(str::to_string),
                begun_by: known["begunBy"]
                    .as_str()
                    .filter(|who| *who == "person" || *who == "agent")
                    .map(str::to_string),
                named_by_owner: false,
            };
            // The rows above are only the ones this request's own listing
            // drew. A row cached by a request already in flight — the sidebar
            // asks on open, on focus and on every project switch — is not in
            // them, and creating a second one for the same chat is how one
            // terminal chat came to be drawn four times (bw-t26l.20). Ask the
            // database, which sees every request's writes, before writing.
            match state
                .database()
                .session_by_external_id(external_id.to_string())
                .await?
            {
                Some(cached) => Some(cached.id),
                None => match state.database().create_session(session.clone()).await {
                    Ok(()) => Some(session.id),
                    Err(error) => {
                        // Two of them looked in the same breath. The unique
                        // pair refuses the second write, and the row the first
                        // one made is the answer for both.
                        let raced = state
                            .database()
                            .session_by_external_id(external_id.to_string())
                            .await?
                            .map(|session| session.id);
                        if raced.is_none() {
                            tracing::warn!(%error, %external_id, "could not cache ACP-discovered session");
                        }
                        raced
                    }
                },
            }
        } else {
            None
        };
        rows.push(json!({"sessionId":durable_id,"externalId":known["externalId"],"brand":known["brand"],
            "title":known["name"],"lastActiveAt":known["lastActiveAt"],"lastSpokeAt":known["lastSpokeAt"],
            "begunBy":known["begunBy"],
            "state":"dormant","origin":"terminal","projectId":query.project,"cwdHint":known["cwd"],
            "folder":known["cwd"].as_str().and_then(folder_of),"branch":known["branch"],"beads":[],
            "runningElsewhere":held.is_some(),"held":held}));
    }
    // Whatever a row's directory came from — our own record or the provider's
    // — the worktree it is in is git's answer, not the folder's own name
    // (bw-ov7a.4). Asked once here for every row, rather than by each of the
    // three places above that sets a folder.
    let checkouts = checkouts_of(rows.iter().filter_map(|row| row["cwdHint"].as_str())).await;
    for row in &mut rows {
        let Some(checkout) = row["cwdHint"].as_str().and_then(|cwd| checkouts.get(cwd)) else {
            continue;
        };
        row["folder"] = json!(checkout.folder);
        row["branch"] = json!(checkout.branch);
    }
    // A saved Codex chat the index no longer lists is still a chat with a
    // rollout on disk, and the rollout's first line says who began it: five
    // of the owner's 144 guardian chats were placed this way and no other.
    // Bounded, because a row with no rollout anywhere is looked for on every
    // load (bw-p61.17).
    //
    // A row that could not be placed is not looked for again for a while.
    // Each look walks every account's whole sessions tree, and the same fifty
    // unplaceable rows were walked for on every load, which a write to any
    // chat triggers (bw-69sa.1).
    const PLACE_AT_MOST: usize = 50;
    const UNPLACED_FOR: Duration = Duration::from_secs(600);
    static UNPLACEABLE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, std::time::Instant>>> =
        std::sync::LazyLock::new(Default::default);
    let tried = UNPLACEABLE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let unplaced: Vec<(String, String)> = rows
        .iter()
        .filter(|row| row["brand"] == "codex" && row["begunBy"].is_null())
        .filter(|row| {
            row["sessionId"].as_str().is_none_or(|id| {
                tried.get(id).is_none_or(|at| at.elapsed() >= UNPLACED_FOR)
            })
        })
        .filter_map(|row| {
            Some((
                row["sessionId"].as_str()?.to_string(),
                row["externalId"].as_str()?.to_string(),
            ))
        })
        .take(PLACE_AT_MOST)
        .collect();
    if !unplaced.is_empty() {
        let behind = state.clone();
        let placed = tokio::task::spawn_blocking(move || {
            unplaced
                .into_iter()
                .filter_map(|(session_id, external_id)| {
                    let who = behind
                        .codex_record_anywhere(&external_id)
                        .map(|path| crate::workbench::codex::history::begun_by(&json!({ "path": path })))
                        .unwrap_or("unknown");
                    if who == "unknown" {
                        UNPLACEABLE
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(session_id, std::time::Instant::now());
                        return None;
                    }
                    Some((session_id, who))
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for (session_id, who) in placed {
            state
                .database()
                .mark_begun_by(session_id.clone(), who.to_string())
                .await?;
            if let Some(row) = rows.iter_mut().find(|row| row["sessionId"] == session_id) {
                row["begunBy"] = json!(who);
            }
        }
    }
    // A saved row the record has just placed as the agents' own leaves this
    // answer as well as the next one: its fact is now kept, so the local
    // answer drawn before any of this drops it on the load after (bw-p61.17).
    if !everything {
        rows.retain(|row| row["begunBy"] != "agent");
    }
    name_the_rows(&mut rows, query.path.as_deref());
    rows.sort_by(|a, b| restore_clock(b).cmp(restore_clock(a)));
    Ok(Json(rows))
}

async fn session(
    State(state): State<WorkbenchState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let found = state
        .database()
        .get_session(id.clone())
        .await?
        .ok_or_else(|| ApiError::not_found(format!("no session {id}")))?;
    // Asked on every open, and it used to start an adapter per provider each
    // time: the shared answer is the one the sidebar just drew from, and it is
    // only taken if it is already there (bw-550g.1).
    let known = provider_sessions_in_hand(&state, Some(&found.project_path))
        .await
        .into_iter()
        .find(|known| {
            known["brand"] == found.brand
                && found.external_id.as_ref().is_some_and(|id| {
                    known["externalId"]
                        .as_str()
                        .is_some_and(|external| external.eq_ignore_ascii_case(id))
                })
        });
    let cwd = known
        .as_ref()
        .and_then(|row| row["cwd"].as_str())
        .unwrap_or(&found.cwd)
        .to_string();
    // The worktree the chat is working in, not the folder it happens to sit
    // in: a chat in `worktrees/bw-1/server` is working in `bw-1`, on `bw-1`'s
    // branch (bw-ov7a.4). What the provider's own record says is the fallback,
    // for a directory git cannot answer for.
    let checkout = crate::routes::git::checkout_at(std::path::Path::new(&cwd)).await;
    let folder = checkout
        .as_ref()
        .map(|it| it.folder.clone())
        .or_else(|| folder_of(&cwd));
    let mut linked = state
        .database()
        .beads_for_sessions(vec![found.id.clone()])
        .await?;
    let mut beads = linked.remove(&found.id).unwrap_or_default();
    beads.extend(
        crate::workbench::beads_links::issues_for_session(
            &Default::default(),
            std::path::Path::new(&cwd),
            &found.id,
        )
        .await,
    );
    beads.sort();
    beads.dedup();
    for bead in &beads {
        let _ = state
            .database()
            .remember_bead_link(
                found.id.clone(),
                bead.clone(),
                "claim".into(),
                chrono::Utc::now().to_rfc3339(),
            )
            .await;
    }
    if state.begin_claim_sweep(std::path::Path::new(&cwd)).await {
        let sweep = state.database().clone();
        let sweep_cwd = std::path::PathBuf::from(&cwd);
        tokio::spawn(async move {
            let Ok(sessions) = sweep.list_sessions(None).await else {
                return;
            };
            let here = sessions
                .iter()
                .filter(|session| std::path::Path::new(&session.cwd) == sweep_cwd)
                .filter_map(|session| Some((session.id.as_str(), session.external_id.as_deref()?)))
                .collect::<Vec<_>>();
            if here.is_empty() {
                return;
            }
            let runner = crate::workbench::beads_links::BdRunner::default();
            let cards = crate::workbench::beads_links::claimed_cards(&runner, &sweep_cwd).await;
            let links = crate::workbench::beads_links::claimed_links(here, &cards);
            let at = chrono::Utc::now().to_rfc3339();
            for (session, beads) in links {
                for bead in beads {
                    let _ = sweep
                        .remember_bead_link(session.clone(), bead, "claim".into(), at.clone())
                        .await;
                }
            }
        });
    }
    let holds = state.provider_holds().await;
    let held = found
        .external_id
        .as_deref()
        .and_then(|id| holds.iter().find(|hold| hold.id.eq_ignore_ascii_case(id)));
    Ok(Json(json!({
        "sessionId": found.id, "origin": found.origin, "brand": found.brand,
        "externalId": found.external_id, "runningElsewhere": held.is_some(), "held": held,
        "title": known.as_ref().and_then(|row|row["name"].as_str()).map(str::to_string).or(found.title),
        "cwd": cwd, "folder": folder,
        "branch": checkout.as_ref().and_then(|it| it.branch.clone()).map(Value::from)
            .or_else(|| known.as_ref().map(|row| row["branch"].clone()))
            .unwrap_or(Value::Null),
        "beads": beads,
    })))
}

#[derive(Deserialize)]
struct HistoryQuery {
    session: String,
    before: Option<i64>,
    parent: Option<String>,
}

async fn history(
    State(state): State<WorkbenchState>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let page = if let Some(parent) = query.parent {
        state
            .database()
            .agent_transcript_items(query.session, parent, query.before, 40)
            .await?
    } else {
        let before = query
            .before
            .ok_or_else(|| ApiError::from("before is required".to_string()))?;
        state
            .database()
            .transcript_items(query.session, Some(before), 40)
            .await?
    };
    Ok(Json(
        json!({"items":page.items,"cursor":page.cursor,"hasOlder":page.has_older}),
    ))
}

#[derive(Deserialize)]
struct EventsQuery {
    session: String,
    since: Option<i64>,
}

fn event_frame(event: &Event) -> SseEvent {
    let seq = event
        .fields
        .get("seq")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    SseEvent::default()
        .id(seq.to_string())
        .json_data(event)
        .expect("canonical event serializes")
}

fn snapshot_frame(view: &Value) -> SseEvent {
    SseEvent::default()
        .id(view["lastSeq"].as_i64().unwrap_or_default().to_string())
        .event("snapshot")
        .json_data(view)
        .expect("projection serializes")
}

fn session_tail(
    receiver: broadcast::Receiver<crate::workbench::actor::SessionUpdate>,
    database: ChatDb,
    session_id: String,
    after: i64,
) -> EventStream {
    Box::pin(stream::unfold(
        (
            receiver,
            database,
            session_id,
            after,
            VecDeque::<Event>::new(),
        ),
        |(mut receiver, database, session_id, mut after, mut replay)| async move {
            loop {
                if let Some(event) = replay.pop_front() {
                    let seq = event
                        .fields
                        .get("seq")
                        .and_then(Value::as_i64)
                        .unwrap_or_default();
                    if seq <= after {
                        continue;
                    }
                    after = seq;
                    return Some((
                        Ok(event_frame(&event)),
                        (receiver, database, session_id, after, replay),
                    ));
                }
                match receiver.recv().await {
                    Ok(crate::workbench::actor::SessionUpdate::ReplayCommitted {
                        from, ..
                    }) => {
                        let Ok(events) = database
                            .events_since(session_id.clone(), after.min(from.saturating_sub(1)))
                            .await
                        else {
                            return None;
                        };
                        replay.extend(events);
                    }
                    Ok(crate::workbench::actor::SessionUpdate::Event(event)) => {
                        let seq = event
                            .fields
                            .get("seq")
                            .and_then(Value::as_i64)
                            .unwrap_or_default();
                        if seq <= after {
                            continue;
                        }
                        return Some((
                            Ok(event_frame(&event)),
                            (receiver, database, session_id, seq, replay),
                        ));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(events) = database.events_since(session_id.clone(), after).await
                        else {
                            return None;
                        };
                        replay.extend(events);
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        },
    ))
}

async fn events(
    State(state): State<WorkbenchState>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<EventStream>, ApiError> {
    // Subscribe before replay so an append racing the snapshot cannot fall in the gap.
    let receiver = state.database().subscribe_session(&query.session);
    let since = query.since.unwrap_or(0).max(0);
    let (initial, watermark) = if since == 0 {
        state.reconcile_status(&query.session).await?;
        let view = snapshot(&state, &query.session).await?;
        let watermark = view["lastSeq"].as_i64().unwrap_or_default();
        (vec![Ok(snapshot_frame(&view))], watermark)
    } else {
        let replay = state
            .database()
            .events_since(query.session.clone(), since)
            .await?;
        let watermark = replay
            .last()
            .and_then(|event| event.fields.get("seq"))
            .and_then(Value::as_i64)
            .unwrap_or(since);
        (
            replay.iter().map(|event| Ok(event_frame(event))).collect(),
            watermark,
        )
    };
    // The compatibility endpoint follows the multiplexed feed's latency
    // contract too: publish the bounded stored page first, then reconcile the
    // provider record without holding the HTTP response open.
    if since == 0 {
        let reconcile = state.clone();
        let session_id = query.session.clone();
        tokio::spawn(async move { reconcile.looked_at(&session_id).await });
    }
    let output: EventStream = Box::pin(stream::iter(initial).chain(session_tail(
        receiver,
        state.database().clone(),
        query.session,
        watermark,
    )));
    Ok(Sse::new(output).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("keep-alive"),
    ))
}

pub(crate) async fn snapshot(state: &WorkbenchState, session_id: &str) -> Result<Value, String> {
    let database = state.database();
    let snapshot = database.snapshot(session_id.to_string()).await?;
    let mut view = fold_all(&snapshot.history).view;
    // What a chat can be set to belongs to the installed provider, and it is
    // asked for when the chat's agent answers. It is never built here out of
    // what the chat is already set to.
    //
    // This used to invent one: a chat whose provider menu had not arrived got a
    // list of exactly one option, the value it was already on, labelled with
    // the wire's own spelling. So the effort chip read `high` where every other
    // chip reads `High` — the app has one place that puts a level into words
    // and an invented displayName went around it — and opening the picker
    // offered that single fabricated choice, with the provider's real levels
    // nowhere in it. It read as a menu and it was a mirror (bw-l4fr.4).
    //
    // A control with no options is deliberately absent instead. The pins
    // themselves are unaffected: they ride on `session.pinned`, the chips name
    // them through the app's own words, and the real catalog replaces nothing
    // when the agent supplies it.
    with_atelier_commands(state.database(), state.registry(), session_id, &mut view["menu"]).await?;
    view["items"] = json!(snapshot.page.items);
    view["agents"] = json!(snapshot.agents);
    view["lastSeq"] = json!(snapshot.page.newest_seq);
    view["historyCursor"] = json!(snapshot.page.cursor);
    view["hasOlder"] = json!(snapshot.page.has_older);
    // What the chat is holding is read from where it is kept rather than
    // folded out of the history, so a chat whose oldest events have scrolled
    // out of the loaded window still opens on every waiting message.
    view["held"] = json!(database.held_messages(session_id.to_string()).await?);
    Ok(view)
}

/// A chat that is not awake still lists the Atelier commands it can run.
///
/// A woken chat's own menu already carries them, from the library its
/// connection pinned. Any other chat is given the library as it stands now, in
/// place of whatever Atelier rows its last menu kept, so a slash offers the
/// same Atelier rows whether or not it has woken; the command is expanded from
/// the pinned revision when the prompt wakes it (bw-zldt.2).
async fn with_atelier_commands(
    database: &ChatDb,
    registry: &WorkbenchRegistry,
    session_id: &str,
    menu: &mut Value,
) -> Result<(), String> {
    if registry.has_driver(session_id).await {
        return Ok(());
    }
    let Some(session) = database.get_session(session_id.to_string()).await? else {
        return Ok(());
    };
    let commands = crate::workbench::store::native_commands(menu);
    // A chat with a driver is told its commands by that driver; one without,
    // whatever state it stopped in, asks for them (bw-zldt.2).
    // Until it answers, the menu says the provider's commands are on their
    // way rather than that there are none.
    if commands.is_empty() && ask_provider_for_commands(database, &session) {
        if !menu.is_object() {
            *menu = json!({});
        }
        menu["commandsPending"] = json!(true);
    }
    let root = std::path::PathBuf::from(&session.cwd);
    let shared = tokio::task::spawn_blocking(move || crate::workbench::library::commands_for(&root))
        .await
        .map_err(|error| error.to_string())?;
    with_library(menu, commands, shared);
    Ok(())
}

/// A menu's commands as the provider's own, then the library's as it stands.
fn with_library(menu: &mut Value, mut native: Vec<Value>, shared: Vec<Value>) {
    let kept = menu["commands"].as_array().map_or(0, Vec::len);
    if shared.is_empty() && kept == native.len() {
        return;
    }
    if !menu.is_object() {
        *menu = json!({});
    }
    native.extend(shared);
    menu["commands"] = Value::Array(native);
}

/// Nothing has told this app what the provider of a stopped chat can run:
/// no chat on it has spoken since the catalogue began keeping commands. Ask
/// the provider in the background, once at a time for each account, project
/// and folder; every stopped chat that asked meanwhile is given the answer. A
/// question that failed is asked again after a pause, a few times, for the
/// chats already waiting; opening a chat after that starts over (bw-zldt.2).
///
/// True while the provider is being asked for this chat.
fn ask_provider_for_commands(database: &ChatDb, session: &crate::workbench::store::Session) -> bool {
    static ASKS: std::sync::LazyLock<std::sync::Mutex<CommandAsks>> = std::sync::LazyLock::new(Default::default);
    if !matches!(session.brand.as_str(), "claude" | "codex") {
        return false;
    }
    let key = ask_key(session);
    let Ok(first) = ASKS.lock().map(|mut asks| asks.join(&key, &session.id)) else {
        return false;
    };
    if !first {
        return true;
    }
    let (database, session) = (database.clone(), session.clone());
    tokio::spawn(async move {
        let asked = session.clone();
        let (answer, waiting) = ask_until_answered(&ASKS, &key, CommandAsks::RETRY_AFTER, move || {
            let session = asked.clone();
            async move {
                let answer = crate::workbench::acp::client::ask_provider_catalogue(&session).await;
                if let Err(error) = &answer {
                    tracing::warn!(session_id = %session.id, %error, "could not ask the provider for its commands");
                }
                answer
            }
        })
        .await;
        let Some((menu, shared)) = answer else {
            let root = std::path::PathBuf::from(&session.cwd);
            let shared = tokio::task::spawn_blocking(move || crate::workbench::library::commands_for(&root))
                .await
                .unwrap_or_default();
            for session_id in waiting {
                if let Err(error) = database.settle_menu(session_id.clone(), shared.clone()).await {
                    tracing::warn!(%session_id, %error, "could not settle a stopped chat's menu");
                }
            }
            return;
        };
        for session_id in waiting {
            if let Err(error) = crate::workbench::acp::client::offer_provider_catalogue(
                &database,
                &session_id,
                menu.clone(),
                shared.clone(),
            )
            .await
            {
                tracing::warn!(%session_id, %error, "could not offer a stopped chat its provider's commands");
            }
        }
    });
    true
}

/// Which chats one answer serves. The folder is part of the question: the
/// provider reads its project commands, and Atelier its library, from there,
/// so every chat waiting on one answer is in the folder it was asked from.
fn ask_key(session: &crate::workbench::store::Session) -> String {
    [session.brand.as_str(), session.profile.as_deref().unwrap_or_default(), &session.project_path, &session.cwd]
        .join("\u{0}")
}

/// Asks until an answer comes or the tries run out, pausing longer after each
/// failure, and returns the answer with every chat that waited for it.
async fn ask_until_answered<T, E, F, Fut>(
    asks: &std::sync::Mutex<CommandAsks>,
    key: &str,
    pause: Duration,
    mut ask: F,
) -> (Option<T>, Vec<String>)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut answer = None;
    for attempt in 0..CommandAsks::TRIES {
        if let Ok(answered) = ask().await {
            answer = Some(answered);
            break;
        }
        if attempt + 1 < CommandAsks::TRIES {
            tokio::time::sleep(pause * 2u32.pow(attempt)).await;
        }
    }
    let waiting = asks
        .lock()
        .map(|mut asks| asks.finish(key))
        .unwrap_or_default();
    (answer, waiting)
}

/// Which providers are being asked for their commands, and by which chats.
/// Once answered, the catalogue holds the commands and nothing asks again; a
/// catalogue that lost them is asked for anew.
#[derive(Default)]
struct CommandAsks {
    waiting: HashMap<String, Vec<String>>,
}

impl CommandAsks {
    const RETRY_AFTER: Duration = Duration::from_secs(60);
    const TRIES: u32 = 5;

    /// Adds a chat to the question for `key`; true when it must be asked now.
    fn join(&mut self, key: &str, session_id: &str) -> bool {
        if let Some(waiting) = self.waiting.get_mut(key) {
            if !waiting.iter().any(|id| id == session_id) {
                waiting.push(session_id.to_string());
            }
            return false;
        }
        self.waiting.insert(key.to_string(), vec![session_id.to_string()]);
        true
    }

    /// Ends the question for `key` and returns the chats that were waiting.
    fn finish(&mut self, key: &str) -> Vec<String> {
        self.waiting.remove(key).unwrap_or_default()
    }
}

#[cfg(test)]
mod command_asks_tests {
    use super::{ask_until_answered, with_library, CommandAsks};
    use serde_json::json;

    #[test]
    fn chats_in_other_folders_of_one_project_are_asked_for_apart() {
        let chat = |cwd: &str| crate::workbench::store::Session {
            id: cwd.into(), brand: "claude".into(), external_id: None,
            project_id: "p".into(), project_path: "/repo".into(), cwd: cwd.into(),
            model: None, permission_mode: "default".into(), effort: None,
            collaboration_mode: None, profile: None, title: None, state: "dormant".into(),
            origin: "app".into(), created_at: "now".into(), last_active_at: "now".into(),
            last_spoke_at: None, begun_by: None, named_by_owner: false,
        };
        assert_eq!(super::ask_key(&chat("/repo")), super::ask_key(&chat("/repo")));
        assert_ne!(super::ask_key(&chat("/repo")), super::ask_key(&chat("/repo/worktrees/a")));
    }

    #[test]
    fn a_chat_without_a_driver_lists_the_library_as_it_stands() {
        let mut menu = json!({"models":[], "commands":[
            {"name":"compact"},
            {"name":"skill:removed","execution":"shared"},
        ]});
        let native = crate::workbench::store::native_commands(&menu);
        with_library(&mut menu, native, vec![json!({"name":"skill:added","execution":"shared"})]);
        assert_eq!(menu["commands"], json!([{"name":"compact"},{"name":"skill:added","execution":"shared"}]));

        let native = crate::workbench::store::native_commands(&menu);
        with_library(&mut menu, native, vec![]);
        assert_eq!(menu["commands"], json!([{"name":"compact"}]), "a removed command is not listed");

        let mut nothing = serde_json::Value::Null;
        with_library(&mut nothing, vec![], vec![]);
        assert!(nothing.is_null(), "a chat with no menu is not given an empty one");
    }
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[test]
    fn every_chat_that_asked_meanwhile_is_given_the_answer() {
        let mut asks = CommandAsks::default();
        assert!(asks.join("claude", "one"));
        assert!(!asks.join("claude", "two"));
        assert!(!asks.join("claude", "two"));
        assert!(asks.join("codex", "three"));
        assert_eq!(asks.finish("claude"), ["one", "two"]);
        assert!(asks.join("claude", "four"), "a catalogue that lost its commands is asked for anew");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_question_is_asked_again_for_the_chats_already_waiting() {
        let asks = Arc::new(Mutex::new(CommandAsks::default()));
        assert!(asks.lock().unwrap().join("claude", "open"));
        let tries = Arc::new(AtomicU32::new(0));
        let counted = tries.clone();
        let asking = {
            let asks = asks.clone();
            tokio::spawn(async move {
                ask_until_answered(&asks, "claude", Duration::from_secs(60), move || {
                    let tries = counted.clone();
                    async move {
                        match tries.fetch_add(1, Ordering::SeqCst) {
                            0 | 1 => Err("adapter did not answer"),
                            _ => Ok("menu"),
                        }
                    }
                })
                .await
            })
        };
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(tries.load(Ordering::SeqCst), 1);
        assert!(!asks.lock().unwrap().join("claude", "opened-while-waiting"));
        let (answer, waiting) = asking.await.unwrap();
        assert_eq!(answer, Some("menu"));
        assert_eq!(tries.load(Ordering::SeqCst), 3);
        assert_eq!(waiting, ["open", "opened-while-waiting"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_question_that_keeps_failing_stops_and_the_next_chat_starts_over() {
        let asks = Mutex::new(CommandAsks::default());
        assert!(asks.lock().unwrap().join("claude", "open"));
        let (answer, waiting) =
            ask_until_answered(&asks, "claude", Duration::from_secs(60), || async { Err::<(), _>("no") }).await;
        assert_eq!(answer, None);
        assert_eq!(waiting, ["open"]);
        assert!(asks.lock().unwrap().join("claude", "open"));
    }
}

async fn command(
    State(state): State<WorkbenchState>,
    Json(command): Json<Command>,
) -> Result<Json<Value>, ApiError> {
    use crate::workbench::protocol::CommandKind;
    // A prompt to a saved chat attaches a driver on the way; one to a chat
    // already driven does not, and need not pay for a reading.
    let attaches = match command.kind {
        CommandKind::SessionStart | CommandKind::SessionResume => true,
        CommandKind::PromptSend => match command.fields.get("sessionId").and_then(Value::as_str) {
            Some(id) => !state.registry.has_driver(id).await,
            None => false,
        },
        _ => false,
    };
    let reply = state.registry.execute(&command).await?;
    if attaches {
        // Before the reply: the browser opens the chat on the reply, and the
        // hold set it opens it against must already say the chat is ours.
        state.publish_holds().await;
    }
    Ok(Json(reply))
}

#[derive(Deserialize)]
struct UploadedRequest {
    args: Vec<String>,
    #[serde(default)]
    stdin: String,
    #[serde(default)]
    files: BTreeMap<String, String>,
    #[serde(default)]
    ephemeral: bool,
}

fn presentation_directory(
    state: &WorkbenchState,
    ephemeral: bool,
) -> Result<std::path::PathBuf, String> {
    if ephemeral {
        Ok(state.registry.media_directory().to_path_buf())
    } else {
        crate::identity::durable_presentation_media_dir()
            .ok_or_else(|| "Durable presentation storage is unavailable".to_string())
    }
}

fn decoded(files: BTreeMap<String, String>) -> Result<BTreeMap<String, Vec<u8>>, String> {
    files
        .into_iter()
        .map(|(path, encoded)| {
            let label = path.clone();
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map(|bytes| (path, bytes))
                .map_err(|error| format!("{label}: {error}"))
        })
        .collect()
}

/// One file the owner attached, on its way to being a name instead of bytes.
#[derive(Deserialize)]
struct AttachmentRequest {
    /// What the file is called, which is all the extension is read off.
    name: String,
    /// Its bytes, base64'd — the one way a browser can hand them over in JSON.
    data: String,
}

/// POST /api/workbench/attachment
///
/// Keeps an attached file in the same content-addressed store the app's own
/// presentation media lives in, and answers with the name it was kept under.
/// From here on the message carries that name: the bytes are fetched back
/// through `GET /api/presentation-assets/:asset` by whoever needs to draw
/// them, and the agent is handed the file's own path (bw-oamr.5).
async fn attachment(
    State(state): State<WorkbenchState>,
    Json(request): Json<AttachmentRequest>,
) -> Result<Json<Value>, ApiError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.data.as_bytes())
        .map_err(|error| format!("{}: {error}", request.name))?;
    let directory = state.registry.media_directory().to_path_buf();
    let size = bytes.len();
    let asset = crate::workbench::media::import_attachment(&bytes, &request.name, &directory)?;
    let path = directory.join(&asset);
    Ok(Json(json!({
        "asset": asset,
        "size": size,
        "path": path.to_string_lossy(),
    })))
}

async fn present(
    State(state): State<WorkbenchState>,
    Json(request): Json<UploadedRequest>,
) -> Result<Json<Value>, ApiError> {
    let files = decoded(request.files)?;
    let media = presentation_directory(&state, request.ephemeral)?;
    Ok(Json(
        json!({"output":state.registry.present(&request.args, &request.stdin, &files, &media)?}),
    ))
}

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|word| word == name)
        .and_then(|at| args.get(at + 1))
        .map(String::as_str)
}

async fn screen_check(
    State(state): State<WorkbenchState>,
    Json(request): Json<UploadedRequest>,
) -> Result<Json<Value>, ApiError> {
    let files = decoded(request.files)?;
    let media = presentation_directory(&state, request.ephemeral)?;
    let action = request.args.first().map(String::as_str).unwrap_or("help");
    if matches!(action, "help" | "--help" | "-h") {
        return Ok(Json(
            json!({"result":{"help":"atelier tool screen-check windows|capture|check|compare"}}),
        ));
    }
    if action == "--schema" {
        return Ok(Json(
            json!({"result":{"schema":{"actions":["windows","capture","check","compare"],"capture_types":["web","window","image"]}}}),
        ));
    }
    if action == "windows" {
        let windows = crate::workbench::screen_check::native_windows()?;
        return Ok(Json(
            json!({"result":{"windows":windows,"safeguards":["explicit ID required","two matching frames required","no whole-display fallback"]}}),
        ));
    }

    let mut captures = Vec::new();
    if action == "compare" {
        let before =
            option(&request.args, "--before").ok_or_else(|| "--before is required".to_string())?;
        let after =
            option(&request.args, "--after").ok_or_else(|| "--after is required".to_string())?;
        let before_bytes = files
            .get(before)
            .ok_or_else(|| format!("no upload for {before}"))?;
        let after_bytes = files
            .get(after)
            .ok_or_else(|| format!("no upload for {after}"))?;
        let before_stored =
            state
                .registry
                .store_capture(before_bytes, "Before", "image", &media)?;
        let after_stored = state
            .registry
            .store_capture(after_bytes, "After", "image", &media)?;
        let comparison = state
            .registry
            .compare_captures(before_bytes, after_bytes, &media)?;
        captures.push(
            json!({"asset":before_stored.asset,"label":"Before","evidence":before_stored.evidence}),
        );
        captures.push(
            json!({"asset":after_stored.asset,"label":"After","evidence":after_stored.evidence}),
        );
        return Ok(Json(
            json!({"result":{"check_id":format!("check_{}_{}", before_stored.asset.chars().take(12).collect::<String>(), after_stored.asset.chars().take(12).collect::<String>()),"captures":captures,"comparison":comparison.objective,"diff_asset":comparison.diff_asset,"verdict":"INDETERMINATE"}}),
        ));
    }

    let stored = if let Some(recipe) = option(&request.args, "--recipe") {
        let bytes = files
            .get(recipe)
            .ok_or_else(|| format!("no upload for {recipe}"))?;
        let recipe = crate::workbench::browser::parse_recipe(bytes)?;
        let capture = state.registry.capture_browser(&recipe, &files).await?;
        state
            .registry
            .store_capture(&capture.bytes, "Browser capture", "browser", &media)?
    } else if let Some(window_id) = option(&request.args, "--window-id") {
        let stable_ms = option(&request.args, "--stable-ms")
            .and_then(|value| value.parse().ok())
            .unwrap_or(200);
        let retries = option(&request.args, "--stable-retries")
            .and_then(|value| value.parse().ok())
            .unwrap_or(5);
        let mut source = crate::workbench::screen_check::NativeWindowSource;
        let (bytes, _, _) = crate::workbench::screen_check::stable_window_capture(
            &mut source,
            window_id,
            Duration::from_millis(stable_ms),
            retries,
        )
        .await?;
        state
            .registry
            .store_capture(&bytes, "Window capture", "window", &media)?
    } else {
        let target = option(&request.args, "--target")
            .ok_or_else(|| "--target, --window-id or --recipe is required".to_string())?;
        let bytes = files
            .get(target)
            .ok_or_else(|| format!("no upload for {target}"))?;
        state
            .registry
            .store_capture(bytes, "Image capture", "image", &media)?
    };
    captures.push(json!({"asset":stored.asset,"label":"Capture","evidence":stored.evidence}));
    Ok(Json(
        json!({"result":{"check_id":format!("check_{}", stored.asset.chars().take(12).collect::<String>()),"captures":captures,"verdict":if action == "capture" { Value::Null } else { json!("INDETERMINATE") }}}),
    ))
}

struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn unavailable(message: String) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message,
        }
    }

    fn not_found(message: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message,
        }
    }
}
impl From<String> for ApiError {
    fn from(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response<Body> {
        (self.status, Json(json!({"error":self.message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::{
        protocol::Event,
        registry::{RegistryPaths, UnavailableFactory},
        store::Session,
    };
    use axum::body::Body;
    use futures::StreamExt;
    use serde_json::json;
    use tower::ServiceExt;

    fn fixture() -> (tempfile::TempDir, WorkbenchState) {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let paths = RegistryPaths {
            home: directory.path().to_path_buf(),
            claude_config: directory.path().join("claude"),
            codex_home: directory.path().join("codex"),
            profiles: directory.path().join("profiles"),
            media: directory.path().join("media"),
        };
        let registry = WorkbenchRegistry::new(database, paths, Arc::new(UnavailableFactory));
        (directory, WorkbenchState::new(registry))
    }

    /// The same fixture with a project list behind it, which is what naming a
    /// chat's project needs.
    fn fixture_with_projects() -> (tempfile::TempDir, WorkbenchState, Arc<crate::db::Database>) {
        let (directory, state) = fixture();
        let projects = Arc::new(crate::db::Database::new_in_memory().unwrap());
        (directory, state.with_projects(Arc::clone(&projects)), projects)
    }

    fn a_project(projects: &crate::db::Database, name: &str) -> String {
        projects
            .create_project(crate::db::CreateProjectInput {
                name: name.to_string(),
                path: format!("/work/{name}"),
                local_path: None,
                is_test: false,
            })
            .unwrap()
            .id
    }

    /// A chat in a state that stays put.
    ///
    /// Only `errored`, `idle` and `stopped` are safe to build a case on here.
    /// The registry sweeps every ACTIVE state every five seconds and puts any
    /// chat with no driver attached to sleep — right for the app, and fatal for
    /// a fixture, because `waiting_permission` silently became `dormant`
    /// part-way through a case and the row under test stopped being worth
    /// announcing. What those states MEAN is proved in `workbench::notice`,
    /// where no clock can reach it.
    fn a_chat(id: &str, project_id: &str, state: &str) -> Session {
        Session {
            id: id.into(),
            project_id: project_id.into(),
            state: state.into(),
            title: Some(format!("Chat {id}")),
            // One chat per row, each its own: the saved fixture carries a
            // provider id, and a brand may only claim one of those once.
            external_id: None,
            ..saved_session()
        }
    }

    async fn asked_for_notifications(state: WorkbenchState, query: &str) -> Vec<Value> {
        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri(format!("/notifications{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    /// The tray is told what to draw, rather than working it out.
    ///
    /// Chats wanting an answer come above chats merely finished, and each row
    /// arrives already carrying the name of its project — the join the page
    /// used to attempt for itself, against a list it fetched separately.
    #[tokio::test]
    async fn the_server_says_which_chats_are_worth_a_row_and_names_their_project() {
        let (_directory, state, projects) = fixture_with_projects();
        let project = a_project(&projects, "Keystone");
        for chat in [
            a_chat("finished", &project, "idle"),
            a_chat("asking", &project, "errored"),
            // Working is not news: nothing is waiting on the owner yet.
            a_chat("busy", &project, "streaming"),
        ] {
            state.database().create_session(chat).await.unwrap();
        }

        let rows = asked_for_notifications(state, "").await;

        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["asking", "finished"], "a chat merely working was announced, or the order was wrong");
        assert_eq!(rows[0]["needsAction"], true);
        assert_eq!(rows[0]["says"], "it stopped with an error");
        assert_eq!(rows[0]["projectName"], "Keystone");
        assert_eq!(rows[1]["needsAction"], false);
        assert_eq!(rows[1]["says"], "Ready to read");
        assert_eq!(rows[1]["projectName"], "Keystone");
    }

    /// The rows the owner complained about: chats pointing at a project that
    /// is not there any more.
    ///
    /// They drew as "Unknown project" and never went away, because nothing
    /// deletes a chat when its project goes and the page had no way to tell the
    /// difference between a name it had not fetched yet and a name that does
    /// not exist (bw-altj). A project the owner has archived counts the same:
    /// he has said he is not working there.
    #[tokio::test]
    async fn a_chat_whose_project_is_gone_or_put_away_is_never_announced() {
        let (_directory, state, projects) = fixture_with_projects();
        let live = a_project(&projects, "Keystone");
        let deleted = a_project(&projects, "Gone");
        let archived = a_project(&projects, "Put away");
        projects.delete_project(&deleted).unwrap();
        projects.archive_project(&archived).unwrap();

        for (id, project) in [("kept", &live), ("orphan", &deleted), ("shelved", &archived)] {
            state
                .database()
                .create_session(a_chat(id, project, "errored"))
                .await
                .unwrap();
        }

        let rows = asked_for_notifications(state, "").await;

        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["kept"], "a chat with no project to name was announced anyway");
        assert!(
            rows.iter().all(|r| r["projectName"].as_str().is_some_and(|n| !n.is_empty())),
            "a row arrived without a project name"
        );
    }

    /// What the owner has already read is not said to him again — but only for
    /// as long as the chat has nothing new to say.
    ///
    /// The comparison is against the state the chat was READ in, never the id
    /// alone: a chat dismissed while it wanted permission has to come back the
    /// moment it stops with an error, or clearing once would silence it for
    /// good. It also has to be the reading that counts and not the announcing,
    /// which is why the two are separate columns (bw-altj.1).
    #[tokio::test]
    async fn a_chat_read_in_the_state_it_is_still_in_is_not_announced_again() {
        let (_directory, state, projects) = fixture_with_projects();
        let project = a_project(&projects, "Keystone");
        for chat in [
            a_chat("read-and-unchanged", &project, "errored"),
            a_chat("read-but-moved-on", &project, "stopped"),
            a_chat("only-announced", &project, "errored"),
        ] {
            state.database().create_session(chat).await.unwrap();
        }
        state
            .database()
            .mark_read(
                vec![
                    ("read-and-unchanged".to_string(), "errored".to_string()),
                    // Read back when it was still working; it has since stopped,
                    // which is a new thing to say about a chat already read.
                    ("read-but-moved-on".to_string(), "idle".to_string()),
                ],
                "2026-09-22T00:00:00Z".to_string(),
            )
            .await
            .unwrap();
        // Telling a phone about a chat is not the owner having read it.
        state
            .database()
            .mark_announced(
                "only-announced".to_string(),
                "errored".to_string(),
                "2026-09-22T00:00:00Z".to_string(),
            )
            .await
            .unwrap();

        let rows = asked_for_notifications(state, "").await;

        let mut ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            ["only-announced", "read-but-moved-on"],
            "the wrong chats were announced: a chat already read came back, or one with something new to say was swallowed"
        );
    }

    async fn cleared(state: WorkbenchState, chats: Value) -> StatusCode {
        router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method(axum::http::Method::POST)
                    .uri("/notifications/read")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"chats": chats}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    /// Clearing the tray goes to the server, and sticks.
    ///
    /// The whole round trip the browser used to do by itself in its own
    /// storage: press clear, and the rows are gone from what the server offers
    /// — to this browser and to every other one, and to the next tab this
    /// phone builds after it throws the current one away (bw-altj).
    #[tokio::test]
    async fn clearing_the_tray_is_remembered_and_lasts_until_the_chat_moves_on() {
        let (_directory, state, projects) = fixture_with_projects();
        let project = a_project(&projects, "Keystone");
        for chat in [
            a_chat("asking", &project, "errored"),
            a_chat("finished", &project, "idle"),
        ] {
            state.database().create_session(chat).await.unwrap();
        }
        assert_eq!(asked_for_notifications(state.clone(), "").await.len(), 2);

        let answer = cleared(
            state.clone(),
            json!([
                {"id": "asking", "state": "errored"},
                {"id": "finished", "state": "idle"}
            ]),
        )
        .await;
        assert_eq!(answer, StatusCode::NO_CONTENT);

        assert!(
            asked_for_notifications(state.clone(), "").await.is_empty(),
            "a cleared tray still had something to say"
        );

        // The chat that had stopped with an error has since been stopped
        // outright. That is a new thing to say about a chat already read, so it
        // comes back — clearing means "I have read this, as it stands", never
        // "never mention this chat again".
        state
            .database()
            .update_session(
                "asking".to_string(),
                crate::workbench::store::SessionPatch {
                    state: Some("stopped".to_string()),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();

        let rows = asked_for_notifications(state, "").await;
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(
            ids, ["asking"],
            "a cleared chat did not come back when it went on to say something else"
        );
    }

    /// A chat nobody ever named is still called something — and called the
    /// same thing in the tray and on the rail.
    ///
    /// `?? 'Untitled chat'` was written into six screens separately, so what a
    /// nameless chat was called was whatever the screen drawing it happened to
    /// say. In the tray it was the whole row: "Untitled chat", a project, and a
    /// line about an error, naming nothing the owner could act on (bw-altj.7).
    /// Both lists are the server's answers now, so this takes one chat with no
    /// title and holds the two answers against each other.
    #[tokio::test]
    async fn a_chat_with_no_title_is_named_the_same_in_the_tray_and_on_the_rail() {
        let (_directory, state, projects) = fixture_with_projects();
        let project = a_project(&projects, "Keystone");
        let nameless = Session {
            title: None,
            // A worktree of the project, which is where this app's own chats
            // mostly work, and what tells two nameless chats apart.
            cwd: "/work/Keystone/worktrees/bw-altj".into(),
            ..a_chat("nameless", &project, "errored")
        };
        state
            .database()
            .create_session(nameless.clone())
            .await
            .unwrap();

        let tray = asked_for_notifications(state.clone(), "").await;
        let row = tray
            .iter()
            .find(|row| row["id"] == "nameless")
            .expect("the tray had nothing to say about a chat that stopped with an error");

        // The rail's row for the same chat, named the way every restore answer
        // names one.
        let mut listed = vec![restore_row(nameless, Vec::new(), &[], &HashMap::new())];
        name_the_rows(&mut listed, None);

        assert_eq!(
            row["name"], listed[0]["name"],
            "the tray and the rail called the same nameless chat different things"
        );
        assert_eq!(
            row["name"], "bw-altj",
            "a chat with no title was not named by the folder it is working in"
        );
    }

    /// A test project's chats are not the owner's news either, on the same
    /// terms the project list itself hides them.
    #[tokio::test]
    async fn a_test_projects_chats_are_announced_only_when_asked_for() {
        let (_directory, state, projects) = fixture_with_projects();
        let fixture_project = projects
            .create_project(crate::db::CreateProjectInput {
                name: "e2e".into(),
                path: "/work/e2e".into(),
                local_path: None,
                is_test: true,
            })
            .unwrap()
            .id;
        state
            .database()
            .create_session(a_chat("in-a-fixture", &fixture_project, "errored"))
            .await
            .unwrap();

        assert!(
            asked_for_notifications(state.clone(), "").await.is_empty(),
            "a test fixture's chat reached the owner's tray"
        );
        assert_eq!(
            asked_for_notifications(state, "?include_test=true").await.len(),
            1,
            "a case that asked for test projects was refused them"
        );
    }

    /// Deleting a project takes its chats' notices with it, and stops the
    /// chats themselves streaming into a screen nobody can open.
    ///
    /// The chats stay. The button that deletes a project says in so many words
    /// that its cards and files are not touched, and a transcript is the
    /// owner's work rather than the list's. What goes is everything that only
    /// made sense while the project existed.
    #[tokio::test]
    async fn deleting_a_project_leaves_nothing_of_its_chats_to_announce() {
        let (_directory, state, projects) = fixture_with_projects();
        let project = a_project(&projects, "keystone");
        let other = a_project(&projects, "still-here");
        for (id, project_id, chat_state) in [
            ("asking", &project, "errored"),
            ("finished", &project, "idle"),
            ("elsewhere", &other, "errored"),
        ] {
            state
                .database()
                .create_session(a_chat(id, project_id, chat_state))
                .await
                .unwrap();
        }
        // Something has been said about one of them, so there is a notice row
        // to be left behind if nothing removes it.
        state
            .database()
            .mark_announced("asking".into(), "errored".into(), "2026-01-01T00:00:00Z".into())
            .await
            .unwrap();
        assert_eq!(asked_for_notifications(state.clone(), "").await.len(), 3);

        // Through the handler the browser actually calls, so the order it does
        // its two jobs in is what is under test as much as either job.
        let deleted = crate::routes::projects::delete_project(
            axum::extract::State(Arc::clone(&projects)),
            Some(axum::Extension(state.clone())),
            axum::extract::Path(project.clone()),
        )
        .await
        .map_err(|(status, _)| status)
        .expect("the project should delete");
        assert_eq!(deleted, StatusCode::NO_CONTENT);

        let left = asked_for_notifications(state.clone(), "").await;
        let ids: Vec<&str> = left.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(
            ids, ["elsewhere"],
            "a deleted project's chats were still being announced"
        );

        assert!(
            state.database().notices().await.unwrap().is_empty(),
            "a deleted project left behind a record of what had been said about its chats"
        );

        // Asleep, so nothing keeps streaming state at a screen that cannot be
        // reached — and still there, because the delete promised as much.
        for id in ["asking", "finished"] {
            let session = state
                .database()
                .get_session(id.to_string())
                .await
                .unwrap()
                .expect("a deleted project must not take its chats' transcripts");
            assert_eq!(session.state, "dormant", "{id} was left awake");
        }
        assert_eq!(
            state.database().get_session("elsewhere".into()).await.unwrap().unwrap().state,
            "errored",
            "a chat in another project was put to sleep by an unrelated deletion"
        );
    }

    fn saved_session() -> Session {
        Session {
            id: "chat-1".into(),
            brand: "codex".into(),
            external_id: Some("thread-1".into()),
            project_id: "project-1".into(),
            project_path: "/work/project".into(),
            cwd: "/work/project/tree".into(),
            model: Some("gpt-5".into()),
            permission_mode: "default".into(),
            effort: Some("high".into()),
            collaboration_mode: None,
            profile: None,
            title: Some("The chat that must remain visible".into()),
            state: "dormant".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00.000Z".into(),
            last_active_at: "2026-08-30T00:01:00.000Z".into(),
            last_spoke_at: Some("2026-08-30T00:00:30.000Z".into()),
            begun_by: None,
            named_by_owner: false,
        }
    }

    /**
     * A chat somebody else is working in is read whether or not it is open.
     *
     * The lease is what is asserted, because the lease is the decision: while
     * this task holds one the follower cannot retire, and the reader's own
     * lease on the same chat is counted separately from it (bw-t26l.20).
     */
    #[tokio::test]
    async fn native_workbench_keeps_reading_a_chat_somebody_else_is_working_in() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let working = crate::workbench::external::ProviderHold {
            id: "thread-1".into(),
            holder: crate::workbench::external::Holder::Terminal,
            doing: crate::workbench::external::HeldDoing::Working,
            detail: None,
            told: false,
            since: None,
            turn_since: None,
            typical_ms: None,
            pids: Default::default(),
        };
        let mut followed = HashMap::new();
        state
            .keep_following_the_worked_in(&[working.clone()], &mut followed)
            .await;
        assert_eq!(followed.keys().collect::<Vec<_>>(), vec!["chat-1"]);

        // Asking again while the same chat is still being worked in does not
        // start a second reading of it.
        state
            .keep_following_the_worked_in(&[working], &mut followed)
            .await;
        assert_eq!(followed.len(), 1);

        // And a chat nobody is working in any more is let go.
        state.keep_following_the_worked_in(&[], &mut followed).await;
        assert!(followed.is_empty());

        // A chat with no row of ours is not followed: there is nowhere to put
        // what it says.
        let stranger = crate::workbench::external::ProviderHold {
            id: "thread-nobody-knows".into(),
            holder: crate::workbench::external::Holder::Terminal,
            doing: crate::workbench::external::HeldDoing::Working,
            detail: None,
            told: false,
            since: None,
            turn_since: None,
            typical_ms: None,
            pids: Default::default(),
        };
        state
            .keep_following_the_worked_in(&[stranger], &mut followed)
            .await;
        assert!(followed.is_empty());
    }

    #[tokio::test]
    async fn external_claim_sweep_is_once_per_project_window() {
        let (_directory, state) = fixture();
        let first = std::path::Path::new("/work/project");
        let second = std::path::Path::new("/work/another");

        assert!(state.begin_claim_sweep(first).await);
        assert!(!state.begin_claim_sweep(first).await);
        assert!(state.begin_claim_sweep(second).await);
    }

    /// An allowance belongs to a login, so both the cache and the in-flight
    /// refresh are keyed by the account and not only by the brand.
    ///
    /// Before this, one reading per brand was taken and handed to every chat:
    /// a chat on the work account drew the owner's own remaining hours, and
    /// the first reading taken kept the second from ever being asked for
    /// thirty seconds (bw-5ihw.8).
    #[test]
    fn an_allowance_is_filed_under_the_account_that_holds_it() {
        assert_eq!(usage_key("claude", "system"), "claude/system");
        assert_ne!(
            usage_key("claude", "system"),
            usage_key("claude", "work"),
            "two accounts of one brand must not share a reading"
        );
        assert_ne!(
            usage_key("claude", "work"),
            usage_key("codex", "work"),
            "two brands must not share a reading"
        );
    }

    #[tokio::test]
    async fn usage_single_flights_are_shared_per_provider_not_across_providers() {
        let (_directory, state) = fixture();
        let claude = state.usage_refresh(&usage_key("claude", "system")).await;
        let same_claude = state.usage_refresh(&usage_key("claude", "system")).await;
        let codex = state.usage_refresh(&usage_key("codex", "system")).await;
        // And one account of a brand never waits behind another's.
        let work = state.usage_refresh(&usage_key("claude", "work")).await;
        assert!(!Arc::ptr_eq(&claude, &work));

        assert!(Arc::ptr_eq(&claude, &same_claude));
        assert!(!Arc::ptr_eq(&claude, &codex));
        let _claude_guard = claude.lock().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), codex.lock())
                .await
                .is_ok()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), same_claude.lock())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn every_browser_shares_one_poller_and_the_last_one_stops_it() {
        let (_directory, state) = fixture();
        {
            let mut cache = state.usage_cache.lock().await;
            for brand in ["claude", "codex"] {
                cache.insert(
                    usage_key(brand, crate::workbench::profiles::SYSTEM),
                    (std::time::Instant::now(), json!({"at":"now"})),
                );
            }
        }

        let (_first_rx, first) = state.watch_poll_subscription().await;
        let first_task = state.watch_pollers.lock().await.as_ref().unwrap().id();
        let (_second_rx, second) = state.watch_poll_subscription().await;
        let second_task = state.watch_pollers.lock().await.as_ref().unwrap().id();
        assert_eq!(first_task, second_task);
        assert_eq!(state.watch_poll_subscribers.load(Ordering::Acquire), 2);

        drop(first);
        assert_eq!(state.watch_poll_subscribers.load(Ordering::Acquire), 1);
        drop(second);
        tokio::time::timeout(Duration::from_millis(250), async {
            loop {
                if state
                    .watch_pollers
                    .lock()
                    .await
                    .as_ref()
                    .is_some_and(|task| task.is_finished())
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the shared poller outlived its last browser");
    }

    #[tokio::test]
    async fn a_page_joining_the_poller_hears_codex_at_once_even_while_claude_is_slow() {
        let (_directory, state) = fixture();
        state.usage_cache.lock().await.insert(
            usage_key("codex", crate::workbench::profiles::SYSTEM),
            (std::time::Instant::now(), json!({"brand":"codex"})),
        );
        // Claude's reading is stuck mid-request: nothing cached, lock held.
        let claude = state
            .usage_refresh(&usage_key("claude", crate::workbench::profiles::SYSTEM))
            .await;
        let _claude_busy = claude.lock().await;

        async fn codex(receiver: &mut broadcast::Receiver<Value>) -> Value {
            loop {
                let frame = receiver.recv().await.unwrap();
                if frame["kind"] == "usage" && frame["brand"] == "codex" {
                    return frame;
                }
            }
        }
        let (mut first_rx, _first) = state.watch_poll_subscription().await;
        tokio::time::timeout(Duration::from_millis(500), codex(&mut first_rx))
            .await
            .expect("the first beat waited for Claude before sending Codex");
        // A second page joins the running poller between beats, and must not
        // wait up to half a minute for the next one (bw-kde0.1).
        let (mut second_rx, _second) = state.watch_poll_subscription().await;
        let frame = tokio::time::timeout(Duration::from_millis(500), codex(&mut second_rx))
            .await
            .expect("a joining page heard nothing until the next beat");
        assert_eq!(frame["profile"], crate::workbench::profiles::SYSTEM);
        assert_eq!(frame["usage"]["brand"], "codex");
    }

    #[tokio::test]
    async fn every_viewer_shares_one_chat_follower_until_the_last_leaves() {
        let (_directory, state) = fixture();
        let (first, started) = state.chat_follow_subscription("chat-1").await;
        let control = started.expect("the first viewer starts the follower");
        let (second, started_again) = state.chat_follow_subscription("chat-1").await;
        assert!(started_again.is_none());
        assert_eq!(control.viewers.load(Ordering::Acquire), 2);

        drop(first);
        assert_eq!(control.viewers.load(Ordering::Acquire), 1);
        drop(second);
        tokio::time::timeout(Duration::from_millis(50), control.stopped())
            .await
            .expect("the last viewer wakes the one shared follower");
        state.finish_chat_follow("chat-1", &control).await;
        assert!(!state.chat_followers.lock().await.contains_key("chat-1"));
    }

    #[tokio::test]
    async fn shared_poller_broadcasts_one_external_record_change_to_every_browser() {
        let (directory, state) = fixture();
        let project = directory.path().join("claude/projects/-work-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(directory.path().join("codex/sessions")).unwrap();
        {
            let mut cache = state.usage_cache.lock().await;
            for brand in ["claude", "codex"] {
                cache.insert(
                    usage_key(brand, crate::workbench::profiles::SYSTEM),
                    (std::time::Instant::now(), json!({"brand":brand})),
                );
            }
        }

        let (mut first_rx, first) = state.watch_poll_subscription().await;
        let (mut second_rx, second) = state.watch_poll_subscription().await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(
            project.join("session.jsonl"),
            "{\"type\":\"meta\",\"cwd\":\"/work/project\"}\n",
        )
        .unwrap();

        async fn outside(receiver: &mut broadcast::Receiver<Value>) -> Value {
            loop {
                let frame = receiver.recv().await.unwrap();
                if frame["kind"] == "outside" {
                    return frame;
                }
            }
        }
        let (first_frame, second_frame) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(outside(&mut first_rx), outside(&mut second_rx))
        })
        .await
        .expect("the shared filesystem watcher announces within its settle window");
        assert_eq!(first_frame["folders"], json!(["/work/project"]));
        assert_eq!(second_frame, first_frame);

        drop(first);
        drop(second);
    }

    fn notice() -> Event {
        serde_json::from_value(json!({"type":"notice","sessionId":"chat-1","seq":0,"at":"2026-08-30T00:01:00.000Z","text":"still here","providerEvent":{"provider":"codex","threadId":"thread-1","eventId":"n-1","delivery":"live"}})).unwrap()
    }

    async fn first_chunk(response: Response<Body>) -> String {
        let mut body = response.into_body().into_data_stream();
        String::from_utf8(body.next().await.unwrap().unwrap().to_vec()).unwrap()
    }

    #[test]
    fn native_workbench_restores_rich_codex_status_when_no_rollout_fd_is_open() {
        let (directory, state) = fixture();
        let id = "6f729ab8-6b7d-4ad6-a78e-5dc8cc05eddb";
        let rollout = directory
            .path()
            .join("codex/sessions/2026/09/01")
            .join(format!("rollout-{id}.jsonl"));
        std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        std::fs::write(
            &rollout,
            "{\"payload\":{\"type\":\"task_started\"}}\n{\"payload\":{\"type\":\"reasoning\"}}\n",
        )
        .unwrap();
        let mut hold = crate::workbench::external::ProviderHold {
            id: id.into(),
            holder: crate::workbench::external::Holder::Terminal,
            doing: crate::workbench::external::HeldDoing::Unknown,
            detail: None,
            told: false,
            since: None,
            turn_since: None,
            typical_ms: None,
            pids: std::collections::BTreeSet::from([42]),
        };

        state.enrich_unknown_codex_hold(&mut hold);

        assert_eq!(hold.doing, crate::workbench::external::HeldDoing::Thinking);
        assert_eq!(
            state.codex_record(id, None).as_deref(),
            Some(rollout.as_path())
        );
    }

    #[tokio::test]
    async fn native_workbench_routes_restore_saved_chats_and_stream_their_snapshot() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        state.database().append(notice()).await.unwrap();
        let mut catalog = saved_session();
        catalog.id = "catalog-chat".into();
        // Another chat is another thread. One row per chat another program is
        // holding is what the store enforces now (bw-t26l.20).
        catalog.external_id = Some("thread-2".into());
        catalog.project_id = "another-project".into();
        state.database().create_session(catalog).await.unwrap();
        let menu: Event = serde_json::from_value(json!({
            "type":"session.menu", "sessionId":"catalog-chat", "seq":0, "at":"now",
            "models":[{"value":"gpt-5","displayName":"GPT-5"}],
            "permissionModes":["on-request"], "commands":[{"name":"project-only"}]
        }))
        .unwrap();
        state.database().append(menu).await.unwrap();
        let app = router(state);
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(rows[0]["sessionId"], "chat-1");
        assert_eq!(rows[0]["title"], "The chat that must remain visible");
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/events?session=chat-1&since=0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let chunk = first_chunk(response).await;
        assert!(chunk.contains("event: snapshot"), "{chunk}");
        assert!(chunk.contains("still here"), "{chunk}");
        assert!(!chunk.contains("GPT-5"), "{chunk}");
        assert!(!chunk.contains("project-only"), "{chunk}");
    }

    /// A chat that is set to something is not thereby a chat that offers it.
    ///
    /// The pins and the catalog are different facts with different owners: what
    /// this chat is set to is the chat's, and what it could be set to is the
    /// installed provider's. Building the second out of the first produced a
    /// menu of one item spelled the way the wire spells it, which is both a
    /// wrong list and a wrong word (bw-l4fr.4).
    #[tokio::test]
    async fn saved_pins_do_not_fabricate_a_catalog_of_one() {
        let (_directory, state) = fixture();
        let mut session = saved_session();
        session.permission_mode = "on-request".into();
        session.effort = Some("high".into());
        session.collaboration_mode = Some("plan".into());
        state
            .database()
            .create_session(session.clone())
            .await
            .unwrap();
        let started: Event = serde_json::from_value(json!({
            "type":"session.started","sessionId":session.id,"seq":0,"at":session.created_at,
            "brand":session.brand,"externalId":session.external_id,"model":session.model,
            "cwd":session.cwd,"permissionMode":session.permission_mode,"effort":session.effort,
            "collaborationMode":session.collaboration_mode
        }))
        .unwrap();
        state.database().append(started).await.unwrap();

        let view = snapshot(&state, &session.id).await.unwrap();
        for field in ["models", "permissionModes", "efforts", "collaborationModes"] {
            assert_eq!(
                view["menu"][field],
                json!([]),
                "{field} was invented from what the chat is already set to"
            );
        }
        // And every pin is still there to be named, which is the half of this
        // the chips actually read.
        assert_eq!(view["model"], "gpt-5");
        assert_eq!(view["permissionMode"], "on-request");
        assert_eq!(view["effort"], "high");
        assert_eq!(view["collaborationMode"], "plan");
    }

    #[tokio::test]
    async fn native_workbench_local_restore_returns_durable_rows_without_discovery() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject&local=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(rows.as_array().map(Vec::len), Some(1));
        assert_eq!(rows[0]["sessionId"], "chat-1");
        assert_eq!(rows[0]["title"], "The chat that must remain visible");
        assert_eq!(rows[0]["runningElsewhere"], false);
    }

    /**
     * A chat held in another checkout is not this project's to list.
     *
     * `session/list` is asked for one folder, but scoping the answer is the
     * adapter's to do and neither provider's does it: on the owner's own
     * machine 455 of the 643 chats filed under one project were held in other
     * checkouts, in /tmp and in the home folder, each adopted on sight. The
     * switch for the agents' own chats widens the kinds listed, never the
     * folder (bw-t9no.1).
     */
    #[test]
    fn native_workbench_lists_only_the_chats_held_in_this_project() {
        let project = std::path::Path::new("/home/ahsan/dev/corsetta");
        let mut rows = vec![
            json!({"externalId":"here","cwd":"/home/ahsan/dev/corsetta"}),
            json!({"externalId":"worktree","cwd":"/home/ahsan/dev/corsetta/worktrees/c-1"}),
            json!({"externalId":"worktree-beside","cwd":"/home/ahsan/dev/worktrees/corsetta/c-2/server"}),
            json!({"externalId":"another-checkout","cwd":"/home/ahsan/dev/aspen"}),
            json!({"externalId":"the-home-folder","cwd":"/home/ahsan"}),
            json!({"externalId":"a-scratch-folder","cwd":"/tmp/bench"}),
            json!({"externalId":"a-name-that-starts-the-same","cwd":"/home/ahsan/dev/corsetta-old"}),
            json!({"externalId":"placed-nowhere","cwd":Value::Null}),
        ];
        // Git keeps this project's second worktree outside its folder.
        let folders = [
            project.to_path_buf(),
            std::path::PathBuf::from("/home/ahsan/dev/worktrees/corsetta/c-2"),
        ];
        only_in_this_folder(&mut rows, Some(&folders), &[]);
        let listed: Vec<&str> = rows
            .iter()
            .map(|row| row["externalId"].as_str().unwrap())
            .collect();
        assert_eq!(listed, ["here", "worktree", "worktree-beside"]);

        // Asked about no project at all — the machine-wide sweep — nothing is
        // dropped, because there is no folder to be outside of.
        let mut every = vec![json!({"externalId":"anywhere","cwd":"/tmp"})];
        only_in_this_folder(&mut every, None, &[]);
        assert_eq!(every.len(), 1);
    }

    /**
     * One discovery answer serves everyone who asks in the same breath.
     *
     * The sidebar asks on open, on focus and on every project switch, and each
     * ask used to start an ACP adapter per provider and read the provider's
     * whole record beside it. What is asserted here is the gate that stops
     * that: an answer inside its window is handed back as it stands, and one
     * past it is not (bw-t26l.20).
     */
    #[tokio::test]
    async fn native_workbench_shares_one_discovery_between_overlapping_asks() {
        let (_directory, state) = fixture();
        let key = "/work/project".to_string();
        let listed = vec![json!({"brand":"claude","externalId":"thread-1"})];
        state
            .discovery_cache
            .lock()
            .await
            .insert(key.clone(), (std::time::Instant::now(), listed.clone()));
        let rows = provider_sessions_shared(&state, Some("/work/project")).await;
        assert_eq!(rows, listed, "a fresh answer is handed back as it stands");

        state.discovery_cache.lock().await.insert(
            key.clone(),
            (
                std::time::Instant::now() - DISCOVERY_FRESH - Duration::from_secs(1),
                listed,
            ),
        );
        assert!(
            fresh_discovery(&state.discovery_cache, &key)
                .await
                .is_none(),
            "an answer past its window is asked again"
        );
        // And the folder is part of what makes an answer this reader's.
        assert!(
            fresh_discovery(&state.discovery_cache, "/somewhere/else")
                .await
                .is_none()
        );
    }

    /**
     * Opening a chat is not held up by a listing that has not come back.
     *
     * Everything a chat is opened with is this app's own record of it, save
     * for the branch, and waiting on two adapters to say what they have saved
     * put the whole discovery in front of the reader. Held here by taking the
     * lock the discovery itself takes: what is in hand is used, and what is
     * still on its way is not waited for (bw-550g.1).
     */
    #[tokio::test]
    async fn native_workbench_chat_facts_do_not_wait_for_a_listing_still_on_its_way() {
        let (_directory, state) = fixture();
        let key = "/work/project".to_string();
        let listed = vec![json!({"brand":"codex","externalId":"thread-1"})];
        state
            .discovery_cache
            .lock()
            .await
            .insert(key.clone(), (std::time::Instant::now(), listed.clone()));
        assert_eq!(
            provider_sessions_in_hand(&state, Some("/work/project")).await,
            listed,
            "an answer already in hand is the one used"
        );

        // Past its window, and with the discovery that would refresh it
        // already running: the reader must not join that queue.
        state.discovery_cache.lock().await.insert(
            key.clone(),
            (
                std::time::Instant::now() - DISCOVERY_FRESH - Duration::from_secs(1),
                listed,
            ),
        );
        let running = state.discovery(&key).await;
        let _held = running.lock().await;
        let answered = tokio::time::timeout(
            Duration::from_secs(2),
            provider_sessions_in_hand(&state, Some("/work/project")),
        )
        .await
        .expect("the chat's facts waited for a listing that had not come back");
        assert!(
            answered.is_empty(),
            "what has not come back is not waited for"
        );
    }

    /**
     * A provider that cannot answer is left alone for a while.
     *
     * Starting an adapter to be told "Authentication required" costs what
     * starting one that answers costs, and a provider that is not signed in
     * refuses every time it is asked (bw-t26l.20).
     */
    #[tokio::test]
    async fn native_workbench_stops_asking_a_provider_that_just_refused_to_list() {
        let (_directory, state) = fixture();
        state
            .listing_refused
            .lock()
            .await
            .insert("codex".into(), std::time::Instant::now());
        let answer = ask_provider_to_list(&state, "codex", None).await;
        assert!(answer.is_err_and(|why| why.contains("a moment ago")));

        // A refusal old enough is not an answer, and the provider is asked
        // again — here there is no adapter to ask, so it refuses afresh.
        state.listing_refused.lock().await.insert(
            "codex".into(),
            std::time::Instant::now() - LISTING_REFUSED_FOR - Duration::from_secs(1),
        );
        let answer = ask_provider_to_list(&state, "codex", None).await;
        assert!(answer.is_err_and(|why| !why.contains("a moment ago")));
        assert!(state.listing_refused.lock().await.contains_key("codex"));
    }

    /**
     * A provider that just answered is not asked again for the same folder.
     *
     * Each answer is an adapter process per account, and each one loads the
     * provider's plugins before replying (bw-69sa.2).
     */
    #[tokio::test]
    async fn native_workbench_reuses_a_provider_listing_it_just_heard() {
        let (_directory, state) = fixture();
        let folder = std::path::PathBuf::from("/work/project");
        let heard = crate::workbench::acp::client::ListedSession {
            session_id: "thread-heard".into(),
            cwd: "/work/project".into(),
            title: Some("Heard".into()),
            updated_at: None,
            meta: Value::Null,
        };
        state.listings.lock().await.insert(
            ("codex".into(), Some(folder.clone())),
            (std::time::Instant::now(), vec![heard.clone()]),
        );
        let answer = ask_provider_to_list(&state, "codex", Some(&folder)).await;
        assert_eq!(answer, Ok(vec![heard.clone()]));

        // Another folder was never heard, and an old answer is asked afresh —
        // here there is no adapter to ask, so both are refused.
        let elsewhere = std::path::PathBuf::from("/work/other");
        assert!(ask_provider_to_list(&state, "codex", Some(&elsewhere)).await.is_err());
        state.listing_refused.lock().await.clear();
        state.listings.lock().await.insert(
            ("codex".into(), Some(folder.clone())),
            (
                std::time::Instant::now() - LISTING_FRESH - Duration::from_secs(1),
                vec![heard],
            ),
        );
        assert!(ask_provider_to_list(&state, "codex", Some(&folder)).await.is_err());
    }

    /**
     * A Codex thread list is asked again only when what it is drawn from
     * moved: a new rollout today, or the state database (bw-sppo.2).
     */
    #[test]
    fn native_workbench_reuses_a_codex_thread_list_until_a_thread_is_added() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        std::fs::write(home.join("state_5.sqlite"), "state").unwrap();
        let stamp = codex_listing_stamp(Some(home));
        remember_threads(Some(home), stamp.clone(), &[json!({"id":"thread-one"})]);
        assert_eq!(
            listed_threads(Some(home), &codex_listing_stamp(Some(home))),
            Some(vec![json!({"id":"thread-one"})])
        );

        // A new rollout lands in today's folder: the old list is not reused.
        let today = home
            .join("sessions")
            .join(chrono::Local::now().date_naive().format("%Y/%m/%d").to_string());
        std::fs::create_dir_all(&today).unwrap();
        std::fs::write(today.join("rollout-new.jsonl"), "{}\n").unwrap();
        let moved = codex_listing_stamp(Some(home));
        assert_ne!(moved, stamp);
        assert_eq!(listed_threads(Some(home), &moved), None);

        // Nor when the state database changes.
        remember_threads(Some(home), moved.clone(), &[]);
        std::fs::write(home.join("state_5.sqlite"), "state, renamed").unwrap();
        assert_eq!(listed_threads(Some(home), &codex_listing_stamp(Some(home))), None);
    }

    /// The sidebar keeps no rule of its own for which chats are listed: when
    /// the live stream names a chat the list does not hold, it asks this
    /// answer again (chat-sidebar.tsx, `unlisted`). So this answer has to hold
    /// every chat a person began here, in the states the page used to drop:
    /// one never spoken in, one whose profile switch left it asleep with no
    /// conversation, and one in a worktree made after the page loaded
    /// (bw-ljko.1).
    #[tokio::test]
    async fn the_local_list_holds_every_chat_a_person_began_here() {
        let (directory, state) = fixture();
        let project = directory.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&project)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(status.status.success(), "{status:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "start"]);
        let worktree = directory.path().join("elsewhere").join("fix-a-thing");
        git(&["worktree", "add", "-q", worktree.to_str().unwrap(), "-b", "fix-a-thing"]);
        let project_path = project.to_str().unwrap().to_string();

        let chat = |id: &str, cwd: &std::path::Path| {
            let mut session = saved_session();
            session.id = id.into();
            session.brand = "claude".into();
            session.external_id = None;
            session.project_path = project_path.clone();
            session.cwd = cwd.to_str().unwrap().into();
            session.title = None;
            session.last_spoke_at = None;
            session.begun_by = Some("person".into());
            session
        };
        // Begun a moment ago and not yet spoken in.
        state.database().create_session(chat("new", &project)).await.unwrap();
        // Its profile switched: asleep, and the old conversation let go.
        let mut switched = chat("switched", &project);
        switched.external_id = Some("old-conversation".into());
        state.database().create_session(switched).await.unwrap();
        state
            .database()
            .update_session(
                "switched".into(),
                crate::workbench::store::SessionPatch {
                    external_id: Some(None),
                    state: Some("dormant".into()),
                    profile: Some(Some("work".into())),
                    ..crate::workbench::store::SessionPatch::default()
                },
                None,
            )
            .await
            .unwrap();
        // Working in a worktree git keeps outside the project's folder.
        state.database().create_session(chat("in-a-worktree", &worktree)).await.unwrap();
        // And one an agent began, which the list leaves out by the same rule.
        let mut agents = chat("agents", &project);
        agents.begun_by = Some("agent".into());
        state.database().create_session(agents).await.unwrap();

        let uri = format!(
            "/restore?project=project-1&path={}&local=1",
            project_path.replace('/', "%2F")
        );
        let response = router(state)
            .oneshot(axum::http::Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
        let mut ids: Vec<&str> = rows.iter().filter_map(|row| row["sessionId"].as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["in-a-worktree", "new", "switched"]);
        let switched = rows.iter().find(|row| row["sessionId"] == "switched").unwrap();
        assert!(switched["externalId"].is_null(), "the row kept the conversation the switch let go");
        let tree = rows.iter().find(|row| row["sessionId"] == "in-a-worktree").unwrap();
        assert_eq!(tree["branch"], "fix-a-thing");
    }

    #[tokio::test]
    async fn native_workbench_local_restore_orders_and_groups_by_human_clock() {
        let (_directory, state) = fixture();
        let mut older_human = saved_session();
        older_human.id = "opened-today".into();
        older_human.external_id = Some("thread-opened-today".into());
        older_human.last_active_at = "2026-09-01T09:50:00Z".into();
        older_human.last_spoke_at = Some("2026-08-30T22:05:00Z".into());
        let mut newer_human = saved_session();
        newer_human.id = "spoken-today".into();
        newer_human.external_id = Some("thread-spoken-today".into());
        newer_human.last_active_at = "2026-09-01T09:00:00Z".into();
        newer_human.last_spoke_at = Some("2026-09-01T08:55:00Z".into());
        state.database().create_session(older_human).await.unwrap();
        state.database().create_session(newer_human).await.unwrap();

        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&local=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let rows: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(rows[0]["sessionId"], "spoken-today");
        assert_eq!(rows[1]["sessionId"], "opened-today");
    }

    #[tokio::test]
    async fn native_workbench_persists_the_provider_title_for_the_next_fast_restore() {
        let (directory, state) = fixture();
        let external_id = "c0704045-2fd3-4e88-bbe2-b7361ebf6a32";
        let mut session = saved_session();
        session.brand = "claude".into();
        session.external_id = Some(external_id.into());
        session.title = Some("Temporary stored label".into());
        state.database().create_session(session).await.unwrap();
        let record = directory
            .path()
            .join("claude/projects/-work-project")
            .join(format!("{external_id}.jsonl"));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            record,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-01T06:00:00Z\",",
                "\"cwd\":\"/work/project\",\"customTitle\":\"Canonical provider title\",",
                "\"message\":{\"role\":\"user\",\"content\":\"A prompt\"}}\n"
            ),
        )
        .unwrap();

        let app = router(state);
        let full = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let full: Value = serde_json::from_slice(
            &axum::body::to_bytes(full.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(full[0]["title"], "Canonical provider title");
        let provider_clock = full[0]["lastActiveAt"].clone();

        let local = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/restore?project=project-1&path=%2Fwork%2Fproject&local=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let local: Value = serde_json::from_slice(
            &axum::body::to_bytes(local.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(local[0]["title"], "Canonical provider title");
        assert_eq!(local[0]["lastActiveAt"], provider_clock);
    }

    #[tokio::test]
    async fn a_chat_moved_to_another_profile_is_still_one_row() {
        let (directory, state) = fixture();
        let left = "5b0e1c52-8a51-4d0c-9f43-2c1f7a0b6e11";
        let mut session = saved_session();
        session.brand = "claude".into();
        session.external_id = Some(left.into());
        session.begun_by = Some("person".into());
        state.database().create_session(session).await.unwrap();
        // The provider keeps the conversation the chat leaves behind.
        let record = directory
            .path()
            .join("claude/projects/-work-project")
            .join(format!("{left}.jsonl"));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            record,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-09-01T06:00:00Z\",",
                "\"cwd\":\"/work/project\",",
                "\"message\":{\"role\":\"user\",\"content\":\"Reply with pong\"}}\n"
            ),
        )
        .unwrap();
        // What a profile switch writes: asleep, on the new profile, and the
        // old conversation let go for the next account to replace.
        state
            .database()
            .update_session(
                "chat-1".into(),
                crate::workbench::store::SessionPatch {
                    external_id: Some(None),
                    state: Some("dormant".into()),
                    profile: Some(Some("work".into())),
                    ..crate::workbench::store::SessionPatch::default()
                },
                None,
            )
            .await
            .unwrap();

        let app = router(state);
        for uri in [
            "/restore?project=project-1&path=%2Fwork%2Fproject",
            "/restore?project=project-1&path=%2Fwork%2Fproject&local=1",
        ] {
            let response = app
                .clone()
                .oneshot(axum::http::Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let rows: Vec<Value> = serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
            .unwrap();
            let ids: Vec<&str> = rows.iter().filter_map(|row| row["sessionId"].as_str()).collect();
            assert_eq!(ids, ["chat-1"], "{uri} listed the left conversation again: {rows:?}");
        }
    }

    #[tokio::test]
    async fn native_workbench_routes_execute_provider_independent_commands() {
        let (_directory, state) = fixture();
        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/command")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"type":"provider-defaults.read","brand":"codex"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn native_workbench_snapshot_handoff_does_not_deliver_buffered_events_twice() {
        let (_directory, state) = fixture();
        let (sender, receiver) = tokio::sync::broadcast::channel(8);
        let old: Event = serde_json::from_value(
            json!({"type":"notice","sessionId":"chat-1","seq":4,"at":"now","text":"in snapshot"}),
        )
        .unwrap();
        let fresh: Event = serde_json::from_value(json!({"type":"notice","sessionId":"chat-1","seq":5,"at":"now","text":"after snapshot"})).unwrap();
        sender
            .send(crate::workbench::actor::SessionUpdate::Event(old))
            .unwrap();
        sender
            .send(crate::workbench::actor::SessionUpdate::Event(fresh))
            .unwrap();
        let mut tail = session_tail(receiver, state.database().clone(), "chat-1".into(), 4);
        let frame = tail.next().await.unwrap().unwrap();
        assert!(format!("{frame:?}").contains("after snapshot"));
    }

    #[tokio::test]
    async fn native_workbench_session_tail_replays_every_durable_event_after_a_lag() {
        let (_directory, state) = fixture();
        state
            .database()
            .create_session(saved_session())
            .await
            .unwrap();
        let receiver = state.database().subscribe_session("chat-1");
        for index in 0..1_100 {
            let event: Event = serde_json::from_value(json!({
                "type":"notice", "sessionId":"chat-1", "seq":0,
                "at":"2026-08-30T00:01:00.000Z", "text":format!("burst {index}")
            }))
            .unwrap();
            state.database().append(event).await.unwrap();
        }
        let mut tail = session_tail(receiver, state.database().clone(), "chat-1".into(), 0);
        let first = tail.next().await.unwrap().unwrap();
        assert!(
            format!("{first:?}").contains("burst 0"),
            "the lag recovery skipped the oldest durable event"
        );
    }
}
