//! Runtime status is derived; the database value is only its cached projection.
use super::{actor::ChatDb, protocol::Event, store::Session};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin, sync::Arc};

/// Reads the existing runtime objects, without going through the command queue
/// or asking a provider to respond. Safe even while a command is outstanding.
pub type Reconciler =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;

pub fn is_active(state: &str) -> bool {
    matches!(
        state,
        "starting"
            | "thinking"
            | "streaming"
            | "running_tool"
            | "waiting_for_agents"
            | "waiting_permission"
    )
}

/// Membership follows the actual prompt future's lifetime, including failure
/// to spawn, cancellation and unwinding. It is not a last-event status flag.
pub type Requests = Arc<std::sync::Mutex<std::collections::HashSet<u64>>>;
pub struct RequestLease {
    requests: Requests,
    generation: u64,
}
impl RequestLease {
    pub fn new(requests: Requests, generation: u64) -> Self {
        requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(generation);
        Self {
            requests,
            generation,
        }
    }
}
impl Drop for RequestLease {
    fn drop(&mut self) {
        self.requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.generation);
    }
}

pub struct RuntimeFacts {
    pub connected: bool,
    pub turn_open: bool,
    pub pending_answer: bool,
    pub activity: Option<Value>,
    pub outcome: Value,
}

/// The one status decision. An old active database state is never evidence of
/// running work. Only terminal outcomes may survive a missing attachment.
pub fn resolve(session: &Session, runtime: Option<&RuntimeFacts>) -> Value {
    match runtime {
        Some(facts) if facts.connected => {
            if facts.pending_answer {
                return json!({"state":"waiting_permission","label":"Waiting for your answer"});
            }
            if !facts.turn_open {
                // A provider notice can outlive its turn; it cannot keep Stop
                // or an activity clock alive after the request has finished.
                return if facts.outcome["state"].as_str().is_some_and(is_active) {
                    json!({"state":"idle","label":"Ready"})
                } else {
                    facts.outcome.clone()
                };
            }
            facts
                .activity
                .clone()
                .unwrap_or_else(|| json!({"state":"streaming","label":"Working"}))
        }
        _ => match session.state.as_str() {
            "stopped" => json!({"state":"stopped","label":"Stopped"}),
            "errored" => json!({"state":"errored","label":"Failed"}),
            "idle" if runtime.is_none() => json!({"state":"idle","label":"Ready"}),
            _ if session.brand == super::local::BRAND
                && session.model.is_none()
                && session.state != "dormant" =>
            {
                json!({"state":"idle","label":"Ready"})
            }
            _ => json!({"state":"dormant","label":"Asleep"}),
        },
    }
}

