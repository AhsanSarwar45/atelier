//! One blocking SQLite owner behind asynchronous request channels.
//!
//! `rusqlite::Connection` never enters an Axum request task. The worker assigns
//! event sequence numbers and publishes only committed appends, so replay,
//! per-chat tails and the app-wide watch all observe one monotone order.

use super::protocol::{Event, EventKind};
use super::store::{
    Notice, SearchHit, Session, SessionActivity, SessionPatch, Spend, Store, TokenStats,
    TranscriptItemPage,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use tokio::sync::{broadcast, mpsc, oneshot};

type Reply<T> = oneshot::Sender<Result<T, String>>;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreUpdate {
    pub session_id: String,
    pub seq: i64,
    pub event: Event,
    /// First durable sequence in a historical replay committed atomically.
    /// Consumers should refresh or read that range instead of assuming the
    /// representative `event` is the only newly stored row.
    pub batch_from: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SessionUpdate {
    Event(Event),
    ReplayCommitted { from: i64, through: i64 },
}

/// One self-consistent cold-chat read. The watermark and every fact it covers
/// are selected in the same actor turn, so an append can only land wholly
/// before or wholly after the snapshot.
pub struct SnapshotParts {
    pub history: Vec<Event>,
    pub page: TranscriptItemPage,
    pub agents: Vec<serde_json::Value>,
}

enum Command {
    CreateSession(Session, Reply<()>),
    DeleteSession(String, Reply<()>),
    Notices(Reply<HashMap<String, Notice>>),
    MarkRead(Vec<(String, String)>, String, Reply<()>),
    MarkAnnounced(String, String, String, Reply<()>),
    ForgetNoticesForProject(String, Reply<usize>),
    GetSession(String, Reply<Option<Session>>),
    SessionByExternalId(String, Reply<Option<Session>>),
    UpdateSession(String, SessionPatch, Option<String>, Reply<()>),
    MarkSpoke(String, String, Reply<()>),
    MarkBegunBy(String, String, Reply<()>),
    CorrectFolders(Vec<(String, String, String)>, Reply<usize>),
    ListSessions(Option<String>, Reply<Vec<Session>>),
    ActiveSessionIds(Reply<Vec<String>>),
    BackgroundOutputs(String, Vec<String>, Reply<Vec<(String, String)>>),
    LastModelForBrand(String, Reply<Option<String>>),
    ListRestoreSessions(Option<String>, bool, Vec<std::path::PathBuf>, Reply<Vec<Session>>),
    MarkAllDormant(Reply<usize>),
    BeadsForSessions(Vec<String>, Reply<HashMap<String, Vec<String>>>),
    BeadsForSession(String, Reply<Vec<String>>),
    RememberBeadLink(String, String, String, String, Reply<()>),
    SessionsForBead(String, Reply<Vec<Session>>),
    Search(String, usize, Reply<Vec<SearchHit>>),
    AccountHandoff(String, Reply<String>),
    SaveAccountHandoff(String, String, Reply<()>),
    SavedAccountHandoff(String, Reply<Option<String>>),
    ClearAccountHandoff(String, Reply<()>),
    Spend(Reply<Vec<Spend>>),
    ToolDetails(String, String, Reply<Option<serde_json::Value>>),
    Append(Event, Reply<Option<Event>>),
    AppendMany(Vec<Event>, bool, Reply<usize>),
    EventsSince(String, i64, Reply<Vec<Event>>),
    EventCount(String, Reply<i64>),
    TimelineCount(String, Reply<i64>),
    FollowedTo(String, Reply<Option<i64>>),
    ImportedBy(String, Reply<Option<i64>>),
    MarkImported(String, Reply<()>),
    RememberFollowed(String, i64, Reply<()>),
    WasDrivenHere(String, Reply<bool>),
    BeginDriving(String, i64, Reply<()>),
    EndDriving(String, Reply<()>),
    DrivenFrom(String, Reply<Option<i64>>),
    StillDriving(Reply<Vec<String>>),
    UnfinishedTools(String, Reply<Vec<String>>),
    SessionStatus(String, Reply<Option<serde_json::Value>>),
    SessionActivity(String, Reply<SessionActivity>),
    SessionActivities(Reply<HashMap<String, SessionActivity>>),
    TokenStats(String, Reply<TokenStats>),
    NoteSummaryRun(String, String, String, i64, Reply<()>),
    SummaryRuns(String, usize, Reply<Vec<i64>>),
    ViewEvents(String, Reply<Vec<Event>>),
    SteeringMenu(String, Reply<serde_json::Value>),
    OfferedMenu(String, Reply<serde_json::Value>),
    OfferCatalogue(String, Event, Vec<serde_json::Value>, Reply<()>),
    Snapshot(String, Reply<SnapshotParts>),
    TranscriptItems(String, Option<i64>, usize, Reply<TranscriptItemPage>),
    AgentTranscriptItems(
        String,
        String,
        Option<i64>,
        usize,
        Reply<TranscriptItemPage>,
    ),
    ProjectedAgents(String, Reply<Vec<serde_json::Value>>),
    HoldMessage(
        String,
        String,
        String,
        serde_json::Value,
        Option<serde_json::Value>,
        String,
        Reply<serde_json::Value>,
    ),
    HeldMessages(String, Reply<Vec<serde_json::Value>>),
    TakeHeld(String, Option<String>, Reply<Option<serde_json::Value>>),
    ReleaseHeld(String, Reply<()>),
    DropHeld(String, String, Reply<Option<serde_json::Value>>),
    ForgetHeld(String, Reply<()>),
    Shutdown,
}

struct Owner {
    commands: mpsc::UnboundedSender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
    #[cfg(test)]
    stopped: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

#[derive(Clone)]
pub struct ChatDb {
    owner: Arc<Owner>,
    global: broadcast::Sender<StoreUpdate>,
    sessions: Arc<Mutex<HashMap<String, broadcast::Sender<SessionUpdate>>>>,
}

impl ChatDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        // Open before starting the thread so migration/open failures are
        // returned to startup instead of becoming a lost worker panic.
        let store = Store::open(path).map_err(|error| error.to_string())?;
        let (commands, receiver) = mpsc::unbounded_channel();
        let (global, _) = broadcast::channel(1024);
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let worker_global = global.clone();
        let worker_sessions = sessions.clone();
        #[cfg(test)]
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(test)]
        let worker_stopped = stopped.clone();
        let worker = thread::Builder::new()
            .name("atelier-chat-db".to_string())
            .spawn(move || {
                run(store, receiver, worker_global, worker_sessions);
                #[cfg(test)]
                worker_stopped.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            owner: Arc::new(Owner {
                commands,
                worker: Mutex::new(Some(worker)),
                #[cfg(test)]
                stopped,
            }),
            global,
            sessions,
        })
    }

    async fn request<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Result<T, String> {
        let (reply, receive) = oneshot::channel();
        self.owner
            .commands
            .send(make(reply))
            .map_err(|_| "chat database worker stopped".to_string())?;
        receive
            .await
            .map_err(|_| "chat database worker stopped before replying".to_string())?
    }

    pub async fn create_session(&self, session: Session) -> Result<(), String> {
        self.request(|reply| Command::CreateSession(session, reply))
            .await
    }

    pub async fn delete_session(&self, id: String) -> Result<(), String> {
        self.request(|reply| Command::DeleteSession(id, reply))
            .await
    }

    pub async fn get_session(&self, id: String) -> Result<Option<Session>, String> {
        self.request(|reply| Command::GetSession(id, reply)).await
    }

    /// What has already been said about each chat, and to whom.
    pub async fn notices(&self) -> Result<HashMap<String, Notice>, String> {
        self.request(Command::Notices).await
    }

    /// Write down that the owner has read these chats, in the states given.
    pub async fn mark_read(&self, states: Vec<(String, String)>, at: String) -> Result<(), String> {
        self.request(|reply| Command::MarkRead(states, at, reply))
            .await
    }

    /// Forget everything said about every chat in one project, for when the
    /// project is deleted and nothing will announce them again.
    pub async fn forget_notices_for_project(&self, project_id: String) -> Result<usize, String> {
        self.request(|reply| Command::ForgetNoticesForProject(project_id, reply))
            .await
    }

    /// Write down that a device has been told about this chat, in this state.
    pub async fn mark_announced(
        &self,
        session_id: String,
        state: String,
        at: String,
    ) -> Result<(), String> {
        self.request(|reply| Command::MarkAnnounced(session_id, state, at, reply))
            .await
    }

    pub async fn session_by_external_id(
        &self,
        external_id: String,
    ) -> Result<Option<Session>, String> {
        self.request(|reply| Command::SessionByExternalId(external_id, reply))
            .await
    }

    pub async fn update_session(
        &self,
        id: String,
        patch: SessionPatch,
        touch_at: Option<String>,
    ) -> Result<(), String> {
        self.request(|reply| Command::UpdateSession(id, patch, touch_at, reply))
            .await
    }

    pub async fn mark_spoke(&self, id: String, at: String) -> Result<(), String> {
        self.request(|reply| Command::MarkSpoke(id, at, reply))
            .await
    }

    pub async fn correct_folders(&self, found: Vec<(String, String, String)>) -> Result<usize, String> {
        self.request(|reply| Command::CorrectFolders(found, reply))
            .await
    }

    pub async fn mark_begun_by(&self, id: String, who: String) -> Result<(), String> {
        self.request(|reply| Command::MarkBegunBy(id, who, reply))
            .await
    }

    pub async fn active_session_ids(&self) -> Result<Vec<String>, String> {
        self.request(Command::ActiveSessionIds).await
    }

    pub async fn background_outputs(
        &self,
        session_id: String,
        tool_call_ids: Vec<String>,
    ) -> Result<Vec<(String, String)>, String> {
        self.request(|reply| Command::BackgroundOutputs(session_id, tool_call_ids, reply))
            .await
    }

    pub async fn list_sessions(&self, project_id: Option<String>) -> Result<Vec<Session>, String> {
        self.request(|reply| Command::ListSessions(project_id, reply))
            .await
    }

    pub async fn last_model_for_brand(&self, brand: String) -> Result<Option<String>, String> {
        self.request(|reply| Command::LastModelForBrand(brand, reply))
            .await
    }

    pub async fn list_restore_sessions(
        &self,
        project_id: Option<String>,
        everything: bool,
        others: Vec<std::path::PathBuf>,
    ) -> Result<Vec<Session>, String> {
        self.request(|reply| Command::ListRestoreSessions(project_id, everything, others, reply))
            .await
    }

    pub async fn mark_all_dormant(&self) -> Result<usize, String> {
        self.request(Command::MarkAllDormant).await
    }

    pub async fn beads_for_sessions(
        &self,
        session_ids: Vec<String>,
    ) -> Result<HashMap<String, Vec<String>>, String> {
        self.request(|reply| Command::BeadsForSessions(session_ids, reply))
            .await
    }

    pub async fn beads_for_session(&self, id: String) -> Result<Vec<String>, String> {
        self.request(|reply| Command::BeadsForSession(id, reply))
            .await
    }
    pub async fn remember_bead_link(
        &self,
        session: String,
        bead: String,
        via: String,
        at: String,
    ) -> Result<(), String> {
        self.request(|reply| Command::RememberBeadLink(session, bead, via, at, reply))
            .await
    }
    pub async fn sessions_for_bead(&self, id: String) -> Result<Vec<Session>, String> {
        self.request(|reply| Command::SessionsForBead(id, reply))
            .await
    }
    pub async fn search(&self, query: String, limit: usize) -> Result<Vec<SearchHit>, String> {
        self.request(|reply| Command::Search(query, limit, reply))
            .await
    }
    pub async fn account_handoff(&self, id: String) -> Result<String, String> {
        self.request(|reply| Command::AccountHandoff(id, reply)).await
    }
    pub async fn save_account_handoff(&self, id: String, context: String) -> Result<(), String> {
        self.request(|reply| Command::SaveAccountHandoff(id, context, reply)).await
    }
    pub async fn saved_account_handoff(&self, id: String) -> Result<Option<String>, String> {
        self.request(|reply| Command::SavedAccountHandoff(id, reply)).await
    }
    pub async fn clear_account_handoff(&self, id: String) -> Result<(), String> {
        self.request(|reply| Command::ClearAccountHandoff(id, reply)).await
    }
    pub async fn spend(&self) -> Result<Vec<Spend>, String> {
        self.request(Command::Spend).await
    }
    pub async fn tool_details(
        &self,
        session: String,
        tool: String,
    ) -> Result<Option<serde_json::Value>, String> {
        self.request(|reply| Command::ToolDetails(session, tool, reply))
            .await
    }

    /// Append a provider event after assigning its durable sequence number.
    /// A duplicate provider identity returns `None` and publishes nothing.
    pub async fn append(&self, event: Event) -> Result<Option<Event>, String> {
        self.request(|reply| Command::Append(event, reply)).await
    }

    /// Persist a provider replay in one actor turn and one SQLite commit.
    /// Publication happens only after the whole batch is durable.
    pub async fn append_many(&self, events: Vec<Event>) -> Result<usize, String> {
        self.request(|reply| Command::AppendMany(events, false, reply))
            .await
    }

    /// Persist a historical provider replay atomically and notify each live
    /// consumer once. The durable range is authoritative; sending thousands
    /// of replay rows through a bounded live channel only creates lag and
    /// repeated snapshots while adding no information.
    pub async fn append_replay(&self, events: Vec<Event>) -> Result<usize, String> {
        self.request(|reply| Command::AppendMany(events, true, reply))
            .await
    }

    pub async fn events_since(&self, session_id: String, since: i64) -> Result<Vec<Event>, String> {
        self.request(|reply| Command::EventsSince(session_id, since, reply))
            .await
    }

    pub async fn event_count(&self, session_id: String) -> Result<i64, String> {
        self.request(|reply| Command::EventCount(session_id, reply))
            .await
    }
    pub async fn timeline_count(&self, session_id: String) -> Result<i64, String> {
        self.request(|reply| Command::TimelineCount(session_id, reply))
            .await
    }
    pub async fn followed_to(&self, session_id: String) -> Result<Option<i64>, String> {
        self.request(|reply| Command::FollowedTo(session_id, reply))
            .await
    }
    pub async fn imported_by(&self, session_id: String) -> Result<Option<i64>, String> {
        self.request(|reply| Command::ImportedBy(session_id, reply))
            .await
    }
    pub async fn mark_imported(&self, session_id: String) -> Result<(), String> {
        self.request(|reply| Command::MarkImported(session_id, reply))
            .await
    }
    pub async fn remember_followed(&self, session_id: String, at: i64) -> Result<(), String> {
        self.request(|reply| Command::RememberFollowed(session_id, at, reply))
            .await
    }
    pub async fn begin_driving(&self, session_id: String, from: i64) -> Result<(), String> {
        self.request(|reply| Command::BeginDriving(session_id, from, reply))
            .await
    }
    pub async fn end_driving(&self, session_id: String) -> Result<(), String> {
        self.request(|reply| Command::EndDriving(session_id, reply))
            .await
    }
    pub async fn driven_from(&self, session_id: String) -> Result<Option<i64>, String> {
        self.request(|reply| Command::DrivenFrom(session_id, reply))
            .await
    }
    pub async fn still_driving(&self) -> Result<Vec<String>, String> {
        self.request(Command::StillDriving).await
    }
    pub async fn unfinished_tools(&self, session_id: String) -> Result<Vec<String>, String> {
        self.request(|reply| Command::UnfinishedTools(session_id, reply))
            .await
    }
    pub async fn was_driven_here(&self, session_id: String) -> Result<bool, String> {
        self.request(|reply| Command::WasDrivenHere(session_id, reply))
            .await
    }
    pub async fn session_activity(&self, session_id: String) -> Result<SessionActivity, String> {
        self.request(|reply| Command::SessionActivity(session_id, reply))
            .await
    }
    pub async fn session_status(
        &self,
        session_id: String,
    ) -> Result<Option<serde_json::Value>, String> {
        self.request(|reply| Command::SessionStatus(session_id, reply))
            .await
    }
    pub async fn session_activities(&self) -> Result<HashMap<String, SessionActivity>, String> {
        self.request(Command::SessionActivities).await
    }
    pub async fn token_stats(&self, session_id: String) -> Result<TokenStats, String> {
        self.request(|reply| Command::TokenStats(session_id, reply))
            .await
    }
    pub async fn note_summary_run(
        &self,
        project: String,
        session_id: String,
        at: String,
        ms: i64,
    ) -> Result<(), String> {
        self.request(|reply| Command::NoteSummaryRun(project, session_id, at, ms, reply))
            .await
    }
    pub async fn summary_runs(&self, project: String, limit: usize) -> Result<Vec<i64>, String> {
        self.request(|reply| Command::SummaryRuns(project, limit, reply))
            .await
    }

    pub async fn view_events(&self, session_id: String) -> Result<Vec<Event>, String> {
        self.request(|reply| Command::ViewEvents(session_id, reply))
            .await
    }

    pub async fn steering_menu(&self, session_id: String) -> Result<serde_json::Value, String> {
        self.request(|reply| Command::SteeringMenu(session_id, reply))
            .await
    }

    /// The choices a chat is offered, including those a stopped chat is
    /// shown from its provider's last menu (bw-y5dc.1).
    /// Keep what a provider offered when asked on a stopped chat's behalf,
    /// and show it to that chat while it stays stopped (bw-zldt.2).
    pub async fn offer_catalogue(
        &self,
        session_id: String,
        menu: Event,
        shared: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        self.request(|reply| Command::OfferCatalogue(session_id, menu, shared, reply))
            .await
    }

    pub async fn offered_menu(&self, session_id: String) -> Result<serde_json::Value, String> {
        self.request(|reply| Command::OfferedMenu(session_id, reply))
            .await
    }

    /// Hold one message the reader wrote but has not sent (bw-r54j.1).
    pub async fn hold_message(
        &self,
        session_id: String,
        id: String,
        text: String,
        images: serde_json::Value,
        parts: Option<serde_json::Value>,
        at: String,
    ) -> Result<serde_json::Value, String> {
        self.request(|reply| Command::HoldMessage(session_id, id, text, images, parts, at, reply))
            .await
    }

    pub async fn held_messages(
        &self,
        session_id: String,
    ) -> Result<Vec<serde_json::Value>, String> {
        self.request(|reply| Command::HeldMessages(session_id, reply))
            .await
    }

    /// Claim a held message for sending; nothing when another sender has it.
    pub async fn take_held(
        &self,
        session_id: String,
        id: Option<String>,
    ) -> Result<Option<serde_json::Value>, String> {
        self.request(|reply| Command::TakeHeld(session_id, id, reply))
            .await
    }

    pub async fn release_held(&self, id: String) -> Result<(), String> {
        self.request(|reply| Command::ReleaseHeld(id, reply)).await
    }

    pub async fn drop_held(
        &self,
        session_id: String,
        id: String,
    ) -> Result<Option<serde_json::Value>, String> {
        self.request(|reply| Command::DropHeld(session_id, id, reply))
            .await
    }

    pub async fn forget_held(&self, id: String) -> Result<(), String> {
        self.request(|reply| Command::ForgetHeld(id, reply)).await
    }

    pub async fn snapshot(&self, session_id: String) -> Result<SnapshotParts, String> {
        self.request(|reply| Command::Snapshot(session_id, reply))
            .await
    }

    pub async fn transcript_items(
        &self,
        session_id: String,
        before: Option<i64>,
        limit: usize,
    ) -> Result<TranscriptItemPage, String> {
        self.request(|reply| Command::TranscriptItems(session_id, before, limit, reply))
            .await
    }

    pub async fn agent_transcript_items(
        &self,
        session_id: String,
        parent_id: String,
        before: Option<i64>,
        limit: usize,
    ) -> Result<TranscriptItemPage, String> {
        self.request(|reply| {
            Command::AgentTranscriptItems(session_id, parent_id, before, limit, reply)
        })
        .await
    }

    pub async fn projected_agents(
        &self,
        session_id: String,
    ) -> Result<Vec<serde_json::Value>, String> {
        self.request(|reply| Command::ProjectedAgents(session_id, reply))
            .await
    }

    pub fn subscribe_all(&self) -> broadcast::Receiver<StoreUpdate> {
        self.global.subscribe()
    }

    pub fn subscribe_session(&self, session_id: &str) -> broadcast::Receiver<SessionUpdate> {
        let mut sessions = self.sessions.lock().unwrap();
        let sender = sessions.entry(session_id.to_string()).or_insert_with(|| {
            let (sender, _) = broadcast::channel(1024);
            sender
        });
        sender.subscribe()
    }

    #[cfg(test)]
    fn stopped_flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.owner.stopped.clone()
    }
}

