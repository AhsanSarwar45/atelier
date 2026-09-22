//! Landing is the completion boundary. Journals bridge Git and Beads without
//! pretending their two durable stores can commit one transaction.
use crate::board_state::{self, Node};
use crate::board_tools::{
    bd, card, checks, git, labels, main_copy, manifest, metadata, root, subject_names,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub fn common_root(root: &Path) -> PathBuf {
    git(root, &["rev-parse", "--git-common-dir"])
        .ok()
        .map(|path| {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .and_then(|path| path.canonicalize().ok())
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| root.to_path_buf())
}

pub fn landing_branch(root: &Path) -> String {
    if let Ok(settings) = manifest(root) {
        if !settings.git.completed_work_branch.trim().is_empty() {
            return settings.git.completed_work_branch;
        }
    }
    for branch in ["main", "master", "ours"] {
        if git(
            root,
            &["show-ref", "--verify", &format!("refs/heads/{branch}")],
        )
        .is_ok()
        {
            return branch.into();
        }
    }
    "main".into()
}

pub fn operational(row: &Value) -> bool {
    let tags = labels(row);
    tags.contains(&"no-code")
        && tags.iter().any(|tag| {
            matches!(
                *tag,
                "step:checks"
                    | "step:land"
                    | "step:review"
                    | "step:design"
                    | "step:ground"
                    | "step:benchmark"
                    | "step:verify"
                    | "step:worktree"
                    | "step:clarify"
                    | "step:prove"
            )
        })
}
fn cancelled(row: &Value) -> bool {
    row["status"] == "cancelled" || labels(row).contains(&"cancelled")
}
fn status(row: &Value) -> &str {
    if cancelled(row) {
        "cancelled"
    } else {
        board_state::normalize(row["status"].as_str().unwrap_or("open"))
    }
}
fn all(root: &Path) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(&bd(
        root,
        &[
            "list".into(),
            "--status".into(),
            "all".into(),
            "--limit".into(),
            "0".into(),
            "--json".into(),
        ],
    )?)
    .map_err(|e| e.to_string())?;
    value
        .as_array()
        .cloned()
        .ok_or_else(|| "Beads returned a non-array board; refusing reconciliation".into())
}
fn parent<'a>(row: &'a Value, ids: &HashSet<&str>) -> Option<&'a str> {
    row["parent"]
        .as_str()
        .or_else(|| row["parent_id"].as_str())
        .or_else(|| {
            row["dependencies"].as_array().and_then(|deps| {
                deps.iter()
                    .find(|d| d["type"] == "parent-child")
                    .and_then(|d| d["depends_on_id"].as_str())
            })
        })
        .or_else(|| {
            labels(row)
                .into_iter()
                .find_map(|tag| tag.strip_prefix("of:"))
        })
        .or_else(|| {
            row["id"]
                .as_str()
                .and_then(|id| id.rsplit_once('.').map(|(p, _)| p))
                .filter(|p| ids.contains(p))
        })
}
pub fn belongs_to(root: &Path, id: &str, job: &str) -> bool {
    if id == job { return true; }
    let Ok(rows) = all(root) else { return false; };
    let graph = nodes(&rows);
    let mut pending = vec![job.to_string()]; let mut seen = HashSet::new();
    while let Some(parent) = pending.pop() {
        if !seen.insert(parent.clone()) { continue; }
        if let Some(node) = graph.iter().find(|node| node.id == parent) {
            for child in &node.children {
                if child == id { return true; }
                pending.push(child.clone());
            }
        }
    }
    false
}

pub fn nodes(rows: &[Value]) -> Vec<Node> {
    let ids: HashSet<_> = rows.iter().filter_map(|r| r["id"].as_str()).collect();
    let mut children: HashMap<&str, Vec<String>> = HashMap::new();
    for row in rows.iter().filter(|row| !operational(row)) {
        if let (Some(p), Some(id)) = (parent(row, &ids), row["id"].as_str()) {
            children.entry(p).or_default().push(id.into());
        }
    }
    rows.iter()
        .filter_map(|row| {
            let id = row["id"].as_str()?;
            let mut below = children.remove(id).unwrap_or_default();
            if let Some(named) = row["children"].as_array() {
                for child in named.iter().filter_map(Value::as_str) {
                    if !rows.iter().any(|r| r["id"] == child && operational(r)) {
                        below.push(child.into());
                    }
                }
            }
            below.sort();
            below.dedup();
            Some(Node {
                id: id.into(),
                container: row["issue_type"] == "epic",
                error: parent(row, &ids).filter(|p| !ids.contains(p)).map(|p| format!("Missing parent {p}")),
                status: if status(row) == "cancelled" && true_meta(row, "status_derived") { "open" } else { status(row) }.into(),
                children: below,
                started: row["started_at"].as_str().is_some()
                    || !matches!(status(row), "open" | "cancelled"),
            })
        })
        .collect()
}

