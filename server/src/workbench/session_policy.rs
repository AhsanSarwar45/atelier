//! Atelier-owned provider policy, injected per session without modifying provider homes.

use std::path::Path;
#[cfg(test)]
use std::fs;

pub const VERSION: u8 = 1;
pub const MARKER: &str = "ATELIER_SESSION_POLICY_V1";

#[cfg(test)]
fn body(path: &Path) -> Result<String, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(if let Some(rest) = text.strip_prefix("---\n") {
        rest.find("\n---\n")
            .map_or(text.as_str(), |end| &rest[end + 5..])
            .trim()
            .to_string()
    } else {
        text.trim().to_string()
    })
}

fn guidance(cwd: &Path) -> String {
    let Some(data) = crate::identity::data_dir() else {
        return "This project has no Atelier project manifest.".into();
    };
    let Some(found) = crate::project_manifest::locate(cwd, &data) else {
        return "This project has no Atelier project manifest.".into();
    };
    project_lines(cwd, found)
}

/// What a session is told about the project it is working in: its name and
/// summary, then the project in its own words.
fn project_lines(cwd: &Path, found: crate::project_manifest::LocatedManifest) -> String {
    let m = found.manifest;
    let mut lines = vec![format!(
        "Project: {}",
        if m.project.display_name.is_empty() {
            cwd.display().to_string()
        } else {
            m.project.display_name
        }
    )];
    if !m.project.summary.is_empty() {
        lines.push(format!("Project context: {}", m.project.summary));
    }
    let derived = lines.join("\n");
    if found.instructions.is_empty() {
        derived
    } else {
        format!("{derived}\n\n{}", found.instructions)
    }
}

pub fn build(cwd: &Path) -> Result<String, String> {
    let snapshot = super::library::snapshot(cwd)?;
    Ok(build_with_library(cwd, &snapshot))
}

pub fn build_with_library(cwd: &Path, snapshot: &super::library::Snapshot) -> String {
    let project = guidance(cwd);
    format!("<!-- {MARKER} -->\n\n{project}\n\n{}", snapshot.guidance())
}

/// The guidance with the chat's open tasks after it (`tasks::open_section`),
/// or unchanged when it holds none.
pub fn with_open_tasks(guidance: String, open_tasks: &str) -> String {
    if open_tasks.trim().is_empty() {
        guidance
    } else {
        format!("{guidance}\n\n{open_tasks}")
    }
}

/// What an orchestrator chat is told about its job
/// (docs/designs/orchestrator-workers.md, Role guidance).
const ORCHESTRATOR: &str = "# Orchestrator

You own the owner's goal. Worker chats do most of the coding, on the provider and account the owner chose for this chat.

- Turn the owner's request into a plan, {TASK}and see it through to done.
- Hand the bulk of the implementation to workers. Edit files yourself only when that is quicker than writing a brief: plans, tests, a small fix, a finishing touch.
- Start a worker with `atelier tool worker start --title TITLE` and the brief on standard input. Steer it with `atelier tool worker send ID`, check on it with `list` and `read ID`, and stop it with `stop ID`. Run `atelier tool worker help` for the details.
- A message to a worker that is mid-turn waits until that turn ends, and the reply says Queued. To change course now, run `atelier tool worker send ID --now`: it interrupts the worker's turn and your message goes next. To end the work without a new instruction, use `stop ID`.
- Write each brief so it stands alone: the goal, why, where to start, the checks it must pass, and what is out of scope.
- Only one worker can be working in this folder at a time. Idle workers keep their context, so send follow-ups to the same worker.
- After starting or messaging a worker, end your turn. Atelier wakes you with a short note such as Worker \"login form\" finished, followed by its report.
- Treat a report as a claim. Check the diff, run the checks and try the change before you accept it.
- Never just say \"continue\". Send back the exact failing check or missing piece, or split the work. After three send-backs without progress, change the approach or ask the owner.
- Ask the owner only for decisions that are theirs to make.";

/// What a worker chat is told about its job.
const WORKER: &str = "# Worker

An orchestrator chat started you and is waiting for your report. Do the brief, and nothing beyond it.

- Run the brief's checks before you finish.
- End every turn with a short report under these headings: Done, Left, Blocked, Files changed, Checks run.
- {TASK}Put questions for the owner under Blocked instead of asking.";

