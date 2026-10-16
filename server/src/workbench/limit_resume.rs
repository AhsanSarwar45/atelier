//! Resuming a chat stopped by a usage limit, a minute after the limit resets.
//!
//! Off unless `workbench.limits.auto-resume` is on. While it is off this
//! watcher reads that one setting every few seconds and does nothing else.
//!
//! The chats it looks at are the ones the transcript itself says are still
//! held by a usage limit: the newest usage-limit notice stands, and the agent
//! has not replied since (`Store::standing_usage_limits`). When the reset the
//! notice names has passed by a minute, the chat is sent `continue`, the same
//! word a person would type. A chat with no driver is started by that message
//! the way a person's own message starts it.
//!
//! The reset comes from the notice: a real instant in `retryAt` when the kit
//! sent one, otherwise the provider's own words in `resets` — `resets 9pm
//! (Asia/Karachi)` from Claude, `try again at Oct 5th, 2026 10:28 AM` from
//! Codex. A bare time is the next one after the notice was written. Words
//! that name no time this can read leave the chat alone: resuming at a guessed
//! hour would only run into the same limit again.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use regex::Regex;
use serde_json::{json, Value};

use super::protocol::{Command, CommandKind};
use super::registry::WorkbenchRegistry;
use super::store::StandingLimit;

/// How often the standing limits are read. A resume lands within this much of
/// its minute, which is close enough for a wait measured in hours.
const EVERY: Duration = Duration::from_secs(15);

/// How long after the reset the chat is sent on, so a provider whose clock
/// runs a little behind has let go of the limit by then.
const GRACE: chrono::Duration = chrono::Duration::minutes(1);

/// What the chat is sent.
const CONTINUE: &str = "continue";

/// Watch every chat stopped by a usage limit, for as long as the registry lives.
pub fn watch(settings: Arc<crate::db::Database>, registry: Arc<WorkbenchRegistry>) {
    let registry = Arc::downgrade(&registry);
    tokio::spawn(async move {
        let mut every = tokio::time::interval(EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut plan = Plan::default();
        loop {
            every.tick().await;
            let Some(registry) = registry.upgrade() else {
                break;
            };
            let since = match crate::routes::limit_settings::resuming_since(&settings) {
                Ok(Some(since)) => since,
                Ok(None) => {
                    plan = Plan::default();
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "usage limit settings unreadable; no chat will be resumed");
                    continue;
                }
            };
            let standing = match registry.database().standing_usage_limits().await {
                Ok(standing) => standing,
                Err(error) => {
                    tracing::warn!(%error, "usage limits unreadable; no chat will be resumed");
                    continue;
                }
            };
            for step in plan.next(&standing, since, Utc::now()) {
                match step {
                    Step::Announce { session_id, at } => announce(&registry, &session_id, at).await,
                    Step::Resume { session_id } => resume(&registry, &session_id).await,
                }
            }
        }
    });
}

/// Say in the chat when it will resume. The reader's to know, so drawn by
/// default: an aside with no audience is the app talking about itself and
/// starts hidden.
async fn announce(registry: &WorkbenchRegistry, session_id: &str, at: DateTime<Utc>) {
    let notice = serde_json::from_value(json!({
        "type":"notice", "sessionId":session_id, "seq":0, "at":Utc::now().to_rfc3339(),
        "text":format!("Auto-resume at {}", spoken(at, Local::now())),
        "family":"waiting", "audience":"you"
    }));
    let appended = match notice {
        Ok(notice) => registry.database().append(notice).await,
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = appended {
        tracing::warn!(chat = session_id, %error, "a planned resume could not be recorded");
    }
}

async fn resume(registry: &WorkbenchRegistry, session_id: &str) {
    tracing::info!(chat = session_id, "resuming a chat whose usage limit has reset");
    let tell = Command {
        kind: CommandKind::PromptSend,
        fields: serde_json::Map::from_iter([
            ("sessionId".into(), json!(session_id)),
            ("text".into(), json!(CONTINUE)),
            ("images".into(), json!([])),
        ]),
    };
    if let Err(error) = registry.execute(&tell).await {
        tracing::warn!(chat = session_id, %error, "a chat could not be resumed after its usage limit");
    }
}

#[derive(Debug, PartialEq)]
enum Step {
    /// Say in the chat when it will resume.
    Announce { session_id: String, at: DateTime<Utc> },
    /// Send the chat on.
    Resume { session_id: String },
}

/// Which resumes have been announced, by chat and time, and which notices
/// acted on, by chat and seq. A notice is resumed from once. A time is
/// announced once, however many notices name it: a chat held by its limit is
/// refused again each time its own background work wakes it, and each refusal
/// is a new notice naming the same reset (bw-uic5z).
#[derive(Default)]
struct Plan {
    announced: HashSet<(String, DateTime<Utc>)>,
    resumed: HashSet<(String, i64)>,
}

impl Plan {
    /// `since` is when resuming was turned on; a limit that reset before then
    /// is left as it is.
    fn next(&mut self, standing: &[StandingLimit], since: DateTime<Utc>, now: DateTime<Utc>) -> Vec<Step> {
        let present: HashSet<(String, i64)> =
            standing.iter().map(|limit| (limit.session_id.clone(), limit.seq)).collect();
        self.announced
            .retain(|(chat, _)| standing.iter().any(|limit| limit.session_id == *chat));
        self.resumed.retain(|key| present.contains(key));
        let mut steps = Vec::new();
        for limit in standing {
            let key = (limit.session_id.clone(), limit.seq);
            if self.resumed.contains(&key) {
                continue;
            }
            let Some(noticed) = DateTime::parse_from_rfc3339(&limit.at).ok().map(|at| at.to_utc()) else {
                continue;
            };
            let Some(lifts) = lifts_at(&limit.signal, noticed, &Local).filter(|lifts| *lifts > since) else {
                continue;
            };
            let due = lifts + GRACE;
            if now >= due {
                self.resumed.insert(key);
                steps.push(Step::Resume { session_id: limit.session_id.clone() });
            } else if self.announced.insert((limit.session_id.clone(), due)) {
                steps.push(Step::Announce { session_id: limit.session_id.clone(), at: due });
            }
        }
        steps
    }
}

/// A time as the chat's reader would say it: the hour alone today, with the
/// day in front of it on any other.
fn spoken(at: DateTime<Utc>, now: DateTime<Local>) -> String {
    let local = at.with_timezone(&Local);
    if local.date_naive() == now.date_naive() {
        local.format("%-I:%M %p").to_string()
    } else {
        local.format("%b %-d, %-I:%M %p").to_string()
    }
}

static ZONE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\s*([A-Za-z_]+(?:/[A-Za-z0-9_+\-]+)+|UTC)\s*\)").unwrap());
static CLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?").unwrap());
static DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?",
    )
    .unwrap()
});

