//! Clearing old chats by the owner's rules.
//!
//! A rule names an age, what to remove from chats older than that — the whole
//! chat, only its pictures, or only its other files — and optionally one
//! project. Rules are kept in the settings table as one list
//! (`storage.cleanup.rules`); none are set by default, and with none set
//! nothing is ever removed.
//!
//! The same plan answers the screen's preview and the run itself, so what a
//! rule says it will do is what it does. Whole chats go through the same
//! delete a person's own delete takes, provider record included; pictures and
//! files are marked removed in the storage index and their stored file is
//! deleted once no chat still shows it.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::protocol::{Command, CommandKind};
use super::registry::WorkbenchRegistry;
use super::storage_index::{Indexed, Kind, StorageIndex};

pub const RULES: &str = "storage.cleanup.rules";
pub const LAST_RUN: &str = "storage.cleanup.last-run";

/// The most rules a list may hold. More than this is not a policy any person
/// can read at a glance.
const MOST_RULES: usize = 20;

/// The oldest age a rule may name: ten years.
const LONGEST_DAYS: u32 = 3650;

/// Chats deleted in one run. Each one asks its provider to delete its own
/// record, which starts the provider once; the rest wait for the next run.
const CHATS_PER_RUN: usize = 200;

/// How often the scheduler looks, and how long a run counts for.
const LOOK_EVERY: Duration = Duration::from_secs(3600);
const RUN_EVERY: chrono::Duration = chrono::Duration::hours(23);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Days,
    Weeks,
    Months,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Chats,
    Images,
    Files,
}

