//! Stopping a chat that has grown past the limit set for it.
//!
//! The measurement is the one the memory badge already shows: every process a
//! chat owns — its adapter, its provider, its subagents and every shell below
//! them — charged its proportional share of RAM and of swap (`memory.rs`).
//!
//! The limit is `workbench.memory.limit-gb`, unset by default. While it is
//! unset this watcher reads one setting every few seconds and does nothing
//! else.
//!
//! When a chat is over the limit twice running, it is closed — which tears
//! down the adapter's whole process group — and then sent a message naming
//! what it spent. It has no driver by then, so delivering that message takes
//! the same dormant path a person's own message takes to a sleeping chat, and
//! the chat comes back on a fresh process. Its first sight of that process is
//! the bill for the last one.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::memory;
use super::protocol::{Command, CommandKind};
use super::registry::WorkbenchRegistry;

/// As often as the badge asks, so the limit reacts about as fast as the number
/// a person can watch.
const EVERY: Duration = Duration::from_secs(3);

/// How many samples in a row a chat may measure over its limit before it is
/// stopped. Two, so a command that briefly balloons and then exits does not
/// cost the chat its life.
const STRIKES: u32 = 2;

/// How long a chat is left alone after being stopped. A relaunched chat needs
/// time to settle, and striking it on the two samples that follow its own
/// restart would be a loop rather than a limit.
const SETTLING: Duration = Duration::from_secs(60);

/// What the watcher remembers between samples: who is over, and who was only
/// just dealt with.
#[derive(Default)]
struct Standing {
    strikes: HashMap<String, u32>,
    settling: HashMap<String, Instant>,
}

impl Standing {
    /// The chats to stop, given what this sample measured. A chat over the
    /// limit earns a strike; one at or under it, or gone from the report
    /// altogether, loses the strikes it had. A chat still settling after being
    /// stopped is passed over entirely.
    fn judge(&mut self, measured: &[(String, u64)], limit: u64, now: Instant) -> Vec<String> {
        self.settling.retain(|_, since| now < *since + SETTLING);
        let seen: Vec<&String> = measured.iter().map(|(id, _)| id).collect();
        self.strikes
            .retain(|id, _| seen.iter().any(|seen| *seen == id));
        let mut stopping = Vec::new();
        for (id, bytes) in measured {
            if self.settling.contains_key(id) {
                continue;
            }
            if *bytes <= limit {
                self.strikes.remove(id);
                continue;
            }
            let strikes = self.strikes.entry(id.clone()).or_insert(0);
            *strikes += 1;
            if *strikes >= STRIKES {
                self.strikes.remove(id);
                self.settling.insert(id.clone(), now);
                stopping.push(id.clone());
            }
        }
        stopping
    }

    /// Nothing is over a limit that is not set.
    fn forget(&mut self) {
        self.strikes.clear();
        self.settling.clear();
    }
}

/// Watch every chat against the limit, for as long as the registry lives.
pub fn watch(settings: Arc<crate::db::Database>, registry: Arc<WorkbenchRegistry>) {
    let registry = Arc::downgrade(&registry);
    tokio::spawn(async move {
        let mut every = tokio::time::interval(EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut standing = Standing::default();
        loop {
            every.tick().await;
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let limit = match crate::routes::memory_settings::limit_bytes(&settings) {
                Ok(Some(limit)) => limit,
                Ok(None) => {
                    standing.forget();
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "memory limit unreadable; no chat will be stopped");
                    standing.forget();
                    continue;
                }
            };
            let report = match memory::report(registry.database()).await {
                Ok(report) => report,
                Err(error) => {
                    tracing::warn!(%error, "chat memory unreadable; no chat will be stopped");
                    continue;
                }
            };
            let measured: Vec<(String, u64)> = report
                .chats
                .iter()
                .map(|chat| (chat.session_id.clone(), chat.bytes))
                .collect();
            for id in standing.judge(&measured, limit, Instant::now()) {
                let invoice = invoice(&report, &id, limit);
                stop_and_tell(&registry, &id, &invoice).await;
            }
        }
    });
}

