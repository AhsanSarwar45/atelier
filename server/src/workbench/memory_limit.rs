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
//!
//! The same watcher keeps the whole app alive when the computer runs short.
//! Every chat, every build it runs and this server share one systemd service,
//! and `systemd-oomd` kills that service outright, every chat with it, once
//! it has been stalled for memory for twenty seconds. Long before that the
//! server itself is stalled with everything else, which is when screens start
//! saying the app gave no answer. So when the service is stalled for memory
//! two samples running, the chat holding the most is stopped and told why,
//! whether or not a limit is set: one chat starting over is better than all
//! of them dying with the app (bw-jb5nf).

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

/// The share of a sample the service may spend stalled for memory before the
/// heaviest chat is stopped. `systemd-oomd` kills the whole service once its
/// ten-second average has stayed over 80% for twenty seconds; this acts at
/// half that, two samples running, so a build that is merely busy is left
/// alone and one that is starving the app is stopped seconds after it starts.
const CROWDED: f64 = 0.4;

/// How long after stopping a chat for the service's sake before another is
/// stopped. A stopped chat's memory takes a few seconds to come back, and
/// stopping a second chat while it does would cost a chat for nothing.
const EASING: Duration = Duration::from_secs(15);

/// What the watcher remembers about the service as a whole.
#[derive(Default)]
struct Crowding {
    strikes: u32,
    eased_at: Option<Instant>,
    /// The last reading of the stall total, and when it was read.
    last: Option<(u64, Instant)>,
}

impl Crowding {
    /// The share of the time since the last reading the service spent
    /// stalled for memory, given the running total read now.
    fn share(&mut self, stall: Option<u64>, now: Instant) -> Option<f64> {
        let last = self.last.take();
        let stall = stall?;
        self.last = Some((stall, now));
        let (before, then) = last?;
        let micros = now.checked_duration_since(then)?.as_micros() as f64;
        (micros > 0.0).then(|| stall.saturating_sub(before) as f64 / micros)
    }

    /// Whether this sample should cost the heaviest chat its run.
    fn judge(&mut self, stall: Option<u64>, now: Instant) -> bool {
        let share = self.share(stall, now);
        if self.eased_at.is_some_and(|at| now < at + EASING) {
            return false;
        }
        if !share.is_some_and(|share| share >= CROWDED) {
            self.strikes = 0;
            return false;
        }
        self.strikes += 1;
        if self.strikes < STRIKES {
            return false;
        }
        self.strikes = 0;
        self.eased_at = Some(now);
        true
    }
}

/// The least share of what the service holds, file cache aside, that a chat
/// must hold to be stopped for it. When the memory is somewhere else — a Dolt
/// server left running, or the server itself — stopping chats would not free
/// it, and the watcher would stop one after another for nothing.
const SHARE_TO_STOP: u64 = 8;

/// The chat holding the most, which is the one to stop for the service, when
/// it holds enough that stopping it would help.
fn heaviest(report: &memory::MemoryReport) -> Option<&memory::ChatMemory> {
    let held = report
        .service
        .as_ref()
        .map(|service| service.total_bytes.saturating_sub(service.cache_bytes));
    report
        .chats
        .iter()
        .max_by_key(|chat| chat.bytes)
        .filter(|chat| worth_stopping(chat.bytes, held))
}

/// Whether a chat holding `bytes` holds enough of what the service holds.
fn worth_stopping(bytes: u64, service_held: Option<u64>) -> bool {
    bytes > 0 && service_held.is_none_or(|held| bytes.saturating_mul(SHARE_TO_STOP) >= held)
}

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