fn respond<T>(reply: Reply<T>, result: rusqlite::Result<T>) {
    let _ = reply.send(result.map_err(|error| error.to_string()));
}

fn string(event: &Event, name: &str) -> Option<String> {
    event
        .fields
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn apply_session_fact(store: &Store, session_id: &str, event: &Event) -> rusqlite::Result<()> {
    let mut patch = SessionPatch::default();
    let mut said_at: Option<String> = None;
    // Whether this event is something that HAPPENED in the chat. Most are, and
    // date it. Two are not: the app writing down that a chat exists, and a chat
    // going to sleep. Both are stamped with the moment the app got round to
    // them, so a chat discovered this afternoon and never touched since March
    // would report this afternoon — which is the whole complaint about opening
    // a chat making it look newly worked in (bw-t26l.22).
    let mut happened = true;
    match event.kind {
        EventKind::SessionStarted => {
            happened = false;
            if event.fields.contains_key("externalId") {
                patch.external_id = Some(string(event, "externalId"));
            }
            if event.fields.contains_key("model") {
                patch.model = Some(string(event, "model"));
            }
            if let Some(mode) = string(event, "permissionMode") {
                patch.permission_mode = Some(mode);
            }
            if event.fields.contains_key("effort") {
                patch.effort = Some(string(event, "effort"));
            }
            if event.fields.contains_key("collaborationMode") {
                patch.collaboration_mode = Some(string(event, "collaborationMode"));
            }
            if event.fields.contains_key("profile") {
                patch.profile = Some(string(event, "profile"));
            }
        }
        EventKind::SessionState => {
            patch.state = string(event, "state");
            happened = patch.state.as_deref() != Some("dormant");
        }
        EventKind::SessionPinned => {
            // The one clock ACP reports for a session, when the agent sends it.
            // The event's own `at` is when the notification arrived; this is
            // when the agent says the chat was last worked in, which is what
            // the list is dated by (bw-t26l.22).
            if let Some(updated) = string(event, "updatedAt") {
                said_at = Some(updated);
            }
            if let Some(title) = string(event, "title") {
                // Provider titles remain useful until the person names the
                // chat. Once they do, later session-info refreshes cannot take
                // ownership of that choice back.
                let chosen = store.explicit_title(session_id)?;
                if chosen.as_deref().is_none_or(|saved| saved == title) {
                    patch.title = Some(Some(title));
                }
            }
            if let Some(model) = string(event, "model") {
                patch.model = Some(Some(model));
            } else if event
                .fields
                .get("clearModel")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                patch.model = Some(None);
            }
            if let Some(mode) = string(event, "permissionMode") {
                patch.permission_mode = Some(mode);
            }
            if let Some(effort) = string(event, "effort") {
                patch.effort = Some(Some(effort));
            }
            if let Some(collaboration_mode) = string(event, "collaborationMode") {
                patch.collaboration_mode = Some(Some(collaboration_mode));
            }
        }
        EventKind::SessionEnded => {
            patch.state = Some("dormant".into());
            happened = false;
        }
        _ => return Ok(()),
    }
    let touch = said_at.or_else(|| happened.then(|| string(event, "at")).flatten());
    store.update_session(session_id, patch, touch.as_deref())
}

