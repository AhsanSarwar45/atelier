//! The working rules the product carries: the board tools, the session gates,
//! and the internal workers and skills a session reads.
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

/// The board tools and the session gates, as they sit in the repository.
///
/// `projects.toml` and declarations live in personal Atelier data and are never
/// carried: shipping the maintainer's copies would point a teammate at folders
/// and project policy that do not belong to their machine.
#[derive(Embed)]
#[folder = "../machinery/"]
#[include = "README.md"]
#[include = "project.example.toml"]
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
    "machinery/hooks/picture-gate.py",
    "machinery/hooks/agent-fence.py",
    "machinery/hooks/session-context.py",
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
    ] {
        let _ = std::fs::remove_dir(dir.join(relative));
    }
    Ok(())
}

/// Lay the rules down beside the data, and say where they went.
pub fn install() -> Result<PathBuf, String> {
    let Some(dir) = crate::identity::rules_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Beads,
    Chat,
}

/// What setup should do about Beads, before anything has been written.
#[derive(Debug, PartialEq, Eq)]
enum Decision {
    /// The mode is already known — a flag said it, or the question can be put.
    Settled(Mode),
    /// Put the question to the reader.
    Ask,
    /// Chat, because this computer has no `bd`; the note says so out loud.
    ChatWithoutBd(String),
    /// Set nothing up, and say why.
    Refuse(String),
}

/// Whether to ask about Beads, and what to do when this computer has no `bd`.
///
/// A computer with no `bd` is not asked about Beads: the question had one
/// answer it could honour, and asking it anyway ended in `bd init` failing
/// *after* the manifest had been written — a project recorded as a board with
/// no board behind it. What a stranger's machine cannot do, it is told rather
/// than offered.
///
/// Silence is not consent to lose a board, either. A project already set up
/// for Beads keeps its setting and hears why nothing changed, rather than
/// being quietly rewritten to chat because a tool went missing (bw-3tkl.2).
fn decide_mode(
    chosen: Option<Mode>,
    beads_available: bool,
    uses_beads: bool,
    display_name: &str,
) -> Decision {
    match chosen {
        Some(Mode::Beads) if !beads_available => {
            Decision::Refuse(crate::routes::BD_MISSING.to_string())
        }
        Some(mode) => Decision::Settled(mode),
        None if beads_available => Decision::Ask,
        None if uses_beads => Decision::Refuse(format!(
            "{display_name} already uses Beads, and this computer has no bd to read it with. {}",
            crate::routes::BD_MISSING
        )),
        None => Decision::ChatWithoutBd(
            "No bd on this computer, so this project is set up for chat.".to_string(),
        ),
    }
}