/// Watch every chat against the limit, and the service against running out,
/// for as long as the registry lives.
pub fn watch(settings: Arc<crate::db::Database>, registry: Arc<WorkbenchRegistry>) {
    let registry = Arc::downgrade(&registry);
    tokio::spawn(async move {
        let mut every = tokio::time::interval(EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut standing = Standing::default();
        let mut crowding = Crowding::default();
        loop {
            every.tick().await;
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let now = Instant::now();
            let crowded = crowding.judge(memory::service_stall(), now);
            let limit = match crate::routes::memory_settings::limit_bytes(&settings) {
                Ok(limit) => limit,
                Err(error) => {
                    tracing::warn!(%error, "memory limit unreadable; no chat will be stopped for it");
                    None
                }
            };
            if limit.is_none() {
                standing.forget();
            }
            // Walking every process is the costly part, so it waits until
            // something is to be judged against it.
            if limit.is_none() && !crowded {
                continue;
            }
            let report = match memory::report(registry.database()).await {
                Ok(report) => report,
                Err(error) => {
                    tracing::warn!(%error, "chat memory unreadable; no chat will be stopped");
                    continue;
                }
            };
            let mut stopped = Vec::new();
            if let Some(limit) = limit {
                let measured: Vec<(String, u64)> = report
                    .chats
                    .iter()
                    .map(|chat| (chat.session_id.clone(), chat.bytes))
                    .collect();
                for id in standing.judge(&measured, limit, now) {
                    let invoice = invoice(&report, &id, Some(limit));
                    stop_and_tell(&registry, &id, &invoice).await;
                    stopped.push(id);
                }
            }
            if crowded && stopped.is_empty() {
                match heaviest(&report) {
                    Some(chat) => {
                        tracing::warn!(
                            service = report.service.as_ref().map(|service| service.total_bytes),
                            "the app is stalled for memory; stopping the chat holding the most"
                        );
                        let invoice = invoice(&report, &chat.session_id, None);
                        stop_and_tell(&registry, &chat.session_id, &invoice).await;
                    }
                    None => tracing::warn!(
                        service = report.service.as_ref().map(|service| service.total_bytes),
                        others = ?report
                            .service
                            .as_ref()
                            .map(|service| service.others.iter().map(|other| (&other.name, other.bytes)).collect::<Vec<_>>()),
                        "the app is stalled for memory and no chat holds enough of it to stop"
                    ),
                }
            }
        }
    });
}

/// What the chat was holding when it was stopped, and what it was holding it
/// in. Kept to the largest few processes: a chat over its limit is over it
/// because of one or two of them, and the rest is noise to whoever reads this.
/// With no limit, the chat was stopped because the app was running out.
struct Invoice {
    held: u64,
    limit: Option<u64>,
    largest: Vec<String>,
}

fn invoice(report: &memory::MemoryReport, session_id: &str, limit: Option<u64>) -> Invoice {
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
        match self.limit {
            Some(limit) => format!(
                "Atelier stopped this chat: it was holding {}, over its {} memory limit.",
                words(self.held),
                words(limit)
            ),
            None => format!(
                "Atelier stopped this chat: the app was running out of memory, and this chat \
                 was holding the most, {}.",
                words(self.held)
            ),
        }
    }

    /// The message the chat is restarted with, addressed to the agent that ran
    /// up the bill. It has to say what was spent, that everything was killed,
    /// and that it should carry on with the work while staying under the limit.
    fn message(&self) -> String {
        let largest = if self.largest.is_empty() {
            String::new()
        } else {
            format!(" The largest were: {}.", self.largest.join("; "))
        };
        let Some(limit) = self.limit else {
            return format!(
                "Your run was stopped because the computer was running out of memory and this \
                 chat was holding more than any other.\n\n\
                 At the moment it was stopped this chat was holding {}.{}\n\n\
                 Everything that run owned has been killed — the provider, every subagent and \
                 every shell it had started — and you are now on a fresh process with none of it \
                 left. Restarting it as it was will fail: do not run it the same way again, \
                 because whatever was holding that memory will hold it again and this chat will \
                 be stopped again.\n\n\
                 Please use less memory and continue what you were working on: smaller batches, \
                 fewer processes at once, and nothing left running in the background.",
                words(self.held),
                largest
            );
        };
        format!(
            "Your run was stopped because it went over the memory limit set for this chat.\n\n\
             At the moment it was stopped this chat was holding {}, against a limit of {}.{}\n\n\
             Everything that run owned has been killed — the provider, every subagent and every \
             shell it had started — and you are now on a fresh process with none of it left. \
             Restarting it as it was will fail: do not run it the same way again, because \
             whatever was holding that memory will hold it again and this chat will be stopped \
             again.\n\n\
             Please fix your memory consumption to stay under the limit of {} and continue what \
             you were working on: smaller batches, fewer processes at once, and nothing left \
             running in the background.",
            words(self.held),
            words(limit),
            largest,
            words(limit)
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
        "stopping a chat for its memory"
    );
    let close = Command {
        kind: CommandKind::SessionClose,
        fields: serde_json::Map::from_iter([("sessionId".into(), json!(session_id))]),
    };
    if let Err(error) = registry.execute(&close).await {
        tracing::warn!(chat = session_id, %error, "over-limit chat could not be closed");
        return;
    }
    let id = session_id.to_owned();
    let stopped = tokio::task::spawn_blocking(move || memory::stop_outlived(&id))
        .await
        .unwrap_or(0);
    if stopped > 0 {
        tracing::warn!(chat = session_id, stopped, "stopped what the over-limit chat left running");
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
        assert!(standing
            .judge(&[chat("a", 9.0)], LIMIT, now)
            .is_empty());
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
        assert_eq!(standing.judge(&[chat("a", 9.0)], LIMIT, now + EVERY).len(), 1);
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
            limit: Some(LIMIT),
            largest: vec!["node (PID 41) holding 6.0 GB".into()],
        };
        let message = invoice.message();
        assert!(message.contains("9.0 GB"), "{message}");
        assert!(message.contains("8.0 GB"), "{message}");
        assert!(message.contains("node (PID 41) holding 6.0 GB"), "{message}");
        assert!(invoice.notice().contains("9.0 GB"));
    }

    /// The stall totals a service would show if it spent `shares` of each
    /// sample stalled, one reading per sample.
    fn stalled(shares: &[f64]) -> Vec<Option<u64>> {
        let mut total = 0u64;
        let mut readings = vec![Some(total)];
        for share in shares {
            total += (EVERY.as_micros() as f64 * share) as u64;
            readings.push(Some(total));
        }
        readings
    }

    fn verdicts(crowding: &mut Crowding, readings: &[Option<u64>], from: Instant) -> Vec<bool> {
        readings
            .iter()
            .enumerate()
            .map(|(at, stall)| crowding.judge(*stall, from + EVERY * at as u32))
            .collect()
    }

    #[test]
    fn one_stalled_sample_is_not_enough_to_stop_a_chat_for_the_app() {
        let mut crowding = Crowding::default();
        let said = verdicts(&mut crowding, &stalled(&[0.9, 0.1, 0.9, 0.0]), Instant::now());
        assert!(said.iter().all(|stop| !stop), "{said:?}");
    }

    #[test]
    fn two_stalled_samples_stop_a_chat_then_the_app_is_given_time_to_recover() {
        let mut crowding = Crowding::default();
        let shares = [CROWDED, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95];
        let said = verdicts(&mut crowding, &stalled(&shares), Instant::now());
        // The first reading has nothing to compare with; the next two are the
        // strikes; then five samples, fifteen seconds, are left to recover.
        assert_eq!(said, [false, false, true, false, false, false, false, false, true]);
    }

    #[test]
    fn a_busy_app_that_is_not_short_of_memory_keeps_every_chat() {
        let mut crowding = Crowding::default();
        let said = verdicts(&mut crowding, &stalled(&[0.2; 20]), Instant::now());
        assert!(said.iter().all(|stop| !stop), "{said:?}");
    }

    #[test]
    fn a_chat_holding_little_of_what_the_app_holds_is_not_stopped_for_it() {
        const GB: u64 = 1024 * 1024 * 1024;
        assert!(worth_stopping(2 * GB, Some(10 * GB)));
        assert!(worth_stopping(2 * GB, Some(16 * GB)));
        assert!(!worth_stopping(GB, Some(16 * GB)), "the memory is somewhere else");
        assert!(!worth_stopping(0, None));
        assert!(worth_stopping(GB, None));
    }

    #[test]
    fn an_app_with_no_service_of_its_own_never_stops_a_chat_for_it() {
        let mut crowding = Crowding::default();
        let said = verdicts(&mut crowding, &[None; 6], Instant::now());
        assert!(said.iter().all(|stop| !stop), "{said:?}");
    }

    #[test]
    fn a_chat_stopped_for_the_app_is_told_it_held_the_most() {
        let invoice = Invoice {
            held: 6 * 1024 * 1024 * 1024,
            limit: None,
            largest: vec!["rustc (PID 7) holding 5.0 GB".into()],
        };
        let message = invoice.message();
        assert!(message.contains("running out of memory"), "{message}");
        assert!(message.contains("6.0 GB"), "{message}");
        assert!(message.contains("rustc (PID 7) holding 5.0 GB"), "{message}");
        assert!(!message.contains("limit"), "{message}");
        assert!(invoice.notice().contains("holding the most, 6.0 GB"));
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
                limit: Some(LIMIT),
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
            assert!(
                sent[0].contains("continue what you were working on"),
                "{}",
                sent[0]
            );
            assert!(!sent[0].contains("Wait to be asked"), "{}", sent[0]);

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
