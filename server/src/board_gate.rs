//! The board lifecycle check for a person dragging a card in the browser.
//!
//! When someone drags a card into review, into the manager's column, or into
//! done on the board screen, the server asks this before letting the change
//! through. It used to ask `machinery/hooks/board-status-gate.py`, shelling out
//! to a Python interpreter -- which the release cannot assume is on the machine,
//! so on every computer without one the whole review/done half of the board was
//! refused. The binary is always present, so the binary answers (bw-oesd.3).
//!
//! **This is a deliberate, documented narrowing.** The Python gate is a
//! `PreToolUse(Bash)` hook written for an AI agent typing board commands inside
//! a worktree it claimed, and most of what it enforces is agent-session
//! governance -- that the session stands in the job's own worktree, that it does
//! not still own an abandoned copy, that a checks step's suites ran against the
//! current tree, that a step which declared it makes no code left none behind,
//! that a manager-judged goal carries something to look at. None of that has any
//! meaning for a human dragging a card in a browser under no session at all, and
//! the old bridge fed the gate a synthetic `atelier-api` session where those
//! checks either misfired (a person is never "standing in a worktree") or
//! silently no-opped (there is no edit-session record to read).
//!
//! So this port keeps ONLY the checks that sensibly apply to a hand drag, and
//! drops the rest. Agent sessions use the separate native lifecycle hook,
//! narrowed to machine-verifiable repository and completion invariants.
//!
//! What it enforces:
//!
//!   * The manager's column is untouchable by a drag. A card sitting in
//!     `manager_review` is not moved out -- not forward, not back, not to done --
//!     by anyone but the manager on their own screen.
//!   * Entering review (agent review or the manager's column) needs a commit
//!     naming the card to have reached the main line. Review begins after merge.
//!   * Closing needs the same landed commit, every open review gate resolved,
//!     and every child work item closed.
//!
//! What it drops (agent-session concepts, not human-drag ones): the
//! worktree-standing check, merge-slot and copy ownership, the step-note /
//! reason-length check, and the edit-session machinery (`wrote_code`,
//! `checks_proof`, `looked_at`).
//!
//! Two carry-over exceptions keep the landed-commit check from misfiring on
//! cards that legitimately have no commit of their own -- a goal/job card (its
//! work lands under its children), and a card that declared it makes no code
//! (`no-code`, `find`, `question`, `decision`, or an `epic`/`decision` type).
//! The children-closed and gates-resolved checks still apply to those.

use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// What this check needs to know about the card being dragged.
struct Card {
    /// The column it sits in now, in the board's own words.
    status: String,
    /// task, bug, feature, epic, decision, gate ...
    issue_type: String,
    /// Every label on the card, `of:`/`step:`/`copy:` and all.
    labels: Vec<String>,
}

/// The labels that say a card was never going to land a commit of its own.
/// A goal (`job`) lands under its children; the others declare they make no
/// code at all. Read the same way the Python gate reads them (`NO_CODE`,
/// `makes_code`).
const NO_CODE: [&str; 4] = ["no-code", "find", "question", "decision"];

/// Whether no commit naming this card need ever exist for it to advance.
fn no_commit_expected(card: &Card) -> bool {
    card.labels.iter().any(|l| l == "job")
        || card.labels.iter().any(|l| NO_CODE.contains(&l.as_str()))
        || matches!(card.issue_type.as_str(), "epic" | "decision")
}