fn canonical_event(
    store: &Store,
    agent_lifecycles: &mut HashMap<String, super::lifecycle::AgentLifecycle>,
    mut event: Event,
) -> Result<Option<(String, Event)>, String> {
    super::wire::bound_event(&mut event);
    let session_id = event
        .fields
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    if event.kind == EventKind::TranscriptReset {
        // A provider recipe replay is a new canonical transcript generation.
        // Keeping terminal rows from the previous generation makes the shared
        // lifecycle reject every replayed helper start as a duplicate, while
        // paging correctly ignores the old child events after this reset.
        // Keep an explicit empty generation. AppendMany canonicalizes the
        // complete batch before persisting its reset, so removing the entry
        // would make the next helper start reload pre-reset tombstones from
        // SQLite and reject itself again.
        agent_lifecycles.insert(
            session_id.clone(),
            super::lifecycle::AgentLifecycle::default(),
        );
        return Ok(Some((session_id, event)));
    }
    if !matches!(
        event.kind,
        EventKind::AgentStarted | EventKind::AgentProgress | EventKind::AgentFinished
    ) {
        return Ok(Some((session_id, event)));
    }
    if !agent_lifecycles.contains_key(&session_id) {
        let history = store
            .agent_lifecycle_events(&session_id)
            .map_err(|error| error.to_string())?;
        let mut lifecycle = super::lifecycle::AgentLifecycle::default();
        let prior = history
            .into_iter()
            .filter_map(|event| serde_json::to_value(event).ok())
            .collect();
        let _ = lifecycle.accept(prior);
        agent_lifecycles.insert(session_id.clone(), lifecycle);
    }
    let raw = serde_json::to_value(&event).map_err(|error| error.to_string())?;
    let Some(canonical) = agent_lifecycles
        .entry(session_id.clone())
        .or_default()
        .accept(vec![raw])
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let event = serde_json::from_value(canonical).map_err(|error| error.to_string())?;
    Ok(Some((session_id, event)))
}

/// Native discovery refreshes provider choices independently of the active
/// connection. Its catalogue cannot remove that connection's shared guidance.
fn preserve_shared_library(event: &mut Event, previous: Option<&Event>) {
    if event.kind != EventKind::SessionMenu || event.fields.contains_key("sharedLibrary") { return; }
    let Some(previous) = previous else { return };
    let Some(library) = previous.fields.get("sharedLibrary") else { return };
    event.fields.insert("sharedLibrary".into(), library.clone());
    let shared = previous.fields.get("commands").and_then(serde_json::Value::as_array).into_iter().flatten()
        .filter(|c| c["execution"] == "shared").cloned();
    let mut commands = event.fields.get("commands").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    commands.retain(|c| !c["name"].as_str().is_some_and(|name| name.starts_with("skill:")));
    commands.extend(shared);
    event.fields.insert("commands".into(), serde_json::json!(commands));
}

fn persist_event(
    store: &Store,
    session_id: &str,
    mut event: Event,
    seq: i64,
) -> rusqlite::Result<Option<(i64, Event)>> {
    event
        .fields
        .insert("seq".to_string(), serde_json::json!(seq));
    let mut durable = event.clone();
    if durable.kind == EventKind::SessionMenu {
        durable
            .fields
            .retain(|field, _| matches!(field.as_str(), "sessionId" | "seq" | "at"));
    }
    if !store.append_event(&durable)? {
        return Ok(None);
    }
    apply_session_fact(store, session_id, &event)?;
    if event.kind == EventKind::Cost {
        store.remember_turn_cost(
            session_id,
            string(&event, "at").as_deref().unwrap_or_default(),
            event.fields.get("cost").unwrap_or(&serde_json::Value::Null),
        )?;
    }
    // What was said, in the table that "everything ever said" is searched in.
    //
    // Nothing wrote to it outside its own unit tests, so `/api/workbench/search`
    // answered every word in every chat with `[]` -- and read as "nobody has
    // ever said that" rather than as "nobody is keeping the words"
    // (bw-t26l.20).
    match event.kind {
        EventKind::MessageStarted => {
            if let Some(message_id) = string(&event, "messageId") {
                store.open_message(
                    session_id,
                    &message_id,
                    string(&event, "role").as_deref().unwrap_or("assistant"),
                    string(&event, "at").as_deref().unwrap_or(""),
                )?;
            }
        }
        EventKind::TextDelta => {
            // Grown rather than set: this is one piece of a sentence that
            // arrives a few characters at a time.
            if let (Some(message_id), Some(text)) =
                (string(&event, "messageId"), string(&event, "text"))
            {
                store.grow_message(session_id, &message_id, &text)?;
            }
        }
        EventKind::MessageRetracted => {
            // A message the provider took back is one nobody said, and a
            // search that still answered with it would be quoting a chat
            // about a line that is not in it.
            if let Some(message_id) = string(&event, "messageId") {
                store.retract_message(session_id, &message_id)?;
            }
        }
        _ => {}
    }
    if event.kind == EventKind::LinkBead {
        if let Some(bead_id) = string(&event, "beadId") {
            store.remember_bead_link(
                session_id,
                &bead_id,
                string(&event, "via").as_deref().unwrap_or("tool"),
                string(&event, "at").as_deref().unwrap_or(""),
            )?;
        }
    }
    Ok(Some((seq, event)))
}

fn view_with_live_menu(mut events: Vec<Event>, live: Option<&Event>) -> Vec<Event> {
    events.retain(|event| event.kind != EventKind::SessionMenu);
    if let Some(menu) = live {
        events.push(menu.clone());
        events.sort_by_key(|event| event.fields.get("seq").and_then(serde_json::Value::as_i64));
    }
    events
}

/// The installed provider's current steering choices for a saved chat.
///
/// A chat's history never keeps a menu: models and modes can change when the
/// provider is upgraded. They are provider facts, though, rather than facts of
/// one conversation, so the provider's last menu is kept beside the chats for
/// a stopped one to be set from until it wakes (bw-y5dc.1). Reopening a dormant chat used to show no picker until its
/// first prompt woke that exact session, even when another session on the same
/// provider had just advertised the current catalogue. Reuse only those
/// provider-wide choices, and the provider's own `/` commands to list; skills,
/// agents and config values remain owned by the session that announced them.
fn live_steering_menu(
    store: &Store,
    live_menus: &HashMap<String, Event>,
    session_id: &str,
) -> Option<Event> {
    let Some(own) = live_menus.get(session_id) else {
        return provider_menu(store, live_menus, session_id);
    };
    let mut own = own.clone();
    // A menu of its own that names none of the provider's commands -- one an
    // import wrote, or one asked for before the adapter announced them -- is
    // given the ones the provider announced elsewhere, to list (bw-zldt.2).
    if super::store::native_commands(&serde_json::Value::Object(own.fields.clone())).is_empty() {
        let known = provider_menu(store, live_menus, session_id)
            .and_then(|menu| menu.fields.get("commands").cloned())
            .and_then(|commands| commands.as_array().cloned())
            .unwrap_or_default();
        if !known.is_empty() {
            let mut commands = known;
            commands.extend(own.fields.get("commands").and_then(serde_json::Value::as_array).cloned().unwrap_or_default());
            own.fields.insert("commands".into(), serde_json::json!(commands));
        }
    }
    Some(own)
}

