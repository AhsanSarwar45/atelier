//! What the composer's `@` offers besides files: tasks, chats and
//! skills (bw-mi3s.4).
//!
//! One question, one answer. The menu asks `GET /api/workbench/mention` once per
//! keystroke and draws what comes back, grouped by kind, in the order it comes.
//! Everything asked about is already held in memory: the task list, the chat list, the library's skills, and the file listing `/api/fs/find`
//! keeps. So a keystroke costs a scan of a few thousand short strings, not a
//! disk or a process.
//!
//! Ranking is one small scorer for every kind, so a task and a chat that answer
//! the same letters equally well are scored the same way. What was typed is a
//! single word — whitespace ends an `@` in the composer — so there is no query
//! language here, only how well that word fits a name or an id.

use serde::Serialize;
use serde_json::Value;

use crate::workbench::store::Session;

/// A kind the menu can offer, in the order its groups are drawn when nothing
/// has been typed yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Chat,
    Skill,
    Diff,
    Task,
    Grid,
}

impl Kind {
    pub const ALL: [Kind; 6] = [Kind::File, Kind::Diff, Kind::Task, Kind::Grid, Kind::Chat, Kind::Skill];

    pub fn parse(word: &str) -> Option<Kind> {
        match word {
            "file" => Some(Kind::File),
            "chat" => Some(Kind::Chat),
            "skill" => Some(Kind::Skill),
            "diff" => Some(Kind::Diff),
            "task" => Some(Kind::Task),
            "grid" => Some(Kind::Grid),
            _ => None,
        }
    }

    /// How many of this kind the menu shows beside the others. Asked for alone,
    /// a kind gets the whole menu.
    pub fn share(self) -> usize {
        match self {
            Kind::File => 8,
            Kind::Chat => 5,
            Kind::Skill => 5,
            Kind::Diff => 4,
            Kind::Task => 6,
            Kind::Grid => 4,
        }
    }
}

/// One line of the menu.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Offer {
    pub kind: Kind,
    /// What goes after `@kind:` — or, for a file, after `@`.
    pub id: String,
    /// What is read: a file's name, a task's title, a chat's or a skill's name.
    pub label: String,
    /// What is read after it, dimmed: a file's folder, a task's status, a
    /// chat's provider, a skill's description.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// A file that is a folder; a task's status; a chat's provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    #[serde(rename = "projectId", skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip)]
    pub score: i32,
}

impl Offer {
    fn new(kind: Kind, id: String, label: String, score: i32) -> Offer {
        Offer { kind, id, label, detail: String::new(), folder: None, status: None, brand: None, project_id: None, score }
    }
}

const EXACT: i32 = 1000;
const PREFIX: i32 = 800;
const WORD: i32 = 600;
const INSIDE: i32 = 400;
const LOOSE: i32 = 200;

/// How well `wanted` (already lower case) fits one name. `None` when it does
/// not fit at all.
pub fn fit(name: &str, wanted: &str) -> Option<i32> {
    if wanted.is_empty() {
        return Some(0);
    }
    let name = name.to_lowercase();
    if name == wanted {
        return Some(EXACT);
    }
    // Shorter names first among equals: `std` fits `standup` better than
    // `standup-for-the-whole-team`.
    let shorter = -(name.len().min(100) as i32);
    if name.starts_with(wanted) {
        return Some(PREFIX + shorter);
    }
    if let Some(at) = name.find(wanted) {
        let on_a_word = name[..at].ends_with(|c: char| !c.is_alphanumeric());
        return Some(if on_a_word { WORD } else { INSIDE } + shorter);
    }
    // The letters in order with gaps between them, fewer and earlier gaps first.
    let mut first = None;
    let mut last = 0;
    let mut letters = name.char_indices();
    for wanted in wanted.chars() {
        let (at, _) = letters.find(|(_, c)| *c == wanted)?;
        first.get_or_insert(at);
        last = at;
    }
    let spread = (last - first.unwrap_or(0)).min(100) as i32;
    Some(LOOSE - spread - first.unwrap_or(0).min(50) as i32)
}

/// The best fit over several names of one thing.
fn best_fit(names: &[&str], wanted: &str) -> Option<i32> {
    names.iter().filter_map(|name| fit(name, wanted)).max()
}

fn keep(mut offers: Vec<Offer>, limit: usize, tie: impl Fn(&Offer, &Offer) -> std::cmp::Ordering) -> Vec<Offer> {
    offers.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| tie(a, b)));
    offers.truncate(limit);
    offers
}

