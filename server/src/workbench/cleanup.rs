//! Clearing old chats by the owner's rules.
//!
//! A rule names an age, what to do with chats older than that — delete the
//! whole chat, archive it, remove only its pictures or only its other files,
//! or shorten its long tool output — and optionally one project. Rules are
//! kept in the settings table as one list (`storage.cleanup.rules`); none are
//! set by default, and with none set nothing is ever removed.
//!
//! The same plan answers the screen's preview and the run itself, so what a
//! rule says it will do is what it does. Whole chats go through the same
//! delete a person's own delete takes, provider record included. An archived
//! chat leaves the record for a compressed file of its own and can be put
//! back; a rule that deletes chats deletes archives of that age too. Pictures
//! and files are marked removed in the storage index and their stored file is
//! deleted once no chat still shows it. Chats linked to a card that is still
//! open are left alone unless the owner turns that off.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::protocol::{Command, CommandKind};
use super::registry::WorkbenchRegistry;
use super::storage_index::{Holders, Indexed, Kind, StorageIndex};
use super::store::{self as chat_store, ArchivedChat};

pub const RULES: &str = "storage.cleanup.rules";
pub const LAST_RUN: &str = "storage.cleanup.last-run";
/// "false" when chats linked to open cards may be cleared too.
pub const KEEP_LINKED: &str = "storage.cleanup.keep-linked";

/// The most rules a list may hold. More than this is not a policy any person
/// can read at a glance.
const MOST_RULES: usize = 20;

/// The oldest age a rule may name: ten years.
const LONGEST_DAYS: u32 = 3650;

/// Chats deleted or archived in one run. Each delete asks its provider to
/// delete its own record, which starts the provider once; the rest wait for
/// the next run.
const CHATS_PER_RUN: usize = 200;

/// How often the scheduler looks, and how long a run counts for.
const LOOK_EVERY: Duration = Duration::from_secs(3600);
const RUN_EVERY: chrono::Duration = chrono::Duration::hours(23);

/// A stored file no chat shows is only called unused once it is this old, so
/// a picture on its way into a chat is never taken.
const UNUSED_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

/// How recently the installed copy must have said what it shows before any
/// other copy deletes a file from the store they share.
const OWNER_FRESH: Duration = Duration::from_secs(2 * 3600);

/// Pages handed back to the disk per writer turn, so appends wait no longer
/// than one short step (16 MB at the default page size).
const RECLAIM_STEP: i64 = 4096;

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
    Archive,
    Images,
    Files,
    Output,
}

impl Target {
    fn kind(self) -> Option<Kind> {
        match self {
            Target::Images => Some(Kind::Images),
            Target::Files => Some(Kind::Files),
            _ => None,
        }
    }