/// What the provider of a chat with no menu of its own offers: another live
/// chat's on the same provider account and project, or the last one kept.
fn provider_menu(
    store: &Store,
    live_menus: &HashMap<String, Event>,
    session_id: &str,
) -> Option<Event> {
    let target = store.get_session(session_id).ok().flatten()?;
    let borrowed = live_menus
        .iter()
        .filter(|(id, _)| id.as_str() != session_id)
        .filter(|(id, _)| {
            store
                .get_session(id)
                .ok()
                .flatten()
                .is_some_and(|session| {
                    session.brand == target.brand
                        && session.profile == target.profile
                        && session.project_id == target.project_id
                        && session.project_path == target.project_path
                })
        })
        .max_by_key(|(_, menu)| {
            menu.fields
                .get("at")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string()
        })
        .map(|(id, menu)| (id.clone(), menu.clone()));
    // The commands are this chat's folder's, whichever chat lent the rest: a
    // project's worktrees can each hold commands of their own (bw-zldt.2).
    let lent_here = borrowed.as_ref().is_some_and(|(lender, _)| {
        store.get_session(lender).ok().flatten().is_some_and(|lender| lender.cwd == target.cwd)
    });
    let borrowed = borrowed.map(|(_, menu)| menu);
    // No chat on this provider has spoken since the app started. What it
    // offered last time is still the best account of it, and a stopped chat
    // with no effort or Fast mode to set could only be changed by waking it
    // with a message first (bw-y5dc.1).
    let mut menu = match borrowed {
        Some(menu) => menu,
        None => {
            let catalogue = store.provider_catalogue(session_id).ok().flatten()?;
            let mut fields = catalogue.as_object().cloned().unwrap_or_default();
            fields.insert("type".into(), serde_json::json!("session.menu"));
            fields.insert("seq".into(), serde_json::json!(0));
            fields.insert("at".into(), serde_json::json!(target.last_active_at));
            serde_json::from_value(serde_json::Value::Object(fields)).ok()?
        }
    };
    let lent = super::store::native_commands(&serde_json::Value::Object(menu.fields.clone()));
    let commands = if lent_here && !lent.is_empty() {
        lent
    } else {
        store
            .provider_catalogue(session_id)
            .ok()
            .flatten()
            .map(|catalogue| super::store::native_commands(&catalogue))
            .unwrap_or_default()
    };
    menu.fields.retain(|field, _| {
        matches!(field.as_str(), "type" | "sessionId" | "seq" | "at")
            || super::store::PROVIDER_CATALOGUE_FIELDS.contains(&field.as_str())
    });
    // What the person could type is listed too, so a slash in a stopped chat is not
    // an empty menu. Shown only: the command is accepted or refused by the
    // chat's own session once the prompt wakes it (bw-zldt.2).
    if !commands.is_empty() {
        menu.fields.insert("commands".into(), serde_json::json!(commands));
    }
    menu.fields.insert("sessionId".into(), serde_json::json!(session_id));
    // The options are the provider's; the values set on them are this chat's.
    let pinned = store.steering_menu(session_id).ok();
    if let Some(options) = menu
        .fields
        .get_mut("configOptions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for option in options {
            let own = pinned
                .as_ref()
                .and_then(|pinned| pinned["configOptions"].as_array())
                .into_iter()
                .flatten()
                .find(|patch| patch["id"] == option["id"]);
            // Unset here, it is whatever a freshly woken agent starts at, not
            // what another chat turned it to: the wake sends only this chat's
            // own values, so anything else would be shown and never applied.
            option["currentValue"] = match own {
                Some(own) => own["currentValue"].clone(),
                None if option["type"] == "boolean" => serde_json::json!(false),
                None => {
                    let choices = option["options"].as_array().cloned().unwrap_or_default();
                    choices
                        .iter()
                        .find(|choice| choice["value"] == "default")
                        .or_else(|| choices.first())
                        .map(|choice| choice["value"].clone())
                        .unwrap_or(serde_json::Value::Null)
                }
            };
        }
    }
    Some(menu)
}

fn remember_catalogue(store: &Store, session_id: &str, menu: &Event) {
    let menu = serde_json::Value::Object(menu.fields.clone());
    if let Err(error) = store.remember_provider_catalogue(session_id, &menu) {
        tracing::warn!(session_id, %error, "could not remember the provider's catalogue");
    }
}

/// What a chat may be set to: the menu it is shown, whether its own
/// provider announced it or it was borrowed for a stopped chat.
fn offered_menu(
    store: &Store,
    live_menus: &HashMap<String, Event>,
    session_id: &str,
) -> serde_json::Value {
    live_steering_menu(store, live_menus, session_id)
        .map(|menu| serde_json::Value::Object(menu.fields))
        .unwrap_or_else(|| serde_json::json!({}))
}

fn steering_menu(
    store: &Store,
    live_menus: &HashMap<String, Event>,
    session_id: &str,
) -> rusqlite::Result<serde_json::Value> {
    let selected = store.steering_menu(session_id)?;
    let Some(live) = live_menus.get(session_id) else {
        return Ok(selected);
    };
    let mut menu = live.fields.clone();
    let selected = selected["configOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|patch| {
            Some((
                patch["id"].as_str()?.to_string(),
                patch["currentValue"].clone(),
            ))
        })
        .collect::<HashMap<_, _>>();
    if let Some(options) = menu
        .get_mut("configOptions")
        .and_then(serde_json::Value::as_array_mut)
    {
        for option in options {
            if let Some(current) = option["id"].as_str().and_then(|id| selected.get(id)) {
                option["currentValue"] = current.clone();
            }
        }
    }
    Ok(serde_json::Value::Object(menu))
}

fn publish_event(
    global: &broadcast::Sender<StoreUpdate>,
    sessions: &Arc<Mutex<HashMap<String, broadcast::Sender<SessionUpdate>>>>,
    session_id: String,
    seq: i64,
    event: Event,
) {
    if let Some(sender) = sessions.lock().unwrap().get(&session_id) {
        let _ = sender.send(SessionUpdate::Event(event.clone()));
    }
    let _ = global.send(StoreUpdate {
        session_id,
        seq,
        event,
        batch_from: None,
    });
}

