//! The working rules the product carries: the internal workers and skills a
//! session reads, and the one session gate this binary still answers.
//!
//! Three things had to be true at once for a teammate to get a working project
//! out of one install. The rules had to travel inside the binary, because a
//! machine that has never held this repository has nowhere to read them from.
//! They land as provider-readable skills and worker instructions. Executable
//! workflow logic lives in this binary.
//! Provider-facing policy is injected when Atelier starts a session rather than
//! placed where a provider scans the user's home. The gates a project ends up
//! wired to could not be paths, because a path is one person's home folder
//! written into a file everybody else clones (bw-8um.3.3).
//!
//! So the tree is laid down verbatim under one folder beside the data, and the
//! gates are wired as a word this program answers to — `atelier hook <name>` —
//! which is the same on every machine and stays right when the data folder
//! moves.

use rust_embed::Embed;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// The skills and workers, as they sit in the repository.
///
/// `projects.toml` and declarations live in personal Atelier data and are never
/// carried: shipping the maintainer's copies would point a teammate at folders
/// and project policy that do not belong to their machine.
#[derive(Embed)]
#[folder = "../machinery/"]
#[include = "README.md"]
#[include = "skills/**"]
#[include = "workers/*.md"]
struct Machinery;

/// Where the machinery lands under the rules folder.
///
/// Kept as the stable location used by existing skill links.
pub const MACHINERY: &str = "machinery";

/// The word `join` writes into a project's gates instead of a path, when this
/// program is the one running it.
const RETIRED_RULE_FILES: &[&str] = &[
    ".claude/agents/general-purpose.md",
    ".claude/agents/researcher.md",
    ".claude/agents/reviewer.md",
    ".claude/agents/scout.md",
    ".claude/agents/screen-check.md",
    ".claude/commands/docs-cleanup.md",
    ".claude/output-styles/manager.md",
    ".claude/skills/compact-handoff/SKILL.md",
    ".claude/skills/judge-against-reference/SKILL.md",
    ".claude/skills/read-image/SKILL.md",
    ".claude/skills/spec/SKILL.md",
    "machinery/skills/external-review/SKILL.md",
    "machinery/skills/external-review/references/practices.md",
    "machinery/skills/atelier/references/visual-artifacts.md",
    "machinery/hooks/picture-gate.py",
    "machinery/hooks/agent-fence.py",
    "machinery/hooks/session-context.py",
    // Retired with the board.
    "machinery/project.example.toml",
    "machinery/skills/beads/SKILL.md",
    "machinery/skills/board-search/SKILL.md",
    "machinery/workers/external-review.md",
];

fn remove_retired_rule_files(dir: &Path) -> Result<(), String> {
    for relative in RETIRED_RULE_FILES {
        let path = dir.join(relative);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
    }
    for relative in [
        ".claude/skills/compact-handoff",
        ".claude/skills/judge-against-reference",
        ".claude/skills/read-image",
        ".claude/skills/spec",
        ".claude/skills",
        ".claude/agents",
        ".claude/commands",
        ".claude/output-styles",
        ".claude",
        "machinery/skills/external-review/references",
        "machinery/skills/external-review",
        "machinery/skills/atelier/references",
        "machinery/skills/beads",
        "machinery/skills/board-search",
    ] {
        let _ = std::fs::remove_dir(dir.join(relative));
    }
    Ok(())
}

/// Lay the rules down beside the data, and say where they went.
pub fn install() -> Result<PathBuf, String> {
    let Some(dir) = crate::identity::rules_dir() else {
        return Err("Could not find the application data folder".to_string());
    };
    let files = crate::laid_down::gather::<Machinery>(MACHINERY)?;
    crate::laid_down::install(&dir, &files)?;
    remove_retired_rule_files(&dir)?;
    Ok(dir)
}

/// Set a project up: lay the rules down, then join that project to them.
///
/// `rest` is passed through to `join` word for word, so `--forward` and
/// `--check` keep working and this stays one command rather than a second
/// help screen to keep in step with the first.
pub fn init(rest: &[String]) -> Result<i32, String> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    init_with(rest, &mut input, &mut output)
}