    /// Whether the rule takes the whole chat out of the record.
    fn removes(self) -> bool {
        matches!(self, Target::Chats | Target::Archive)
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

pub fn keep_linked(settings: &crate::db::Database) -> bool {
    settings.setting(KEEP_LINKED).ok().flatten().as_deref() != Some("false")
}

pub fn save_keep_linked(settings: &crate::db::Database, keep: bool) -> Result<(), String> {
    settings
        .set_setting(KEEP_LINKED, (!keep).then_some("false"))
        .map_err(|e| e.to_string())
}

/// What the last run did, for the screen.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub at: String,
    pub chats: usize,
    #[serde(default)]
    pub archived: usize,
    /// Tool outputs shortened.
    #[serde(default)]
    pub trimmed: usize,
    pub images: usize,
    pub files: usize,
    pub bytes: u64,
    /// Chats a rule matched that could not be cleared, with the first reason.
    pub failed: usize,
    #[serde(default)]
    pub error: Option<String>,
    /// Chats left for the next run because one run clears only so many.
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
#[derive(Clone, Debug, Default)]
pub struct Chat {
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub title: Option<String>,
    pub last_at: DateTime<Utc>,
    pub active: bool,
    /// Linked to a card that is still open, and kept for it.
    pub kept: bool,
}

/// What one rule would do.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    /// Chats the rule deletes or archives, or chats it removes from.
    pub chats: usize,
    /// Pictures or files removed, or tool outputs shortened.
    pub items: usize,
    /// About how many bytes it frees.
    pub bytes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Plan {
    pub effects: Vec<Effect>,
    /// Chats to delete, oldest first.
    pub delete: Vec<String>,
    /// Chats to archive, oldest first.
    pub archive: Vec<String>,
    /// Archives to delete.
    pub drop: Vec<String>,
    /// Chats whose long tool output is shortened.
    pub trim: Vec<String>,
    /// Pictures or files to mark removed, through the chat's newest event.
    pub clear: Vec<(String, Kind, i64)>,
    /// Stored files no chat would show once the rest is done.
    pub free: Vec<String>,
}

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

fn applies(rule: &Rule, project: &str, last_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    rule.enabled
        && last_at < now - chrono::Duration::days(rule.days() as i64)
        && rule.project_id.as_ref().map_or(true, |p| p == project)
}

/// Decide what a list of rules does to the chats as they stand.
///
/// Rules that take whole chats out go first, so no other rule counts a chat
/// one of them removes; a chat goes to the broadest of them (`broadest`), so a
/// chat archived at thirty days is never deleted at ninety while it is still
/// in the record. Deleting rules then take archives of their age. Every other
/// rule works on the chats that are left.
pub fn plan(
    rules: &[Rule],
    chats: &[Chat],
    archived: &[(ArchivedChat, bool)],
    indexed: &Indexed,
    sizes: &HashMap<String, u64>,
    now: DateTime<Utc>,
) -> Plan {
    let mut effects: Vec<Effect> = rules
        .iter()
        .map(|rule| Effect {
            id: rule.id.clone(),
            ..Effect::default()
        })
        .collect();
    let mut by_age: Vec<&Chat> = chats.iter().filter(|chat| !chat.active && !chat.kept).collect();
    by_age.sort_by_key(|chat| chat.last_at);

    // Chats whose files no longer count as shown: deleted ones and deleted
    // archives. Archived chats keep theirs.
    let mut gone: HashSet<String> = HashSet::new();
    let mut moved: HashSet<String> = HashSet::new();
    let mut plan = Plan::default();
    // Which rule touched each file first, for crediting what it frees.
    let mut first_touch: HashMap<String, usize> = HashMap::new();
    let mut refs_by_chat: HashMap<&str, Vec<&super::storage_index::AssetRef>> = HashMap::new();
    for r in &indexed.refs {
        refs_by_chat.entry(r.session_id.as_str()).or_default().push(r);
    }
    for chat in &by_age {
        let Some(at) = broadest(rules, |rule| rule.delete.removes() && applies(rule, &chat.project_id, chat.last_at, now))
        else {
            continue;
        };
        let bytes = indexed.chats.get(&chat.id).map_or(0, |(bytes, _)| (*bytes).max(0) as u64);
        effects[at].chats += 1;
        moved.insert(chat.id.clone());
        if rules[at].delete == Target::Archive {
            // The archive is compressed; most of the chat's room comes back.
            effects[at].bytes += bytes - bytes / 8;
            plan.archive.push(chat.id.clone());
            continue;
        }
        effects[at].bytes += bytes;
        gone.insert(chat.id.clone());
        plan.delete.push(chat.id.clone());
        for r in refs_by_chat.get(chat.id.as_str()).into_iter().flatten() {
            first_touch.entry(r.asset.clone()).or_insert(at);
        }
    }
    let mut old_archives: Vec<&(ArchivedChat, bool)> = archived.iter().filter(|(_, kept)| !kept).collect();
    old_archives.sort_by(|a, b| a.0.last_at.cmp(&b.0.last_at));
    for (archive, _) in old_archives {
        let Some(last_at) = DateTime::parse_from_rfc3339(&archive.last_at).ok().map(|at| at.with_timezone(&Utc)) else {
            continue;
        };
        let Some(at) =
            broadest(rules, |rule| rule.delete == Target::Chats && applies(rule, &archive.project_id, last_at, now))
        else {
            continue;
        };
        effects[at].chats += 1;
        effects[at].bytes += archive.size;
        gone.insert(archive.id.clone());
        plan.drop.push(archive.id.clone());
        for asset in &archive.assets {
            first_touch.entry(asset.clone()).or_insert(at);
        }
    }

    let mut after = indexed.clone();
    for chat in &by_age {
        if moved.contains(&chat.id) {
            continue;
        }
        if let Some(at) =
            broadest(rules, |rule| rule.delete == Target::Output && applies(rule, &chat.project_id, chat.last_at, now))
        {
            if let Some((events, bytes)) = indexed.trimmable.get(&chat.id).filter(|(events, _)| *events > 0) {
                effects[at].chats += 1;
                effects[at].items += *events as usize;
                effects[at].bytes += (*bytes).max(0) as u64;
                plan.trim.push(chat.id.clone());
            }
        }
        for kind in [Kind::Images, Kind::Files] {
            let Some(at) = broadest(rules, |rule| {
                rule.delete.kind() == Some(kind) && applies(rule, &chat.project_id, chat.last_at, now)
            }) else {
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
            plan.clear.push((chat.id.clone(), kind, through));
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
    plan.free = free;
    plan.effects = effects;
    plan
}

/// Everything the plan and the storage screen read, gathered once.
pub struct Gathered {
    pub chats: Vec<Chat>,
    pub indexed: Indexed,
    /// The size of every stored file a chat or archive names.
    pub sizes: HashMap<String, u64>,
    /// Archived chats, each with whether it is kept for an open card.
    pub archived: Vec<(ArchivedChat, bool)>,
}

/// A chat in the list of the largest.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BigChat {
    pub id: String,
    pub title: Option<String>,
    pub project_id: String,
    pub last_at: String,
    /// Its events in the chat record.
    pub bytes: u64,
    /// Pictures and files only it shows.
    pub media: u64,
    pub active: bool,
    pub kept: bool,
}

/// Stored files no chat or archive of any copy shows.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unused {
    pub files: usize,
    pub bytes: u64,
    /// Whether this copy may delete files from the store right now
    /// (`Cleaner::may_delete_files`).
    pub allowed: bool,
}

pub struct Cleaner {
    pub settings: Arc<crate::db::Database>,
    pub index: Arc<StorageIndex>,
    pub media: Option<PathBuf>,
    pub chats_db: PathBuf,
    /// Where archived chats are kept.
    pub archive: PathBuf,
    /// The installed copy's chat record, and whether the store is the one it
    /// shares with every copy; `None` when this copy is the installed one or
    /// its store is its own.
    owner: Option<PathBuf>,
    running: tokio::sync::Mutex<()>,
}

impl Cleaner {
    pub fn new(
        settings: Arc<crate::db::Database>,
        index: Arc<StorageIndex>,
        media: Option<PathBuf>,
        chats_db: PathBuf,
        archive: PathBuf,
    ) -> Self {
        let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let shared = media.is_some() && media == crate::identity::durable_presentation_media_dir();
        let owner = crate::identity::owner_chats_db()
            .filter(|owner| shared && canonical(owner) != canonical(&chats_db));
        Self {
            settings,
            index,
            media,
            chats_db,
            archive,
            owner,
            running: tokio::sync::Mutex::new(()),
        }
    }

    /// Whether this copy may delete files from the store: always, unless the
    /// store is shared with the installed copy and that copy has not said
    /// what it shows lately. A copy too old to say so would otherwise lose
    /// the pictures its chats show without anything saying it.
    pub fn may_delete_files(&self) -> bool {
        match (&self.owner, &self.media) {
            (Some(owner), Some(media)) => Holders::beside(media).published_lately(owner, OWNER_FRESH),
            _ => true,
        }
    }

    /// The index caught up, the chats as they stand, every archived chat and
    /// the size of every stored file they name.
    /// `wait` holds until every chat is measured; without it a first fill is
    /// started in the background and what is measured so far is answered.
    pub(crate) async fn gather(&self, registry: &WorkbenchRegistry, wait: bool) -> Result<Gathered, String> {
        self.gather_keeping(registry, wait, keep_linked(&self.settings)).await
    }

    async fn gather_keeping(&self, registry: &WorkbenchRegistry, wait: bool, keep: bool) -> Result<Gathered, String> {
        let index = self.index.clone();
        let chats_db = self.chats_db.clone();
        let media = self.media.clone();
        let archive = self.archive.clone();
        let active: HashSet<String> = registry.database().active_session_ids().await?.into_iter().collect();
        let (mut chats, indexed, sizes, archived, links) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let refreshed = wait || index.filled();
            if refreshed {
                index.refresh()?;
            } else {
                index.fill_in_background();
            }
            let mut indexed = index.read()?;
            let archived = chat_store::archived_chats(&archive);
            indexed.archived = archived.iter().map(|a| (a.id.clone(), a.assets.clone())).collect();
            if let Some(media) = &media {
                shared_holders(&index, media, &mut indexed, refreshed)?;
            }
            let chats = read_chats(&chats_db)?;
            let links = read_links(&chats_db)?;
            let mut sizes = HashMap::new();
            if let Some(media) = media {
                let named = indexed.refs.iter().map(|r| &r.asset).chain(archived.iter().flat_map(|a| &a.assets));
                for asset in named {
                    if sizes.contains_key(asset) {
                        continue;
                    }
                    if let Some(meta) = super::storage_index::stored_file(&media, asset)
                        .and_then(|path| std::fs::metadata(path).ok())
                        .filter(|meta| meta.is_file())
                    {
                        sizes.insert(asset.clone(), meta.len());
                    }
                }
            }
            Ok((chats, indexed, sizes, archived, links))
        })
        .await
        .map_err(|e| e.to_string())??;
        let open = if keep {
            let mut paths: HashMap<&str, Vec<&str>> = HashMap::new();
            for chat in chats.iter().filter(|chat| links.contains_key(&chat.id)) {
                paths.entry(chat.project_path.as_str()).or_default().push(chat.id.as_str());
            }
            for archive in archived.iter().filter(|a| !a.cards.is_empty()) {
                paths.entry(archive.project_path.as_str()).or_default();
            }
            let mut open: HashMap<String, Option<HashSet<String>>> = HashMap::new();
            for path in paths.keys() {
                open.insert(path.to_string(), open_cards(Path::new(path)).await);
            }
            Some(open)
        } else {
            None
        };
        // A chat is kept when one of its cards is open, or when its project's
        // cards cannot be read: a guess never clears a chat.
        let kept = |path: &str, cards: &[String]| match &open {
            None => false,
            Some(_) if cards.is_empty() => false,
            Some(open) => match open.get(path).and_then(Option::as_ref) {
                Some(open) => cards.iter().any(|card| open.contains(card)),
                None => true,
            },
        };
        for chat in &mut chats {
            chat.active = chat.active || active.contains(&chat.id);
            chat.kept = kept(&chat.project_path, links.get(&chat.id).map(Vec::as_slice).unwrap_or_default());
        }
        let archived = archived
            .into_iter()
            .map(|archive| {
                let keep = kept(&archive.project_path, &archive.cards);
                (archive, keep)
            })
            .collect();
        Ok(Gathered {
            chats,
            indexed,
            sizes,
            archived,
        })
    }

    /// Catch the index up and write down what this copy shows.
    pub async fn publish(&self) -> Result<(), String> {
        let index = self.index.clone();
        let archive = self.archive.clone();
        let Some(media) = self.media.clone() else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || {
            index.refresh()?;
            let mut indexed = index.read()?;
            indexed.archived = archived_assets(&archive);
            shared_holders(&index, &media, &mut indexed, true)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn preview(&self, registry: &WorkbenchRegistry, rules: &[Rule]) -> Result<Vec<Effect>, String> {
        self.preview_keeping(registry, rules, keep_linked(&self.settings)).await
    }

    /// The preview with the keep-linked switch as the screen has it, saved
    /// or not.
    pub async fn preview_keeping(&self, registry: &WorkbenchRegistry, rules: &[Rule], keep: bool) -> Result<Vec<Effect>, String> {
        check(rules)?;
        let found = self.gather_keeping(registry, false, keep).await?;
        Ok(plan(rules, &found.chats, &found.archived, &found.indexed, &found.sizes, Utc::now()).effects)
    }

    /// Follow the saved rules now. Refused while another run is going.
    pub async fn run(&self, registry: &WorkbenchRegistry) -> Result<RunReport, String> {
        let Ok(_running) = self.running.try_lock() else {
            return Err("A cleanup is already running.".into());
        };
        let rules = rules(&self.settings)?;
        let found = self.gather(registry, true).await?;
        let plan = plan(&rules, &found.chats, &found.archived, &found.indexed, &found.sizes, Utc::now());
        let before = self.disk_bytes();
        let mut report = RunReport {
            at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            remaining: (plan.delete.len() + plan.archive.len()).saturating_sub(CHATS_PER_RUN),
            ..RunReport::default()
        };
        let mut budget = CHATS_PER_RUN;
        let fail = |report: &mut RunReport, error: String| {
            report.failed += 1;
            report.error.get_or_insert(error);
        };
        for id in plan.delete.iter().take(budget) {
            match delete_chat(registry, id).await {
                Ok(()) => report.chats += 1,
                Err(error) => fail(&mut report, error),
            }
        }
        budget = budget.saturating_sub(plan.delete.len());
        for id in plan.archive.iter().take(budget) {
            match self.archive_chat(registry, id).await {
                Ok(()) => report.archived += 1,
                Err(error) => fail(&mut report, error),
            }
        }
        for id in &plan.drop {
            match self.delete_archive(id).await {
                Ok(()) => report.chats += 1,
                Err(error) => fail(&mut report, error),
            }
        }
        for id in &plan.trim {
            let id = id.clone();
            let trimmed = registry
                .database()
                .upkeep(move |store| {
                    store
                        .trim_tool_output(&id)
                        .map(|(events, _)| json!(events))
                        .map_err(|e| e.to_string())
                })
                .await;
            match trimmed {
                Ok(events) => report.trimmed += events.as_u64().unwrap_or(0) as usize,
                Err(error) => fail(&mut report, error),
            }
        }
        let clear = plan.clear.clone();
        let index = self.index.clone();
        tokio::task::spawn_blocking(move || index.mark_cleared(&clear))
            .await
            .map_err(|e| e.to_string())??;
        let (images, files) = self.free_files(plan.free.iter().cloned().collect()).await?;
        // Files no chat shows any more, whatever left them: a person's own
        // deletes, or chats gone before the index knew them.
        let (swept_images, swept_files) = self.delete_unused(registry).await.unwrap_or_default();
        report.images = images + swept_images;
        report.files = files + swept_files;
        self.reclaim(registry).await;
        report.bytes = before.saturating_sub(self.disk_bytes());
        let text = serde_json::to_string(&report).map_err(|e| e.to_string())?;
        self.settings
            .set_setting(LAST_RUN, Some(&text))
            .map_err(|e| e.to_string())?;
        tracing::info!(
            chats = report.chats,
            archived = report.archived,
            trimmed = report.trimmed,
            images = report.images,
            files = report.files,
            bytes = report.bytes,
            failed = report.failed,
            "storage cleanup ran"
        );
        Ok(report)
    }

    /// What the chat record, the archives and the store take together: what
    /// a run frees is this before less this after.
    fn disk_bytes(&self) -> u64 {
        let file = |path: &Path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        file(&self.chats_db)
            + super::disk_usage::size_of(&self.archive)
            + self.media.as_deref().map_or(0, super::disk_usage::size_of)
    }

    /// Delete these stored files where no chat or archive of any copy still
    /// shows them, read again now so a file a chat began to show meanwhile is
    /// kept. Nothing is deleted while `may_delete_files` says no. How many
    /// pictures and other files went.
    pub async fn free_files(&self, candidates: HashSet<String>) -> Result<(usize, usize), String> {
        let Some(media) = self.media.clone() else {
            return Ok((0, 0));
        };
        if candidates.is_empty() || !self.may_delete_files() {
            return Ok((0, 0));
        }
        let index = self.index.clone();
        let archive = self.archive.clone();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            index.refresh()?;
            let mut now = index.read()?;
            now.archived = archived_assets(&archive);
            shared_holders(&index, &media, &mut now, true)?;
            let (mut images, mut files) = (0, 0);
            for asset in candidates {
                if now.in_use(&asset, &HashSet::new()) {
                    continue;
                }
                let Some(path) = super::storage_index::stored_file(&media, &asset) else {
                    continue;
                };
                if std::fs::remove_file(&path).is_ok() {
                    match Kind::of(&asset) {
                        Kind::Images => images += 1,
                        Kind::Files => files += 1,
                    }
                }
            }
            Ok((images, files))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Stored files that no chat or archive shows, here or in any copy that
    /// says what it shows, and that have been in the store a while. Only
    /// counted once every chat is measured; before that, none.
    pub async fn unused(&self, found: &Gathered) -> Unused {
        let Some(media) = self.media.clone() else {
            return Unused::default();
        };
        if !self.index.progress().ready {
            return Unused::default();
        }
        let allowed = self.may_delete_files();
        let indexed = found.indexed.clone();
        tokio::task::spawn_blocking(move || {
            let (files, bytes) = unused_files(&media, &indexed)
                .iter()
                .fold((0, 0), |(n, total), (_, size)| (n + 1, total + size));
            Unused { files, bytes, allowed }
        })
        .await
        .unwrap_or_default()
    }

    /// Delete every unused stored file (`unused`).
    pub async fn delete_unused(&self, registry: &WorkbenchRegistry) -> Result<(usize, usize), String> {
        let found = self.gather(registry, true).await?;
        let Some(media) = self.media.clone() else {
            return Ok((0, 0));
        };
        let indexed = found.indexed.clone();
        let candidates = tokio::task::spawn_blocking(move || unused_files(&media, &indexed))
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(asset, _)| asset)
            .collect();
        self.free_files(candidates).await
    }

    /// Delete or archive chats by hand, and free what only they showed.
    pub async fn clear_chats(&self, registry: &WorkbenchRegistry, ids: &[String], archive: bool) -> Result<Value, String> {
        let Ok(_running) = self.running.try_lock() else {
            return Err("A cleanup is already running.".into());
        };
        let index = self.index.clone();
        let indexed = tokio::task::spawn_blocking(move || index.read()).await.map_err(|e| e.to_string())??;
        let mut done = 0;
        let mut error = None;
        for id in ids {
            let result = if archive {
                self.archive_chat(registry, id).await
            } else {
                delete_chat(registry, id).await
            };
            match result {
                Ok(()) => done += 1,
                Err(why) => {
                    error.get_or_insert(why);
                }
            }
        }
        if !archive {
            let gone: HashSet<&String> = ids.iter().collect();
            let candidates = indexed
                .refs
                .iter()
                .filter(|r| gone.contains(&r.session_id))
                .map(|r| r.asset.clone())
                .collect();
            self.free_files(candidates).await?;
        }
        self.reclaim(registry).await;
        Ok(json!({"done": done, "failed": ids.len() - done, "error": error}))
    }

    /// Put an archived chat back.
    pub async fn restore(&self, registry: &WorkbenchRegistry, id: &str) -> Result<(), String> {
        let id = id.to_string();
        let dir = self.archive.clone();
        registry
            .database()
            .upkeep(move |store| {
                store
                    .restore_session(&id, &dir)
                    .map(|()| Value::Null)
                    .map_err(|e| e.to_string())
            })
            .await
            .map(drop)
    }

    async fn archive_chat(&self, registry: &WorkbenchRegistry, id: &str) -> Result<(), String> {
        if registry.has_driver(id).await {
            return Err("The chat is open.".into());
        }
        let id = id.to_string();
        let dir = self.archive.clone();
        let at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        registry
            .database()
            .upkeep(move |store| {
                store
                    .archive_session(&id, &dir, &at)
                    .map(|_| Value::Null)
                    .map_err(|e| e.to_string())
            })
            .await
            .map(drop)
    }

    /// Delete an archive, and ask the chat's provider to delete its own copy
    /// as a person's delete would. The archive stays when the provider can't.
    pub async fn delete_archive(&self, id: &str) -> Result<(), String> {
        let session = chat_store::archived_session(&self.archive, id)?;
        if session.external_id.is_some() {
            super::acp::client::delete_session(&session).await?;
        }
        let assets: HashSet<String> = chat_store::archived_chats(&self.archive)
            .into_iter()
            .find(|a| a.id == id)
            .map(|a| a.assets.into_iter().collect())
            .unwrap_or_default();
        chat_store::drop_archive(&self.archive, id).map_err(|e| e.to_string())?;
        self.free_files(assets).await?;
        Ok(())
    }

    /// Hand the chat record's unused pages back to the disk, a step at a
    /// time. Does nothing until the record has been shrunk once (`compact`).
    pub async fn reclaim(&self, registry: &WorkbenchRegistry) {
        loop {
            let left = registry
                .database()
                .upkeep(|store| {
                    if !store.reclaims_space().map_err(|e| e.to_string())? {
                        return Ok(json!(0));
                    }
                    store.reclaim(RECLAIM_STEP).map(|left| json!(left)).map_err(|e| e.to_string())
                })
                .await;
            match left.map(|left| left.as_i64().unwrap_or(0)) {
                Ok(left) if left > 0 => tokio::task::yield_now().await,
                Ok(_) => break,
                Err(error) => {
                    tracing::warn!(%error, "chat record space not handed back");
                    break;
                }
            }
        }
    }

    /// Shrink the chat record to what it holds, and from then on hand space
    /// back as it is freed. Refused while a chat is running: nothing can be
    /// written while it works, and on a large record that takes minutes.
    pub async fn compact(&self, registry: &WorkbenchRegistry) -> Result<Value, String> {
        let Ok(_running) = self.running.try_lock() else {
            return Err("A cleanup is already running.".into());
        };
        if !registry.database().active_session_ids().await?.is_empty() {
            return Err("Stop running chats first.".into());
        }
        let size = std::fs::metadata(&self.chats_db).map(|m| m.len()).unwrap_or(0);
        let unused = self.index.unused_chat_bytes().unwrap_or(0);
        // The rebuild writes a full copy beside the record, then the record
        // again through its log.
        let needed = 2 * size.saturating_sub(unused) + (1 << 30);
        if let Some(disk) = self.chats_db.parent().and_then(super::disk_usage::disk) {
            if disk.free < needed {
                return Err(format!(
                    "Not enough free space. Shrinking needs about {} free.",
                    words(needed)
                ));
            }
        }
        registry
            .database()
            .upkeep(|store| store.compact().map(|()| Value::Null).map_err(|e| e.to_string()))
            .await?;
        let after = std::fs::metadata(&self.chats_db).map(|m| m.len()).unwrap_or(0);
        Ok(json!({"before": size, "after": after}))
    }

    /// The largest chats, their own events and the files only they show.
    pub fn largest(found: &Gathered, most: usize) -> Vec<BigChat> {
        let mut shown_by: HashMap<&str, usize> = HashMap::new();
        for r in &found.indexed.refs {
            *shown_by.entry(r.asset.as_str()).or_default() += 1;
        }
        let mut media: HashMap<&str, u64> = HashMap::new();
        for r in &found.indexed.refs {
            let cleared = found
                .indexed
                .cleared
                .get(&(r.session_id.clone(), Kind::of(&r.asset)))
                .is_some_and(|through| r.last_seq <= *through);
            if cleared || shown_by[r.asset.as_str()] > 1 || found.indexed.elsewhere.contains(&r.asset) {
                continue;
            }
            *media.entry(r.session_id.as_str()).or_default() += found.sizes.get(&r.asset).copied().unwrap_or(0);
        }
        let mut chats: Vec<BigChat> = found
            .chats
            .iter()
            .map(|chat| BigChat {
                id: chat.id.clone(),
                title: chat.title.clone(),
                project_id: chat.project_id.clone(),
                last_at: chat.last_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                bytes: found.indexed.chats.get(&chat.id).map_or(0, |(bytes, _)| (*bytes).max(0) as u64),
                media: media.get(chat.id.as_str()).copied().unwrap_or(0),
                active: chat.active,
                kept: chat.kept,
            })
            .collect();
        chats.sort_by_key(|chat| std::cmp::Reverse(chat.bytes + chat.media));
        chats.truncate(most);
        chats
    }
}

fn words(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / (1u64 << 30) as f64)
}

/// The files each archived chat names.
fn archived_assets(dir: &Path) -> HashMap<String, Vec<String>> {
    chat_store::archived_chats(dir)
        .into_iter()
        .map(|a| (a.id, a.assets))
        .collect()
}

/// Every stored file not in use and older than `UNUSED_AFTER`, with its size.
fn unused_files(media: &Path, indexed: &Indexed) -> Vec<(String, u64)> {
    let now = std::time::SystemTime::now();
    std::fs::read_dir(media)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            super::storage_index::stored_file(media, &name)?;
            let meta = entry.metadata().ok().filter(|m| m.is_file())?;
            let age = meta.modified().ok().and_then(|at| now.duration_since(at).ok())?;
            (age >= UNUSED_AFTER && !indexed.in_use(&name, &HashSet::new())).then_some((name, meta.len()))
        })
        .collect()
}