/// The project's tasks that answer `wanted`, by number (`12` or `#12`) or by
/// title. With nothing typed, the ones in progress first, then the ones still
/// open, newest first; a finished or cancelled task is only offered when it
/// is asked for.
pub fn tasks(tasks: &[crate::workbench::tasks::TaskRow], wanted: &str, limit: usize) -> Vec<Offer> {
    let wanted = wanted.to_lowercase();
    let wanted = wanted.strip_prefix('#').unwrap_or(&wanted);
    let lively = |status: &str| match status {
        "in_progress" => 2,
        "done" | "cancelled" => 0,
        _ => 1,
    };
    let mut offers = tasks
        .iter()
        .filter(|task| !wanted.is_empty() || lively(&task.status) > 0)
        .filter_map(|task| {
            let number = task.number.to_string();
            let score = best_fit(&[&number, &task.title], wanted)?;
            let mut offer = Offer::new(Kind::Task, number, task.title.clone(), score * 4 + lively(&task.status));
            offer.detail = task.status.replace('_', " ");
            offer.status = Some(task.status.clone());
            offer.project_id = Some(task.project_id.clone());
            Some((offer, task.number))
        })
        .collect::<Vec<_>>();
    offers.sort_by(|a, b| b.0.score.cmp(&a.0.score).then_with(|| b.1.cmp(&a.1)));
    offers.into_iter().take(limit).map(|(offer, _)| offer).collect()
}

/// The project's coverage grids that answer `wanted`, by slug or title; a
/// discarded grid is never offered. Each is offered by its slug, which is
/// what `@grid:` and `@audit` take.
pub fn grids(grids: &[crate::workbench::grids::Grid], wanted: &str, limit: usize) -> Vec<Offer> {
    let wanted = wanted.to_lowercase();
    let offers = grids
        .iter()
        .filter(|grid| grid.status != "discarded")
        .filter_map(|grid| {
            let score = best_fit(&[&grid.slug, &grid.title], &wanted)?;
            let mut offer = Offer::new(Kind::Grid, grid.slug.clone(), grid.title.clone(), score);
            offer.detail = grid.slug.clone();
            offer.status = Some(grid.status.clone());
            offer.project_id = Some(grid.project_id.clone());
            Some(offer)
        })
        .collect();
    keep(offers, limit, |a, b| a.id.cmp(&b.id))
}

/// The chats that answer `wanted`, by name or by id. The chat asking is not
/// offered to itself. Chats of the project being worked in come first among
/// equals, then the most recently active.
pub fn chats(sessions: &[(Session, String)], wanted: &str, here: Option<&str>, project_id: Option<&str>, limit: usize) -> Vec<Offer> {
    let wanted = wanted.to_lowercase();
    let mut offers = sessions
        .iter()
        .filter(|(session, _)| Some(session.id.as_str()) != here)
        .filter_map(|(session, name)| {
            let by_name = best_fit(&[name, session.title.as_deref().unwrap_or("")], &wanted);
            let by_id = (!wanted.is_empty() && session.id.starts_with(&wanted)).then_some(PREFIX);
            let score = by_name.into_iter().chain(by_id).max()?;
            let local = project_id == Some(session.project_id.as_str());
            let mut offer = Offer::new(Kind::Chat, session.id.clone(), name.clone(), score * 2 + i32::from(local));
            offer.brand = Some(session.brand.clone());
            offer.project_id = Some(session.project_id.clone());
            // Two chats in one folder often share a name; when each was last
            // used is what tells them apart in the menu.
            offer.detail = session.last_active_at.clone();
            Some((offer, session.last_active_at.as_str()))
        })
        .collect::<Vec<_>>();
    offers.sort_by(|a, b| b.0.score.cmp(&a.0.score).then_with(|| b.1.cmp(a.1)));
    offers.into_iter().take(limit).map(|(offer, _)| offer).collect()
}

/// The skills that answer `wanted`, from the library's command list (the same
/// list the `/` menu shows, so a skill offered here is one a chat can use).
pub fn skills(commands: &[Value], wanted: &str, limit: usize) -> Vec<Offer> {
    let wanted = wanted.to_lowercase();
    let offers = commands
        .iter()
        .filter_map(|command| {
            let id = command["name"].as_str()?.strip_prefix("skill:")?;
            let name = command["title"].as_str().unwrap_or(id);
            let score = best_fit(&[id, name], &wanted)?;
            let mut offer = Offer::new(Kind::Skill, id.to_string(), name.to_string(), score);
            offer.detail = command["description"].as_str().unwrap_or("").to_string();
            Some(offer)
        })
        .collect();
    keep(offers, limit, |a, b| a.label.cmp(&b.label))
}

