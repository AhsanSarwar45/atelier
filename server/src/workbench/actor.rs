//! One blocking SQLite owner behind asynchronous request channels.
//!
//! `rusqlite::Connection` never enters an Axum request task. The worker assigns
//! event sequence numbers and publishes only committed appends, so replay,
//! per-chat tails and the app-wide watch all observe one monotone order.

use super::protocol::{Event, EventKind};
use super::store::{Session, SessionPatch, Store, TranscriptItemPage};
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

enum Command {
    CreateSession(Session, Reply<()>),
    GetSession(String, Reply<Option<Session>>),
    SessionByExternalId(String, Reply<Option<Session>>),
    UpdateSession(String, SessionPatch, Option<String>, Reply<()>),
    MarkSpoke(String, String, Reply<()>),
    ListSessions(Option<String>, Reply<Vec<Session>>),
    BeadsForSessions(Vec<String>, Reply<HashMap<String, Vec<String>>>),
    Append(Event, Reply<Option<Event>>),
    EventsSince(String, i64, Reply<Vec<Event>>),
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
        self.request(|reply| Command::MarkSpoke(id, at, reply)).await
    }

    pub async fn list_sessions(&self, project_id: Option<String>) -> Result<Vec<Session>, String> {
        self.request(|reply| Command::ListSessions(project_id, reply))
            .await
    }

    pub async fn beads_for_sessions(
        &self,
        session_ids: Vec<String>,
    ) -> Result<HashMap<String, Vec<String>>, String> {
        self.request(|reply| Command::BeadsForSessions(session_ids, reply)).await
    }

    /// Append a provider event after assigning its durable sequence number.
    /// A duplicate provider identity returns `None` and publishes nothing.
    pub async fn append(&self, event: Event) -> Result<Option<Event>, String> {
        self.request(|reply| Command::Append(event, reply)).await
    }

    pub async fn events_since(&self, session_id: String, since: i64) -> Result<Vec<Event>, String> {
        self.request(|reply| Command::EventsSince(session_id, since, reply))
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
    event.fields.get(name).and_then(serde_json::Value::as_str).map(str::to_string)
}

fn apply_session_fact(store: &Store, session_id: &str, event: &Event) -> rusqlite::Result<()> {
    let mut patch = SessionPatch::default();
    match event.kind {
        EventKind::SessionStarted => {
            if event.fields.contains_key("externalId") { patch.external_id = Some(string(event, "externalId")); }
            if event.fields.contains_key("model") { patch.model = Some(string(event, "model")); }
            if let Some(mode) = string(event, "permissionMode") { patch.permission_mode = Some(mode); }
            if event.fields.contains_key("effort") { patch.effort = Some(string(event, "effort")); }
            if event.fields.contains_key("collaborationMode") { patch.collaboration_mode = Some(string(event, "collaborationMode")); }
        }
        EventKind::SessionState => patch.state = string(event, "state"),
        EventKind::SessionPinned => {
            if event.fields.contains_key("model") { patch.model = Some(string(event, "model")); }
            if let Some(mode) = string(event, "permissionMode") { patch.permission_mode = Some(mode); }
            if event.fields.contains_key("effort") { patch.effort = Some(string(event, "effort")); }
            if event.fields.contains_key("collaborationMode") { patch.collaboration_mode = Some(string(event, "collaborationMode")); }
        }
        EventKind::SessionEnded => patch.state = Some("dormant".into()),
        _ => return Ok(()),
    }
    store.update_session(session_id, patch, string(event, "at").as_deref())
}

fn run(
    store: Store,
    mut commands: mpsc::UnboundedReceiver<Command>,
    global: broadcast::Sender<StoreUpdate>,
    sessions: Arc<Mutex<HashMap<String, broadcast::Sender<Event>>>>,
) {
    while let Some(command) = commands.blocking_recv() {
        match command {
            Command::CreateSession(session, reply) => {
                respond(reply, store.create_session(&session))
            }
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
            Command::BeadsForSessions(ids, reply) => {
                respond(reply, store.beads_for_sessions(&ids))
            }
            Command::Append(mut event, reply) => {
                let session_id = event
                    .fields
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let result = store.next_seq(&session_id).and_then(|seq| {
                    event
                        .fields
                        .insert("seq".to_string(), serde_json::json!(seq));
                    store
                        .append_event(&event)
                        .and_then(|appended| {
                            if appended { apply_session_fact(&store, &session_id, &event)?; }
                            Ok(appended.then_some((seq, event)))
                        })
                });
                match result {
                    Ok(Some((seq, event))) => {
                        // Commit precedes publication. Both channels are sent
                        // from this one actor, preserving the same seq order.
                        if let Some(sender) = sessions.lock().unwrap().get(&session_id) {
                            let _ = sender.send(event.clone());
                        }
                        let _ = global.send(StoreUpdate {
                            session_id,
                            seq,
                            event: event.clone(),
                        });
                        let _ = reply.send(Ok(Some(event)));
                    }
                    Ok(None) => {
                        let _ = reply.send(Ok(None));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error.to_string()));
                    }
                }
            }
            Command::EventsSince(session_id, since, reply) => {
                respond(reply, store.events_since(&session_id, since))
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
}