/// When the limit a notice names lifts, if it says so in a way that can be
/// read. `local` is the zone of a time that names none, which is this
/// machine's: the zone the kit wrote it in.
fn lifts_at(signal: &Value, noticed: DateTime<Utc>, local: &impl TimeZone) -> Option<DateTime<Utc>> {
    if let Some(at) = signal["retryAt"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok()) {
        return Some(at.to_utc());
    }
    let words = signal["resets"].as_str()?;
    let lifts = match ZONE.captures(words).and_then(|zone| zone[1].parse::<chrono_tz::Tz>().ok()) {
        Some(zone) => resolve(words, noticed, &zone),
        None => resolve(words, noticed, local),
    }?;
    // A reset before the notice that named it is a misreading, and acting on
    // it would resume the chat straight back into its limit.
    (lifts > noticed).then_some(lifts)
}

fn resolve<Z: TimeZone>(words: &str, noticed: DateTime<Utc>, zone: &Z) -> Option<DateTime<Utc>> {
    let clock = CLOCK.captures(words)?;
    let hour: u32 = clock[1].parse().ok()?;
    let minute: u32 = clock.get(2).map_or(Some(0), |m| m.as_str().parse().ok())?;
    if !(1..=12).contains(&hour) {
        return None;
    }
    let pm = clock[3].eq_ignore_ascii_case("p");
    let time = NaiveTime::from_hms_opt(hour % 12 + if pm { 12 } else { 0 }, minute, 0)?;
    let there = noticed.with_timezone(zone);
    let at = |date: NaiveDate| zone.from_local_datetime(&date.and_time(time)).earliest().map(|at| at.to_utc());
    match DAY.captures(words) {
        Some(day) => {
            let month = MONTHS.iter().position(|m| day[1].eq_ignore_ascii_case(m))? as u32 + 1;
            let date: u32 = day[2].parse().ok()?;
            match day.get(3) {
                Some(year) => at(NaiveDate::from_ymd_opt(year.as_str().parse().ok()?, month, date)?),
                // Without a year, the next such day: a reset in January
                // named in December is next year's.
                None => {
                    let this_year = at(NaiveDate::from_ymd_opt(there.year(), month, date)?)?;
                    if this_year > noticed {
                        Some(this_year)
                    } else {
                        at(NaiveDate::from_ymd_opt(there.year() + 1, month, date)?)
                    }
                }
            }
        }
        None => {
            let today = at(there.date_naive())?;
            if today > noticed {
                Some(today)
            } else {
                at(there.date_naive().succ_opt()?)
            }
        }
    }
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn utc(at: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(at).unwrap().to_utc()
    }

    fn resets(words: &str) -> Value {
        json!({"kind":"usage_limit","retryAt":null,"resets":words})
    }

    fn karachi() -> FixedOffset {
        FixedOffset::east_opt(5 * 3600).unwrap()
    }

    #[test]
    fn claudes_bare_hour_is_the_next_one_in_the_zone_it_names() {
        // 3pm in Karachi is 10:00 UTC; the next 9pm there is 16:00 UTC.
        let noticed = utc("2026-10-09T10:00:00Z");
        let lifts = lifts_at(&resets("resets 9pm (Asia/Karachi)"), noticed, &Utc);
        assert_eq!(lifts, Some(utc("2026-10-09T16:00:00Z")));
    }

    #[test]
    fn an_hour_already_past_today_is_tomorrows() {
        // 10pm in Karachi; 3:40am is the morning after.
        let noticed = utc("2026-10-09T17:00:00Z");
        let lifts = lifts_at(
            &resets("resets 3:40am (Asia/Karachi) (error type rate_limit, HTTP 429)"),
            noticed,
            &Utc,
        );
        assert_eq!(lifts, Some(utc("2026-10-09T22:40:00Z")));
    }

    #[test]
    fn codexs_dated_time_is_read_in_the_machines_own_zone() {
        let noticed = utc("2026-10-05T00:00:00Z");
        let lifts = lifts_at(&resets("try again at Oct 5th, 2026 10:28 AM"), noticed, &karachi());
        assert_eq!(lifts, Some(utc("2026-10-05T05:28:00Z")));
    }

    #[test]
    fn a_date_without_a_year_is_the_next_one() {
        let noticed = utc("2026-12-30T00:00:00Z");
        let lifts = lifts_at(&resets("resets Jan 2, 1pm (UTC)"), noticed, &karachi());
        assert_eq!(lifts, Some(utc("2027-01-02T13:00:00Z")));
    }

    #[test]
    fn a_real_instant_wins_over_the_words() {
        let signal = json!({"retryAt":"2026-10-09T18:00:00Z","resets":"resets 9pm (Asia/Karachi)"});
        assert_eq!(lifts_at(&signal, utc("2026-10-09T10:00:00Z"), &Utc), Some(utc("2026-10-09T18:00:00Z")));
    }

    #[test]
    fn words_that_name_no_time_resume_nothing() {
        let noticed = utc("2026-10-09T10:00:00Z");
        assert_eq!(lifts_at(&resets("resets soon"), noticed, &Utc), None);
        assert_eq!(lifts_at(&json!({"resets":null}), noticed, &Utc), None);
        // A dated reset before the notice is a misreading, not a reason to go.
        assert_eq!(lifts_at(&resets("try again at Sep 3rd, 2020 9:25 PM"), noticed, &Utc), None);
    }

    /// When resuming was turned on, before every limit below resets.
    const ON: DateTime<Utc> = DateTime::from_timestamp_nanos(1_791_504_000_000_000_000);

    fn standing(session_id: &str, seq: i64, retry_at: &str) -> StandingLimit {
        StandingLimit {
            session_id: session_id.into(),
            brand: "claude".into(),
            seq,
            at: "2026-10-09T10:00:00Z".into(),
            signal: json!({"kind":"usage_limit","retryAt":retry_at}),
        }
    }

    #[test]
    fn a_limit_is_announced_once_then_resumed_once_a_minute_after_it_resets() {
        let mut plan = Plan::default();
        let limits = [standing("a", 7, "2026-10-09T16:00:00Z")];
        let before = plan.next(&limits, ON, utc("2026-10-09T12:00:00Z"));
        assert_eq!(before, [Step::Announce { session_id: "a".into(), at: utc("2026-10-09T16:01:00Z") }]);
        assert_eq!(plan.next(&limits, ON, utc("2026-10-09T16:00:30Z")), []);
        assert_eq!(plan.next(&limits, ON, utc("2026-10-09T16:01:00Z")), [Step::Resume { session_id: "a".into() }]);
        // Still standing a tick later: the message is on its way, not sent twice.
        assert_eq!(plan.next(&limits, ON, utc("2026-10-09T16:01:15Z")), []);
    }

    #[test]
    fn a_limit_that_reset_before_resuming_was_turned_on_is_left_alone() {
        let mut plan = Plan::default();
        let old = [standing("a", 7, "2026-10-01T16:00:00Z")];
        assert_eq!(plan.next(&old, utc("2026-10-09T09:00:00Z"), utc("2026-10-09T12:00:00Z")), []);
    }

    #[test]
    fn refusals_naming_the_same_reset_are_announced_once() {
        let mut plan = Plan::default();
        let first = [standing("a", 7, "2026-10-09T16:00:00Z")];
        assert_eq!(plan.next(&first, ON, utc("2026-10-09T12:00:00Z")).len(), 1);
        let again = [standing("a", 19, "2026-10-09T16:00:00Z")];
        assert_eq!(plan.next(&again, ON, utc("2026-10-09T12:05:00Z")), []);
        assert_eq!(plan.next(&again, ON, utc("2026-10-09T16:01:00Z")), [Step::Resume { session_id: "a".into() }]);
    }

    #[test]
    fn running_into_the_limit_again_is_planned_afresh() {
        let mut plan = Plan::default();
        plan.next(&[standing("a", 7, "2026-10-09T16:00:00Z")], ON, utc("2026-10-09T16:02:00Z"));
        let again = [standing("a", 12, "2026-10-09T21:00:00Z")];
        assert_eq!(
            plan.next(&again, ON, utc("2026-10-09T16:05:00Z")),
            [Step::Announce { session_id: "a".into(), at: utc("2026-10-09T21:01:00Z") }]
        );
    }
}