/// Files, already ranked by `/api/fs/find`'s own scorer, as lines of the menu.
/// Scored again here only so the groups can be put in order against each other.
pub fn files(found: Vec<crate::routes::fs::FoundPath>, wanted: &str) -> Vec<Offer> {
    let wanted = wanted.to_lowercase();
    found
        .into_iter()
        .map(|found| {
            let (folder, name) = match found.path.rsplit_once('/') {
                Some((folder, name)) => (folder.to_string(), name.to_string()),
                None => (String::new(), found.path.clone()),
            };
            let score = fit(&name, &wanted).unwrap_or(0);
            let mut offer = Offer::new(Kind::File, found.path.clone(), name, score);
            offer.detail = folder;
            offer.folder = Some(found.kind == "dir");
            offer
        })
        .collect()
}

/// Changed files, as diffs to point at: the uncommitted change to each one
/// whose name fits, best first, with what happened to it beside its folder.
pub fn diffs(changed: &[(String, String)], wanted: &str, limit: usize) -> Vec<Offer> {
    let wanted = wanted.to_lowercase();
    let offers = changed
        .iter()
        // A path the reference cannot carry whole would be inserted cut short.
        .filter(|(path, _)| crate::workbench::references::diff_path_writable(path))
        .filter_map(|(path, status)| {
            let (folder, name) = match path.rsplit_once('/') {
                Some((folder, name)) => (folder, name),
                None => ("", path.as_str()),
            };
            let score = fit(&name.to_lowercase(), &wanted).or_else(|| fit(&path.to_lowercase(), &wanted))?;
            let mut offer = Offer::new(Kind::Diff, path.clone(), name.to_string(), score);
            offer.detail = folder.to_string();
            offer.status = Some(status.clone());
            Some(offer)
        })
        .collect();
    keep(offers, limit, |a, b| a.id.cmp(&b.id))
}

/// The groups in the order the menu draws them: the one with the best answer
/// first once something is typed, and the fixed order before that.
pub fn in_order(mut groups: Vec<(Kind, Vec<Offer>)>, typed: bool) -> Vec<Offer> {
    if typed {
        let top = |offers: &[Offer]| offers.iter().map(|o| o.score).max().unwrap_or(i32::MIN);
        let ranked = |kind: Kind, offers: &[Offer]| match kind {
            // Undo the tie-breaking multipliers so every kind is on one scale.
            Kind::Task => top(offers) / 4,
            Kind::Chat => top(offers) / 2,
            _ => top(offers),
        };
        groups.sort_by_key(|(kind, offers)| std::cmp::Reverse(ranked(*kind, offers)));
    }
    groups.into_iter().flat_map(|(_, offers)| offers).collect()
}

/// What the word after the composer's `@` asks for: a kind named with
/// `task:`, `chat:`, `skill:` or `diff:` narrows the menu to it, and the rest is the
/// word to look for.
pub fn scoped(typed: &str) -> (Option<Kind>, &str) {
    if let Some((word, rest)) = typed.split_once(':') {
        if let Some(kind @ (Kind::Task | Kind::Chat | Kind::Skill | Kind::Diff | Kind::Grid)) = Kind::parse(word) {
            return (Some(kind), rest);
        }
    }
    (None, typed)
}

/// A short-lived copy of something a keystroke reads and a keystroke does not
/// change: the chat list and a folder's skills. Typing `@stand` asks five
/// times in a second, and five reads of the same list are one read kept.
pub struct Kept<T> {
    held: std::sync::Mutex<std::collections::BTreeMap<String, (std::time::Instant, std::sync::Arc<T>)>>,
    fresh_for: std::time::Duration,
}

impl<T> Kept<T> {
    pub const fn new(fresh_for: std::time::Duration) -> Kept<T> {
        Kept { held: std::sync::Mutex::new(std::collections::BTreeMap::new()), fresh_for }
    }

    pub fn get(&self, key: &str) -> Option<std::sync::Arc<T>> {
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        held.get(key).filter(|(at, _)| at.elapsed() < self.fresh_for).map(|(_, value)| value.clone())
    }