fn write_status(root: &Path, row: &Value, next: &str, reason: &str) -> Result<(), String> {
    let id = row["id"].as_str().ok_or("Card has no id")?;
    let mut args = vec![
        "update".into(),
        id.into(),
        "--status".into(),
        if next == "inreview" {
            "in_review".into()
        } else if next == "cancelled" {
            "closed".into()
        } else {
            next.into()
        },
    ];
    if next == "cancelled" {
        args.extend(["--add-label".into(), "cancelled".into(), "--set-metadata".into(),
            format!("status_derived={}", reason.starts_with("Derived from"))]);
    } else {
        args.extend(["--remove-label".into(), "cancelled".into(), "--remove-label".into(), "resolution:cancelled".into()]);
    }
    args.extend([
        "--if-status".into(),
        row["status"].as_str().ok_or("Card has no status")?.into(),
    ]);
    if next == "closed" || next == "cancelled" {
        // Only reached for proven landings, derived settled parents, or explicit cancellation.
        // Legacy operational children and stale dependency gates cannot undo a landing.
        args.push("--force".into());
    }
    args.extend(["--append-notes".into(), reason.into()]);
    bd(root, &args)?;
    Ok(())
}

/// Legacy workflow items are completion records for their owning deliverable.
/// They need no artificial commits and completed work must not look cancelled.
fn operation_decisions(rows: &[Value]) -> Vec<Value> {
    let ids: HashSet<_> = rows.iter().filter_map(|r| r["id"].as_str()).collect();
    let projection = board_state::project(&nodes(rows));
    rows.iter().filter(|r| operational(r)).filter_map(|row| {
        let id = row["id"].as_str()?;
        let owner = parent(row, &ids)?;
        if projection.errors.contains_key(owner) || projection.errors.contains_key(id) { return None; }
        let next = match projection.states.get(owner).map(String::as_str) {
            Some("closed") if status(row) != "closed" => "closed",
            // Undo this reconciler's old blanket retirement on still-active work.
            Some(state) if state != "closed" && state != "cancelled" && cancelled(row)
                && row["notes"].as_str().is_some_and(|s| s.contains("Superseded by landing-is-Done workflow")) => "open",
            _ => return None,
        };
        Some(json!({"id":id,"parent":owner,"action":if next == "closed" {"complete_operation"} else {"restore_operation"},
            "to":next,"reason":if next == "closed" {
                "Required implementation is delivered; historical workflow subtask is complete with its parent. This reconciliation does not claim a new verification run."
            } else { "Restore pending workflow record: required implementation is still unfinished, not cancelled." }}))
    }).collect()
}