/// Publish what this copy shows, when its index is complete, and take in what
/// every other copy sharing the store shows, so neither plans to remove it.
fn shared_holders(index: &StorageIndex, media: &Path, indexed: &mut Indexed, complete: bool) -> Result<(), String> {
    let holders = Holders::beside(media);
    let copy = std::fs::canonicalize(index.chats_path()).unwrap_or_else(|_| index.chats_path().to_path_buf());
    if complete {
        holders.publish(&copy, indexed)?;
    }
    indexed.elsewhere = holders.elsewhere(&copy)?;
    Ok(())
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

/// The cards that are not closed in one project, or `None` when its board
/// can't be read.
async fn open_cards(project: &Path) -> Option<HashSet<String>> {
    if !project.is_dir() {
        return None;
    }
    let out = super::beads_links::BdRunner::default()
        .run(project, &["list", "--json", "--limit", "0", "--flat", "--brief", "--skip-labels"])
        .await;
    if !out.ok {
        return None;
    }
    let rows: Vec<Value> = serde_json::from_str(&out.stdout).ok()?;
    Some(
        rows.iter()
            .filter(|row| row["status"].as_str() != Some("closed"))
            .filter_map(|row| row["id"].as_str().map(String::from))
            .collect(),
    )
}

fn open_read_only(path: &Path) -> Result<rusqlite::Connection, String> {
    let text = |e: rusqlite::Error| e.to_string();
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(text)?;
    connection.busy_timeout(Duration::from_secs(10)).map_err(text)?;
    Ok(connection)
}

/// The cards each chat is linked to.
fn read_links(path: &Path) -> Result<HashMap<String, Vec<String>>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let connection = open_read_only(path)?;
    let mut links: HashMap<String, Vec<String>> = HashMap::new();
    let mut statement = connection
        .prepare("SELECT session_id, bead_id FROM bead_link")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (session, card) = row.map_err(|e| e.to_string())?;
        links.entry(session).or_default().push(card);
    }
    Ok(links)
}

