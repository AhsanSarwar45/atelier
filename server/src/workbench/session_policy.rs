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
}