impl Target {
    fn kind(self) -> Option<Kind> {
        match self {
            Target::Chats => None,
            Target::Images => Some(Kind::Images),
            Target::Files => Some(Kind::Files),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub enabled: bool,
    pub amount: u32,
    pub unit: Unit,
    pub delete: Target,
    /// One project, or every project when absent.
    #[serde(default)]
    pub project_id: Option<String>,
}

impl Rule {
    pub fn days(&self) -> u32 {
        self.amount.saturating_mul(match self.unit {
            Unit::Days => 1,
            Unit::Weeks => 7,
            Unit::Months => 30,
        })
    }
}

/// Refuse a list no run could follow, in words the screen can show.
pub fn check(rules: &[Rule]) -> Result<(), String> {
    if rules.len() > MOST_RULES {
        return Err(format!("You can add up to {MOST_RULES} rules."));
    }
    let mut ids = HashSet::new();
    for rule in rules {
        if rule.id.trim().is_empty() || !ids.insert(rule.id.as_str()) {
            return Err("Each rule needs its own ID.".into());
        }
        if rule.amount == 0 || rule.days() > LONGEST_DAYS {
            return Err(format!("Age must be between 1 day and {} years.", LONGEST_DAYS / 365));
        }
    }
    Ok(())
}

pub fn rules(settings: &crate::db::Database) -> Result<Vec<Rule>, String> {
    let stored = settings.setting(RULES).map_err(|e| e.to_string())?;
    Ok(stored
        .and_then(|text| serde_json::from_str::<Vec<Rule>>(&text).ok())
        .unwrap_or_default())
}

pub fn save_rules(settings: &crate::db::Database, rules: &[Rule]) -> Result<(), String> {
    check(rules)?;
    let text = serde_json::to_string(rules).map_err(|e| e.to_string())?;
    settings
        .set_setting(RULES, (!rules.is_empty()).then_some(text.as_str()))
        .map_err(|e| e.to_string())
}

/// What the last run did, for the screen.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub at: String,
    pub chats: usize,
    pub images: usize,
    pub files: usize,
    pub bytes: u64,
    /// Chats a rule matched that could not be deleted, with the first reason.
    pub failed: usize,
    #[serde(default)]
    pub error: Option<String>,
    /// Chats left for the next run because one run deletes only so many.
    #[serde(default)]
    pub remaining: usize,
}

pub fn last_run(settings: &crate::db::Database) -> Option<RunReport> {
    settings
        .setting(LAST_RUN)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
}

/// One chat as the plan sees it.
#[derive(Clone, Debug)]
pub struct Chat {
    pub id: String,
    pub project_id: String,
    pub last_at: DateTime<Utc>,
    pub active: bool,
}

/// What one rule would do.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    /// Chats the rule deletes, or chats it removes pictures or files from.
    pub chats: usize,
    /// Pictures or files removed; zero for a rule that deletes chats.
    pub items: usize,
    /// Bytes of stored files freed.
    pub bytes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Plan {
    pub effects: Vec<Effect>,
    /// Chats to delete, oldest first.
    pub delete: Vec<String>,
    /// Pictures or files to mark removed, through the chat's newest event.
    pub clear: Vec<(String, Kind, i64)>,
    /// Stored files no chat would show once the rest is done.
    pub free: Vec<String>,
}

/// Decide what a list of rules does to the chats as they stand.
///
/// Rules that delete chats go first, so a pictures rule never counts a chat a
/// chat rule removes. Within each, every chat is credited to the first rule
/// in the list that takes it.
/// Of the rules that apply to a chat, the one it is credited to: the youngest
/// age, then every project before one, then the first. A rule the screen calls
/// covered by another is then never the one credited, so its preview reads no
/// matches rather than taking the other's.
fn broadest(rules: &[Rule], applies: impl Fn(&Rule) -> bool) -> Option<usize> {
    rules
        .iter()
        .enumerate()
        .filter(|(_, rule)| applies(rule))
        .min_by_key(|(at, rule)| (rule.days(), rule.project_id.is_some(), *at))
        .map(|(at, _)| at)
}

pub fn plan(rules: &[Rule], chats: &[Chat], indexed: &Indexed, sizes: &HashMap<String, u64>, now: DateTime<Utc>) -> Plan {
    let mut effects: Vec<Effect> = rules
        .iter()
        .map(|rule| Effect {
            id: rule.id.clone(),
            ..Effect::default()
        })
        .collect();
    let matches = |rule: &Rule, chat: &Chat| {
        rule.enabled
            && !chat.active
            && chat.last_at < now - chrono::Duration::days(rule.days() as i64)
            && rule.project_id.as_ref().map_or(true, |project| *project == chat.project_id)
    };
    let mut by_age: Vec<&Chat> = chats.iter().collect();
    by_age.sort_by_key(|chat| chat.last_at);

    let mut gone: HashSet<String> = HashSet::new();
    let mut delete = Vec::new();
    // Which rule touched each file first, for crediting what it frees.
    let mut first_touch: HashMap<String, usize> = HashMap::new();
    let mut refs_by_chat: HashMap<&str, Vec<&super::storage_index::AssetRef>> = HashMap::new();
    for r in &indexed.refs {
        refs_by_chat.entry(r.session_id.as_str()).or_default().push(r);
    }
    for chat in &by_age {
        let Some(at) = broadest(rules, |rule| rule.delete == Target::Chats && matches(rule, chat)) else {
            continue;
        };
        effects[at].chats += 1;
        gone.insert(chat.id.clone());
        delete.push(chat.id.clone());
        for r in refs_by_chat.get(chat.id.as_str()).into_iter().flatten() {
            first_touch.entry(r.asset.clone()).or_insert(at);
        }
    }

    let mut after = indexed.clone();
    let mut clear = Vec::new();
    for chat in &by_age {
        if gone.contains(&chat.id) {
            continue;
        }
        for kind in [Kind::Images, Kind::Files] {
            let Some(at) = broadest(rules, |rule| rule.delete.kind() == Some(kind) && matches(rule, chat)) else {
                continue;
            };
            let through = indexed.chats.get(&chat.id).map_or(-1, |(_, through)| *through);
            let already = indexed.cleared.get(&(chat.id.clone(), kind)).copied();
            let shown: Vec<&String> = refs_by_chat
                .get(chat.id.as_str())
                .into_iter()
                .flatten()
                .filter(|r| Kind::of(&r.asset) == kind && already.map_or(true, |done| r.last_seq > done))
                .filter(|r| sizes.contains_key(&r.asset))
                .map(|r| &r.asset)
                .collect();
            if shown.is_empty() {
                continue;
            }
            effects[at].chats += 1;
            effects[at].items += shown.len();
            for asset in shown {
                first_touch.entry(asset.clone()).or_insert(at);
            }
            after.cleared.insert((chat.id.clone(), kind), through);
            clear.push((chat.id.clone(), kind, through));
        }
    }

    let mut free: Vec<String> = first_touch
        .keys()
        .filter(|asset| sizes.contains_key(*asset) && !after.in_use(asset, &gone))
        .cloned()
        .collect();
    free.sort();
    for asset in &free {
        effects[first_touch[asset]].bytes += sizes[asset];
    }
    Plan {
        effects,
        delete,
        clear,
        free,
    }
}

/// Everything a plan reads, gathered once.
pub struct Cleaner {
    pub settings: Arc<crate::db::Database>,
    pub index: Arc<StorageIndex>,
    pub media: Option<PathBuf>,
    pub chats_db: PathBuf,
    running: tokio::sync::Mutex<()>,
}

impl Cleaner {
    pub fn new(settings: Arc<crate::db::Database>, index: Arc<StorageIndex>, media: Option<PathBuf>, chats_db: PathBuf) -> Self {
        Self {
            settings,
            index,
            media,
            chats_db,
            running: tokio::sync::Mutex::new(()),
        }
    }

