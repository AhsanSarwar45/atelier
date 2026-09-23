//! A chat's status, decided in one place from what can be checked now.
//!
//! The database value is only this decision's cached projection. Every reader
//! and every live signal comes through `reconcile`, so a reload, opening a
//! chat, sending a message and an adapter event all ask the same question of
//! the same facts. Those facts are the ones that stay true when a message is
//! lost: the runtime's own objects, the provider's record on disk and the
//! machine's open files (`liveness.rs`) — not the last thing somebody said.
use super::{actor::ChatDb, liveness, protocol::Event, store::Session};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};

/// Reads the existing runtime objects, without going through the command queue
/// or asking a provider to respond. Safe even while a command is outstanding.
pub type Reconciler =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;

/// Every state a chat is in while a turn is under way.
pub const ACTIVE_STATES: [&str; 7] = [
    "starting",
    "thinking",
    "streaming",
    "running_tool",
    "waiting_for_agents",
    "waiting_permission",
    // A chat folding itself up is working, and for longer than most of the
    // others: the middle run measured on this machine is 124 seconds. Left out
    // of this list it is not active, so "Ready" is written over a fold that is
    // still going and the chat drops off the working list while it runs.
    "summarising",
];

pub fn is_active(state: &str) -> bool {
    ACTIVE_STATES.contains(&state)
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
    /// Whether the prompt request is still outstanding. The adapter keeps it
    /// open for as long as it believes work is left, so on its own this is
    /// the adapter's belief, not proof of work (bw-1fw6).
    pub turn_open: bool,
    pub pending_answer: bool,
    pub activity: Option<Value>,
    pub outcome: Value,
    pub prompted_at: Option<DateTime<Utc>>,
}

/// What the app found out for itself, beside what the runtime believes.
#[derive(Clone, Copy, Debug, Default)]
pub struct Evidence {
    /// When the provider's record says the agent's reply ended, if its last
    /// word is an ending.
    pub reply_ended_at: Option<DateTime<Utc>>,
    /// Whether work the chat left running is alive, from `settle_background`.
    pub background: bool,
}