/// The decision, as a pure function of the facts.
///
/// Kept apart from the board and git so every case is exercised in a test
/// without a live board, a worktree, or a commit -- the async half below only
/// gathers `landed`, `open_gates` and `open_children` and hands them here.
///
/// `status` is the column the drag asks for: `closed`, or one of the review
/// words (`inreview`/`in_review`/`manager_review`). Gives back the reason to
/// refuse the drag, or `None` to let it through.
fn decide(
    status: &str,
    card: &Card,
    landed: bool,
    open_gates: &[String],
    open_children: usize,
) -> Option<String> {
    // The manager's column first, and before any board or git work: a card in
    // it is theirs to move, in or out, forward or back.
    if card.status == "manager_review" {
        return Some(
            "This card is waiting on the manager, and a board drag cannot move it out of \
             their column -- not forward, not back, not to done. They sign it off on their \
             own screen."
                .to_string(),
        );
    }

    if status == "closed" {
        if !open_gates.is_empty() {
            return Some(format!(
                "This card is held by an unresolved review gate ({}). A gate is a selected \
                 review step; resolve the review before closing the card.",
                open_gates.join(" and ")
            ));
        }
        if open_children > 0 {
            return Some(
                "This card still has open child work items, so it is a container rather than \
                 a task: it closes when its children do. Close them first."
                    .to_string(),
            );
        }
        if !no_commit_expected(card) && !landed {
            return Some(
                "This card cannot close: no commit naming it has reached the main line. A \
                 card is done when its change is merged, not when the work feels finished. \
                 If it was never going to produce code, label it no-code."
                    .to_string(),
            );
        }
        return None;
    }

    // Entering review -- agent review or the manager's column.
    if !no_commit_expected(card) && !landed {
        return Some(
            "This card cannot enter review yet: no commit naming it has reached the main \
             line. Review begins after the change is merged, never as a substitute for it."
                .to_string(),
        );
    }
    None
}

/// Ask the check about one human drag, gathering what it needs from the board
/// and git.
///
/// `project` is the checkout the board issues these ids from; `id` is the card
/// being dragged; `status` is the column asked for.
///
/// Every board or git read that cannot be answered is read as permission, not
/// refusal: the `bd update` that follows this enforces the board's own rules,
/// and a momentary unreadable board must not stand in front of a legitimate
/// drag. This mirrors the Python gate, which skips a card it cannot show and
/// reads an unreadable gate or child list as empty.
pub async fn human_drag_denial(project: &Path, id: &str, status: &str) -> Option<String> {
    let value = show(project, id).await?;
    let card = card_facts(&value);

    // Cheap universal guard -- decided with no board or git work at all.
    if card.status == "manager_review" {
        return decide(status, &card, false, &[], 0);
    }

    let landed = if no_commit_expected(&card) {
        false
    } else {
        is_landed(project, id, &value).await
    };

    let (open_gates, open_children) = if status == "closed" {
        (gates_open(project, id).await, children_open(project, id).await)
    } else {
        (Vec::new(), 0)
    };

    decide(status, &card, landed, &open_gates, open_children)
}

/// The card the board holds under this id, or `None` when it cannot say.
async fn show(project: &Path, id: &str) -> Option<Value> {
    let out = board(project, &["show", id, "--json"]).await?;
    let value: Value = serde_json::from_str(json_start(&out)?).ok()?;
    Some(match value {
        Value::Array(mut rows) if !rows.is_empty() => rows.remove(0),
        other => other,
    })
}

/// The three things this check reads off a card.
fn card_facts(value: &Value) -> Card {
    Card {
        status: value.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
        issue_type: value.get("issue_type").and_then(Value::as_str).unwrap_or("").to_string(),
        labels: labels_of(value),
    }
}

fn labels_of(value: &Value) -> Vec<String> {
    value
        .get("labels")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|l| l.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Whether a commit naming this card has reached the main line.
///
/// The names a commit may land it under are the card's own and any ancestor
/// step's, plus the goal for an old build-spined job -- the same widening the
/// Python gate keeps (`landing_names`), so a work item landed under its step's
/// commit still reads as landed.
async fn is_landed(project: &Path, id: &str, value: &Value) -> bool {
    let branch = landing_branch(project).await;
    for name in landing_names(project, id, value).await {
        if commit_named(project, &branch, &name).await {
            return true;
        }
    }
    false
}

/// The names a commit may use to land this card.
async fn landing_names(project: &Path, id: &str, value: &Value) -> Vec<String> {
    let mut names = vec![id.to_string()];

    // Every ancestor that is itself a step: a step cannot merge while a work
    // item under it is open, so the commit that lands the step lands its items.
    let mut parent = id.to_string();
    while let Some(dot) = parent.rfind('.') {
        parent.truncate(dot);
        if let Some(pv) = show(project, &parent).await {
            if labels_of(&pv).iter().any(|l| l.starts_with("step:")) {
                names.push(parent.clone());
            }
        }
    }

    // The goal, only for a job whose order records a build step: those were
    // poured before the goal-wide reading was narrowed and keep it.
    if let Some(goal) = labels_of(value).iter().find_map(|l| l.strip_prefix("of:").map(str::to_string)) {
        if let Some(gv) = show(project, &goal).await {
            if meta_spine(&gv).contains("build") {
                names.push(goal);
            }
        }
    }

    // Preserve order, drop repeats.
    let mut seen = std::collections::HashSet::new();
    names.retain(|n| seen.insert(n.clone()));
    names
}

/// The stored order of a goal, wherever bd keeps its metadata -- an object with
/// a `spine`, or a JSON string that holds one.
fn meta_spine(value: &Value) -> String {
    let meta = value.get("metadata");
    let spine = match meta {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|m| m.get("spine").and_then(Value::as_str).map(str::to_string)),
        Some(m) => m.get("spine").and_then(Value::as_str).map(str::to_string),
        None => None,
    };
    spine.unwrap_or_default()
}