    /// The index caught up, the chats as they stand and the size of every
    /// stored file a chat names.
    /// `wait` holds until every chat is measured; without it a first fill is
    /// started in the background and what is measured so far is answered.
    pub(crate) async fn gather(&self, registry: &WorkbenchRegistry, wait: bool) -> Result<(Vec<Chat>, Indexed, HashMap<String, u64>), String> {
        let index = self.index.clone();
        let chats_db = self.chats_db.clone();
        let media = self.media.clone();
        let active: HashSet<String> = registry.database().active_session_ids().await?.into_iter().collect();
        let (chats, indexed, sizes) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            if wait || index.filled() {
                index.refresh()?;
            } else {
                index.fill_in_background();
            }
            let indexed = index.read()?;
            let chats = read_chats(&chats_db)?;
            let mut sizes = HashMap::new();
            if let Some(media) = media {
                for r in &indexed.refs {
                    if sizes.contains_key(&r.asset) {
                        continue;
                    }
                    if let Some(meta) = super::storage_index::stored_file(&media, &r.asset)
                        .and_then(|path| std::fs::metadata(path).ok())
                        .filter(|meta| meta.is_file())
                    {
                        sizes.insert(r.asset.clone(), meta.len());
                    }
                }
            }
            Ok((chats, indexed, sizes))
        })
        .await
        .map_err(|e| e.to_string())??;
        let chats = chats
            .into_iter()
            .map(|mut chat| {
                chat.active = chat.active || active.contains(&chat.id);
                chat
            })
            .collect();
        Ok((chats, indexed, sizes))
    }

    pub async fn preview(&self, registry: &WorkbenchRegistry, rules: &[Rule]) -> Result<Vec<Effect>, String> {
        check(rules)?;
        let (chats, indexed, sizes) = self.gather(registry, false).await?;
        Ok(plan(rules, &chats, &indexed, &sizes, Utc::now()).effects)
    }

    /// Follow the saved rules now. Refused while another run is going.
    pub async fn run(&self, registry: &WorkbenchRegistry) -> Result<RunReport, String> {
        let Ok(_running) = self.running.try_lock() else {
            return Err("A cleanup is already running.".into());
        };
        let rules = rules(&self.settings)?;
        let (chats, indexed, sizes) = self.gather(registry, true).await?;
        let plan = plan(&rules, &chats, &indexed, &sizes, Utc::now());
        let mut report = RunReport {
            at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            remaining: plan.delete.len().saturating_sub(CHATS_PER_RUN),
            ..RunReport::default()
        };

        let mut deleted = HashSet::new();
        for id in plan.delete.iter().take(CHATS_PER_RUN) {
            match delete_chat(registry, id).await {
                Ok(()) => {
                    deleted.insert(id.clone());
                }
                Err(error) => {
                    report.failed += 1;
                    report.error.get_or_insert(error);
                }
            }
        }
        report.chats = deleted.len();

        let clear = plan.clear.clone();
        let index = self.index.clone();
        let media = self.media.clone();
        let candidates: HashSet<String> = plan.free.iter().cloned().collect();
        let (images, files, bytes) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            index.mark_cleared(&clear)?;
            // Read again: deleted chats drop out, and anything a chat began to
            // show while this ran keeps its file.
            index.refresh()?;
            let now = index.read()?;
            let (mut images, mut files, mut bytes) = (0, 0, 0);
            let Some(media) = media else {
                return Ok((images, files, bytes));
            };
            for asset in candidates {
                if now.in_use(&asset, &HashSet::new()) {
                    continue;
                }
                let Some(path) = super::storage_index::stored_file(&media, &asset) else {
                    continue;
                };
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(&path).is_ok() {
                    bytes += size;
                    match Kind::of(&asset) {
                        Kind::Images => images += 1,
                        Kind::Files => files += 1,
                    }
                }
            }
            Ok((images, files, bytes))
        })
        .await
        .map_err(|e| e.to_string())??;
        report.images = images;
        report.files = files;
        report.bytes = bytes;
        let text = serde_json::to_string(&report).map_err(|e| e.to_string())?;
        self.settings
            .set_setting(LAST_RUN, Some(&text))
            .map_err(|e| e.to_string())?;
        tracing::info!(chats = report.chats, images, files, bytes, failed = report.failed, "storage cleanup ran");
        Ok(report)
    }
}