/// The one status decision. An old active database state is never evidence of
/// running work. Only terminal outcomes may survive a missing attachment.
pub fn resolve(
    session: &Session,
    runtime: Option<&RuntimeFacts>,
    evidence: &Evidence,
    now: DateTime<Utc>,
) -> Value {
    match runtime {
        Some(facts) if facts.connected => {
            if facts.pending_answer {
                return json!({"state":"waiting_permission","label":"Waiting for your answer"});
            }
            let turn_open = facts.turn_open && !reply_is_over(facts, evidence, now);
            if !turn_open && evidence.background {
                // The reply is over and a task it started is not. The label is
                // the browser's own word for the state.
                return json!({"state":"waiting_for_agents","label":Value::Null});
            }
            if !turn_open {
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

/// Whether the record shows the reply to the latest message is over, whatever
/// the prompt request is still doing. An ending written before the latest
/// message is about the reply before it, and one younger than `SETTLED` may
/// still be on its way over the wire.
fn reply_is_over(facts: &RuntimeFacts, evidence: &Evidence, now: DateTime<Utc>) -> bool {
    evidence.reply_ended_at.is_some_and(|ended| {
        facts.prompted_at.map_or(true, |prompted| ended >= prompted)
            && now
                .signed_duration_since(ended)
                .to_std()
                .is_ok_and(|age| age >= liveness::SETTLED)
    })
}

/// The provider's record of this chat, where it has one the app can read.
pub fn record_of(session: &Session) -> Option<PathBuf> {
    if session.brand != "claude" {
        return None;
    }
    let external = session.external_id.as_deref()?;
    let system = super::profiles::system_dir("claude")?;
    let config = super::profiles::chat_dir("claude", session.profile.as_deref(), &system);
    liveness::find_record(&config, external)
}

/// Close every task this chat left open that is shown to have ended, and say
/// whether any of it is still alive.
///
/// An ending is taken from, in order: the notice the provider wrote in its
/// record; a backgrounded command's output file that no process holds open
/// any more; a helper's own record ending its reply; the chat's process being
/// gone. Work nothing can show has ended stays open — a task is not closed on
/// a guess. A chat started from a terminal runs outside this app, so its
/// process not being attached here says nothing about its tasks.
pub async fn settle_background(
    database: &ChatDb,
    session: &Session,
    connected: bool,
    record: Option<&Path>,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    let agents = database.projected_agents(session.id.clone()).await?;
    let open: Vec<&Value> = agents
        .iter()
        .filter(|agent| !matches!(agent["state"].as_str(), Some("done" | "failed" | "stopped")))
        .collect();
    if open.is_empty() {
        return Ok(false);
    }
    let notices = record.map(liveness::record_endings).unwrap_or_default();
    let calls: Vec<String> = open
        .iter()
        .filter(|agent| agent["kind"] != "helper")
        .filter_map(|agent| agent["toolCallId"].as_str().map(str::to_string))
        .collect();
    let outputs: HashMap<String, PathBuf> = if calls.is_empty() {
        HashMap::new()
    } else {
        database
            .background_outputs(session.id.clone(), calls)
            .await?
            .into_iter()
            .filter_map(|(call, output)| Some((call, liveness::output_file(&output)?)))
            .collect()
    };
    let files: Vec<PathBuf> = outputs.values().cloned().collect();
    let held = liveness::held_open(&files);
    let process_gone = !connected && session.origin != "terminal";
    let mut alive = false;
    let mut endings = Vec::new();
    for agent in open {
        let Some(id) = agent["id"].as_str() else {
            continue;
        };
        let ending = if let Some(notice) = notices.get(id) {
            Some(notice.clone())
        } else if agent["kind"] == "helper" {
            record
                .and_then(|record| liveness::helper_reply(record, id))
                .filter(|(ended, _)| {
                    now.signed_duration_since(*ended)
                        .to_std()
                        .is_ok_and(|age| age >= liveness::SETTLED)
                })
                .map(|(_, words)| finished(id, "done", words))
                .or_else(|| process_gone.then(|| finished(id, "stopped", None)))
        } else {
            match agent["toolCallId"]
                .as_str()
                .and_then(|call| outputs.get(call))
            {
                Some(file) if held.contains(file) => None,
                Some(_) => Some(finished(id, "done", None)),
                None => process_gone.then(|| finished(id, "stopped", None)),
            }
        };
        match ending {
            Some(mut ending) => {
                let fields = ending.as_object_mut().expect("an ending is an object");
                // `model` on a finish overwrites the helper's own; a notice
                // does not know it.
                fields.remove("model");
                fields.insert("sessionId".into(), json!(session.id));
                fields.insert("seq".into(), json!(0));
                fields
                    .entry("at")
                    .or_insert_with(|| json!(now.to_rfc3339()));
                fields.insert("source".into(), json!("background-reconciliation"));
                endings.push(serde_json::from_value::<Event>(ending).map_err(|e| e.to_string())?);
            }
            None => alive = true,
        }
    }
    if !endings.is_empty() {
        database.append_many(endings).await?;
    }
    Ok(alive)
}

fn finished(id: &str, state: &str, words: Option<String>) -> Value {
    json!({
        "type":"agent.finished", "agentId":id, "state":state,
        "result":words, "seconds":0, "tokens":0, "calls":0
    })
}

/// How often a chat mid-turn has its tasks looked at. Its status does not
/// read them until the reply is over, and a turn publishes many events a
/// second; the sweep still comes every five.
const SETTLE_DURING_TURN: Duration = Duration::from_secs(3);

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
    let record = record_of(&session);
    reconcile_with(database, &session, runtime, record.as_deref(), Utc::now()).await
}

/// `reconcile` with the record and the clock given, for tests.
pub async fn reconcile_with(
    database: &ChatDb,
    session: &Session,
    runtime: Option<&RuntimeFacts>,
    record: Option<&Path>,
    now: DateTime<Utc>,
) -> Result<Value, String> {
    static SETTLED_AT: LazyLock<Mutex<HashMap<String, (Instant, bool)>>> =
        LazyLock::new(Default::default);
    let session_id = session.id.as_str();
    let connected = runtime.is_some_and(|facts| facts.connected);
    let mut evidence = Evidence {
        reply_ended_at: record.and_then(liveness::record_reply_ended_at),
        background: false,
    };
    let mid_turn = runtime.is_some_and(|facts| {
        facts.connected && facts.turn_open && !reply_is_over(facts, &evidence, now)
    });
    let recent = SETTLED_AT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .filter(|(at, _)| mid_turn && at.elapsed() < SETTLE_DURING_TURN)
        .map(|(_, alive)| *alive);
    evidence.background = match recent {
        Some(alive) => alive,
        None => {
            let alive = settle_background(database, session, connected, record, now).await?;
            SETTLED_AT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_id.to_string(), (Instant::now(), alive));
            alive
        }
    };
    let mut status = resolve(session, runtime, &evidence, now);
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
        fields.insert("at".into(), json!(now.to_rfc3339()));
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
            prompted_at: None,
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
            assert_eq!(
                resolve(
                    &saved(state),
                    Some(&idle()),
                    &Evidence::default(),
                    Utc::now()
                )["state"],
                "idle"
            );
        }
        let mut working = idle();
        working.turn_open = true;
        assert_eq!(
            resolve(
                &saved("idle"),
                Some(&working),
                &Evidence::default(),
                Utc::now()
            )["state"],
            "streaming"
        );
        working.pending_answer = true;
        assert_eq!(
            resolve(
                &saved("idle"),
                Some(&working),
                &Evidence::default(),
                Utc::now()
            )["state"],
            "waiting_permission"
        );
        working.connected = false;
        assert_eq!(
            resolve(
                &saved("streaming"),
                Some(&working),
                &Evidence::default(),
                Utc::now()
            )["state"],
            "dormant"
        );
    }
    #[test]
    fn detached_chats_preserve_outcomes_but_never_cached_activity() {
        for state in ["stopped", "errored", "idle", "dormant"] {
            assert_eq!(
                resolve(&saved(state), None, &Evidence::default(), Utc::now())["state"],
                state
            );
        }
        assert_eq!(
            resolve(&saved("streaming"), None, &Evidence::default(), Utc::now())["state"],
            "dormant"
        );
        let mut finished = idle();
        finished.outcome = json!({"state":"running_tool","label":"Retrying"});
        assert_eq!(
            resolve(
                &saved("running_tool"),
                Some(&finished),
                &Evidence::default(),
                Utc::now()
            )["state"],
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

    fn event(value: Value) -> Event {
        let mut value = value;
        value["sessionId"] = json!("chat");
        value["seq"] = json!(0);
        value["at"] = json!("2026-09-15T10:00:00Z");
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_held_prompt_is_over_once_the_record_says_the_reply_ended() {
        let now = Utc::now();
        let ago = |seconds| now - chrono::Duration::seconds(seconds);
        let mut held = idle();
        held.turn_open = true;
        held.prompted_at = Some(ago(600));
        let ended = |at| Evidence {
            reply_ended_at: Some(at),
            background: false,
        };
        let state = |facts: &RuntimeFacts, evidence: Evidence| {
            resolve(&saved("streaming"), Some(facts), &evidence, now)["state"].clone()
        };
        // The adapter still holds the request; the record says the reply is over.
        assert_eq!(state(&held, ended(ago(60))), "idle");
        // An ending that may still be on its way over the wire is not believed yet.
        assert_eq!(state(&held, ended(now)), "streaming");
        // An ending from before the latest message is the reply before.
        held.prompted_at = Some(ago(30));
        assert_eq!(state(&held, ended(ago(60))), "streaming");
        // Over, with a task it started still alive.
        held.prompted_at = Some(ago(600));
        let both = Evidence {
            reply_ended_at: Some(ago(60)),
            background: true,
        };
        assert_eq!(state(&held, both), "waiting_for_agents");
        let over = resolve(
            &saved("idle"),
            Some(&idle()),
            &Evidence {
                reply_ended_at: None,
                background: true,
            },
            now,
        );
        assert_eq!(over["state"], "waiting_for_agents");
        assert_eq!(over["label"], Value::Null);
        // While the reply is going, what it is doing is what it shows.
        assert_eq!(
            state(
                &held,
                Evidence {
                    reply_ended_at: None,
                    background: true
                }
            ),
            "streaming"
        );
        // A question waiting on the person outranks all of it.
        held.pending_answer = true;
        assert_eq!(state(&held, both), "waiting_permission");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn tasks_left_running_are_closed_on_what_can_be_checked() {
        let directory = tempfile::tempdir().unwrap();
        let db = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        db.create_session(saved("idle")).await.unwrap();
        let running = directory.path().join("running.output");
        let over = directory.path().join("over.output");
        std::fs::write(&running, "").unwrap();
        std::fs::write(&over, "done").unwrap();
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("exec 3>>\"$1\"; sleep 30")
            .arg("sh")
            .arg(&running)
            .spawn()
            .unwrap();
        let record = directory.path().join("record.jsonl");
        std::fs::write(&record, format!("{}\n", json!({"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-15T15:03:54Z",
            "content":"<task-notification><task-id>noticed</task-id><status>killed</status><summary>Background command \"x\" was stopped</summary></task-notification>"}))).unwrap();
        for (task, call, kind) in [
            ("running", "t1", "command"),
            ("over", "t2", "command"),
            ("noticed", "t3", "command"),
            ("unknown", "t4", "watch"),
            ("helper", "h1", "helper"),
        ] {
            db.append(event(json!({"type":"agent.started","agentId":task,"toolCallId":call,"kind":kind,"what":task,"agentType":null,"model":null}))).await.unwrap();
        }
        for (call, file) in [("t1", &running), ("t2", &over)] {
            db.append(event(json!({"type":"tool.completed","toolCallId":call,"ok":true,
                "output":format!("Command running in background with ID: x. Output is being written to: {}. You will be notified when it completes.", file.display())}))).await.unwrap();
        }
        // Wait for the child to have the file open before asking.
        for _ in 0..50 {
            if std::fs::read_dir("/proc/self").is_ok()
                && std::fs::read_dir(format!("/proc/{}/fd", child.id()))
                    .map(|fds| {
                        fds.flatten()
                            .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|to| to == running))
                    })
                    .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let session = db.get_session("chat".into()).await.unwrap().unwrap();
        let states = |agents: Vec<Value>| {
            agents
                .into_iter()
                .map(|a| {
                    (
                        a["id"].as_str().unwrap().to_string(),
                        a["state"].as_str().unwrap().to_string(),
                    )
                })
                .collect::<HashMap<_, _>>()
        };

        let alive = settle_background(&db, &session, true, Some(&record), Utc::now())
            .await
            .unwrap();
        assert!(alive);
        let now = states(db.projected_agents("chat".into()).await.unwrap());
        assert_eq!(now["running"], "running");
        assert_eq!(now["over"], "done");
        assert_eq!(now["noticed"], "stopped");
        assert_eq!(now["unknown"], "running");
        assert_eq!(now["helper"], "running");

        // Started from a terminal: not being attached here ends nothing.
        let mut outside = session.clone();
        outside.origin = "terminal".into();
        assert!(
            settle_background(&db, &outside, false, Some(&record), Utc::now())
                .await
                .unwrap()
        );
        assert_eq!(
            states(db.projected_agents("chat".into()).await.unwrap())["helper"],
            "running"
        );

        // The chat's process is gone: what cannot be shown alive has stopped,
        // and a command still writing its file is still running.
        assert!(
            settle_background(&db, &session, false, Some(&record), Utc::now())
                .await
                .unwrap()
        );
        let now = states(db.projected_agents("chat".into()).await.unwrap());
        assert_eq!(now["helper"], "stopped");
        assert_eq!(now["unknown"], "stopped");
        assert_eq!(now["running"], "running");
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[tokio::test]
    async fn the_status_says_background_working_until_the_last_task_ends() {
        let directory = tempfile::tempdir().unwrap();
        let db = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        db.create_session(saved("idle")).await.unwrap();
        db.append(event(json!({"type":"agent.started","agentId":"h","toolCallId":"h","kind":"helper","what":"h","agentType":null,"model":null}))).await.unwrap();
        let session = db.get_session("chat".into()).await.unwrap().unwrap();
        let status = reconcile_with(&db, &session, Some(&idle()), None, Utc::now())
            .await
            .unwrap();
        assert_eq!(status["state"], "waiting_for_agents");
        db.append(event(json!({"type":"agent.finished","agentId":"h","state":"done","result":"ok","seconds":0,"tokens":0,"calls":0}))).await.unwrap();
        let status = reconcile_with(&db, &session, Some(&idle()), None, Utc::now())
            .await
            .unwrap();
        assert_eq!(status["state"], "idle");
        // Reopened after a restart with nothing attached: the task is closed too.
        db.append(event(json!({"type":"agent.started","agentId":"h2","toolCallId":"h2","kind":"helper","what":"h2","agentType":null,"model":null}))).await.unwrap();
        reconcile(&db, "chat", None).await.unwrap();
        let agents = db.projected_agents("chat".into()).await.unwrap();
        assert!(
            agents.iter().all(|agent| agent["state"] != "running"),
            "{agents:?}"
        );
    }

    #[tokio::test]
    async fn the_sweep_finds_a_chat_whose_last_status_is_active_even_when_its_row_is_not() {
        let directory = tempfile::tempdir().unwrap();
        let db = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        db.create_session(saved("idle")).await.unwrap();
        assert!(db.active_session_ids().await.unwrap().is_empty());
        db.append(event(json!({"type":"session.state","state":"running_tool","label":"Terminal","detail":null,"call":null}))).await.unwrap();
        db.update_session(
            "chat".into(),
            super::super::store::SessionPatch {
                state: Some("dormant".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            db.get_session("chat".into()).await.unwrap().unwrap().state,
            "dormant"
        );
        assert_eq!(
            db.active_session_ids().await.unwrap(),
            vec!["chat".to_string()]
        );
    }

    /// Settles a real chat in a copy of a real database:
    /// `STATUS_DB=copy.db STATUS_CHAT=id cargo test --lib real_chat -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn real_chat_settles_from_what_can_be_checked() {
        let (Ok(path), Ok(chat)) = (std::env::var("STATUS_DB"), std::env::var("STATUS_CHAT"))
        else {
            return;
        };
        let db = ChatDb::open(std::path::Path::new(&path)).unwrap();
        let session = db.get_session(chat.clone()).await.unwrap().unwrap();
        println!("record {:?}", record_of(&session));
        let record = record_of(&session);
        println!(
            "reply ended {:?}",
            record.as_deref().and_then(liveness::record_reply_ended_at)
        );
        println!("status {}", reconcile(&db, &chat, None).await.unwrap());
        for agent in db.projected_agents(chat).await.unwrap() {
            println!("{} {} {}", agent["id"], agent["kind"], agent["state"]);
        }
    }
}