    pub fn put(&self, key: &str, value: T) -> std::sync::Arc<T> {
        let value = std::sync::Arc::new(value);
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|_, (at, _)| at.elapsed() < self.fresh_for);
        held.insert(key.to_string(), (std::time::Instant::now(), value.clone()));
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_fits_best_whole_then_at_the_start_then_on_a_word_then_inside_then_loosely() {
        let fits = ["standup", "standup-notes", "daily-standup", "withstand", "s-t-a-n-d"]
            .map(|name| fit(name, "stand").unwrap());
        assert!(fits.windows(2).all(|pair| pair[0] > pair[1]), "{fits:?}");
        assert_eq!(fit("anything", "zz"), None);
    }

    #[test]
    fn a_kind_named_before_a_colon_narrows_the_menu_to_it() {
        assert_eq!(scoped("chat:stand"), (Some(Kind::Chat), "stand"));
        // The board's kind is gone; `bead:` is read as a word to look for.
        assert_eq!(scoped("bead:"), (None, "bead:"));
        assert_eq!(scoped("src/a:b"), (None, "src/a:b"));
        assert_eq!(scoped("file:x"), (None, "file:x"));
    }

    fn task(number: i64, title: &str, status: &str) -> crate::workbench::tasks::TaskRow {
        crate::workbench::tasks::TaskRow {
            project_id: "p".into(), number, kind: "bug".into(), title: title.into(), why: String::new(),
            status: status.into(), session_id: None, created_by: None, plan: Value::Null, result: None,
            shortfalls: false, blocked: None, cancel_reason: None, pending_amend: None,
            created_at: 0, updated_at: 0, started_at: None, finished_at: None, checks: None, gate: None,
            decisions: Value::Null, type_def: None,
        }
    }

    #[test]
    fn a_task_answers_to_its_number_and_its_title_and_a_finished_one_only_when_asked() {
        let tasks_here = [
            task(1, "Fix the login page", "done"),
            task(2, "Draw the badge", "todo"),
            task(3, "Search for chats", "in_progress"),
            task(12, "Speed up the board", "blocked"),
        ];
        let ids = |offers: Vec<Offer>| offers.into_iter().map(|o| o.id).collect::<Vec<_>>();
        assert_eq!(ids(tasks(&tasks_here, "", 10)), ["3", "12", "2"]);
        assert_eq!(ids(tasks(&tasks_here, "login", 10)), ["1"]);
        assert_eq!(ids(tasks(&tasks_here, "12", 10))[0], "12");
        assert_eq!(ids(tasks(&tasks_here, "#1", 10))[0], "1");
        let found = tasks(&tasks_here, "badge", 10);
        assert_eq!((found[0].label.as_str(), found[0].status.as_deref(), found[0].detail.as_str()), ("Draw the badge", Some("todo"), "todo"));
        assert_eq!(scoped("task:12"), (Some(Kind::Task), "12"));
    }

    #[test]
    fn a_skill_answers_to_its_id_and_its_name() {
        let commands = [
            serde_json::json!({"name":"skill:standup","title":"Daily standup","description":"Write it"}),
            serde_json::json!({"name":"skill:web-qa","title":"Web QA","description":"Test it"}),
            serde_json::json!({"name":"compact","description":"Not a skill"}),
        ];
        let found = skills(&commands, "daily", 10);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].id.as_str(), found[0].label.as_str()), ("standup", "Daily standup"));
        assert_eq!(skills(&commands, "", 10).len(), 2);
    }

    #[test]
    fn the_group_with_the_best_answer_is_drawn_first() {
        let file = Offer::new(Kind::File, "src/misc.ts".into(), "misc.ts".into(), LOOSE);
        let skill = Offer::new(Kind::Skill, "standup".into(), "Standup".into(), EXACT);
        let drawn = in_order(vec![(Kind::File, vec![file.clone()]), (Kind::Skill, vec![skill.clone()])], true);
        assert_eq!(drawn, [skill.clone(), file.clone()]);
        let untyped = in_order(vec![(Kind::File, vec![file.clone()]), (Kind::Skill, vec![skill.clone()])], false);
        assert_eq!(untyped, [file, skill]);
    }

    #[test]
    fn a_changed_file_a_reference_cannot_carry_whole_is_not_offered() {
        let changed = [
            ("docs/my notes.md".to_string(), "modified".to_string()),
            ("src/café.ts".to_string(), "modified".to_string()),
            ("src/a:12".to_string(), "modified".to_string()),
            ("src/a.ts".to_string(), "modified".to_string()),
        ];
        let found = diffs(&changed, "", 10);
        assert_eq!(found.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["src/a.ts"]);
    }
}