/// Recompute, persist only a change, and publish through the normal event log.
/// Live callers hold the runtime's activity lock through this operation, so a
/// terminal transition cannot race an older active snapshot into the database.
pub async fn reconcile(
    database: &ChatDb,
    session_id: &str,
    runtime: Option<&RuntimeFacts>,
) -> Result<Value, String> {
    let Some(session) = database.get_session(session_id.to_string()).await? else {
        return Ok(Value::Null);
    };
    let mut status = resolve(&session, runtime);
    let saved = database.session_status(session_id.to_string()).await?;
    let same_projection = status["state"] == session.state
        && saved.as_ref().is_some_and(|saved| {
            ["state", "label", "detail", "call"]
                .into_iter()
                .all(|field| {
                    saved.get(field).unwrap_or(&Value::Null)
                        == status.get(field).unwrap_or(&Value::Null)
                })
        });
    if !same_projection {
        let fields = status.as_object_mut().expect("status is an object");
        fields.insert("type".into(), json!("session.state"));
        fields.insert("sessionId".into(), json!(session_id));
        fields.insert("seq".into(), json!(0));
        fields.insert("at".into(), json!(chrono::Utc::now().to_rfc3339()));
        fields.entry("detail").or_insert(Value::Null);
        fields.entry("call").or_insert(Value::Null);
        fields.insert("source".into(), json!("runtime-reconciliation"));
        let event: Event =
            serde_json::from_value(status.clone()).map_err(|error| error.to_string())?;
        database.append(event).await?;
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn saved(state: &str) -> Session {
        serde_json::from_value(json!({
            "id":"chat", "brand":"claude", "projectId":"project", "projectPath":"/test", "cwd":"/test",
            "permissionMode":"default", "state":state, "origin":"atelier", "createdAt":"2026-09-12T00:00:00Z", "lastActiveAt":"2026-09-12T00:00:00Z"
        })).unwrap()
    }
    fn idle() -> RuntimeFacts {
        RuntimeFacts {
            connected: true,
            turn_open: false,
            pending_answer: false,
            activity: Some(json!({"state":"streaming","label":"Answering"})),
            outcome: json!({"state":"idle","label":"Ready"}),
        }
    }
    #[test]
    fn cached_active_states_never_outvote_actual_runtime_work() {
        for state in [
            "starting",
            "thinking",
            "streaming",
            "running_tool",
            "waiting_for_agents",
            "waiting_permission",
            "stopped",
            "errored",
            "idle",
        ] {
            assert_eq!(resolve(&saved(state), Some(&idle()))["state"], "idle");
        }
        let mut working = idle();
        working.turn_open = true;
        assert_eq!(
            resolve(&saved("idle"), Some(&working))["state"],
            "streaming"
        );
        working.pending_answer = true;
        assert_eq!(
            resolve(&saved("idle"), Some(&working))["state"],
            "waiting_permission"
        );
        working.connected = false;
        assert_eq!(
            resolve(&saved("streaming"), Some(&working))["state"],
            "dormant"
        );
    }
    #[test]
    fn detached_chats_preserve_outcomes_but_never_cached_activity() {
        for state in ["stopped", "errored", "idle", "dormant"] {
            assert_eq!(resolve(&saved(state), None)["state"], state);
        }
        assert_eq!(resolve(&saved("streaming"), None)["state"], "dormant");
        let mut finished = idle();
        finished.outcome = json!({"state":"running_tool","label":"Retrying"});
        assert_eq!(
            resolve(&saved("running_tool"), Some(&finished))["state"],
            "idle"
        );
    }
    #[tokio::test]
    async fn aborted_prompt_futures_cannot_leave_active_request_facts() {
        let requests = Requests::default();
        let lease = RequestLease::new(requests.clone(), 7);
        let task = tokio::spawn(async move {
            let _lease = lease;
            std::future::pending::<()>().await;
        });
        assert!(requests.lock().unwrap().contains(&7));
        task.abort();
        let _ = task.await;
        assert!(requests.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn reconciliation_repairs_the_record_once_without_an_event_loop() {
        let directory = tempfile::tempdir().unwrap();
        let db = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        db.create_session(saved("streaming")).await.unwrap();
        reconcile(&db, "chat", Some(&idle())).await.unwrap();
        assert_eq!(
            db.get_session("chat".into()).await.unwrap().unwrap().state,
            "idle"
        );
        let count = db.event_count("chat".into()).await.unwrap();
        reconcile(&db, "chat", Some(&idle())).await.unwrap();
        assert_eq!(db.event_count("chat".into()).await.unwrap(), count);
    }

    #[tokio::test]
    async fn reconciliation_repairs_metadata_even_when_the_state_word_matches() {
        let directory = tempfile::tempdir().unwrap();
        let db = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        db.create_session(saved("idle")).await.unwrap();
        db.append(
            serde_json::from_value(json!({
                "type":"session.state", "sessionId":"chat", "seq":0,
                "at":"2026-09-12T00:00:00Z", "state":"idle", "label":"Answering",
                "detail":"stale command", "call":{"kind":"shell"}
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        reconcile(&db, "chat", Some(&idle())).await.unwrap();
        let status = db.session_status("chat".into()).await.unwrap().unwrap();
        assert_eq!(status["label"], "Ready");
        assert_eq!(status["detail"], Value::Null);
        assert_eq!(status["call"], Value::Null);
    }

    #[tokio::test]
    async fn reconciliation_repairs_a_divergent_session_row_too() {
        let directory = tempfile::tempdir().unwrap();
        let db = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        db.create_session(saved("idle")).await.unwrap();
        reconcile(&db, "chat", Some(&idle())).await.unwrap();
        db.update_session(
            "chat".into(),
            super::super::store::SessionPatch {
                state: Some("streaming".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();

        reconcile(&db, "chat", Some(&idle())).await.unwrap();
        assert_eq!(
            db.get_session("chat".into()).await.unwrap().unwrap().state,
            "idle"
        );
    }
}