fn run(
    mut store: Store,
    mut commands: mpsc::UnboundedReceiver<Command>,
    global: broadcast::Sender<StoreUpdate>,
    sessions: Arc<Mutex<HashMap<String, broadcast::Sender<SessionUpdate>>>>,
) {
    let mut agent_lifecycles: HashMap<String, super::lifecycle::AgentLifecycle> = HashMap::new();
    // Provider catalogues describe the installed provider right now. They are
    // broadcast and replayed while this process is alive, and never restored
    // from a chat's durable history; only the provider's own last menu is
    // (`Store::provider_catalogue`).
    let mut live_menus: HashMap<String, Event> = HashMap::new();
    while let Some(command) = commands.blocking_recv() {
        match command {
            Command::CreateSession(session, reply) => {
                respond(reply, store.create_session(&session))
            }
            Command::DeleteSession(id, reply) => {
                let result = store.delete_session(&id);
                if result.is_ok() {
                    live_menus.remove(&id);
                }
                respond(reply, result)
            }
            Command::GetSession(id, reply) => respond(reply, store.get_session(&id)),
            Command::Notices(reply) => respond(reply, store.notices()),
            Command::MarkRead(states, at, reply) => respond(reply, store.mark_read(&states, &at)),
            Command::ForgetNoticesForProject(project_id, reply) => {
                respond(reply, store.forget_notices_for_project(&project_id))
            }
            Command::MarkAnnounced(session_id, state, at, reply) => {
                respond(reply, store.mark_announced(&session_id, &state, &at))
            }
            Command::SessionByExternalId(id, reply) => {
                respond(reply, store.session_by_external_id(&id))
            }
            Command::UpdateSession(id, patch, touch_at, reply) => {
                respond(reply, store.update_session(&id, patch, touch_at.as_deref()))
            }
            Command::MarkSpoke(id, at, reply) => respond(reply, store.mark_spoke(&id, &at)),
            Command::CorrectFolders(found, reply) => respond(reply, store.correct_folders(&found)),
            Command::MarkBegunBy(id, who, reply) => {
                respond(reply, store.mark_begun_by(&id, &who))
            }
            Command::LastModelForBrand(brand, reply) => {
                respond(reply, store.last_model_for_brand(&brand))
            }
            Command::ActiveSessionIds(reply) => respond(reply, store.active_session_ids()),
            Command::BackgroundOutputs(session_id, calls, reply) => {
                respond(reply, store.background_outputs(&session_id, &calls))
            }
            Command::ListSessions(project_id, reply) => {
                respond(reply, store.list_sessions(project_id.as_deref()))
            }
            Command::ListRestoreSessions(project_id, everything, others, reply) => respond(
                reply,
                store.list_restore_sessions(project_id.as_deref(), everything, &others),
            ),
            Command::MarkAllDormant(reply) => respond(reply, store.mark_all_dormant()),
            Command::BeadsForSessions(ids, reply) => respond(reply, store.beads_for_sessions(&ids)),
            Command::BeadsForSession(id, reply) => respond(reply, store.beads_for_session(&id)),
            Command::RememberBeadLink(session, bead, via, at, reply) => respond(
                reply,
                store
                    .remember_bead_link(&session, &bead, &via, &at)
                    .map(|_| ()),
            ),
            Command::SessionsForBead(id, reply) => respond(reply, store.sessions_for_bead(&id)),
            Command::Search(query, limit, reply) => respond(reply, store.search(&query, limit)),
            Command::AccountHandoff(id, reply) => respond(reply, store.account_handoff(&id)),
            Command::SaveAccountHandoff(id, context, reply) => respond(reply, store.save_account_handoff(&id, &context)),
            Command::SavedAccountHandoff(id, reply) => respond(reply, store.saved_account_handoff(&id)),
            Command::ClearAccountHandoff(id, reply) => respond(reply, store.clear_account_handoff(&id)),
            Command::Spend(reply) => respond(reply, store.spend()),
            Command::ToolDetails(session, tool, reply) => {
                respond(reply, store.tool_details(&session, &tool))
            }
            Command::Append(event, reply) => {
                let lifecycle_before = agent_lifecycles.clone();
                let result =
                    canonical_event(&store, &mut agent_lifecycles, event).and_then(|prepared| {
                        match prepared {
                            Some((session_id, event)) => {
                                let seq = store
                                    .next_seq(&session_id)
                                    .map_err(|error| error.to_string())?;
                                persist_event(&store, &session_id, event, seq)
                                    .map(|stored| {
                                        stored.map(|(seq, event)| (session_id, seq, event))
                                    })
                                    .map_err(|error| error.to_string())
                            }
                            None => Ok(None),
                        }
                    });
                match result {
                    Ok(Some((session_id, seq, mut event))) => {
                        preserve_shared_library(&mut event, live_menus.get(&session_id));
                        if event.kind == EventKind::SessionMenu {
                            remember_catalogue(&store, &session_id, &event);
                            live_menus.insert(session_id.clone(), event.clone());
                        }
                        publish_event(&global, &sessions, session_id, seq, event.clone());
                        let _ = reply.send(Ok(Some(event)));
                    }
                    Ok(None) => {
                        let _ = reply.send(Ok(None));
                    }
                    Err(error) => {
                        agent_lifecycles = lifecycle_before;
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Command::AppendMany(events, replay, reply) => {
                let lifecycle_before = agent_lifecycles.clone();
                let prepared = events
                    .into_iter()
                    .map(|event| canonical_event(&store, &mut agent_lifecycles, event))
                    .collect::<Result<Vec<_>, _>>();
                let result = prepared.and_then(|prepared| {
                    store
                        .begin_event_batch()
                        .map_err(|error| error.to_string())?;
                    let mut next = HashMap::<String, i64>::new();
                    let mut stored = Vec::new();
                    for (session_id, event) in prepared.into_iter().flatten() {
                        let seq = match next.get(&session_id).copied() {
                            Some(seq) => seq,
                            None => match store.next_seq(&session_id) {
                                Ok(seq) => seq,
                                Err(error) => {
                                    store.rollback_event_batch();
                                    return Err(error.to_string());
                                }
                            },
                        };
                        match persist_event(&store, &session_id, event, seq) {
                            Ok(Some((seq, event))) => {
                                next.insert(session_id.clone(), seq + 1);
                                stored.push((session_id, seq, event));
                            }
                            Ok(None) => {}
                            Err(error) => {
                                store.rollback_event_batch();
                                return Err(error.to_string());
                            }
                        }
                    }
                    if let Err(error) = store.commit_event_batch() {
                        store.rollback_event_batch();
                        return Err(error.to_string());
                    }
                    Ok(stored)
                });
                match result {
                    Ok(mut stored) => {
                        let count = stored.len();
                        for (session_id, _, event) in &mut stored {
                            preserve_shared_library(event, live_menus.get(session_id));
                            if event.kind == EventKind::SessionMenu {
                                remember_catalogue(&store, session_id, event);
                                live_menus.insert(session_id.clone(), event.clone());
                            }
                        }
                        if replay {
                            let mut ranges = HashMap::<String, (i64, i64, Event)>::new();
                            for (session_id, seq, event) in stored {
                                ranges
                                    .entry(session_id)
                                    .and_modify(|range| {
                                        range.1 = seq;
                                        range.2 = event.clone();
                                    })
                                    .or_insert((seq, seq, event));
                            }
                            for (session_id, (from, through, event)) in ranges {
                                if let Some(sender) = sessions.lock().unwrap().get(&session_id) {
                                    let _ = sender.send(SessionUpdate::ReplayCommitted {
                                        from,
                                        through,
                                    });
                                }
                                let _ = global.send(StoreUpdate {
                                    session_id,
                                    seq: through,
                                    event,
                                    batch_from: Some(from),
                                });
                            }
                        } else {
                            for (session_id, seq, event) in stored {
                                publish_event(&global, &sessions, session_id, seq, event);
                            }
                        }
                        let _ = reply.send(Ok(count));
                    }
                    Err(error) => {
                        // Canonicalization advances the in-memory agent state.
                        // A failed SQLite batch did not make those transitions
                        // durable, so its lifecycle must fail atomically too.
                        agent_lifecycles = lifecycle_before;
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Command::EventsSince(session_id, since, reply) => {
                let result = store.events_since(&session_id, since).map(|events| {
                    let live = live_menus.get(&session_id).filter(|menu| {
                        menu.fields
                            .get("seq")
                            .and_then(serde_json::Value::as_i64)
                            .is_some_and(|seq| seq > since)
                    });
                    view_with_live_menu(events, live)
                });
                respond(reply, result)
            }
            Command::EventCount(session_id, reply) => {
                respond(reply, store.event_count(&session_id))
            }
            Command::TimelineCount(session_id, reply) => {
                respond(reply, store.timeline_count(&session_id))
            }
            Command::FollowedTo(session_id, reply) => {
                respond(reply, store.followed_to(&session_id))
            }
            Command::ImportedBy(session_id, reply) => {
                respond(reply, store.imported_by(&session_id))
            }
            Command::MarkImported(session_id, reply) => {
                respond(reply, store.mark_imported(&session_id).map(|_| ()))
            }
            Command::RememberFollowed(session_id, at, reply) => {
                respond(reply, store.remember_followed(&session_id, at).map(|_| ()))
            }
            Command::WasDrivenHere(session_id, reply) => {
                respond(reply, store.was_driven_here(&session_id))
            }
            Command::BeginDriving(session_id, from, reply) => {
                respond(reply, store.begin_driving(&session_id, from).map(|_| ()))
            }
            Command::EndDriving(session_id, reply) => {
                respond(reply, store.end_driving(&session_id).map(|_| ()))
            }
            Command::DrivenFrom(session_id, reply) => {
                respond(reply, store.driven_from(&session_id))
            }
            Command::StillDriving(reply) => respond(reply, store.still_driving()),
            Command::UnfinishedTools(session_id, reply) => {
                respond(reply, store.unfinished_tools(&session_id))
            }
            Command::SessionStatus(session_id, reply) => {
                respond(reply, store.session_status(&session_id))
            }
            Command::SessionActivity(session_id, reply) => {
                respond(reply, store.session_activity(&session_id))
            }
            Command::SessionActivities(reply) => respond(reply, store.session_activities()),
            Command::TokenStats(session_id, reply) => {
                respond(reply, store.token_stats(&session_id))
            }
            Command::NoteSummaryRun(project, session_id, at, ms, reply) => respond(
                reply,
                store.note_summary_run(&project, &session_id, &at, ms),
            ),
            Command::SummaryRuns(project, limit, reply) => {
                respond(reply, store.summary_runs(&project, limit))
            }
            Command::ViewEvents(session_id, reply) => {
                let result = store
                    .view_events(&session_id)
                    .map(|events| {
                        let live = live_steering_menu(&store, &live_menus, &session_id);
                        view_with_live_menu(events, live.as_ref())
                    });
                respond(reply, result)
            }
            Command::HoldMessage(session_id, id, text, images, parts, at, reply) => respond(
                reply,
                store.hold_message(&session_id, &id, &text, &images, parts.as_ref(), &at),
            ),
            Command::HeldMessages(session_id, reply) => {
                respond(reply, store.held_messages(&session_id))
            }
            Command::TakeHeld(session_id, id, reply) => {
                respond(reply, store.take_held(&session_id, id.as_deref()))
            }
            Command::ReleaseHeld(id, reply) => respond(reply, store.release_held(&id)),
            Command::DropHeld(session_id, id, reply) => {
                respond(reply, store.drop_held(&session_id, &id))
            }
            Command::ForgetHeld(id, reply) => respond(reply, store.forget_held(&id)),
            Command::SteeringMenu(session_id, reply) => {
                respond(reply, steering_menu(&store, &live_menus, &session_id))
            }
            Command::OfferedMenu(session_id, reply) => {
                let _ = reply.send(Ok(offered_menu(&store, &live_menus, &session_id)));
            }
            Command::OfferCatalogue(session_id, menu, shared, reply) => {
                remember_catalogue(&store, &session_id, &menu);
                // A chat whose own session named the provider's commands --
                // one that woke meanwhile -- already shows them. Any other,
                // asleep, stopped or failed, is offered these. Never made the
                // chat's live menu: what it is set to stays its own, and what
                // a sent command is checked against stays its own session's
                // (bw-zldt.2).
                let lacking = live_menus.get(&session_id).is_none_or(|own| {
                    super::store::native_commands(&serde_json::Value::Object(own.fields.clone())).is_empty()
                });
                let offered = lacking
                    .then(|| live_steering_menu(&store, &live_menus, &session_id))
                    .flatten();
                let result = match offered {
                    None => Ok(()),
                    Some(mut offered) => {
                        let mut commands = offered
                            .fields
                            .get("commands")
                            .and_then(serde_json::Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        if !commands.iter().any(|command| command["execution"] == "shared") {
                            commands.extend(shared);
                        }
                        offered.fields.insert("commands".into(), serde_json::json!(commands));
                        store
                            .next_seq(&session_id)
                            .and_then(|seq| persist_event(&store, &session_id, offered, seq))
                            .map(|stored| {
                                if let Some((seq, event)) = stored {
                                    publish_event(&global, &sessions, session_id, seq, event);
                                }
                            })
                            .map_err(|error| error.to_string())
                    }
                };
                let _ = reply.send(result);
            }
            Command::Snapshot(session_id, reply) => {
                let result = (|| {
                    let started = std::time::Instant::now();
                    let live = live_steering_menu(&store, &live_menus, &session_id);
                    let history = view_with_live_menu(store.view_events(&session_id)?, live.as_ref());
                    let after_history = started.elapsed();
                    let page = store.transcript_items(&session_id, None, 40)?;
                    let after_page = started.elapsed();
                    let agents = store.projected_agents(&session_id)?;
                    tracing::info!(
                        session_id,
                        history_ms = after_history.as_millis(),
                        page_ms = (after_page - after_history).as_millis(),
                        agents_ms = (started.elapsed() - after_page).as_millis(),
                        "bounded snapshot phases"
                    );
                    Ok(SnapshotParts {
                        history,
                        page,
                        agents,
                    })
                })();
                respond(reply, result)
            }
            Command::TranscriptItems(session_id, before, limit, reply) => {
                respond(reply, store.transcript_items(&session_id, before, limit))
            }
            Command::AgentTranscriptItems(session_id, parent_id, before, limit, reply) => respond(
                reply,
                store.agent_transcript_items(&session_id, &parent_id, before, limit),
            ),
            Command::ProjectedAgents(session_id, reply) => {
                respond(reply, store.projected_agents(&session_id))
            }
            Command::Shutdown => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;

    /// The record goes through the actor the way every other write does, so a
    /// route can reach it without touching the connection (bw-altj).
    #[tokio::test]
    async fn what_has_been_said_about_a_chat_reads_back_through_the_actor() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();

        assert!(
            database.notices().await.unwrap().is_empty(),
            "a fresh database had something to say already"
        );

        database
            .mark_read(
                vec![
                    ("chat-1".to_string(), "errored".to_string()),
                    ("chat-2".to_string(), "idle".to_string()),
                ],
                "2026-09-22T00:00:00Z".to_string(),
            )
            .await
            .unwrap();
        database
            .mark_announced(
                "chat-1".to_string(),
                "waiting_permission".to_string(),
                "2026-09-22T00:01:00Z".to_string(),
            )
            .await
            .unwrap();

        let notices = database.notices().await.unwrap();
        assert_eq!(notices.len(), 2, "clearing two chats wrote {} rows", notices.len());
        assert_eq!(notices["chat-1"].read_state.as_deref(), Some("errored"));
        assert_eq!(
            notices["chat-1"].announced_state.as_deref(),
            Some("waiting_permission")
        );
        assert_eq!(notices["chat-2"].read_state.as_deref(), Some("idle"));
        assert_eq!(notices["chat-2"].announced_state, None);
    }

    fn event(id: usize) -> Event {
        serde_json::from_value(json!({
            "type": "notice", "sessionId": "chat-1", "seq": 999,
            "at": "2026-08-30T00:00:00.000Z", "text": format!("event {id}"),
            "providerEvent": {
                "provider": "codex", "threadId": "thread-1",
                "eventId": format!("event-{id}"), "delivery": "live"
            }
        }))
        .unwrap()
    }

    fn live_event(update: SessionUpdate) -> Event {
        match update {
            SessionUpdate::Event(event) => event,
            SessionUpdate::ReplayCommitted { .. } => panic!("expected a live event"),
        }
    }

    #[test]
    fn provider_refresh_preserves_the_connections_shared_guidance() {
        let previous: Event = serde_json::from_value(json!({"type":"session.menu","sessionId":"chat-1","sharedLibrary":{"revision":"one"},"commands":[{"name":"skill:review","execution":"shared"}]})).unwrap();
        let mut refreshed: Event = serde_json::from_value(json!({"type":"session.menu","sessionId":"chat-1","commands":[{"name":"compact"}]})).unwrap();
        preserve_shared_library(&mut refreshed, Some(&previous));
        assert_eq!(refreshed.fields["sharedLibrary"]["revision"], "one");
        assert_eq!(refreshed.fields["commands"].as_array().unwrap().len(), 2);
        preserve_shared_library(&mut refreshed, Some(&previous));
        assert_eq!(refreshed.fields["commands"].as_array().unwrap().len(), 2);
        refreshed.fields.insert("sharedLibrary".into(), json!({"revision":"two"}));
        preserve_shared_library(&mut refreshed, Some(&previous));
        assert_eq!(refreshed.fields["sharedLibrary"]["revision"], "two");
    }

    #[test]
    fn a_saved_chat_reuses_only_its_providers_live_steering_catalogue() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let session = |id: &str, brand: &str| Session {
            id: id.into(), brand: brand.into(), external_id: Some(format!("thread-{id}")),
            project_id: "project".into(), project_path: "/project".into(), cwd: "/project".into(),
            model: None, permission_mode: "on-request".into(), effort: None,
            collaboration_mode: None, profile: None, title: None, state: "dormant".into(),
            origin: "app".into(), created_at: "2026-09-14T00:00:00Z".into(),
            last_active_at: "2026-09-14T00:00:00Z".into(), last_spoke_at: None, begun_by: None, named_by_owner: false,
        };
        for row in [session("open", "codex"), session("saved", "codex"), session("other", "claude")] {
            store.create_session(&row).unwrap();
        }
        let menu: Event = serde_json::from_value(json!({
            "type":"session.menu", "sessionId":"open", "seq":7, "at":"2026-09-14T01:00:00Z",
            "models":[{"value":"gpt-5.6-sol","displayName":"GPT 5.6 Sol"}],
            "efforts":[{"value":"high","displayName":"High"}],
            "permissionModes":["on-request","never"],
            "collaborationModes":[{"value":"default","displayName":"Default"}],
            "commands":[{"name":"project-only"},{"name":"skill:private","execution":"shared"}], "skills":["private"], "sharedLibrary":{"revision":"private"},
            "agentDefinitions":[{"name":"worker"}],
            "configOptions":[{"id":"fast","currentValue":true}]
        })).unwrap();
        let live = HashMap::from([("open".to_string(), menu)]);
        let pinned: Event = serde_json::from_value(json!({
            "type":"session.pinned", "sessionId":"saved", "seq":1, "at":"2026-09-14T00:30:00Z",
            "permissionMode":null, "model":null, "effort":null, "collaborationMode":null,
            "configOptions":[{"id":"fast","currentValue":false}]
        })).unwrap();
        assert!(store.append_event(&pinned).unwrap());

        let restored = live_steering_menu(&store, &live, "saved").unwrap();
        assert_eq!(restored.fields["sessionId"], "saved");
        assert_eq!(restored.fields["models"][0]["value"], "gpt-5.6-sol");
        assert_eq!(restored.fields["efforts"][0]["value"], "high");
        for private in ["skills", "agentDefinitions", "sharedLibrary"] {
            assert!(restored.fields.get(private).is_none(), "{private} leaked between chats");
        }
        // The provider's own commands are listed for a slash; Atelier's are
        // read afresh from the library, not borrowed (bw-zldt.2).
        assert_eq!(restored.fields["commands"], json!([{"name":"project-only"}]));
        // The option is the provider's, so a stopped chat can be set with it;
        // the value is the one this chat chose, not the chat it came from.
        assert_eq!(restored.fields["configOptions"], json!([{"id":"fast","currentValue":false}]));
        assert!(live_steering_menu(&store, &live, "other").is_none());
    }

    /// A restart forgets every live menu. A stopped chat still has the
    /// choices its provider offered last time, so its effort and Fast mode
    /// can be set before the message that wakes it (bw-y5dc.1).
    #[test]
    fn a_stopped_chat_is_offered_its_providers_last_menu_after_a_restart() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let session = |id: &str, project: &str, profile: Option<&str>| Session {
            id: id.into(), brand: "claude".into(), external_id: Some(format!("thread-{id}")),
            project_id: project.into(), project_path: format!("/{project}"), cwd: format!("/{project}"),
            model: None, permission_mode: "default".into(), effort: None,
            collaboration_mode: None, profile: profile.map(str::to_string), title: None, state: "dormant".into(),
            origin: "app".into(), created_at: "2026-09-14T00:00:00Z".into(),
            last_active_at: "2026-09-14T00:00:00Z".into(), last_spoke_at: None, begun_by: None, named_by_owner: false,
        };
        for row in [
            session("spoke", "here", None),
            session("stopped", "here", None),
            session("elsewhere", "there", None),
            session("other-account", "here", Some("work")),
        ] {
            store.create_session(&row).unwrap();
        }
        let menu = json!({
            "type":"session.menu", "sessionId":"spoke", "seq":3, "at":"2026-09-14T01:00:00Z",
            "models":[{"value":"default","displayName":"Default"}],
            "efforts":[{"value":"default","displayName":"Default"},{"value":"high","displayName":"High"}],
            "commands":[{"name":"project-only"},{"name":"skill:review","execution":"shared"}],
            "configOptions":[
                {"id":"fast-mode","name":"Fast mode","type":"boolean","currentValue":true},
                {"id":"agent","type":"select","currentValue":"default","options":[{"value":"reviewer"}]}
            ]
        });
        store.remember_provider_catalogue("spoke", &menu).unwrap();
        let nothing_live = HashMap::new();

        let offered = live_steering_menu(&store, &nothing_live, "stopped").unwrap();
        assert_eq!(offered.kind, EventKind::SessionMenu);
        assert_eq!(offered.fields["sessionId"], "stopped");
        assert_eq!(offered.fields["efforts"][1]["value"], "high");
        assert_eq!(offered.fields["configOptions"][0]["id"], "fast-mode");
        // The chat that spoke had Fast mode on; this one never set it, so it
        // shows what its own agent will start at.
        assert_eq!(offered.fields["configOptions"][0]["currentValue"], false);
        assert_eq!(offered.fields["configOptions"][1]["currentValue"], "reviewer");
        // What the person could type is still listed after a restart (bw-zldt.2).
        assert_eq!(offered.fields["commands"], json!([{"name":"project-only"}]));
        // A later menu sent before the adapter named its commands changes the
        // choices and keeps the commands already written.
        let mut early = menu.clone();
        early["commands"] = json!([{"name":"skill:review","execution":"shared"}]);
        early["efforts"] = json!([{"value":"default","displayName":"Default"},{"value":"max","displayName":"Max"}]);
        store.remember_provider_catalogue("spoke", &early).unwrap();
        let offered = live_steering_menu(&store, &nothing_live, "stopped").unwrap();
        assert_eq!(offered.fields["efforts"][1]["value"], "max");
        assert_eq!(offered.fields["commands"], json!([{"name":"project-only"}]));
        // One that names them replaces them.
        early["commands"] = json!([{"name":"compact"}]);
        store.remember_provider_catalogue("spoke", &early).unwrap();
        let offered = live_steering_menu(&store, &nothing_live, "stopped").unwrap();
        assert_eq!(offered.fields["commands"], json!([{"name":"compact"}]));

        // Another project may allow its provider different things.
        assert!(live_steering_menu(&store, &nothing_live, "elsewhere").is_none());

        // Another account is another provider install as far as this knows.
        assert!(live_steering_menu(&store, &nothing_live, "other-account").is_none());
        assert_eq!(offered_menu(&store, &nothing_live, "stopped")["configOptions"][0]["id"], "fast-mode");
    }

    /// Worktrees of one project can each hold commands of their own, so a
    /// stopped chat lists its own folder's and never another's (bw-zldt.2).
    #[test]
    fn each_folder_of_a_project_keeps_its_own_provider_commands() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workbench.db");
        let store = Store::open(&path).unwrap();
        let session = |id: &str, cwd: &str| Session {
            id: id.into(), brand: "claude".into(), external_id: Some(format!("thread-{id}")),
            project_id: "project".into(), project_path: "/repo".into(), cwd: cwd.into(),
            model: None, permission_mode: "default".into(), effort: None,
            collaboration_mode: None, profile: None, title: None, state: "dormant".into(),
            origin: "app".into(), created_at: "now".into(), last_active_at: "now".into(),
            last_spoke_at: None, begun_by: None, named_by_owner: false,
        };
        for row in [
            session("main", "/repo"),
            session("tree", "/repo/worktrees/a"),
            session("main-stopped", "/repo"),
            session("tree-stopped", "/repo/worktrees/a"),
            session("elsewhere", "/repo/worktrees/b"),
        ] {
            store.create_session(&row).unwrap();
        }
        let menu = |id: &str, command: &str| json!({
            "type":"session.menu", "sessionId":id, "seq":1, "at":"now",
            "models":[{"value":"default","displayName":"Default"}],
            "commands":[{"name":command}]
        });
        store.remember_provider_catalogue("main", &menu("main", "main-only")).unwrap();
        store.remember_provider_catalogue("tree", &menu("tree", "tree-only")).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        let nothing_live = HashMap::new();
        let listed = |id: &str| live_steering_menu(&store, &nothing_live, id).unwrap().fields.get("commands").cloned();
        assert_eq!(listed("main-stopped"), Some(json!([{"name":"main-only"}])));
        assert_eq!(listed("tree-stopped"), Some(json!([{"name":"tree-only"}])));
        assert_eq!(listed("elsewhere"), None, "a folder never asked lists none, so it asks");

        // A live chat in another folder lends its choices, not its commands.
        let live = HashMap::from([("tree".to_string(), serde_json::from_value::<Event>(menu("tree", "tree-only")).unwrap())]);
        let lent = live_steering_menu(&store, &live, "main-stopped").unwrap();
        assert_eq!(lent.fields["commands"], json!([{"name":"main-only"}]));
    }

    /// A catalogue kept before commands were kept says nothing a slash could
    /// list. Asking the provider on a stopped chat's behalf fills it, shows the
    /// stopped chat its commands with Atelier's, and gives them to a stopped
    /// chat whose own imported menu named none (bw-zldt.2).
    #[tokio::test]
    async fn a_catalogue_kept_before_commands_is_filled_by_asking_for_a_stopped_chat() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        for id in ["old", "stopped", "imported"] {
            database.create_session(Session {
                id: id.into(), brand: "claude".into(), external_id: Some(format!("thread-{id}")),
                project_id: "here".into(), project_path: "/here".into(), cwd: "/here".into(),
                model: None, permission_mode: "default".into(), effort: None,
                collaboration_mode: None, profile: None, title: None, state: "dormant".into(),
                origin: "app".into(), created_at: "now".into(), last_active_at: "now".into(),
                last_spoke_at: None, begun_by: None, named_by_owner: false,
            }).await.unwrap();
        }
        let menu = |id: &str, commands: serde_json::Value| -> Event {
            serde_json::from_value(json!({
                "type":"session.menu", "sessionId":id, "seq":0, "at":"now",
                "models":[{"value":"default","displayName":"Default"}], "commands":commands
            })).unwrap()
        };
        // The shape a catalogue had before: models and no commands.
        database.append(menu("old", json!([]))).await.unwrap();
        database.append(menu("imported", json!([{"name":"skill:demo","execution":"shared"}]))).await.unwrap();
        // Restarted: nothing live, only what was kept.
        let database = { drop(database); ChatDb::open(&directory.path().join("workbench.db")).unwrap() };
        assert!(database.offered_menu("stopped".into()).await.unwrap().get("commands").is_none());

        let mut updates = database.subscribe_session("stopped");
        database.offer_catalogue(
            "stopped".into(),
            menu("stopped", json!([{"name":"compact"},{"name":"skill:stale","execution":"shared"}])),
            vec![json!({"name":"skill:demo","execution":"shared"})],
        ).await.unwrap();
        let SessionUpdate::Event(shown) = updates.recv().await.unwrap() else { panic!("no menu shown") };
        assert_eq!(shown.fields["commands"], json!([{"name":"compact"},{"name":"skill:demo","execution":"shared"}]));
        assert_eq!(shown.fields["models"][0]["value"], "default");
        assert_eq!(database.offered_menu("stopped".into()).await.unwrap()["commands"], json!([{"name":"compact"}]));
        // Kept, so the next restart does not need to ask.
        let database = { drop(database); ChatDb::open(&directory.path().join("workbench.db")).unwrap() };
        assert_eq!(database.offered_menu("stopped".into()).await.unwrap()["commands"], json!([{"name":"compact"}]));

        // A chat that stopped or failed rather than fell asleep is not awake
        // either, and is shown the same.
        for state in ["stopped", "errored"] {
            let id = format!("left-{state}");
            database.create_session(Session {
                id: id.clone(), brand: "claude".into(), external_id: Some(format!("thread-{id}")),
                project_id: "here".into(), project_path: "/here".into(), cwd: "/here".into(),
                model: None, permission_mode: "default".into(), effort: None,
                collaboration_mode: None, profile: None, title: None, state: state.into(),
                origin: "app".into(), created_at: "now".into(), last_active_at: "now".into(),
                last_spoke_at: None, begun_by: None, named_by_owner: false,
            }).await.unwrap();
            let mut updates = database.subscribe_session(&id);
            database.offer_catalogue(
                id.clone(),
                menu(&id, json!([{"name":"compact"}])),
                vec![json!({"name":"skill:demo","execution":"shared"})],
            ).await.unwrap();
            let SessionUpdate::Event(shown) = updates.recv().await.unwrap() else { panic!("no menu shown") };
            assert_eq!(shown.fields["commands"], json!([{"name":"compact"},{"name":"skill:demo","execution":"shared"}]), "{state}");
        }
    }

    /// Everything ever said, in the table the search reads.
    ///
    /// A word reaches the record as a message that opens and then grows a few
    /// characters at a time, and the search is a `LIKE` over the whole
    /// sentence — so a chat whose words were never assembled has nothing to
    /// match, whatever it said. Nothing assembled them: `open_message` and
    /// `grow_message` were called by their own unit tests and by nothing else,
    /// and `/api/workbench/search` answered `[]` for every word in every chat
    /// on this machine (bw-t26l.20).
    #[test]
    fn what_a_chat_said_is_searchable_once_it_has_been_said() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("workbench.db")).unwrap();
        let said = |kind: &str, fields: serde_json::Value| -> Event {
            let mut value = json!({"type":kind,"sessionId":"chat-1","seq":0,
                "at":"2026-09-04T00:00:00.000Z"});
            for (name, field) in fields.as_object().unwrap() {
                value[name] = field.clone();
            }
            serde_json::from_value(value).unwrap()
        };

        let mut seq = 0;
        let mut persist = |event: Event| {
            seq += 1;
            persist_event(&store, "chat-1", event, seq).unwrap();
        };
        persist(said("message.started", json!({"messageId":"m1","role":"assistant"})));
        // A sentence in pieces, which is how one actually arrives.
        persist(said("text.delta", json!({"messageId":"m1","text":"The word is PERI"})));
        persist(said("text.delta", json!({"messageId":"m1","text":"WINKLE in spend-a."})));
        persist(said("message.completed", json!({"messageId":"m1"})));

        let found = store.search("PERIWINKLE", 10).unwrap();
        assert_eq!(found.len(), 1, "the word was said once and found {} times", found.len());
        assert_eq!(found[0].text, "The word is PERIWINKLE in spend-a.");
        assert_eq!(found[0].role, "assistant");
        // What the panel draws: the sentence, and the words as they were
        // written in it. Marking is done by finding the second inside the
        // first, so a hit that answers neither draws an empty mark — which is
        // what the search screen did (search-panel.tsx, `split`).
        assert_eq!(found[0].sentence, "The word is PERIWINKLE in spend-a.");
        assert_eq!(found[0].matched, "PERIWINKLE");

        // Asked for in lower case, marked as it was said.
        let lower = store.search("periwinkle", 10).unwrap();
        assert_eq!(lower[0].matched, "PERIWINKLE");
        assert!(lower[0].sentence.contains(&lower[0].matched));

        // A message the provider took back is one nobody said.
        persist(said("message.retracted", json!({"messageId":"m1"})));
        assert!(store.search("PERIWINKLE", 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn workbench_core_actor_serializes_and_publishes_monotone_updates() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let mut chat = database.subscribe_session("chat-1");
        let mut all = database.subscribe_all();
        let mut tasks = Vec::new();
        for id in 0..20 {
            let database = database.clone();
            tasks.push(tokio::spawn(async move {
                database.append(event(id)).await.unwrap().unwrap()
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }

        let mut chat_seq = Vec::new();
        let mut all_seq = Vec::new();
        for _ in 0..20 {
            chat_seq.push(
                live_event(chat.recv().await.unwrap()).fields["seq"]
                    .as_i64()
                    .unwrap(),
            );
            all_seq.push(all.recv().await.unwrap().seq);
        }
        assert_eq!(chat_seq, (1..=20).collect::<Vec<_>>());
        assert_eq!(all_seq, chat_seq);
        assert_eq!(
            database
                .events_since("chat-1".into(), 0)
                .await
                .unwrap()
                .len(),
            20
        );

        // Live/replay duplication crosses the actor boundary once too.
        assert!(database.append(event(0)).await.unwrap().is_none());
        assert!(matches!(
            chat.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn workbench_core_actor_commits_replay_batches_once_and_publishes_in_order() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let mut chat = database.subscribe_session("chat-1");

        let mut replay = (0..500).map(event).collect::<Vec<_>>();
        replay.push(event(499));
        assert_eq!(database.append_many(replay).await.unwrap(), 500);
        assert_eq!(database.event_count("chat-1".into()).await.unwrap(), 500);

        for expected in 1..=500 {
            let received = live_event(chat.recv().await.unwrap());
            assert_eq!(received.fields["seq"], expected);
        }
        assert!(matches!(
            chat.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn historical_replay_publishes_one_authoritative_range() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let mut chat = database.subscribe_session("chat-1");
        let mut all = database.subscribe_all();

        assert_eq!(
            database
                .append_replay((0..500).map(event).collect())
                .await
                .unwrap(),
            500
        );
        assert_eq!(
            chat.recv().await.unwrap(),
            SessionUpdate::ReplayCommitted {
                from: 1,
                through: 500
            }
        );
        assert!(matches!(
            chat.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let update = all.recv().await.unwrap();
        assert_eq!(update.batch_from, Some(1));
        assert_eq!(update.seq, 500);
        assert!(matches!(
            all.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn transcript_reset_rebuilds_helper_lifecycle_and_private_history() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let at = "2026-09-02T00:00:00.000Z";
        let decode = |value| serde_json::from_value::<Event>(value).unwrap();

        database
            .append_many(vec![
                decode(json!({
                    "type":"agent.started","sessionId":"chat-1","seq":0,"at":at,
                    "agentId":"helper","toolCallId":"old-call","kind":"helper",
                    "what":"Inspect","agentType":null,"model":null
                })),
                decode(json!({
                    "type":"agent.finished","sessionId":"chat-1","seq":0,"at":at,
                    "agentId":"helper","state":"done","seconds":1,"tokens":1,
                    "calls":0,"model":null,"result":"old"
                })),
            ])
            .await
            .unwrap();

        database
            .append_many(vec![
                decode(json!({
                    "type":"transcript.reset","sessionId":"chat-1","seq":0,"at":at
                })),
                decode(json!({
                    "type":"agent.started","sessionId":"chat-1","seq":0,"at":at,
                    "agentId":"helper","toolCallId":"new-call","kind":"helper",
                    "what":"Inspect again","agentType":null,"model":null
                })),
                decode(json!({
                    "type":"message.started","sessionId":"chat-1","seq":0,"at":at,
                    "messageId":"answer","role":"assistant","parentToolCallId":"new-call"
                })),
                decode(json!({
                    "type":"text.delta","sessionId":"chat-1","seq":0,"at":at,
                    "messageId":"answer","text":"restored"
                })),
                decode(json!({
                    "type":"message.completed","sessionId":"chat-1","seq":0,"at":at,
                    "messageId":"answer"
                })),
            ])
            .await
            .unwrap();

        let agents = database.projected_agents("chat-1".into()).await.unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["toolCallId"], "new-call");
        let page = database
            .agent_transcript_items("chat-1".into(), "new-call".into(), None, 40)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0]["text"], "restored");
    }

    #[tokio::test]
    async fn workbench_core_actor_snapshots_facts_and_watermark_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        database
            .create_session(Session {
                id: "chat-1".into(),
                brand: "codex".into(),
                external_id: Some("thread-1".into()),
                project_id: "project-1".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                model: Some("gpt-5".into()),
                permission_mode: "on-request".into(),
                effort: Some("high".into()),
                collaboration_mode: None,
                profile: None,
                title: Some("Saved".into()),
                state: "dormant".into(),
                origin: "app".into(),
                created_at: "now".into(),
                last_active_at: "now".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        let menu: Event = serde_json::from_value(json!({
            "type":"session.menu","sessionId":"chat-1","seq":0,"at":"now",
            "models":[{"id":"gpt-5","label":"GPT-5"}]
        }))
        .unwrap();
        database.append(menu).await.unwrap();

        let snapshot = database.snapshot("chat-1".into()).await.unwrap();

        assert_eq!(snapshot.page.newest_seq, 1);
        assert!(snapshot
            .history
            .iter()
            .any(|event| event.kind == EventKind::SessionMenu
                && event.fields["seq"] == snapshot.page.newest_seq
                && event.fields["models"][0]["id"] == "gpt-5"));

        drop(database);
        let durable = Store::open(&directory.path().join("workbench.db")).unwrap();
        let stored = durable.view_events("chat-1").unwrap();
        let menu = stored
            .iter()
            .find(|event| event.kind == EventKind::SessionMenu)
            .unwrap();
        assert!(menu.fields.get("models").is_none());
        drop(durable);

        // The chat's history never holds the catalogue, but the reopened chat
        // is offered what its provider last announced, kept beside the chats
        // for exactly this, so it can be set before it is woken (bw-y5dc.1).
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let menus = database
            .snapshot("chat-1".into())
            .await
            .unwrap()
            .history
            .into_iter()
            .filter(|event| event.kind == EventKind::SessionMenu)
            .collect::<Vec<_>>();
        assert_eq!(menus.len(), 1);
        assert_eq!(menus[0].fields["models"][0]["id"], "gpt-5");
    }

    #[tokio::test]
    async fn pinned_nulls_leave_settings_untouched_while_provider_titles_persist() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        database
            .create_session(Session {
                id: "chat-1".into(),
                brand: "codex".into(),
                external_id: Some("thread-1".into()),
                project_id: "project-1".into(),
                project_path: "/project".into(),
                cwd: "/project".into(),
                model: Some("gpt-5".into()),
                permission_mode: "on-request".into(),
                effort: Some("high".into()),
                collaboration_mode: Some("default".into()),
                profile: None,
                title: Some("Old title".into()),
                state: "idle".into(),
                origin: "app".into(),
                created_at: "now".into(),
                last_active_at: "now".into(),
                last_spoke_at: None,
                begun_by: None,
                named_by_owner: false,
            })
            .await
            .unwrap();
        let pinned: Event = serde_json::from_value(json!({
            "type":"session.pinned","sessionId":"chat-1","seq":0,"at":"later",
            "permissionMode":null,"model":null,"effort":null,"collaborationMode":null,
            "title":"Provider title"
        }))
        .unwrap();
        database.append(pinned).await.unwrap();
        let session = database
            .get_session("chat-1".into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.title.as_deref(), Some("Provider title"));
        assert_eq!(session.model.as_deref(), Some("gpt-5"));
        assert_eq!(session.permission_mode, "on-request");
        assert_eq!(session.effort.as_deref(), Some("high"));
        assert_eq!(session.collaboration_mode.as_deref(), Some("default"));
    }

    #[tokio::test]
    async fn explicit_rename_survives_a_later_provider_title_and_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workbench.db");
        let database = ChatDb::open(&path).unwrap();
        database.create_session(Session {
            id: "chat-1".into(), brand: "codex".into(), external_id: Some("thread-1".into()),
            project_id: "project-1".into(), project_path: "/project".into(), cwd: "/project".into(),
            model: Some("gpt-5".into()), permission_mode: "on-request".into(), effort: Some("high".into()),
            collaboration_mode: Some("default".into()), profile: None, title: Some("Generated title".into()),
            state: "idle".into(), origin: "app".into(), created_at: "now".into(), last_active_at: "now".into(),
            last_spoke_at: None, begun_by: None, named_by_owner: false,
        }).await.unwrap();
        for value in [
            json!({
                "type":"session.pinned","sessionId":"chat-1","seq":0,"at":"later",
                "permissionMode":null,"model":null,"effort":null,"collaborationMode":null,
                "title":"My title","titleSource":"user"
            }),
            json!({
                "type":"session.pinned","sessionId":"chat-1","seq":0,"at":"latest",
                "permissionMode":null,"model":null,"effort":null,"collaborationMode":null,
                "title":"Generated title","acp":{"sessionUpdate":"session_info_update"}
            }),
        ] {
            database.append(serde_json::from_value(value).unwrap()).await.unwrap();
        }

        assert_eq!(database.get_session("chat-1".into()).await.unwrap().unwrap().title.as_deref(), Some("My title"));
        assert_eq!(database.steering_menu("chat-1".into()).await.unwrap()["title"], "My title");
        drop(database);
        assert_eq!(ChatDb::open(&path).unwrap().get_session("chat-1".into()).await.unwrap().unwrap().title.as_deref(), Some("My title"));
    }

    #[tokio::test]
    async fn workbench_core_actor_last_handle_joins_its_owned_worker() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let stopped = database.stopped_flag();
        let clone = database.clone();
        drop(database);
        assert!(!stopped.load(Ordering::SeqCst));
        drop(clone);
        assert!(stopped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn workbench_core_actor_keeps_agent_tombstones_across_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workbench.db");
        {
            let database = ChatDb::open(&path).unwrap();
            for value in [
                json!({"type":"agent.started","sessionId":"chat","seq":0,"at":"now","agentId":"a","toolCallId":"t","kind":"helper","what":"Inspect","agentType":null,"model":null}),
                json!({"type":"agent.finished","sessionId":"chat","seq":0,"at":"now","agentId":"a","state":"done","seconds":1,"tokens":2,"calls":3,"model":null,"result":"done"}),
            ] {
                database
                    .append(serde_json::from_value(value).unwrap())
                    .await
                    .unwrap();
            }
        }
        let database = ChatDb::open(&path).unwrap();
        let late:Event=serde_json::from_value(json!({"type":"agent.started","sessionId":"chat","seq":0,"at":"later","agentId":"a","toolCallId":"t","kind":"helper","what":"Late","agentType":null,"model":null})).unwrap();
        assert!(database.append(late).await.unwrap().is_none());
    }
}