pub fn reconcile_parents(root: &Path) -> Result<(), String> {
    let rows = all(root)?;
    for decision in operation_decisions(&rows) {
        let row = rows.iter().find(|r| r["id"] == decision["id"]).unwrap();
        write_status(root, row, decision["to"].as_str().unwrap(), decision["reason"].as_str().unwrap())?;
    }
    let graph = nodes(&rows);
    let projected = board_state::project(&graph);
    // Children before parents where IDs encode ancestry; projection is recursive for every ID.
    let mut containers: Vec<_> = graph.iter().filter(|n| n.container || !n.children.is_empty()).collect();
    containers.sort_by_key(|n| std::cmp::Reverse(n.id.matches('.').count()));
    let mut errors = Vec::new();
    for node in containers {
        if let Some(error) = projected.errors.get(&node.id) {
            errors.push(format!("{}: {error}", node.id)); continue;
        }
        let next = &projected.states[&node.id];
        let row = rows.iter().find(|r| r["id"] == node.id).unwrap();
        if status(row) != next {
            write_status(
                root,
                row,
                next,
                "Derived from required child work; Done means all required work landed",
            )?;
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

#[derive(Debug, Serialize, Deserialize)]
struct Landing {
    version: u32,
    branch: String,
    tip: String,
    tree: String,
    actor: String,
    cards: Vec<String>,
    complete: bool,
    /// Why this landing carries no passing-check evidence: an empty
    /// verification list, or failures the work did not cause. The gate reads
    /// the journal rather than the manifest, whose working tree is the one a
    /// fast-forward is busy moving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    waived: Option<String>,
}
fn journal_dir(root: &Path) -> Result<PathBuf, String> {
    let path = git(root, &["rev-parse", "--git-common-dir"])?;
    let path = PathBuf::from(path);
    Ok(if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
    .join("atelier-landings"))
}
fn save(path: &Path, record: &Landing) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("Journal has no parent")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension("pending");
    let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
    use std::io::Write;
    file.write_all(&serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}
fn finish(root: &Path, path: &Path, record: &mut Landing) -> Result<(), String> {
    if record.complete {
        return Ok(());
    }
    git(
        root,
        &["merge-base", "--is-ancestor", &record.tip, &record.branch],
    )
    .map_err(|_| {
        format!(
            "{} has not reached {}; no tickets were closed",
            record.tip, record.branch
        )
    })?;
    for id in &record.cards {
        let row = card(root, id)?;
        if cancelled(&row) {
            bd(root, &["update".into(), id.clone(), "--append-notes".into(),
                format!("Landing recovery preserved cancelled scope; commit {} reached {} but this card was not marked delivered", record.tip, record.branch)])?;
            eprintln!("{id}: preserving cancellation while completing landing recovery");
            continue;
        }
        if status(&row) == "closed" {
            continue;
        }
        // A previous successful write followed by a reopen starts new work.
        // Recovery must never close it again from the same old transaction.
        if row["metadata"]["landed_commit"] == record.tip { continue; }
        bd(root, &[
            "update".into(), id.clone(), "--status".into(), "closed".into(),
            "--if-status".into(), row["status"].as_str().ok_or("Card has no status")?.into(),
            "--force".into(),
            "--set-metadata".into(), format!("landed_commit={}", record.tip),
            "--set-metadata".into(), format!("landed_tree={}", record.tree),
            "--set-metadata".into(), format!("landed_branch={}", record.branch),
            "--append-notes".into(), format!("Work landed in {} at {}", record.branch, record.tip),
        ])?;
    }
    if let Err(error) = reconcile_parents(root) {
        eprintln!("Work landed; hierarchy still needs repair: {error}");
    }
    record.complete = true;
    save(path, record)
}

/// Git sends raw old/new/ref triples, not provider JSON. Validate the actual
/// ref update so merge, push, and update-ref share the same completion boundary.
pub fn reference_transaction(phase: &str, input: &str) -> Result<i32, String> {
    if phase == "aborted" { return Ok(0); }
    if !matches!(phase, "prepared" | "committed") { return Err("Unknown Git transaction phase".into()); }
    let work = root()?;
    let branch = landing_branch(&work);
    let target = format!("refs/heads/{branch}");
    let mut touched = false;
    for line in input.lines().filter(|l| !l.trim().is_empty()) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 3 { return Err("Malformed Git reference transaction".into()); }
        if fields[2] != target { continue; }
        touched = true;
        if phase == "committed" { continue; }
        let old = git(&work, &["rev-parse", &target])?;
        let new = fields[1];
        git(&work, &["merge-base", "--is-ancestor", &old, new])
            .map_err(|_| "The completed-work branch only accepts fast-forward landings".to_string())?;
        let dir = journal_dir(&work)?;
        let mut authorized = false;
        if dir.exists() {
            for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
                let record: Landing = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                if record.complete || record.tip != new || record.branch != branch { continue; }
                if git(&work, &["rev-parse", &format!("{new}^{{tree}}")])? != record.tree {
                    return Err("Landing journal tree differs from the proposed commit".into());
                }
                let slot: Value = serde_json::from_str(&bd(&work, &["merge-slot".into(), "check".into(), "--json".into()])?).map_err(|e| e.to_string())?;
                if slot["holder"].as_str() != Some(record.actor.as_str()) {
                    return Err("The landing transaction does not own the merge slot".into());
                }
                let mut verified = false;
                for id in &record.cards {
                    let row = card(&work, id)?;
                    if row["assignee"].as_str().is_some_and(|a| !a.is_empty() && a != record.actor) {
                        return Err(format!("{id} changed owner during landing"));
                    }
                    prerequisites(&work, id, &record.cards)?;
                    verified |= current_proof(&row, "checks", &record.tree);
                }
                if !verified && record.waived.is_none() {
                    return Err("No passing checks for this landing tree".into());
                }
                authorized = true;
                break;
            }
        }
        if !authorized { return Err("No prepared landing transaction; use atelier tool board/land CARD-ID".into()); }
    }
    if touched && phase == "committed" { recover(&work)?; }
    Ok(0)
}

pub fn recover(root: &Path) -> Result<(), String> {
    let dir = journal_dir(root)?;
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mut record: Landing =
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("{}: {e}", path.display()))?;
        if !record.complete
            && git(
                root,
                &["merge-base", "--is-ancestor", &record.tip, &record.branch],
            )
            .is_ok()
        {
            finish(root, &path, &mut record)?;
        }
    }
    Ok(())
}
fn true_meta(row: &Value, key: &str) -> bool {
    row["metadata"][key] == true || row["metadata"][key] == "true"
}
fn current_proof(row: &Value, kind: &str, tree: &str) -> bool {
    row["metadata"][format!("{kind}_tree")] == tree && true_meta(row, &format!("{kind}_passed"))
}
pub(crate) fn actor(root: &Path) -> Result<String, String> {
    std::env::var("BEADS_ACTOR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(Ok)
        .unwrap_or_else(|| git(root, &["config", "user.name"]))
}

fn prerequisites(root: &Path, id: &str, carried: &[String]) -> Result<(), String> {
    let row = card(root, id)?;
    for dep in row["dependencies"].as_array().into_iter().flatten() {
        let kind = dep["dependency_type"]
            .as_str()
            .or_else(|| dep["type"].as_str())
            .unwrap_or("blocks");
        if matches!(kind, "parent-child" | "relates-to" | "discovered-from") {
            continue;
        }
        let dependency = dep
            .as_str()
            .or_else(|| dep["depends_on_id"].as_str())
            .or_else(|| dep["id"].as_str())
            .ok_or("Unreadable dependency")?;
        if carried.iter().any(|id| id == dependency) {
            continue;
        }
        let required = card(root, dependency)?;
        if status(&required) != "closed" {
            return Err(format!(
                "{id} still requires {dependency}; resolve that prerequisite before landing"
            ));
        }
    }
    Ok(())
}

/// The card id is the first word that is neither a flag nor a flag's value: a
/// reason that reads like an id must not be mistaken for the card.
fn requested(rest: &[String]) -> (Option<String>, Option<String>) {
    let mut id = None;
    let mut words = rest.iter();
    while let Some(word) = words.next() {
        if word == "--checks-unrelated" {
            words.next();
        } else if !word.starts_with('-') && id.is_none() {
            id = Some(word.clone());
        }
    }
    (id, crate::board_tools::flags(rest, "--checks-unrelated").pop())
}

/// The refusal an agent reads when a suite fails. It has to answer the only
/// question the agent now has: is this mine to fix, or mine to explain?
fn failing_checks(id: &str) -> String {
    format!(
        "Required checks failed; nothing landed.\n\
         If the failures are this work's doing, fix them and land again.\n\
         If they are not, land saying why:\n  \
         atelier tool board/land {id} --checks-unrelated 'why these failures are not this work'"
    )
}

pub fn land(rest: &[String]) -> Result<i32, String> {
    let (asked, waiver) = requested(rest);
    let id = &asked.ok_or("board/land needs a card id")?;
    if waiver.as_ref().is_some_and(|reason| reason.trim().is_empty()) {
        return Err("--checks-unrelated needs the reason the failures are not this work".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'))
    {
        return Err("Invalid card id".into());
    }
    let work = root()?;
    recover(&work)?;
    let item = card(&work, id)?;
    let landing = landing_branch(&work);
    let settings = manifest(&work)?;
    if status(&item) == "closed"
        && item["metadata"]["landed_commit"]
            .as_str()
            .is_some_and(|sha| git(&work, &["merge-base", "--is-ancestor", sha, &landing]).is_ok())
    {
        println!("{id} is already Done on {landing}");
        return Ok(0);
    }
    if operational(&item) {
        return Err("This is a legacy workflow step, not deliverable work. Use board/reconcile to complete workflow records with delivered work; cleanup is board/cleanup JOB-ID.".into());
    }
    if !git(&work, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Commit the tracked changes before landing.".into());
    }
    let branch = git(&work, &["branch", "--show-current"])?;
    if branch == landing || branch.is_empty() {
        return Err(format!(
            "Run board/land from the job worktree, not {landing} or a detached checkout"
        ));
    }
    let caller = actor(&work)?;
    if item["assignee"]
        .as_str()
        .is_some_and(|owner| !owner.is_empty() && owner != caller)
    {
        return Err(format!(
            "{id} belongs to another actor; if that session has stopped, use board/reclaim {id} --from OLD-ACTOR --abandoned --reason TEXT in this job copy"
        ));
    }
    let rows = all(&work)?;
    let graph = nodes(&rows);
    let commits = git(&work, &["log", &format!("{landing}..HEAD"), "--format=%s"])?;
    let carried: Vec<String> = graph
        .iter()
        .filter(|n| n.children.is_empty() && !n.container)
        .filter_map(|node| {
            let row = rows.iter().find(|r| r["id"] == node.id)?;
            (status(row) != "closed"
                && !cancelled(row)
                && !operational(row)
                && commits.lines().any(|s| subject_names(s, &node.id)))
            .then(|| node.id.clone())
        })
        .collect();
    if !carried.contains(id) {
        return Err(format!("No unlanded deliverable commit explicitly names {id}. A historical mention is not current completion evidence."));
    }
    for carried_id in &carried {
        let row = rows.iter().find(|r| r["id"] == *carried_id).unwrap();
        if row["assignee"]
            .as_str()
            .is_some_and(|owner| !owner.is_empty() && owner != caller)
        {
            return Err(format!(
                "{carried_id} belongs to another actor; split the landing"
            ));
        }
    }
    for id in &carried {
        prerequisites(&work, id, &carried)?;
    }
    let acquire = vec![
        "--actor".into(),
        caller.clone(),
        "merge-slot".into(),
        "acquire".into(),
    ];
    if let Err(error) = bd(&work, &acquire) {
        if !error.contains("merge slot not found") {
            return Err(error);
        }
        bd(&work, &["merge-slot".into(), "create".into()])?;
        bd(&work, &acquire)?;
    }
    let result = (|| {
        git(&work, &["rebase", &landing])?;
        let tree = git(&work, &["rev-parse", "HEAD^{tree}"])?;
        let current = card(&work, id)?;
        let checked_suites: Vec<String> = current["metadata"]["checks_suites"].as_str()
            .and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
        // Nothing declared is nothing to run and nothing to prove: a project
        // with an empty verification list would otherwise be refused forever,
        // for want of evidence it has no way to produce.
        let mut waived = None;
        if settings.verification.commands.is_empty() {
            waived = Some("the project declares no verification suite".to_string());
        } else if (!current_proof(&current, "checks", &tree)
            || !settings.verification.commands.iter().all(|suite| checked_suites.contains(&suite.name)))
            && checks(&[id.clone(), "--all".into()])? != 0
        {
            let Some(reason) = waiver.clone() else {
                return Err(failing_checks(id));
            };
            bd(&work, &["--actor".into(), caller.clone(), "comments".into(), "add".into(), id.clone(),
                format!("checks waived for tree {tree}: {reason}")])?;
            metadata(&work, id, &[("checks_waived_tree", tree.clone()), ("checks_waived_reason", reason.clone())])?;
            eprintln!("Landing {id} although its checks failed: {reason}");
            waived = Some(format!("failures this work did not cause: {reason}"));
        }
        if settings.review.external_review == "always" && !current_proof(&card(&work, id)?, "review", &tree) {
            return Err(format!("Project policy requires external review of {id} before landing"));
        }
        let ids: HashSet<_> = rows.iter().filter_map(|r| r["id"].as_str()).collect();
        let mut review_ids = carried.clone();
        for carried_id in &carried {
            let mut row = rows.iter().find(|r| r["id"] == *carried_id).unwrap();
            let mut visited = HashSet::new();
            while let Some(p) = parent(row, &ids) {
                if !visited.insert(p) {
                    return Err("Cyclic parent relationship".into());
                }
                review_ids.push(p.into());
                let Some(found) = rows.iter().find(|r| r["id"] == p) else {
                    break;
                };
                row = found;
            }
        }
        review_ids.sort();
        review_ids.dedup();
        for review_id in review_ids {
            let row = card(&work, &review_id)?;
            let spine = row["metadata"]["spine"].as_str().unwrap_or("");
            if (spine.split(',').any(|s| s == "review")
                || true_meta(&row, "review_required")
                || status(&row) == "inreview")
                && !current_proof(&row, "review", &tree)
            {
                return Err(format!(
                    "Review {review_id} against this tree before landing"
                ));
            }
            if (row["metadata"]["judge"]
                .as_str()
                .is_some_and(|s| s.starts_with("manager"))
                || status(&row) == "manager_review"
                || !settings.git.agents_may_merge_completed_work)
                && row["metadata"]["manager_approved_tree"] != tree
            {
                metadata(&work, &review_id, &[("manager_review_tree", tree.clone()), ("manager_review_commit", git(&work, &["rev-parse", "HEAD"])? )])?;
                write_status(&work, &card(&work, id)?, "manager_review", "Waiting for manager approval of committed work")?;
                return Err(format!(
                    "{review_id} requires manager approval of this tree before landing"
                ));
            }
        }
        let tip = git(&work, &["rev-parse", "HEAD"])?;
        let path = journal_dir(&work)?.join(format!("{id}-{tip}.json"));
        let mut record = Landing {
            version: 1,
            branch: landing.clone(),
            tip,
            tree,
            actor: caller.clone(),
            cards: carried.clone(),
            complete: false,
            waived,
        };
        save(&path, &record)?;
        let main = main_copy(&work, &landing)?;
        git(&main, &["merge", "--ff-only", &branch])?;
        finish(&work, &path, &mut record)?;
        Ok(())
    })();
    let release = bd(
        &work,
        &[
            "--actor".into(),
            caller,
            "merge-slot".into(),
            "release".into(),
        ],
    );
    result?;
    release?;
    println!("landed {} on {landing}; Done: {}", id, carried.join(", "));
    Ok(0)
}

/// Every entry point uses this decision. Only the landing transaction writes
/// a deliverable's completion; containers are projections, never independent moves.
pub fn approve(root: &Path, id: &str, tree: &str) -> Result<(), String> {
    let row = card(root, id)?;
    if tree.is_empty() || row["metadata"]["manager_review_tree"] != tree {
        return Err("The requested approval is stale; refresh the review evidence".into());
    }
    let commit = row["metadata"]["manager_review_commit"].as_str().ok_or("No proposed commit")?;
    if git(root, &["rev-parse", &format!("{commit}^{{tree}}")])? != tree {
        return Err("The proposed commit does not match the reviewed tree".into());
    }
    metadata(root, id, &[("manager_approved_tree", tree.into())])?;
    bd(root, &["comments".into(), "add".into(), id.into(), format!("Manager approved tree {tree} before landing")])?;
    Ok(())
}

pub fn transition(root: &Path, id: &str, next: &str, human: bool) -> Result<(), String> {
    let rows = all(root)?;
    let row = rows.iter().find(|r| r["id"] == id).ok_or("Cannot read the requested card")?;
    let next = board_state::normalize(next);
    let graph = nodes(&rows);
    let node = graph.iter().find(|n| n.id == id).ok_or("Missing hierarchy node")?;
    if !node.children.is_empty() || row["issue_type"] == "epic" {
        let projection = board_state::project(&graph);
        if let Some(error) = projection.errors.get(id) { return Err(error.clone()); }
        if projection.states.get(id).map(String::as_str) != Some(next) {
            return Err(format!("{id} follows its required subtasks; change the subtasks or cancel scope explicitly"));
        }
        return Ok(());
    }
    if status(row) == "manager_review" && !human && next != "manager_review" {
        return Err(format!("{id} needs the manager's decision before its state changes"));
    }
    if next == "closed" && status(row) != "closed" {
        return Err(format!("{id} becomes Done when its work lands. Use atelier tool board/land {id}"));
    }
    Ok(())
}

pub fn status_command(rest: &[String]) -> Result<i32, String> {
    let work = root()?;
    let rows = all(&work)?;
    let projection = board_state::project(&nodes(&rows));
    let result: Vec<_> = rows.iter().filter(|row| rest.first().is_none_or(|id| row["id"] == *id)).map(|row| {
        let id = row["id"].as_str().unwrap_or("");
        json!({"id":id,"stored_status":status(row),"status":projection.states.get(id),"error":projection.errors.get(id)})
    }).collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(0)
}

pub fn reconcile_command(rest: &[String]) -> Result<i32, String> {
    let work = root()?;
    let apply = rest.iter().any(|s| s == "--apply");
    let legacy = rest.iter().any(|s| s == "--legacy");
    // --retire-steps remains a compatible spelling; operations now complete
    // with delivered work rather than being blanket-cancelled.

    if apply {
        recover(&work)?;
    }
    let rows = all(&work)?;
    let graph = nodes(&rows);
    let landing = landing_branch(&work);
    let log = git(&work, &["log", &landing, "--format=%H%x09%aI%x09%s"])?;
    let mut report = Vec::new();
    for row in &rows {
        if status(row) == "closed" || cancelled(row) {
            continue;
        }
        let id = row["id"].as_str().ok_or("Card without id")?;
        if operational(row) { continue; }
        if graph
            .iter()
            .any(|node| node.id == id && !node.children.is_empty())
        {
            continue;
        }
        // An old receipt on a reopened ticket cannot complete its new work.
        // Interrupted transactions are recovered from their pending journal above.
        let receipt: Option<&str> = None;
        let explicit = if legacy {
            log.lines().find_map(|line| {
                let mut fields = line.splitn(3, '\t');
                let sha = fields.next()?;
                let date = fields.next()?;
                let subject = fields.next()?;
                if !subject_names(subject, id) {
                    return None;
                }
                let commit_time = chrono::DateTime::parse_from_rfc3339(date).ok()?;
                // Never reuse a commit from before the current execution or a previous close.
                for key in ["created_at", "started_at", "closed_at"] {
                    if row[key]
                        .as_str()
                        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                        .is_some_and(|stamp| stamp > commit_time)
                    {
                        return None;
                    }
                }
                Some(sha)
            })
        } else {
            None
        };
        if let Some(sha) = receipt.or(explicit) {
            if graph.iter().any(|node| node.id == id && node.container) {
                report.push(json!({"id":id,"action":"retain","commit":sha,"reason":"Direct delivery on an empty legacy epic requires an audited kind correction; empty containers cannot be Done"}));
                continue;
            }
            report.push(json!({"id":id,"action":"done","commit":sha,"branch":landing}));
            if apply {
                metadata(
                    &work,
                    id,
                    &[
                        ("landed_commit", sha.into()),
                        ("landed_branch", landing.clone()),
                    ],
                )?;
                write_status(
                    &work,
                    row,
                    "closed",
                    &format!("Reconciled explicit work landed in {landing} at {sha}"),
                )?;
            }
        } else {
            report.push(json!({"id":id,"action":"retain","reason":"No current explicit landing evidence; needs implementation audit"}));
        }
    }
    let mut planned = rows.clone();
    for decision in &report {
        if let Some(row) = planned.iter_mut().find(|row| row["id"] == decision["id"]) {
            match decision["action"].as_str() {
                Some("done") => row["status"] = json!("closed"),
                Some("cancel") => row["status"] = json!("cancelled"),
                _ => (),
            }
        }
    }
    report.extend(operation_decisions(&planned));
    let graph = nodes(&planned);
    let projection = board_state::project(&graph);
    for node in &graph {
        if let Some(error) = projection.errors.get(&node.id) {
            report.push(json!({"id":node.id,"action":"repair_hierarchy","reason":error}));
        } else if (node.container || !node.children.is_empty()) && projection.states.contains_key(&node.id) {
            let next = &projection.states[&node.id];
            let original = rows.iter().find(|row| row["id"] == node.id).unwrap();
            if status(original) != next {
                report.push(json!({"id":node.id,"action":"derive","from":status(original),"to":next,"reason":"State of required descendants"}));
            }
        }
    }
    if apply {
        reconcile_parents(&work)?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(0)
}

/// Explicit recovery for an abandoned session, including legacy claims without a lease.
/// No time heuristic or knowledge of the previous actor grants ownership on its own.
pub fn reclaim(rest: &[String]) -> Result<i32, String> {
    let id = rest.first().filter(|id| !id.starts_with('-')).ok_or("board/reclaim needs a card id")?;
    let from = crate::board_tools::flag(rest, "--from").filter(|s| !s.trim().is_empty()).ok_or("Name the previous owner with --from")?;
    let reason = crate::board_tools::flag(rest, "--reason").filter(|s| !s.trim().is_empty()).ok_or("Record why this session is abandoned with --reason")?;
    if !rest.iter().any(|s| s == "--abandoned") {
        return Err("Confirm the previous session has stopped with --abandoned; do not take active work".into());
    }
    let work = root()?;
    let job = git(&work, &["branch", "--show-current"])?;
    if job == landing_branch(&work) || !belongs_to(&work, id, &job)
        || main_copy(&work, &job)? != work {
        return Err("Recover the card inside its own job worktree".into());
    }
    let row = card(&work, id)?;
    let who = actor(&work)?;
    if status(&row) == "in_progress" && row["assignee"].as_str() == Some(&who) {
        // Recovery can stop after the ownership transfer but before lease refresh.
        bd(&work, &["update".into(), id.clone(), "--claim".into()])?;
        bd(&work, &["heartbeat".into(), id.clone()])?;
        reconcile_parents(&work)?;
        println!("{id} is already owned by {who}; lease refreshed");
        return Ok(0);
    }
    recovery_allowed(&row, &from, &who)?;
    // Compare-and-set the owner and state: a concurrent reassignment cannot be stolen.
    // The explicit abandonment declaration is required even for lease-less records.
    bd(&work, &["update".into(), id.clone(), "--assignee".into(), who.clone(),
        "--if-assignee".into(), from.clone(), "--if-status".into(), "in_progress".into(),
        "--append-notes".into(), format!("Abandoned claim recovered from {from} by {who}: {reason}")])?;
    bd(&work, &["update".into(), id.clone(), "--claim".into(), "--add-label".into(), format!("copy:{job}")])?;
    bd(&work, &["heartbeat".into(), id.clone()])?;
    reconcile_parents(&work)?;
    println!("Recovered {id} as {who}; existing work is preserved in {}", work.display());
    Ok(0)
}

fn recovery_allowed(row: &Value, from: &str, who: &str) -> Result<(), String> {
    if status(row) != "in_progress" { return Err("Only abandoned in-progress work can be recovered; manager review and settled cards are not claimable".into()); }
    if row["assignee"].as_str() != Some(from) || from == who {
        return Err("The previous owner changed or is this session; inspect the card before recovering it".into());
    }
    if let Some(raw) = row["lease_expires_at"].as_str() {
        let lease = chrono::DateTime::parse_from_rfc3339(raw).map_err(|_| "Cannot verify an unreadable lease")?;
        if lease > chrono::Utc::now() { return Err("The previous owner has a live lease; wait for expiry and confirm the session has stopped".into()); }
    }
    Ok(())
}

pub fn cleanup(rest: &[String]) -> Result<i32, String> {
    let id = rest.first().filter(|id| !id.starts_with('-')).ok_or("board/cleanup needs a job id")?;
    if rest.iter().skip(1).any(|s| s != "--force") { return Err("usage: board/cleanup JOB-ID [--force]".into()); }
    let force = rest.iter().any(|s| s == "--force");
    let work = root()?;
    let base = common_root(&work);
    let rows = all(&work)?;
    let projection = board_state::project(&nodes(&rows));
    if projection.errors.contains_key(id) || !projection.states.get(id).is_some_and(|s| matches!(s.as_str(), "closed" | "cancelled")) {
        return Err(format!("{id} still has required work or an invalid hierarchy"));
    }
    git(&work, &["merge-base", "--is-ancestor", id, &landing_branch(&work)])?;
    let path = main_copy(&work, id)?;
    if work == path { return Err("Run board/cleanup from another checkout, outside the job being removed".into()); }
    if !git(&path, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Cleanup refuses tracked changes, even with --force; preserve or land them first".into());
    }
    let output = std::process::Command::new(crate::routes::find_git().ok_or("Git is unavailable")?)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(&path).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("Cannot enumerate untracked files; cleanup refused".into()); }
    // Do not trim: leading spaces and embedded newlines are valid filenames.
    let untracked = String::from_utf8(output.stdout).map_err(|_| "Cannot archive non-UTF8 paths; cleanup refused")?;
    if !untracked.is_empty() {
        if !force { return Err(format!("{id} has untracked files; run board/cleanup {id} --force to archive them before removal")); }
        let common = git(&work, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        let directory = Path::new(&common).join("atelier-cleanup");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let archive = directory.join(format!("{id}-{}.tar", chrono::Utc::now().timestamp_nanos_opt().ok_or("Clock out of range")?));
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&archive).map_err(|e| e.to_string())?;
        let mut tar = tar::Builder::new(file);
        tar.follow_symlinks(false);
        for name in untracked.split('\0').filter(|s| !s.is_empty()) {
            let relative = Path::new(name);
            if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err("Git returned an unsafe untracked path; cleanup refused".into());
            }
            let source = path.join(relative);
            if std::fs::symlink_metadata(&source).map_err(|e| e.to_string())?.is_dir() {
                tar.append_dir_all(relative, source).map_err(|e| e.to_string())?;
            } else { tar.append_path_with_name(source, relative).map_err(|e| e.to_string())?; }
        }
        let file = tar.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        println!("Preserved untracked files in {}", archive.display());
    }
    // Archiving may take time. Check the worktree again before allowing Git's force flag.
    if !git(&path, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Tracked files changed during cleanup; the worktree was preserved".into());
    }
    git(&path, &["merge-base", "--is-ancestor", "HEAD", &landing_branch(&work)])?;
    let mut args = vec!["worktree", "remove"];
    if force { args.push("--force"); }
    args.push(path.to_str().ok_or("Non-UTF8 worktree path")?);
    git(&base, &args)?;
    git(&base, &["branch", "-d", id])?;
    println!("Removed finished job worktree {id}");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_requires_the_expected_abandoned_owner_and_no_live_lease() {
        let row = json!({"status":"in_progress","assignee":"old"});
        assert!(recovery_allowed(&row, "old", "new").is_ok());
        assert!(recovery_allowed(&row, "other", "new").is_err());
        assert!(recovery_allowed(&row, "old", "old").is_err());
        for state in ["closed", "manager_review", "open", "cancelled"] {
            let mut next = row.clone(); next["status"] = json!(state);
            assert!(recovery_allowed(&next, "old", "new").is_err());
        }
        let mut next = row.clone(); next["lease_expires_at"] = json!("2999-01-01T00:00:00Z");
        assert!(recovery_allowed(&next, "old", "new").is_err());
        next["lease_expires_at"] = json!("2000-01-01T00:00:00Z");
        assert!(recovery_allowed(&next, "old", "new").is_ok());
        next["lease_expires_at"] = json!("unreadable");
        assert!(recovery_allowed(&next, "old", "new").is_err());
    }

    #[test]
    fn historical_operations_complete_with_delivered_work_including_prior_retirement() {
        let rows = vec![
            json!({"id":"j","issue_type":"epic","status":"open"}),
            json!({"id":"j.1","status":"closed","parent":"j"}),
            json!({"id":"j.2","status":"open","parent":"j","labels":["no-code","step:verify"]}),
            json!({"id":"j.3","status":"closed","parent":"j","labels":["no-code","step:land","cancelled"]}),
            json!({"id":"j.4","status":"open","parent":"j","labels":["no-code","step:clarify"]}),
        ];
        let decisions = operation_decisions(&rows);
        assert_eq!(decisions.len(), 3);
        assert!(decisions.iter().all(|d| d["to"] == "closed" && d["action"] == "complete_operation"));
        let mut pending = rows.clone(); pending[1]["status"] = json!("open");
        assert!(operation_decisions(&pending).is_empty());
        pending[3]["notes"] = json!("Superseded by landing-is-Done workflow; operation history retained");
        assert_eq!(operation_decisions(&pending)[0]["action"], "restore_operation");
        pending[0]["labels"] = json!(["cancelled"]);
        assert!(operation_decisions(&pending).is_empty());
    }

    #[test]
    fn operation_records_do_not_keep_landed_work_open() {
        let rows = vec![
            json!({"id":"j","status":"open"}),
            json!({"id":"j.1","status":"closed","parent":"j"}),
            json!({"id":"j.2","status":"open","parent":"j","labels":["no-code","step:land"]}),
            json!({"id":"j.3","status":"open","parent":"j","labels":["no-code","step:verify"]}),
            json!({"id":"j.4","status":"open","parent":"j","labels":["no-code","step:worktree"]}),
        ];
        let projected = board_state::project(&nodes(&rows));
        assert_eq!(projected.states["j"], "closed");
    }
    #[test]
    fn arbitrary_parent_ids_and_cancelled_children_use_one_contract() {
        let rows = vec![
            json!({"id":"parent","status":"open"}),
            json!({"id":"nested","status":"open","parent":"parent"}),
            json!({"id":"leaf","status":"closed","parent":"nested"}),
            json!({"id":"dropped","status":"closed","parent":"parent","labels":["cancelled"]}),
        ];
        let result = board_state::project(&nodes(&rows));
        assert_eq!(result.states["parent"], "closed");
        assert_eq!(result.states["nested"], "closed");
    }
    #[test]
    fn inherited_job_labels_do_not_turn_deliverables_into_empty_epics() {
        let row = json!({"id":"leaf","issue_type":"task","status":"closed","labels":["job","step:work"]});
        assert_eq!(board_state::project(&nodes(&[row])).states["leaf"], "closed");
    }
    #[test]
    fn an_empty_epic_is_never_delivered() {
        for status in ["open", "closed", "in_progress"] {
            let result = board_state::project(&nodes(&[json!({"id":"empty","issue_type":"epic","status":status})]));
            assert_ne!(result.states["empty"], "closed");
        }
    }
    #[test]
    fn check_and_review_evidence_belongs_to_the_exact_tree() {
        let row = json!({"metadata":{"checks_tree":"one","checks_passed":true,"review_tree":"two","review_passed":"true"}});
        assert!(current_proof(&row, "checks", "one"));
        assert!(!current_proof(&row, "checks", "two"));
        assert!(current_proof(&row, "review", "two"));
        assert!(!current_proof(&json!({}), "review", "two"));
    }
    #[test]
    fn a_failing_suite_is_told_how_to_land_work_it_did_not_break() {
        let said = failing_checks("bw-dvaw.2");
        assert!(said.contains("fix them and land again"));
        assert!(said.contains("atelier tool board/land bw-dvaw.2 --checks-unrelated"));
    }
    #[test]
    fn a_reason_that_reads_like_a_card_id_is_not_taken_for_one() {
        let rest: Vec<String> = ["bw-dvaw.2", "--checks-unrelated", "bw-other.9 was already red"]
            .iter().map(|s| s.to_string()).collect();
        let (id, waiver) = requested(&rest);
        assert_eq!(id.as_deref(), Some("bw-dvaw.2"));
        assert_eq!(waiver.as_deref(), Some("bw-other.9 was already red"));
        assert_eq!(requested(&[]).0, None);
    }
    #[test]
    fn a_waiver_travels_in_the_journal_and_older_records_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let record = Landing {
            version: 1,
            branch: "main".into(),
            tip: "abc".into(),
            tree: "tree".into(),
            actor: "session".into(),
            cards: vec!["job.1".into()],
            complete: false,
            waived: Some("the red suite is another card's".into()),
        };
        save(&path, &record).unwrap();
        let read: Landing = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read.waived.as_deref(), Some("the red suite is another card's"));
        let older = json!({"version":1,"branch":"main","tip":"abc","tree":"tree",
            "actor":"session","cards":["job.1"],"complete":false});
        let read: Landing = serde_json::from_value(older).unwrap();
        assert_eq!(read.waived, None);
    }
    #[test]
    fn receipt_file_is_durable_and_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.json");
        let mut record = Landing {
            version: 1,
            branch: "main".into(),
            tip: "abc".into(),
            tree: "tree".into(),
            actor: "session".into(),
            cards: vec!["job.1".into()],
            complete: false,
            waived: None,
        };
        save(&path, &record).unwrap();
        let read: Landing = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(!read.complete);
        assert_eq!(read.cards, vec!["job.1"]);
        record.complete = true;
        save(&path, &record).unwrap();
        let read: Landing = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(read.complete);
        assert!(!path.with_extension("pending").exists());
    }
}