/// The branch a landed commit sits on.
///
/// The main checkout's current branch, which is how the Python gate resolves it
/// for a project that declared no external landing metadata (`project.lands_on`
/// falls through to `git branch --show-current`), and `main` when git cannot
/// say. A custom `completed_work_branch` declaration is not read on this
/// narrowed human-drag path -- the documented simplification. Its only cost is a
/// conservative refusal (a card whose commit landed on some other named branch
/// reads as not landed and cannot be closed by drag), never an unsafe allow.
async fn landing_branch(project: &Path) -> String {
    git_line(project, &["branch", "--show-current"])
        .await
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

/// Whether a commit on `branch` names `name` in its message.
async fn commit_named(repo: &Path, branch: &str, name: &str) -> bool {
    git_line(repo, &["log", branch, "--grep", name, "--max-count", "1", "--format=%H"])
        .await
        .map(|out| !out.trim().is_empty())
        .unwrap_or(false)
}

/// The gates still holding this card shut, by id. An unreadable board reads as
/// none, the way the Python gate reads it.
async fn gates_open(project: &Path, id: &str) -> Vec<String> {
    let Some(out) = board(project, &["gate", "list", id, "--json"]).await else {
        return Vec::new();
    };
    let Some(js) = json_start(&out) else {
        return Vec::new();
    };
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(js) else {
        return Vec::new();
    };
    rows.iter()
        .filter(|r| r.get("status").and_then(Value::as_str) != Some("closed"))
        .filter_map(|r| r.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// How many child work items of this card are still open. An unreadable board
/// reads as none.
async fn children_open(project: &Path, id: &str) -> usize {
    let Some(out) = board(project, &["list", "--parent", id, "--brief", "--json"]).await else {
        return 0;
    };
    let Some(js) = json_start(&out) else {
        return 0;
    };
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(js) else {
        return 0;
    };
    rows.iter()
        .filter(|r| {
            r.get("id").and_then(Value::as_str) != Some(id)
                && r.get("status").and_then(Value::as_str) != Some("closed")
        })
        .count()
}

/// Run the board CLI in `dir`, handing back its stdout, or `None` if it could
/// not run or did not succeed.
async fn board(dir: &Path, args: &[&str]) -> Option<String> {
    let tool = crate::routes::find_bd()?;
    let ran = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new(tool).args(args).current_dir(dir).output(),
    )
    .await
    .ok()?
    .ok()?;
    if ran.status.success() {
        String::from_utf8(ran.stdout).ok()
    } else {
        None
    }
}

/// One line of git output in `dir`, or `None` if git could not run or refused.
async fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::routes::git_output(dir, args).await.ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// The board CLI prints migration and warning lines to stdout before its JSON.
/// This finds where the JSON actually starts.
fn json_start(out: &str) -> Option<&str> {
    out.find(['{', '[']).map(|i| &out[i..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(status: &str, issue_type: &str, labels: &[&str]) -> Card {
        Card {
            status: status.to_string(),
            issue_type: issue_type.to_string(),
            labels: labels.iter().map(|l| l.to_string()).collect(),
        }
    }

    // --- closing ---------------------------------------------------------

    #[test]
    fn a_close_is_refused_when_no_commit_named_the_card() {
        let why = decide("closed", &card("in_progress", "task", &[]), false, &[], 0)
            .expect("a refusal");
        assert!(why.contains("reached the main line"), "{why}");
    }

    #[test]
    fn a_close_goes_through_once_its_commit_has_landed() {
        assert_eq!(decide("closed", &card("in_progress", "task", &[]), true, &[], 0), None);
    }

    #[test]
    fn a_close_is_refused_while_a_child_work_item_is_open() {
        let why = decide("closed", &card("in_progress", "task", &[]), true, &[], 2)
            .expect("a refusal");
        assert!(why.contains("open child work items"), "{why}");
    }

    #[test]
    fn a_close_is_refused_while_a_review_gate_is_unresolved() {
        let why = decide(
            "closed",
            &card("in_progress", "task", &[]),
            true,
            &["bw-oesd.3.gate".to_string()],
            0,
        )
        .expect("a refusal");
        assert!(why.contains("review gate"), "{why}");
        assert!(why.contains("bw-oesd.3.gate"), "the gate id is named: {why}");
    }

    #[test]
    fn an_open_gate_is_reported_before_children_or_the_missing_commit() {
        // The gate is the first thing said, so a card behind one is not first
        // told to go find a commit it does not yet need.
        let why = decide(
            "closed",
            &card("in_progress", "task", &[]),
            false,
            &["g".to_string()],
            3,
        )
        .expect("a refusal");
        assert!(why.contains("review gate"), "{why}");
    }

    #[test]
    fn a_no_code_card_closes_without_any_commit() {
        assert_eq!(decide("closed", &card("in_progress", "task", &["no-code"]), false, &[], 0), None);
    }

    #[test]
    fn an_epic_closes_without_a_commit_but_not_with_open_children() {
        assert_eq!(decide("closed", &card("in_progress", "epic", &[]), false, &[], 0), None);
        let why = decide("closed", &card("in_progress", "epic", &[]), false, &[], 1)
            .expect("a refusal");
        assert!(why.contains("open child work items"), "{why}");
    }

    // --- entering review -------------------------------------------------

    #[test]
    fn entering_review_is_refused_when_no_commit_named_the_card() {
        let why = decide("in_review", &card("in_progress", "task", &[]), false, &[], 0)
            .expect("a refusal");
        assert!(why.contains("enter review"), "{why}");
    }

    #[test]
    fn entering_review_goes_through_once_its_commit_has_landed() {
        assert_eq!(decide("in_review", &card("in_progress", "task", &[]), true, &[], 0), None);
        assert_eq!(decide("inreview", &card("in_progress", "task", &[]), true, &[], 0), None);
    }

    #[test]
    fn a_goal_enters_review_without_a_commit_of_its_own() {
        // A job/goal lands under its children, so it never has a commit naming
        // it and must not be blocked for lacking one.
        assert_eq!(decide("manager_review", &card("in_progress", "task", &["job"]), false, &[], 0), None);
    }

    // --- the manager's column is untouchable -----------------------------

    #[test]
    fn a_drag_out_of_the_managers_column_is_refused() {
        for target in ["in_review", "inreview", "closed", "manager_review"] {
            let why = decide(target, &card("manager_review", "task", &[]), true, &[], 0)
                .expect("a refusal");
            assert!(why.contains("waiting on the manager"), "{target}: {why}");
        }
    }

    // --- the git landed-commit reader ------------------------------------

    #[tokio::test]
    async fn the_landed_reader_finds_a_commit_that_names_the_card() {
        let repo = tempfile::tempdir().expect("a folder");
        let path = repo.path();
        let run = |args: Vec<&'static str>| {
            std::process::Command::new("git")
                .args(&args)
                .current_dir(path)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .expect("git to run")
        };
        if !run(vec!["init", "-q"]).status.success() {
            eprintln!("no usable git here, so the landed reader was not exercised");
            return;
        }
        run(vec!["commit", "-q", "--allow-empty", "-m", "bw-oesd.3.1: did the thing"]);
        let branch = landing_branch(path).await;

        assert!(commit_named(path, &branch, "bw-oesd.3.1").await, "the naming commit was not found");
        assert!(!commit_named(path, &branch, "bw-oesd.3.2").await, "an unrelated id was reported landed");
    }
}