pub(crate) fn read_chats(path: &Path) -> Result<Vec<Chat>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = |e: rusqlite::Error| e.to_string();
    let connection = open_read_only(path)?;
    let mut statement = connection
        .prepare("SELECT id, project_id, project_path, title, state, last_active_at, last_spoke_at FROM session")
        .map_err(text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(text)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(text)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, project_id, project_path, title, state, active, spoke)| {
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
                project_path,
                title,
                active: super::status::is_active(&state),
                last_at,
                kept: false,
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
        let mut every = tokio::time::interval(LOOK_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            let Some(registry) = registry.upgrade() else {
                break;
            };
            // Every copy says what it shows, rules or none, so a copy that does
            // clean up knows what to leave in the store they share.
            if let Err(error) = cleaner.publish().await {
                tracing::warn!(%error, "storage index not caught up");
            }
            // Space a person's own deletes freed goes back to the disk too.
            cleaner.reclaim(&registry).await;
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
            ..Chat::default()
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

    fn archive(id: &str, days_old: i64, assets: &[&str], now: DateTime<Utc>) -> ArchivedChat {
        ArchivedChat {
            id: id.into(),
            project_id: "p".into(),
            last_at: (now - chrono::Duration::days(days_old)).to_rfc3339(),
            size: 7,
            assets: assets.iter().map(|a| a.to_string()).collect(),
            ..ArchivedChat::default()
        }
    }

    #[test]
    fn a_chat_archived_first_is_deleted_later_with_the_files_only_it_showed() {
        let now = Utc::now();
        let chats = vec![chat("recent", "p", 40, now), chat("shared", "p", 2, now)];
        let mut indexed = refs(&[(A, "recent", 1), (A, "shared", 1)]);
        indexed.chats.insert("recent".into(), (800, 1));
        indexed.archived.insert("old".into(), vec![B.into()]);
        let sizes = HashMap::from([(A.to_string(), 10), (B.to_string(), 20)]);
        let rules = vec![
            rule("delete", 365, Target::Chats, None),
            rule("archive", 30, Target::Archive, None),
        ];
        let archived = vec![(archive("old", 400, &[B], now), false), (archive("young", 100, &[], now), false)];
        let plan = plan(&rules, &chats, &archived, &indexed, &sizes, now);
        assert_eq!(plan.archive, vec!["recent"]);
        assert!(plan.delete.is_empty());
        assert_eq!(plan.drop, vec!["old"]);
        // The archived chat keeps its picture; the deleted archive frees its own.
        assert_eq!(plan.free, vec![B.to_string()]);
        assert_eq!(plan.effects[0], Effect { id: "delete".into(), chats: 1, items: 0, bytes: 27 });
        assert_eq!(plan.effects[1], Effect { id: "archive".into(), chats: 1, items: 0, bytes: 700 });
    }

    #[test]
    fn a_chat_kept_for_an_open_card_is_left_whole() {
        let now = Utc::now();
        let mut kept = chat("kept", "p", 100, now);
        kept.kept = true;
        let mut indexed = Indexed::default();
        indexed.trimmable.insert("kept".into(), (3, 900));
        indexed.trimmable.insert("plain".into(), (2, 500));
        let chats = vec![kept, chat("plain", "p", 100, now)];
        let rules = vec![rule("trim", 30, Target::Output, None)];
        let plan = plan(&rules, &chats, &[(archive("a", 900, &[], now), true)], &indexed, &HashMap::new(), now);
        assert_eq!(plan.trim, vec!["plain"]);
        assert_eq!(plan.effects[0], Effect { id: "trim".into(), chats: 1, items: 2, bytes: 500 });
        let plan = plan_all(&[rule("all", 1, Target::Chats, None)], &chats, now);
        assert_eq!(plan.delete, vec!["plain"]);
    }

    fn plan_all(rules: &[Rule], chats: &[Chat], now: DateTime<Utc>) -> Plan {
        plan(rules, chats, &[], &Indexed::default(), &HashMap::new(), now)
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
        let plan = plan(&rules, &chats, &[], &Indexed::default(), &HashMap::new(), now);
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
        let plan = plan(&rules, &chats, &[], &indexed, &sizes, now);
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
        let plan = plan(&rules, &chats, &[], &Indexed::default(), &HashMap::new(), now);
        assert_eq!(plan.delete, vec!["mine"]);
        assert_eq!(plan.effects[0].chats, 0);
    }

    #[test]
    fn pictures_already_removed_are_not_counted_again() {
        let now = Utc::now();
        let mut indexed = refs(&[(A, "c", 2)]);
        indexed.cleared.insert(("c".into(), Kind::Images), 2);
        let sizes = HashMap::from([(A.to_string(), 10)]);
        let plan = plan(&[rule("i", 1, Target::Images, None)], &[chat("c", "p", 5, now)], &[], &indexed, &sizes, now);
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
