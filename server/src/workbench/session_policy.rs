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
    let (project, beads) = guidance(cwd);
    let tail = if beads {
        format!(
            "{}\n\nThis session is in a Beads-registered project.",
            body(&skills.join("beads/SKILL.md"))?
        )
    } else {
        "This project does not use Beads. Do not use Beads, Beads cards, or the Beads lifecycle for its work.".into()
    };
    Ok(format!(
        "<!-- {MARKER} -->\n\n{atelier}\n\n{project}\n\n{tail}"
    ))
}