/// Delete one chat the way a person's own delete does, provider record and all.
async fn delete_chat(registry: &WorkbenchRegistry, id: &str) -> Result<(), String> {
    if registry.has_driver(id).await {
        return Err("The chat is open.".into());
    }
    let mut fields = Map::new();
    fields.insert("sessionId".into(), json!(id));
    registry
        .execute(&Command {
            kind: CommandKind::SessionDelete,
            fields,
        })
        .await
        .map(|_: Value| ())
}

pub(crate) fn read_chats(path: &std::path::Path) -> Result<Vec<Chat>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = |e: rusqlite::Error| e.to_string();
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(text)?;
    connection.busy_timeout(Duration::from_secs(10)).map_err(text)?;
    let mut statement = connection
        .prepare("SELECT id, project_id, state, last_active_at, last_spoke_at FROM session")
        .map_err(text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(text)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(text)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, project_id, state, active, spoke)| {
            let parse = |at: &str| DateTime::parse_from_rfc3339(at).ok().map(|at| at.with_timezone(&Utc));
            // The later of the two, so a chat is only ever judged older than
            // it is by neither.
            let last_at = [Some(active.as_str()), spoke.as_deref()]
                .into_iter()
                .flatten()
                .filter_map(parse)
                .max()?;
            Some(Chat {
                id,
                project_id,
                active: super::status::is_active(&state),
                last_at,
            })
        })
        .collect())
}