/// Remove exact legacy Atelier-owned provider artifacts without joining a repository.
pub fn install_personal() -> Result<i32, String> {
    let dir = install()?;
    let homes = crate::personal::Homes::resolve()?;
    crate::personal::install(&dir, &homes)?;
    Ok(0)
}

fn init_with(
    rest: &[String],
    input: &mut dyn BufRead,
    output: &mut dyn Write,
) -> Result<i32, String> {
    let _dir = install()?;
    let mut said: Vec<String> = Vec::new();
    let mut where_ = None;
    let mut storage = None;
    let mut chosen_name = None;
    for word in rest {
        if word == "--repository-config" {
            storage = Some(crate::project_manifest::ManifestStorage::Repository);
        } else if word == "--personal-config" {
            storage = Some(crate::project_manifest::ManifestStorage::Personal);
        } else if let Some(value) = word.strip_prefix("--name=") {
            chosen_name = Some(value.to_string());
        } else if word.starts_with('-') {
            // `--beads`, `--chat`, `--prefix=`, `--completed-work-branch=` and
            // the merge flags belonged to the board, which is gone. A script
            // that still passes them is told so rather than refused.
            said.push(word.clone());
        } else if where_.is_none() {
            where_ = Some(word.clone());
        } else {
            return Err(format!(
                "`{word}`: only one project can be set up at a time"
            ));
        }
    }
    let root = std::fs::canonicalize(where_.unwrap_or_else(|| ".".to_string()))
        .map_err(|e| format!("that folder cannot be read: {e}"))?;

    let data_dir = crate::identity::data_dir()
        .ok_or_else(|| "Could not find the Atelier data folder".to_string())?;
    let existing = crate::project_manifest::locate(&root, &data_dir);
    let mut manifest = existing
        .as_ref()
        .map(|found| found.manifest.clone())
        .unwrap_or_else(|| crate::project_manifest::infer(&root));
    manifest.project.display_name = chosen_name.unwrap_or_else(|| {
        ask_with_default(
            input,
            output,
            "Project name",
            &manifest.project.display_name,
        )
        .unwrap_or_else(|_| manifest.project.display_name.clone())
    });
    let storage = storage.unwrap_or_else(|| {
        if existing.as_ref().map(|found| found.storage)
            == Some(crate::project_manifest::ManifestStorage::Repository)
            || ask_repository_storage(input, output).unwrap_or(false)
        {
            crate::project_manifest::ManifestStorage::Repository
        } else {
            crate::project_manifest::ManifestStorage::Personal
        }
    });
    writeln!(
        output,
        "\nProject settings: {} · config: {:?}",
        manifest.project.display_name, storage
    )
    .map_err(|error| error.to_string())?;
    match existing {
        Some(found) => {
            if found.storage != storage {
                crate::project_manifest::move_to(&root, &data_dir, storage)?;
            }
            let located = crate::project_manifest::locate(&root, &data_dir).ok_or_else(|| {
                "the project manifest disappeared while it was being updated".to_string()
            })?;
            crate::project_manifest::write_atomic(&located.path, &manifest)?;
        }
        None => {
            crate::project_manifest::create(&root, &data_dir, storage, &manifest)?;
        }
    }
    if !said.is_empty() {
        eprintln!(
            "warning: obsolete setup arguments ignored: {}",
            said.join(" ")
        );
    }
    // What older versions wired into the project for the board goes; the
    // project's own entries stay.
    crate::join::tidy(&root)?;
    // Older copies wrote the doing gate into the reader's own global Claude
    // settings at every startup (bw-t26l.20).
    match crate::doing::unwire_global() {
        Ok((taken, settings)) if taken > 0 => {
            writeln!(
                output,
                "Took {taken} old chat-status hook{} out of {}.",
                if taken == 1 { "" } else { "s" },
                settings.display()
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(_) => {}
        Err(why) => eprintln!("warning: {why}"),
    }
    show_project(&root, &manifest)?;
    Ok(0)
}

fn ask_with_default(
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    label: &str,
    default: &str,
) -> Result<String, String> {
    write!(output, "{label} [{default}]: ").map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    let mut answer = String::new();
    input
        .read_line(&mut answer)
        .map_err(|error| error.to_string())?;
    let answer = answer.trim();
    Ok(if answer.is_empty() {
        default.to_string()
    } else {
        answer.to_string()
    })
}

fn ask_yes_no(
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    label: &str,
    default: bool,
) -> Result<bool, String> {
    loop {
        write!(
            output,
            "{label} [{}]: ",
            if default { "Y/n" } else { "y/N" }
        )
        .map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        let mut answer = String::new();
        input
            .read_line(&mut answer)
            .map_err(|error| error.to_string())?;
        match answer.trim().to_ascii_lowercase().as_str() {
            "" => return Ok(default),
            "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => writeln!(output, "Please answer yes or no.").map_err(|error| error.to_string())?,
        }
    }
}

fn ask_repository_storage(input: &mut dyn BufRead, output: &mut dyn Write) -> Result<bool, String> {
    ask_yes_no(
        input,
        output,
        "Store shared settings in .atelier/project.toml?",
        false,
    )
}

fn show_project(
    root: &Path,
    manifest: &crate::project_manifest::ProjectManifest,
) -> Result<(), String> {
    let db = crate::db::Database::new().map_err(|error| error.to_string())?;
    let path = root.to_string_lossy().to_string();
    if let Some(existing) = db
        .get_project_by_path(&path)
        .map_err(|error| error.to_string())?
    {
        db.update_project(
            &existing.id,
            crate::db::UpdateProjectInput {
                name: Some(manifest.project.display_name.clone()),
                path: None,
                local_path: None,
            },
        )
        .map_err(|error| error.to_string())?;
        if existing.archived_at.is_some() {
            db.unarchive_project(&existing.id)
                .map_err(|error| error.to_string())?;
        }
    } else {
        db.create_project(crate::db::CreateProjectInput {
            name: manifest.project.display_name.clone(),
            path,
            local_path: None,
            is_test: false,
        })
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Answer one provider hook by name, on behalf of a project wired to a word.
///
/// Only `doing` still does anything. Every other name — the board, landing and
/// review gates older versions wired into `.claude/settings.json`,
/// `.codex/hooks.json`, the Goose plugin and the Git `reference-transaction`
/// guard — stands down in silence: exit 0, nothing on standard output, so a
/// project nobody has reopened since keeps every tool call and every ref update
/// working. Opening the project takes those entries out (`join::tidy`).
pub fn hook(name: &str, _rest: &[String]) -> Result<i32, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("`{name}` is not the name of a gate"));
    }
    let mut heard = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut heard);
    if crate::doing::is_ours(name) {
        return Ok(crate::doing::run(&heard));
    }
    Ok(0)
}