fn init_with(
    rest: &[String],
    input: &mut dyn BufRead,
    output: &mut dyn Write,
) -> Result<i32, String> {
    let _dir = install()?;
    let mut said: Vec<String> = Vec::new();
    let mut where_ = None;
    let mut chosen = None;
    let mut storage = None;
    let mut chosen_name = None;
    let mut chosen_prefix = None;
    let mut chosen_branch = None;
    let mut agent_merges = None;
    for word in rest {
        if word == "--beads" {
            if chosen.replace(Mode::Beads) == Some(Mode::Chat) {
                return Err("`--beads` and `--chat` cannot be used together".to_string());
            }
        } else if word == "--chat" {
            if chosen.replace(Mode::Chat) == Some(Mode::Beads) {
                return Err("`--beads` and `--chat` cannot be used together".to_string());
            }
        } else if word == "--repository-config" {
            storage = Some(crate::project_manifest::ManifestStorage::Repository);
        } else if word == "--personal-config" {
            storage = Some(crate::project_manifest::ManifestStorage::Personal);
        } else if word == "--agent-merges" {
            agent_merges = Some(true);
        } else if word == "--manager-merges" {
            agent_merges = Some(false);
        } else if let Some(value) = word.strip_prefix("--name=") {
            chosen_name = Some(value.to_string());
        } else if let Some(value) = word.strip_prefix("--prefix=") {
            chosen_prefix = Some(value.to_string());
        } else if let Some(value) = word.strip_prefix("--completed-work-branch=") {
            chosen_branch = Some(value.to_string());
        } else if word.starts_with('-') {
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
        .ok_or_else(|| "this computer names no folder for Atelier's data".to_string())?;
    let existing = crate::project_manifest::locate(&root, &data_dir);
    let mut manifest = existing
        .as_ref()
        .map(|found| found.manifest.clone())
        .unwrap_or_else(|| crate::project_manifest::infer(&root));
    let mode = match decide_mode(
        chosen,
        crate::routes::find_bd().is_some(),
        manifest.project.use_beads,
        &manifest.project.display_name,
    ) {
        Decision::Settled(mode) => mode,
        Decision::Refuse(why) => return Err(why),
        Decision::ChatWithoutBd(note) => {
            writeln!(output, "{note}")
                .map_err(|e| format!("the setup note could not be shown: {e}"))?;
            Mode::Chat
        }
        Decision::Ask => ask_for_mode(input, output, manifest.project.use_beads)?,
    };
    manifest.project.use_beads = mode == Mode::Beads;
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
    if mode == Mode::Beads {
        manifest.beads.issue_id_prefix = chosen_prefix.unwrap_or_else(|| {
            ask_with_default(
                input,
                output,
                "Issue ID prefix",
                &manifest.beads.issue_id_prefix,
            )
            .unwrap_or_else(|_| manifest.beads.issue_id_prefix.clone())
        });
        manifest.git.completed_work_branch = chosen_branch.unwrap_or_else(|| {
            ask_with_default(
                input,
                output,
                "Completed-work branch",
                &manifest.git.completed_work_branch,
            )
            .unwrap_or_else(|_| manifest.git.completed_work_branch.clone())
        });
        manifest.git.agents_may_merge_completed_work = agent_merges.unwrap_or_else(|| {
            ask_yes_no(
                input,
                output,
                "May agents merge completed work?",
                manifest.git.agents_may_merge_completed_work,
            )
            .unwrap_or(false)
        });
        if !crate::project_manifest::branch_exists(&root, &manifest.git.completed_work_branch) {
            return Err(format!(
                "Completed-work branch `{}` does not exist in this project",
                manifest.git.completed_work_branch
            ));
        }
    }
    writeln!(
        output,
        "\nProject settings: {} · {} · config: {:?}",
        manifest.project.display_name,
        if manifest.project.use_beads {
            "Beads enabled"
        } else {
            "Beads disabled"
        },
        storage
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
    if mode == Mode::Chat {
        crate::join::remove(&root)?;
        show_project(&root, &manifest)?;
        return Ok(0);
    }

    // Only a Beads project belongs on the board screen. Creating its list is
    // deliberately below the choice so chat-only setup changes no project or
    // project-list state.
    // A project that ships the machinery itself is joined by its own copy, and
    // told nothing about the word. That is this repository and the one other
    // project working on the rules: joining either through the installed copy
    // would move it onto whatever version happens to be installed, which is
    // the one thing somebody editing the rules must not have happen to them.
    if !said.is_empty() {
        eprintln!(
            "warning: obsolete join arguments ignored: {}",
            said.join(" ")
        );
    }
    crate::join::install(&root, &manifest)?;
    // Older copies wrote the doing gate into the reader's own global Claude
    // settings at every startup. It belongs to the project now, and was just
    // written there, so what those runs left behind goes (bw-t26l.20).
    match crate::doing::unwire_global() {
        Ok((taken, settings)) if taken > 0 => {
            writeln!(
                output,
                "Took {taken} old chat-status hook{} out of {} — they belong to the project now.",
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

fn ask_for_mode(
    input: &mut dyn BufRead,
    output: &mut dyn Write,
    default_beads: bool,
) -> Result<Mode, String> {
    loop {
        let hint = if default_beads { "Y/n" } else { "y/N" };
        write!(output, "Use Beads for this project? [{hint}]: ")
            .map_err(|e| format!("the setup question could not be shown: {e}"))?;
        output
            .flush()
            .map_err(|e| format!("the setup question could not be shown: {e}"))?;
        let mut answer = String::new();
        input
            .read_line(&mut answer)
            .map_err(|e| format!("the setup answer could not be read: {e}"))?;
        match answer.trim().to_ascii_lowercase().as_str() {
            "" => {
                return Ok(if default_beads {
                    Mode::Beads
                } else {
                    Mode::Chat
                })
            }
            "y" | "yes" => return Ok(Mode::Beads),
            "n" | "no" => return Ok(Mode::Chat),
            _ => writeln!(output, "Please answer yes or no.")
                .map_err(|e| format!("the setup question could not be shown: {e}"))?,
        }
    }
}

pub fn project_beads(rest: &[String]) -> Result<String, String> {
    if rest.len() > 1 {
        return Err("`atelier project beads` accepts at most one folder".to_string());
    }
    let root = std::fs::canonicalize(rest.first().cloned().unwrap_or_else(|| ".".to_string()))
        .map_err(|e| format!("that folder cannot be read: {e}"))?;
    let data_dir = crate::identity::data_dir()
        .ok_or_else(|| "this computer names no folder for Atelier's data".to_string())?;
    Ok(match crate::project_manifest::locate(&root, &data_dir) {
        Some(found) if found.manifest.project.use_beads => "enabled",
        _ => "disabled",
    }
    .into())
}

/// Run one session gate by name, on behalf of a project wired to a word.
///
/// A gate that is not here stands down rather than refusing: a copy whose rules
/// failed to land must not be a copy that cannot finish a turn.
///
/// The event is read once, here, so that every gate is offered the same
/// escape hatch before it runs. See `hook_bypass` for the four ways to say
/// "not this time" and why each of them exists.
pub fn hook(name: &str, rest: &[String]) -> Result<i32, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("`{name}` is not the name of a gate"));
    }
    if rest == ["--version"] && crate::lifecycle::is_ours(name) {
        println!("{}", crate::lifecycle::version());
        return Ok(0);
    }
    let mut heard = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut heard);
    let event: serde_json::Value =
        serde_json::from_str(&heard).unwrap_or(serde_json::Value::Object(Default::default()));
    if let Some(bypass) = crate::hook_bypass::asked(&event) {
        crate::hook_bypass::record(name, &bypass);
        return Ok(0);
    }
    // Every executable gate is native. Unknown legacy names stand down so a
    // stale settings file can never make an interpreter a runtime dependency.
    if crate::doing::is_ours(name) {
        return Ok(crate::doing::run(&heard));
    }
    if crate::completion_gate::is_ours(name) {
        return Ok(crate::completion_gate::run(&heard));
    }
    if crate::board_push::is_ours(name) {
        return Ok(crate::board_push::run(&event));
    }
    if crate::lifecycle::is_ours(name) {
        return Ok(crate::lifecycle::run(name, &event));
    }
    eprintln!(
        "{}: retired or unknown hook `{name}` stood down",
        crate::identity::NAME
    );
    let _ = rest;
    Ok(0)
}

/// Run one deliberately public workflow command from the installed rules.
///
/// The allowlist is the contract written into initialized projects. Accepting
/// an arbitrary relative path here would turn a documentation convenience into
/// a general script runner over application data.
pub async fn tool(name: &str, rest: &[String]) -> Result<i32, String> {
    if name == "present" {
        return crate::workbench::cli::present(rest).await;
    }
    if name == "screen-check" {
        return crate::workbench::cli::screen_check(rest).await;
    }
    if let Some(result) = crate::board_tools::run(name, rest) {
        return result;
    }
    Err(format!("`{name}` is not an Atelier workflow tool"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn carried() -> crate::laid_down::Carried {
        crate::laid_down::gather::<Machinery>(MACHINERY).unwrap()
    }

    #[test]
    fn the_rules_travel_in_the_binary() {
        let files = carried();
        for want in [
            "machinery/skills/atelier/SKILL.md",
            "machinery/skills/beads/SKILL.md",
            "machinery/workers/external-review.md",
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
        assert!(crate::lifecycle::is_ours("board-gate.py"));
    }

    #[test]
    fn a_gate_name_that_is_really_a_path_is_refused() {
        // The name reaches us out of a settings file. One holding `../` would
        // run whatever it liked.
        assert!(hook("../thing.py", &[]).is_err());
        assert!(hook("hooks/board-gate.py", &[]).is_err());
        assert!(hook("", &[]).is_err());
    }

    #[test]
    fn a_new_project_defaults_to_chat_and_an_existing_registration_defaults_to_beads() {
        let mut shown = Vec::new();
        assert_eq!(
            ask_for_mode(&mut Cursor::new("\n"), &mut shown, false).unwrap(),
            Mode::Chat
        );
        shown.clear();
        assert_eq!(
            ask_for_mode(&mut Cursor::new("\n"), &mut shown, true).unwrap(),
            Mode::Beads
        );
        assert!(String::from_utf8(shown).unwrap().contains("[Y/n]"));
    }

    #[test]
    fn the_interactive_choice_accepts_words_and_reasks_after_a_typo() {
        let mut shown = Vec::new();
        assert_eq!(
            ask_for_mode(&mut Cursor::new("perhaps\nno\n"), &mut shown, true).unwrap(),
            Mode::Chat
        );
        assert!(String::from_utf8(shown)
            .unwrap()
            .contains("Please answer yes or no."));
    }

    /// A computer with `bd` still gets the question, both ways round.
    #[test]
    fn asks_about_beads_when_bd_is_here() {
        assert_eq!(decide_mode(None, true, false, "Sample"), Decision::Ask);
        assert_eq!(decide_mode(None, true, true, "Sample"), Decision::Ask);
    }

    /// A flag still decides, so a script that says `--chat` is not re-asked.
    #[test]
    fn a_flag_settles_it() {
        assert_eq!(decide_mode(Some(Mode::Chat), true, false, "Sample"), Decision::Settled(Mode::Chat));
        assert_eq!(decide_mode(Some(Mode::Beads), true, false, "Sample"), Decision::Settled(Mode::Beads));
        // Chat needs no bd, so a computer without one can still be told chat.
        assert_eq!(decide_mode(Some(Mode::Chat), false, false, "Sample"), Decision::Settled(Mode::Chat));
    }

    /// No bd, no question — and the reason is said rather than left to a
    /// failure further down (bw-3tkl.2).
    #[test]
    fn a_new_project_without_bd_is_never_asked_about_beads() {
        let decision = decide_mode(None, false, false, "Sample");
        let Decision::ChatWithoutBd(note) = decision else {
            panic!("expected chat, got {decision:?}");
        };
        assert!(note.to_lowercase().contains("no bd"), "{note}");
        assert!(!note.contains('?'), "the note is not a question: {note}");
    }

    /// `--beads` on a computer with no bd is refused before anything is
    /// written, and the refusal says where to get bd.
    #[test]
    fn asking_for_beads_without_bd_is_refused_up_front() {
        assert_eq!(
            decide_mode(Some(Mode::Beads), false, false, "Sample"),
            Decision::Refuse(crate::routes::BD_MISSING.to_string())
        );
    }

    /// A board already set up is not quietly taken away because bd went
    /// missing: setup refuses rather than rewriting the project to chat.
    #[test]
    fn a_beads_project_is_not_downgraded_when_bd_goes_missing() {
        let decision = decide_mode(None, false, true, "Sample");
        let Decision::Refuse(why) = decision else {
            panic!("expected a refusal, got {decision:?}");
        };
        assert!(why.contains("Sample"), "{why}");
        assert!(why.contains("already uses Beads"), "{why}");
        assert!(why.contains("bd CLI not found"), "{why}");
    }
}
