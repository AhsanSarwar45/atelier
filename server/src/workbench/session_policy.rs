//! Atelier-owned provider policy, injected per session without modifying provider homes.

use std::{fs, path::Path};

pub const VERSION: u8 = 1;
pub const MARKER: &str = "ATELIER_SESSION_POLICY_V1";

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
    if !m.git.completed_work_branch.is_empty() {
        lines.push(format!(
            "Completed work branch: {}",
            m.git.completed_work_branch
        ));
    }
    if !m.review.evidence_requirements.is_empty() {
        lines.push(format!(
            "Required evidence: {}",
            m.review.evidence_requirements
        ));
    }
    for (label, command) in [
        ("Setup", &m.development.setup_command),
        ("Start", &m.development.start_command),
        ("Build", &m.development.build_command),
    ] {
        if !command.is_empty() {
            lines.push(format!("{label} command: {command}"));
        }
    }
    lines.push(
        if m.verification.visual_proof_for_ui_changes {
            "This project requires visual proof for interface changes."
        } else {
            "This project does not require visual proof for interface changes."
        }
        .into(),
    );
    if !m.review.external_review.is_empty() {
        lines.push(format!("External review policy: {}. This policy authorizes any review it allows; do not ask for separate permission.", m.review.external_review));
    }
    if !m.deployment.command.is_empty() {
        lines.push(format!("Deployment command: {}", m.deployment.command));
        if m.deployment.requires_confirmation {
            lines.push(
                "Ask for explicit permission immediately before running the deployment command."
                    .into(),
            );
        }
    }
    (lines.join("\n"), m.project.use_beads)
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
    let installed = crate::identity::rules_dir().map(|rules| rules.join("machinery/skills"));
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("machinery/skills");
    let skills = installed
        .filter(|root| root.join("atelier/SKILL.md").is_file())
        .or_else(|| {
            bundled
                .join("atelier/SKILL.md")
                .is_file()
                .then_some(bundled)
        })
        .ok_or_else(|| "Session policy unavailable. Reinstall Atelier.".to_string())?;
    let atelier = body(&skills.join("atelier/SKILL.md"))?;
    let (project, wants_beads) = guidance(cwd);
    // A workflow whose every command fails is worse than no workflow. The
    // Beads skill goes in only when this computer can actually reach a board,
    // and a project that wants one but cannot have one here is told which of
    // the two it is — saying "does not use Beads" about a board project would
    // be false, and saying nothing would leave the agent to find out by
    // running a command that cannot work (bw-3tkl.3).
    let reachable = crate::routes::find_bd().is_some();
    let beads = if wants_beads && reachable {
        body(&skills.join("beads/SKILL.md"))?
    } else {
        String::new()
    };
    let tail = beads_tail(wants_beads, reachable, &beads);
    Ok(format!(
        "<!-- {MARKER} -->\n\n{atelier}\n\n{project}\n\n{tail}"
    ))
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