/// Follow the rules about once a day, for as long as the registry lives. Does
/// nothing at all while no rule is on.
pub fn watch(cleaner: Arc<Cleaner>, registry: Arc<WorkbenchRegistry>) {
    let registry = Arc::downgrade(&registry);
    tokio::spawn(async move {
        // Let a starting app settle before reading every chat.
        tokio::time::sleep(Duration::from_secs(60)).await;
        cleaner.index.fill_in_background();
        tokio::time::sleep(Duration::from_secs(540)).await;
        let mut every = tokio::time::interval(LOOK_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            let Some(registry) = registry.upgrade() else {
                break;
            };
            match rules(&cleaner.settings) {
                Ok(rules) if rules.iter().any(|rule| rule.enabled) => {}
                Ok(_) => continue,
                Err(error) => {
                    tracing::warn!(%error, "cleanup rules unreadable; nothing removed");
                    continue;
                }
            }
            let due = last_run(&cleaner.settings)
                .and_then(|run| DateTime::parse_from_rfc3339(&run.at).ok())
                .map_or(true, |at| Utc::now() - at.with_timezone(&Utc) >= RUN_EVERY);
            if !due {
                continue;
            }
            if let Err(error) = cleaner.run(&registry).await {
                tracing::warn!(%error, "storage cleanup did not run");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::storage_index::AssetRef;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png";
    const F: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.pdf";

    fn rule(id: &str, days: u32, delete: Target, project: Option<&str>) -> Rule {
        Rule {
            id: id.into(),
            enabled: true,
            amount: days,
            unit: Unit::Days,
            delete,
            project_id: project.map(String::from),
        }
    }

    fn chat(id: &str, project: &str, days_old: i64, now: DateTime<Utc>) -> Chat {
        Chat {
            id: id.into(),
            project_id: project.into(),
            last_at: now - chrono::Duration::days(days_old),
            active: false,
        }
    }

    fn refs(list: &[(&str, &str, i64)]) -> Indexed {
        let mut indexed = Indexed::default();
        for (asset, session, seq) in list {
            indexed.refs.push(AssetRef {
                asset: (*asset).into(),
                session_id: (*session).into(),
                last_seq: *seq,
            });
            let entry = indexed.chats.entry((*session).into()).or_insert((0, 0));
            entry.1 = entry.1.max(*seq);
        }
        indexed
    }

    #[test]
    fn a_chat_is_credited_to_the_rule_that_covers_the_others() {
        let now = Utc::now();
        let chats = vec![chat("old", "p", 200, now), chat("mid", "p", 100, now)];
        let rules = vec![
            rule("in-p", 90, Target::Chats, Some("p")),
            rule("older", 180, Target::Chats, None),
            rule("all", 90, Target::Chats, None),
        ];
        let plan = plan(&rules, &chats, &Indexed::default(), &HashMap::new(), now);
        let credited: Vec<usize> = plan.effects.iter().map(|e| e.chats).collect();
        assert_eq!(credited, vec![0, 0, 2]);
    }

    #[test]
    fn chat_rules_go_first_and_a_shared_picture_is_kept_while_a_chat_shows_it() {
        let now = Utc::now();
        let chats = vec![
            chat("old", "p", 100, now),
            chat("mid", "p", 40, now),
            chat("new", "p", 2, now),
        ];
        let indexed = refs(&[(A, "old", 3), (B, "old", 4), (A, "new", 1), (B, "mid", 2), (F, "mid", 5)]);
        let sizes = HashMap::from([(A.to_string(), 10), (B.to_string(), 20), (F.to_string(), 40)]);
        let rules = vec![
            rule("images", 30, Target::Images, None),
            rule("chats", 90, Target::Chats, None),
        ];
        let plan = plan(&rules, &chats, &indexed, &sizes, now);
        assert_eq!(plan.delete, vec!["old"]);
        // `old` belongs to the chat rule, so the images rule only takes `mid`.
        assert_eq!(plan.effects[0], Effect { id: "images".into(), chats: 1, items: 1, bytes: 0 });
        assert_eq!(plan.effects[1], Effect { id: "chats".into(), chats: 1, items: 0, bytes: 20 });
        // A is still shown by `new`; B is gone from both chats that showed it;
        // the PDF is not a picture.
        assert_eq!(plan.free, vec![B.to_string()]);
        assert_eq!(plan.clear, vec![("mid".to_string(), Kind::Images, 5)]);
    }

    #[test]
    fn a_rule_skips_open_chats_other_projects_and_turned_off_rules() {
        let now = Utc::now();
        let mut busy = chat("busy", "p", 50, now);
        busy.active = true;
        let chats = vec![busy, chat("other", "q", 50, now), chat("mine", "p", 50, now)];
        let mut off = rule("off", 1, Target::Chats, None);
        off.enabled = false;
        let rules = vec![off, rule("p-only", 30, Target::Chats, Some("p"))];
        let plan = plan(&rules, &chats, &Indexed::default(), &HashMap::new(), now);
        assert_eq!(plan.delete, vec!["mine"]);
        assert_eq!(plan.effects[0].chats, 0);
    }

    #[test]
    fn pictures_already_removed_are_not_counted_again() {
        let now = Utc::now();
        let mut indexed = refs(&[(A, "c", 2)]);
        indexed.cleared.insert(("c".into(), Kind::Images), 2);
        let sizes = HashMap::from([(A.to_string(), 10)]);
        let plan = plan(&[rule("i", 1, Target::Images, None)], &[chat("c", "p", 5, now)], &indexed, &sizes, now);
        assert_eq!(plan.effects[0].chats, 0);
        assert!(plan.clear.is_empty() && plan.free.is_empty());
    }

    #[test]
    fn a_list_with_a_zero_age_or_a_repeated_id_is_refused() {
        assert!(check(&[rule("a", 0, Target::Chats, None)]).is_err());
        assert!(check(&[rule("a", 1, Target::Chats, None), rule("a", 2, Target::Images, None)]).is_err());
        let mut long = rule("a", 122, Target::Chats, None);
        long.unit = Unit::Months;
        assert!(check(&[long]).is_err());
        assert!(check(&[rule("a", 30, Target::Chats, None)]).is_ok());
    }
}