/// The section a chat's role adds to its guidance: an orchestrator's when it
/// has a workers choice, a worker's when an orchestrator started it, and
/// nothing for any other chat. Where tasks are off it says nothing of them.
pub fn role_section(session: &super::store::Session, tasks_off: bool) -> String {
    let (text, task) = if session.workers.is_some() {
        (ORCHESTRATOR, "record it as a task with checks, ")
    } else if session.parent_session_id.is_some() {
        (WORKER, "Do not create or propose tasks; the orchestrator owns them. ")
    } else {
        return String::new();
    };
    text.replace("{TASK}", if tasks_off { "" } else { task })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled_skills() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("machinery/skills")
    }

    /// The task rules are in every session's guidance, whatever the project
    /// (docs/tasks.md).
    #[test]
    fn every_session_is_given_the_task_rules() {
        let data = tempfile::tempdir().unwrap();
        let rules = body(&bundled_skills().join("tasks/SKILL.md")).unwrap();
        for root in [None, Some(tempfile::tempdir().unwrap())] {
            let snapshot = super::super::library::resolve(data.path(), root.as_ref().map(|r| r.path())).unwrap();
            let guidance = snapshot.guidance();
            assert!(guidance.contains("instructions — Tasks:"), "{guidance}");
            assert!(guidance.contains(rules.trim()), "the tasks skill is missing:\n{guidance}");
            assert!(guidance.contains("atelier task create"), "{guidance}");
            assert!(guidance.contains("atelier grid prove"), "{guidance}");
        }
    }

    fn located(instructions: &str) -> crate::project_manifest::LocatedManifest {
        let mut manifest = crate::project_manifest::named("Keystone");
        manifest.project.summary = "A workbench".into();
        crate::project_manifest::LocatedManifest {
            manifest,
            path: std::path::PathBuf::from("/data/project.toml"),
            storage: crate::project_manifest::ManifestStorage::Personal,
            instructions: instructions.to_string(),
        }
    }

    /// The project's own wording reaches the session, after its name.
    #[test]
    fn the_projects_own_instructions_reach_the_session_after_its_name() {
        let text = project_lines(Path::new("/dev/keystone"), located("Never touch port 3008."));
        let name = text.find("Project: Keystone").unwrap();
        let own = text.find("Never touch port 3008.").unwrap();
        assert!(name < own, "{text}");
    }

    /// A project that has written nothing reads as its name and summary only.
    #[test]
    fn a_project_with_no_instructions_says_only_what_atelier_knows() {
        let text = project_lines(Path::new("/dev/keystone"), located(""));
        assert_eq!(text, "Project: Keystone\nProject context: A workbench");
    }

    /// The six settings that existed only to become these lines are gone, so
    /// nothing generates them any more (bw-a9ln.2).
    #[test]
    fn no_setting_still_generates_the_retired_prompt_lines() {
        let text = project_lines(Path::new("/dev/keystone"), located(""));
        for retired in ["Setup command", "Start command", "Build command", "Deployment command", "Required evidence", "visual proof"] {
            assert!(!text.contains(retired), "{retired} is still generated:\n{text}");
        }
    }

    /// The board, landing and external review are gone, and a session is told
    /// nothing about any of them — not even that they are absent.
    #[test]
    fn a_session_hears_nothing_of_the_board_landing_or_review() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let snapshot = super::super::library::resolve(data.path(), Some(root.path())).unwrap();
        let policy = build_with_library(root.path(), &snapshot).to_lowercase();
        for word in ["board", "landing", "completed work branch", "external review", "reviewer"] {
            assert!(!policy.contains(word), "the session policy says {word:?}:\n{policy}");
        }
    }

    /// Turns tasks on or off in a scope's folder (the data folder for the
    /// install, `catalog::project_dir` for a project), as the owner's switch does.
    fn switch_tasks(folder: &Path, on: bool) {
        fs::create_dir_all(folder).unwrap();
        fs::write(folder.join("tasks.json"), serde_json::json!({"enabled": on}).to_string()).unwrap();
    }

    /// Everything a chat could learn tasks or grids from: its guidance, and
    /// what a bare `@task`, `@merge`, `@matrix` or `@audit` in a message adds.
    fn told_of_tasks(data: &Path, root: &Path) -> Vec<String> {
        let snapshot = super::super::library::resolve(data, Some(root)).unwrap();
        let mut said = vec![build_with_library(root, &snapshot)];
        let references = super::super::references::find("@task tidy the export, then @merge, @matrix and @audit camera");
        said.extend(super::super::references::block(&references, &Default::default(), &snapshot));
        let words = ["instructions — Tasks", "atelier task", "atelier grid", "@task", "@merge", "@matrix", "@audit", "coverage grid"];
        words
            .iter()
            .filter(|word| said.iter().any(|text| text.contains(**word)))
            .map(|word| word.to_string())
            .collect()
    }

    /// With tasks turned off for the install, a chat is told nothing of
    /// tasks or grids: not the rules, not the commands, not what `@task` means.
    #[test]
    fn a_chat_hears_nothing_of_tasks_when_the_install_turns_them_off() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        switch_tasks(data.path(), false);
        let told = told_of_tasks(data.path(), root.path());
        assert!(told.is_empty(), "the chat is told about tasks while they are off: {told:?}");
    }

    /// A project's switch wins over the install's, either way.
    #[test]
    fn a_projects_tasks_switch_wins_over_the_installs() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let project = super::super::tasks::catalog::project_dir(data.path(), root.path()).unwrap();
        switch_tasks(&project, false);
        let told = told_of_tasks(data.path(), root.path());
        assert!(told.is_empty(), "the chat is told about tasks while they are off: {told:?}");

        switch_tasks(data.path(), false);
        switch_tasks(&project, true);
        let told = told_of_tasks(data.path(), root.path());
        assert!(told.contains(&"instructions — Tasks".to_string()), "a project that turns tasks on gets the rules: {told:?}");
    }

    /// With Require approval off, a chat is told to create and start the
    /// tasks it needs itself, not to propose one and wait for the owner.
    #[test]
    fn a_chat_creates_tasks_itself_when_approval_is_off() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let told = |data: &Path| {
            let snapshot = super::super::library::resolve(data, Some(root.path())).unwrap();
            build_with_library(root.path(), &snapshot)
        };
        let asking = told(data.path());
        assert!(asking.contains("run `atelier task propose`, and stop"), "approval on asks first:\n{asking}");

        fs::write(data.path().join("tasks.json"), serde_json::json!({"approval": false}).to_string()).unwrap();
        let policy = told(data.path());
        assert!(policy.contains("instructions — Tasks"), "tasks are still on:\n{policy}");
        assert!(!policy.contains("run `atelier task propose`, and stop"), "the chat is still told to propose and wait:\n{policy}");
        assert!(!policy.contains("`create` is refused unless"), "the chat is told create needs @task:\n{policy}");
        assert!(policy.contains("run `atelier task create`, then start it"), "the chat is not told to create the task itself:\n{policy}");
    }
}
