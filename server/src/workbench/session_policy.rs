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

fn guidance(cwd: &Path) -> (String, bool) {
    let Some(data) = crate::identity::data_dir() else {
        return (
            "This project has no Atelier project manifest.".into(),
            false,
        );
    };
    let Some(found) = crate::project_manifest::locate(cwd, &data) else {
        return (
            "This project has no Atelier project manifest.".into(),
            false,
        );
    };
    project_lines(cwd, found)
}

/// What a session is told about the project it is working in: the settings
/// Atelier enforces, then the project in its own words.
fn project_lines(cwd: &Path, found: crate::project_manifest::LocatedManifest) -> (String, bool) {
    let m = found.manifest.clone();
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
    if !m.git.completed_work_branch.is_empty() {
        lines.push(format!(
            "Completed work branch: {}",
            m.git.completed_work_branch
        ));
    }
    if !m.review.external_review.is_empty() {
        lines.push(format!("External review policy: {}. This policy authorizes any review it allows; do not ask for separate permission.", m.review.external_review));
    }
    // Atelier's own facts first, then the project in its own words. The two are
    // kept apart because only the first set is enforced: a project may say
    // anything here, but it may not contradict the branch its work lands on or
    // the review policy its landings are checked against (bw-a9ln.1).
    let derived = lines.join("\n");
    let guidance = if found.instructions.is_empty() {
        derived
    } else {
        format!("{derived}\n\n{}", found.instructions)
    };
    (guidance, m.project.use_beads)
}

/// What a session is told about Beads, given what the project wants and what
/// this computer can reach.
///
/// A workflow whose every command fails is worse than no workflow, so the
/// Beads skill goes in only when there is a board to reach. A project that
/// wants one but cannot have one here is told which of the two it is: saying
/// "does not use Beads" about a board project would be false, and saying
/// nothing would leave the agent to find that out by running a command that
/// cannot work (bw-3tkl.3).
fn beads_tail(wants_beads: bool, reachable: bool, beads_body: &str) -> String {
    match (wants_beads, reachable) {
        (true, true) => {
            format!("{beads_body}\n\nThis session is in a Beads-registered project.")
        }
        (true, false) => format!(
            "This project uses Beads, but this computer has no bd to reach the board with. {} Until then, do not use Beads, Beads cards, or the Beads lifecycle for its work.",
            crate::routes::BD_MISSING
        ),
        (false, _) => "This project does not use Beads. Do not use Beads, Beads cards, or the Beads lifecycle for its work.".to_string(),
    }
}

pub fn build(cwd: &Path) -> Result<String, String> {
    let snapshot = super::library::snapshot(cwd)?;
    Ok(build_with_library(cwd, &snapshot))
}

pub fn build_with_library(cwd: &Path, snapshot: &super::library::Snapshot) -> String {
    let (project, wants_beads) = guidance(cwd);
    let reachable = snapshot.items.iter().any(|row| row.item.id == "atelier-beads" && row.state == "available");
    let tail = beads_tail(wants_beads, reachable, "");
    format!("<!-- {MARKER} -->\n\n{project}\n\n{}\n\n{tail}", snapshot.guidance())
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

    /// The skill every session gets names no Beads concept, so a chat-only
    /// project is not handed board vocabulary and then told to ignore it
    /// (bw-3tkl.3).
    #[test]
    fn the_always_injected_skill_says_nothing_about_beads() {
        let text = body(&bundled_skills().join("atelier/SKILL.md")).unwrap();
        let lowered = text.to_lowercase();
        assert!(!lowered.contains("beads"), "atelier/SKILL.md still names Beads:\n{text}");
        assert!(!lowered.contains(" epic"), "atelier/SKILL.md still names epics:\n{text}");
    }

    /// The checklist rules did not vanish; they moved to the skill that only
    /// a board project is given.
    #[test]
    fn the_checklist_rules_moved_to_the_beads_skill() {
        let text = body(&bundled_skills().join("beads/SKILL.md")).unwrap();
        assert!(text.contains("Live checklist"), "{text}");
        assert!(text.contains("Beads epic"), "{text}");
    }

    fn located(instructions: &str) -> crate::project_manifest::LocatedManifest {
        let mut manifest = crate::project_manifest::infer_virtual("Keystone");
        manifest.project.summary = "A workbench".into();
        crate::project_manifest::LocatedManifest {
            manifest,
            path: std::path::PathBuf::from("/data/project.toml"),
            storage: crate::project_manifest::ManifestStorage::Personal,
            instructions: instructions.to_string(),
        }
    }

    /// The project's own wording reaches the session, and it comes after the
    /// settings Atelier enforces rather than mixed among them: a project may
    /// say anything here, but it may not quietly restate the branch its work
    /// lands on or the review policy its landings are checked against
    /// (bw-a9ln.1).
    #[test]
    fn the_projects_own_instructions_reach_the_session_after_the_enforced_settings() {
        let (text, _) = project_lines(Path::new("/dev/keystone"), located("Never touch port 3008."));
        let enforced = text.find("External review policy").unwrap();
        let own = text.find("Never touch port 3008.").unwrap();
        assert!(enforced < own, "{text}");
        assert!(text.contains("Completed work branch: main"), "{text}");
    }

    /// A project that has written nothing reads exactly as it did before the
    /// instructions file existed — no stray blank block on the end
    /// (bw-a9ln.1).
    #[test]
    fn a_project_with_no_instructions_says_only_what_atelier_knows() {
        let (text, _) = project_lines(Path::new("/dev/keystone"), located(""));
        assert!(text.ends_with("do not ask for separate permission."), "{text:?}");
    }

    /// The six settings that existed only to become these lines are gone, so
    /// nothing generates them any more (bw-a9ln.2).
    #[test]
    fn no_setting_still_generates_the_retired_prompt_lines() {
        let (text, _) = project_lines(Path::new("/dev/keystone"), located(""));
        for retired in ["Setup command", "Start command", "Build command", "Deployment command", "Required evidence", "visual proof"] {
            assert!(!text.contains(retired), "{retired} is still generated:\n{text}");
        }
    }

    #[test]
    fn a_board_project_on_a_computer_with_bd_gets_the_beads_skill() {
        let tail = beads_tail(true, true, "THE BEADS SKILL");
        assert!(tail.starts_with("THE BEADS SKILL"), "{tail}");
        assert!(tail.contains("Beads-registered project"), "{tail}");
    }

    /// A board project on a computer with no bd is told which of the two it
    /// is, and where to get bd — not that it "does not use Beads", which
    /// would be false.
    #[test]
    fn a_board_project_without_bd_is_told_the_board_is_out_of_reach() {
        let tail = beads_tail(true, false, "THE BEADS SKILL");
        assert!(!tail.contains("THE BEADS SKILL"), "{tail}");
        assert!(!tail.contains("does not use Beads"), "{tail}");
        assert!(tail.contains("no bd to reach the board with"), "{tail}");
        assert!(tail.contains("bd CLI not found"), "{tail}");
        assert!(tail.contains("do not use Beads"), "{tail}");
    }

    #[test]
    fn a_chat_only_project_is_told_so_whether_or_not_bd_is_here() {
        for reachable in [true, false] {
            let tail = beads_tail(false, reachable, "THE BEADS SKILL");
            assert_eq!(
                tail,
                "This project does not use Beads. Do not use Beads, Beads cards, or the Beads lifecycle for its work."
            );
        }
    }
}