/// What the chat was holding when it was stopped, and what it was holding it
/// in. Kept to the largest few processes: a chat over its limit is over it
/// because of one or two of them, and the rest is noise to whoever reads this.
struct Invoice {
    held: u64,
    limit: u64,
    largest: Vec<String>,
}

fn invoice(report: &memory::MemoryReport, session_id: &str, limit: u64) -> Invoice {
    let held = report
        .chats
        .iter()
        .find(|chat| chat.session_id == session_id)
        .map(|chat| chat.bytes)
        .unwrap_or(0);
    // `process_details` is already sorted largest first.
    let largest = report
        .process_details
        .iter()
        .filter(|process| process.session_id.as_deref() == Some(session_id))
        .take(4)
        .map(|process| {
            format!(
                "{} (PID {}) holding {}",
                process.name,
                process.pid,
                words(process.bytes)
            )
        })
        .collect();
    Invoice {
        held,
        limit,
        largest,
    }
}

impl Invoice {
    /// The line the transcript shows a person who comes back to a stopped chat.
    fn notice(&self) -> String {
        format!(
            "Atelier stopped this chat: it was holding {}, over its {} memory limit.",
            words(self.held),
            words(self.limit)
        )
    }

    /// The message the chat is restarted with, addressed to the agent that ran
    /// up the bill. It has to say what was spent, that everything was killed,
    /// and that repeating the run is not what to do next.
    fn message(&self) -> String {
        let largest = if self.largest.is_empty() {
            String::new()
        } else {
            format!(" The largest were: {}.", self.largest.join("; "))
        };
        format!(
            "Your run was stopped because it went over the memory limit set for this chat.\n\n\
             At the moment it was stopped this chat was holding {}, against a limit of {}.{}\n\n\
             Everything that run owned has been killed — the provider, every subagent and every \
             shell it had started — and you are now on a fresh process with none of it left. \
             Do not pick that work back up and do not run it the same way again: whatever was \
             holding that memory will hold it again and this chat will be stopped again.\n\n\
             Wait to be asked before continuing. When you are asked, do it in a way that stays \
             well under {}: smaller batches, fewer processes at once, and nothing left running \
             in the background.",
            words(self.held),
            words(self.limit),
            largest,
            words(self.limit)
        )
    }
}

/// Close the chat, say in the transcript why, then send the invoice — which
/// launches it again, because a chat with no driver is started by the message
/// sent to it.
async fn stop_and_tell(registry: &WorkbenchRegistry, session_id: &str, invoice: &Invoice) {
    tracing::warn!(
        chat = session_id,
        held = invoice.held,
        limit = invoice.limit,
        "stopping a chat that went over its memory limit"
    );
    let close = Command {
        kind: CommandKind::SessionClose,
        fields: serde_json::Map::from_iter([("sessionId".into(), json!(session_id))]),
    };
    if let Err(error) = registry.execute(&close).await {
        tracing::warn!(chat = session_id, %error, "over-limit chat could not be closed");
        return;
    }
    if let Err(error) =
        super::provider::append_notice(registry.database(), session_id, &invoice.notice()).await
    {
        tracing::warn!(chat = session_id, %error, "the reason a chat stopped could not be recorded");
    }
    let tell = Command {
        kind: CommandKind::PromptSend,
        fields: serde_json::Map::from_iter([
            ("sessionId".into(), json!(session_id)),
            ("text".into(), json!(invoice.message())),
            ("images".into(), json!([])),
        ]),
    };
    if let Err(error) = registry.execute(&tell).await {
        tracing::warn!(chat = session_id, %error, "a stopped chat could not be told why");
    }
}