/// Run one deliberately public workflow command from the installed rules.
///
/// The allowlist is the contract written into initialized projects. Accepting
/// an arbitrary relative path here would turn a documentation convenience into
/// a general script runner over application data.
pub async fn tool(name: &str, rest: &[String]) -> Result<i32, String> {
    if name == "skills" {
        return crate::workbench::library::cli(rest);
    }
    if name == "memory" {
        return crate::workbench::agent_memory::cli(rest);
    }
    if name == "present" {
        return crate::workbench::cli::present(rest).await;
    }
    if name == "chat" {
        return crate::workbench::cli::chat(rest).await;
    }
    if name == "task" {
        return crate::workbench::tasks::cli::run(rest).await;
    }
    if name == "grid" {
        return crate::workbench::grids::cli::run(rest).await;
    }
    if name == "screen-check" {
        return crate::workbench::cli::screen_check(rest).await;
    }
    if name == "chrome" {
        return crate::workbench::chrome::run(rest).await;
    }
    Err(format!("`{name}` is not an Atelier workflow tool"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn carried() -> crate::laid_down::Carried {
        crate::laid_down::gather::<Machinery>(MACHINERY).unwrap()
    }

    #[test]
    fn the_rules_travel_in_the_binary() {
        let files = carried();
        for want in [
            "machinery/skills/atelier/SKILL.md",
            "machinery/skills/atelier-reference/SKILL.md",
            "machinery/skills/atelier-reference/references/screen-check.md",
            "machinery/workers/screen-check.md",
        ] {
            assert!(
                files.iter().any(|(name, _)| name == want),
                "{want} is not carried"
            );
        }
    }

    #[test]
    fn no_provider_customization_is_carried_into_a_user_directory() {
        let files = carried();
        assert!(!files
            .iter()
            .any(|(name, _)| name.starts_with(".claude/") || name.starts_with(".codex/")));
    }

    #[test]
    fn retired_rules_are_removed_without_touching_neighboring_files() {
        let dir = tempfile::tempdir().unwrap();
        let retired = dir.path().join(".claude/agents/reviewer.md");
        let neighbor = dir.path().join(".claude/agents/mine.md");
        std::fs::create_dir_all(retired.parent().unwrap()).unwrap();
        std::fs::write(&retired, "old Atelier reviewer").unwrap();
        std::fs::write(&neighbor, "user-owned neighbor").unwrap();

        remove_retired_rule_files(dir.path()).unwrap();

        assert!(!retired.exists());
        assert_eq!(
            std::fs::read_to_string(neighbor).unwrap(),
            "user-owned neighbor"
        );
    }

    #[test]
    fn the_board_skills_an_older_install_laid_down_are_taken_back() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("machinery/skills/beads/SKILL.md");
        let worker = dir.path().join("machinery/workers/external-review.md");
        let kept = dir.path().join("machinery/workers/screen-check.md");
        for path in [&skill, &worker, &kept] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "old").unwrap();
        }
        remove_retired_rule_files(dir.path()).unwrap();
        assert!(!skill.exists() && !skill.parent().unwrap().exists());
        assert!(!worker.exists());
        assert!(kept.exists());
        let carried = carried();
        assert!(!carried.iter().any(|(name, _)| name.contains("beads") || name.contains("board-search") || name.contains("external-review")));
    }

    #[test]
    fn this_machines_own_list_of_projects_stays_behind() {
        // It names folders on the maintainer's disk. Shipped, it would point a
        // teammate's board screen at projects they do not have.
        let files = carried();
        assert!(!files
            .iter()
            .any(|(name, _)| name.ends_with("projects.toml")));
        assert!(!files
            .iter()
            .any(|(name, _)| name.ends_with("projects.toml.example")));
    }

    #[test]
    fn repository_provider_wiring_stays_behind() {
        // Repository hooks are joined into that repository, never carried in
        // the rules payload or copied into a provider's personal home.
        let files = carried();
        assert!(!files
            .iter()
            .any(|(name, _)| name == ".claude/settings.json"));
    }

    #[test]
    fn no_runtime_script_is_carried() {
        let files = carried();
        let junk: Vec<&String> = files
            .iter()
            .map(|(name, _)| name)
            .filter(|name| name.ends_with(".py") || name.ends_with(".pyc") || name.ends_with(".ts"))
            .collect();
        assert!(junk.is_empty(), "carried runtime scripts: {junk:?}");
    }

    #[test]
    fn the_carried_rules_are_read_only_material() {
        let files = carried();
        let shebanged = files
            .iter()
            .filter(|(_, bytes)| bytes.starts_with(b"#!"))
            .count();
        assert_eq!(
            shebanged, 0,
            "read-only rules unexpectedly contain executables"
        );
    }

    #[test]
    fn executable_gates_are_not_looked_for_on_disk() {
        assert!(crate::doing::is_ours("doing"));
        assert!(!crate::doing::is_ours("board-gate.py"));
    }

    #[test]
    fn a_gate_name_that_is_really_a_path_is_refused() {
        // The name reaches us out of a settings file. One holding `../` would
        // run whatever it liked.
        assert!(hook("../thing.py", &[]).is_err());
        assert!(hook("hooks/board-gate.py", &[]).is_err());
        assert!(hook("", &[]).is_err());
    }
}
