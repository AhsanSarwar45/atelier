//! One blocking SQLite owner behind asynchronous request channels.
//!
//! `rusqlite::Connection` never enters an Axum request task. The worker assigns
//! event sequence numbers and publishes only committed appends, so replay,
//! per-chat tails and the app-wide watch all observe one monotone order.

use super::protocol::{Event, EventKind};
use super::store::{
    SearchHit, Session, SessionActivity, SessionPatch, Spend, Store, TokenStats, TranscriptItemPage,
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
    GetSession(String, Reply<Option<Session>>),
    SessionByExternalId(String, Reply<Option<Session>>),
    UpdateSession(String, SessionPatch, Option<String>, Reply<()>),
    MarkSpoke(String, String, Reply<()>),
    ListSessions(Option<String>, Reply<Vec<Session>>),
    ListRestoreSessions(Option<String>, bool, Reply<Vec<Session>>),
    MarkAllDormant(Reply<usize>),
    BeadsForSessions(Vec<String>, Reply<HashMap<String, Vec<String>>>),
    BeadsForSession(String, Reply<Vec<String>>),
    RememberBeadLink(String, String, String, String, Reply<()>),
    SessionsForBead(String, Reply<Vec<Session>>),
    Search(String, usize, Reply<Vec<SearchHit>>),
    Spend(Reply<Vec<Spend>>),
    ToolDetails(String, String, Reply<Option<serde_json::Value>>),
    Append(Event, Reply<Option<Event>>),
    AppendMany(Vec<Event>, Reply<usize>),
    EventsSince(String, i64, Reply<Vec<Event>>),
    EventCount(String, Reply<i64>),
    TimelineCount(String, Reply<i64>),
    FollowedTo(String, Reply<Option<i64>>),
    ImportedBy(String, Reply<Option<i64>>),
    MarkImported(String, Reply<()>),
    RememberFollowed(String, i64, Reply<()>),
    WasDrivenHere(String, Reply<bool>),
    SessionActivity(String, Reply<SessionActivity>),
    SessionActivities(Reply<HashMap<String, SessionActivity>>),
    TokenStats(String, Reply<TokenStats>),
    NoteSummaryRun(String, String, String, i64, Reply<()>),
    SummaryRuns(String, usize, Reply<Vec<i64>>),
    ViewEvents(String, Reply<Vec<Event>>),
    SteeringMenu(String, Reply<serde_json::Value>),
    Snapshot(String, Reply<SnapshotParts>),
    TranscriptItems(String, Option<i64>, usize, Reply<TranscriptItemPage>),
    ProjectedAgents(String, Reply<Vec<serde_json::Value>>),
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
    sessions: Arc<Mutex<HashMap<String, broadcast::Sender<Event>>>>,
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

    pub async fn list_sessions(&self, project_id: Option<String>) -> Result<Vec<Session>, String> {
        self.request(|reply| Command::ListSessions(project_id, reply))
            .await
    }

    pub async fn list_restore_sessions(
        &self,
        project_id: Option<String>,
        everything: bool,
    ) -> Result<Vec<Session>, String> {
        self.request(|reply| Command::ListRestoreSessions(project_id, everything, reply))
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
        self.request(|reply| Command::AppendMany(events, reply))
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
    pub async fn was_driven_here(&self, session_id: String) -> Result<bool, String> {
        self.request(|reply| Command::WasDrivenHere(session_id, reply))
            .await
    }
    pub async fn session_activity(&self, session_id: String) -> Result<SessionActivity, String> {
        self.request(|reply| Command::SessionActivity(session_id, reply))
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

    pub fn subscribe_session(&self, session_id: &str) -> broadcast::Receiver<Event> {
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
    match event.kind {
        EventKind::SessionStarted => {
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
        }
        EventKind::SessionState => patch.state = string(event, "state"),
        EventKind::SessionPinned => {
            if let Some(title) = string(event, "title") {
                patch.title = Some(Some(title));
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
        EventKind::SessionEnded => patch.state = Some("dormant".into()),
        _ => return Ok(()),
    }
    store.update_session(session_id, patch, string(event, "at").as_deref())
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

fn persist_event(
    store: &Store,
    session_id: &str,
    mut event: Event,
    seq: i64,
) -> rusqlite::Result<Option<(i64, Event)>> {
    event
        .fields
        .insert("seq".to_string(), serde_json::json!(seq));
    if !store.append_event(&event)? {
        return Ok(None);
    }
    apply_session_fact(store, session_id, &event)?;
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

fn publish_event(
    global: &broadcast::Sender<StoreUpdate>,
    sessions: &Arc<Mutex<HashMap<String, broadcast::Sender<Event>>>>,
    session_id: String,
    seq: i64,
    event: Event,
) {
    if let Some(sender) = sessions.lock().unwrap().get(&session_id) {
        let _ = sender.send(event.clone());
    }
    let _ = global.send(StoreUpdate {
        session_id,
        seq,
        event,
    });
}

fn run(
    mut store: Store,
    mut commands: mpsc::UnboundedReceiver<Command>,
    global: broadcast::Sender<StoreUpdate>,
    sessions: Arc<Mutex<HashMap<String, broadcast::Sender<Event>>>>,
) {
    let mut agent_lifecycles: HashMap<String, super::lifecycle::AgentLifecycle> = HashMap::new();
    while let Some(command) = commands.blocking_recv() {
        match command {
            Command::CreateSession(session, reply) => {
                respond(reply, store.create_session(&session))
            }
            Command::DeleteSession(id, reply) => respond(reply, store.delete_session(&id)),
            Command::GetSession(id, reply) => respond(reply, store.get_session(&id)),
            Command::SessionByExternalId(id, reply) => {
                respond(reply, store.session_by_external_id(&id))
            }
            Command::UpdateSession(id, patch, touch_at, reply) => {
                respond(reply, store.update_session(&id, patch, touch_at.as_deref()))
            }
            Command::MarkSpoke(id, at, reply) => respond(reply, store.mark_spoke(&id, &at)),
            Command::ListSessions(project_id, reply) => {
                respond(reply, store.list_sessions(project_id.as_deref()))
            }
            Command::ListRestoreSessions(project_id, everything, reply) => respond(
                reply,
                store.list_restore_sessions(project_id.as_deref(), everything),
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
                    Ok(Some((session_id, seq, event))) => {
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
            Command::AppendMany(events, reply) => {
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
                    Ok(stored) => {
                        let count = stored.len();
                        for (session_id, seq, event) in stored {
                            publish_event(&global, &sessions, session_id, seq, event);
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
                respond(reply, store.events_since(&session_id, since))
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
                respond(reply, store.view_events(&session_id))
            }
            Command::SteeringMenu(session_id, reply) => {
                respond(reply, store.steering_menu(&session_id))
            }
            Command::Snapshot(session_id, reply) => {
                let result = (|| {
                    let started = std::time::Instant::now();
                    let history = store.view_events(&session_id)?;
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
            chat_seq.push(chat.recv().await.unwrap().fields["seq"].as_i64().unwrap());
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
            let received = chat.recv().await.unwrap();
            assert_eq!(received.fields["seq"], expected);
        }
        assert!(matches!(
            chat.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
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
                title: Some("Saved".into()),
                state: "dormant".into(),
                origin: "app".into(),
                created_at: "now".into(),
                last_active_at: "now".into(),
                last_spoke_at: None,
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
                && event.fields["seq"] == snapshot.page.newest_seq));
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
                title: Some("Old title".into()),
                state: "idle".into(),
                origin: "app".into(),
                created_at: "now".into(),
                last_active_at: "now".into(),
                last_spoke_at: None,
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