/// A size in the units a person reads, matching the badge's own wording.
fn words(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let bytes = bytes as f64;
    if bytes >= GB {
        format!("{:.1} GB", bytes / GB)
    } else {
        format!("{:.0} MB", bytes / MB)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: u64 = 8 * 1024 * 1024 * 1024;

    fn chat(id: &str, gb: f64) -> (String, u64) {
        (id.into(), (gb * 1024.0 * 1024.0 * 1024.0) as u64)
    }

    #[test]
    fn one_sample_over_the_limit_is_not_enough_to_stop_a_chat() {
        let mut standing = Standing::default();
        let now = Instant::now();
        assert!(standing.judge(&[chat("a", 9.0)], LIMIT, now).is_empty());
    }

    #[test]
    fn two_samples_over_the_limit_stop_the_chat() {
        let mut standing = Standing::default();
        let now = Instant::now();
        standing.judge(&[chat("a", 9.0)], LIMIT, now);
        assert_eq!(
            standing.judge(&[chat("a", 9.2)], LIMIT, now + EVERY),
            vec!["a".to_string()]
        );
    }

    /// The spike this rule exists for: over once, back under, and left alone.
    #[test]
    fn a_chat_that_comes_back_under_loses_its_strike() {
        let mut standing = Standing::default();
        let now = Instant::now();
        standing.judge(&[chat("a", 9.0)], LIMIT, now);
        assert!(standing
            .judge(&[chat("a", 2.0)], LIMIT, now + EVERY)
            .is_empty());
        assert!(standing
            .judge(&[chat("a", 9.0)], LIMIT, now + EVERY * 2)
            .is_empty());
    }

    /// A chat whose processes are gone between samples is not carrying a
    /// strike towards a life it no longer has.
    #[test]
    fn a_chat_that_disappears_loses_its_strike() {
        let mut standing = Standing::default();
        let now = Instant::now();
        standing.judge(&[chat("a", 9.0)], LIMIT, now);
        standing.judge(&[], LIMIT, now + EVERY);
        assert!(standing
            .judge(&[chat("a", 9.0)], LIMIT, now + EVERY * 2)
            .is_empty());
    }

    /// The restart is still over the limit while it settles, and must not be
    /// stopped again on the strength of that.
    #[test]
    fn a_chat_just_stopped_is_left_alone_while_it_settles() {
        let mut standing = Standing::default();
        let now = Instant::now();
        standing.judge(&[chat("a", 9.0)], LIMIT, now);
        assert_eq!(
            standing.judge(&[chat("a", 9.0)], LIMIT, now + EVERY).len(),
            1
        );
        for tick in 2..8 {
            assert!(standing
                .judge(&[chat("a", 9.0)], LIMIT, now + EVERY * tick)
                .is_empty());
        }
        // Once it has settled and is still over, it is stopped again.
        let after = now + SETTLING + EVERY;
        standing.judge(&[chat("a", 9.0)], LIMIT, after);
        assert_eq!(
            standing.judge(&[chat("a", 9.0)], LIMIT, after + EVERY),
            vec!["a".to_string()]
        );
    }

    #[test]
    fn only_the_chat_over_the_limit_is_stopped() {
        let mut standing = Standing::default();
        let now = Instant::now();
        let sample = [chat("small", 1.0), chat("big", 12.0)];
        standing.judge(&sample, LIMIT, now);
        assert_eq!(
            standing.judge(&sample, LIMIT, now + EVERY),
            vec!["big".to_string()]
        );
    }

    #[test]
    fn clearing_the_limit_forgets_every_strike() {
        let mut standing = Standing::default();
        let now = Instant::now();
        standing.judge(&[chat("a", 9.0)], LIMIT, now);
        standing.forget();
        assert!(standing
            .judge(&[chat("a", 9.0)], LIMIT, now + EVERY)
            .is_empty());
    }

    #[test]
    fn the_message_names_the_bill_the_limit_and_what_was_holding_it() {
        let invoice = Invoice {
            held: 9 * 1024 * 1024 * 1024,
            limit: LIMIT,
            largest: vec!["node (PID 41) holding 6.0 GB".into()],
        };
        let message = invoice.message();
        assert!(message.contains("9.0 GB"), "{message}");
        assert!(message.contains("8.0 GB"), "{message}");
        assert!(
            message.contains("node (PID 41) holding 6.0 GB"),
            "{message}"
        );
        assert!(invoice.notice().contains("9.0 GB"));
    }

    #[test]
    fn a_size_under_a_gigabyte_is_said_in_megabytes() {
        assert_eq!(words(512 * 1024 * 1024), "512 MB");
        assert_eq!(words(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    mod stopping {
        use super::*;
        use crate::workbench::actor::ChatDb;
        use crate::workbench::registry::{
            DriverFuture, LaunchFuture, LaunchedSession, ProviderDriver, RegistryPaths,
            SessionFactory,
        };
        use std::sync::Mutex;

        /// A driver that writes down every message it was handed.
        struct Recording {
            sent: Arc<Mutex<Vec<String>>>,
        }
        impl ProviderDriver for Recording {
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

        struct Relaunching {
            sent: Arc<Mutex<Vec<String>>>,
            launches: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl SessionFactory for Relaunching {
            fn launch<'a>(&'a self, _: ChatDb, _: &'a Command) -> LaunchFuture<'a> {
                self.launches
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let sent = self.sent.clone();
                Box::pin(async move {
                    Ok(LaunchedSession {
                        session_id: "session-1".into(),
                        reply: json!({"id":"session-1","brand":"claude"}),
                        driver: Some(Box::new(Recording { sent })),
                    })
                })
            }
        }

        fn a_chat() -> crate::workbench::store::Session {
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
                state: "dormant".into(),
                origin: "app".into(),
                created_at: "2026-09-19T00:00:00Z".into(),
                last_active_at: "2026-09-19T00:00:00Z".into(),
                last_spoke_at: None,
                begun_by: Some("person".into()),
                named_by_owner: false,
            }
        }

        /// The whole of what enforcing is: the chat is closed, the transcript
        /// says why, and the message that explains the bill is what starts the
        /// replacement process.
        #[tokio::test]
        async fn a_stopped_chat_is_relaunched_by_the_message_that_bills_it() {
            let root = tempfile::tempdir().unwrap();
            let database = ChatDb::open(&root.path().join("workbench.db")).unwrap();
            let sent = Arc::new(Mutex::new(Vec::new()));
            let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let registry = WorkbenchRegistry::new(
                database.clone(),
                RegistryPaths {
                    home: root.path().join("home"),
                    claude_config: root.path().join("claude"),
                    codex_home: root.path().join("codex"),
                    profiles: root.path().join("profiles"),
                    media: root.path().join("media"),
                },
                Arc::new(Relaunching {
                    sent: sent.clone(),
                    launches: launches.clone(),
                }),
            );
            database.create_session(a_chat()).await.unwrap();

            let invoice = Invoice {
                held: 9 * 1024 * 1024 * 1024,
                limit: LIMIT,
                largest: vec!["node (PID 41) holding 6.0 GB".into()],
            };
            stop_and_tell(&registry, "session-1", &invoice).await;

            assert_eq!(
                launches.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "the billing message starts the replacement process"
            );
            let sent = sent.lock().unwrap().clone();
            assert_eq!(sent.len(), 1, "one message, not a repeat: {sent:?}");
            assert!(sent[0].contains("9.0 GB"), "{}", sent[0]);
            assert!(sent[0].contains("8.0 GB"), "{}", sent[0]);
            assert!(
                sent[0].contains("do not run it the same way again"),
                "{}",
                sent[0]
            );

            let said = database.events_since("session-1".into(), 0).await.unwrap();
            let notices: Vec<String> = said
                .iter()
                .filter_map(|event| {
                    let value = serde_json::to_value(event).ok()?;
                    (value["type"] == json!("notice"))
                        .then(|| value["text"].as_str().map(str::to_string))
                        .flatten()
                })
                .collect();
            assert!(
                notices.iter().any(|text| text.contains("over its 8.0 GB")),
                "the transcript says why the chat stopped: {notices:?}"
            );
        }
    }
}
