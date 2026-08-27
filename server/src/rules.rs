//! The working rules the product carries: the board tools, the session gates,
//! and the workers and skills a session reads.
//!
//! Three things had to be true at once for a teammate to get a working project
//! out of one install. The rules had to travel inside the binary, because a
//! machine that has never held this repository has nowhere to read them from.
//! They had to land in a shape the rules themselves already understand — `join`
//! and `project.py` work out where they live from their own file's path, and
//! the craft has to sit in a `.claude/` one level above the machinery, because
//! that is the one place Claude Code looks. And the gates a project ends up
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
use std::process::Command;

/// The board tools and the session gates, as they sit in the repository.
///
/// `projects.toml` and declarations live in personal Atelier data and are never
/// carried: shipping the maintainer's copies would point a teammate at folders
/// and project policy that do not belong to their machine.
#[derive(Embed)]
#[folder = "../machinery/"]
#[exclude = "projects.toml"]
#[exclude = "__pycache__/*"]
#[exclude = "*/__pycache__/*"]
#[exclude = "**/__pycache__/**"]
#[exclude = "**/*.pyc"]
struct Machinery;

/// The workers, skills, commands and house voice a session reads.
///
/// `settings.json` stays behind. It is the wiring of one project — which gates
/// run on which tool — and `join` writes each project its own, merged into
/// whatever that project already had.
#[derive(Embed)]
#[folder = "../.claude/"]
#[exclude = "settings.json"]
#[exclude = "settings.local.json"]
#[exclude = "RESUME.md"]
#[exclude = "**/__pycache__/**"]
#[exclude = "**/*.pyc"]
struct Craft;

/// Where the machinery lands under the rules folder.
///
/// `project.py` reads its own file's path to find the registry beside it and
/// `join` reads its own to find the gates, so this name is part of the
/// contract and not a label.
pub const MACHINERY: &str = "machinery";

/// And where the craft lands: one level above the machinery, never inside it,
/// because Claude Code reads a checkout's `.claude/` and nowhere else.
pub const CRAFT: &str = ".claude";

/// The word `join` writes into a project's gates instead of a path, when this
/// program is the one running it.
const GATE_WORD: &str = "ATELIER_GATE_WORD";

/// Lay the rules down beside the data, and say where they went.
pub fn install() -> Result<PathBuf, String> {
    let Some(dir) = crate::identity::rules_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
    };
    let mut files = crate::laid_down::gather::<Machinery>(MACHINERY)?;
    files.extend(crate::laid_down::gather::<Craft>(CRAFT)?);
    crate::laid_down::install(&dir, &files)?;
    runnable(&dir, &files);
    Ok(dir)
}

/// Give back the execute bit to everything that is meant to be typed.
///
/// What travels in the binary is bytes and nothing else — a file's mode is not
/// carried — so `machinery/board/job` arrives unrunnable and the board tools
/// the gates tell a reader to type answer "permission denied". Anything opening
/// with a shebang is something somebody runs, which is the whole rule.
#[cfg(unix)]
fn runnable(dir: &Path, files: &crate::laid_down::Carried) {
    use std::os::unix::fs::PermissionsExt;
    for (name, bytes) in files {
        if !bytes.starts_with(b"#!") {
            continue;
        }
        let dest = dir.join(name);
        if let Ok(held) = std::fs::metadata(&dest) {
            let mut mode = held.permissions();
            if mode.mode() & 0o111 == 0o111 {
                continue;
            }
            mode.set_mode(0o755);
            let _ = std::fs::set_permissions(&dest, mode);
        }
    }
}

/// Windows runs a script by its extension, so there is no bit to give back.
#[cfg(not(unix))]
fn runnable(_dir: &Path, _files: &crate::laid_down::Carried) {}

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

/// Install personal skills and conditional provider hooks without joining a repository.
/// Service installation calls this once for the whole computer; init calls the
/// same path so machines that do not use a login service still receive it.
pub fn install_personal() -> Result<i32, String> {
    let dir = install()?;
    let join = dir.join(MACHINERY).join("join");
    run_python(
        &[join.display().to_string(), "--personal".to_string()],
        &[(GATE_WORD, crate::identity::NAME)],
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Beads,
    Chat,
}

fn init_with(
    rest: &[String],
    input: &mut dyn BufRead,
    output: &mut dyn Write,
) -> Result<i32, String> {
    let dir = install()?;
    let mut said: Vec<String> = Vec::new();
    let mut where_ = None;
    let mut chosen = None;
    for word in rest {
        if word == "--beads" {
            if chosen.replace(Mode::Beads) == Some(Mode::Chat) {
                return Err("`--beads` and `--chat` cannot be used together".to_string());
            }
        } else if word == "--chat" {
            if chosen.replace(Mode::Chat) == Some(Mode::Beads) {
                return Err("`--beads` and `--chat` cannot be used together".to_string());
            }
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

    let join = join_for(&root, &dir);
    run_python(
        &[join.display().to_string(), "--personal".to_string()],
        &[(GATE_WORD, crate::identity::NAME)],
    )?;
    let mode = match chosen {
        Some(mode) => mode,
        None => {
            let current = mode_from(&join, &root)?;
            ask_for_mode(input, output, current == Mode::Beads)?
        }
    };
    if mode == Mode::Chat {
        return run_python(
            &[
                join.display().to_string(),
                "--chat-only".to_string(),
                root.display().to_string(),
            ],
            &[],
        );
    }

    // Only a Beads project belongs on the board screen. Creating its list is
    // deliberately below the choice so chat-only setup changes no project or
    // project-list state.
    if let Err(e) = crate::db::Database::new() {
        eprintln!("the board screen's list of projects could not be opened: {e}");
    }

    // A project that ships the machinery itself is joined by its own copy, and
    // told nothing about the word. That is this repository and the one other
    // project working on the rules: joining either through the installed copy
    // would move it onto whatever version happens to be installed, which is
    // the one thing somebody editing the rules must not have happen to them.
    let mine = root.join(MACHINERY).join("join");
    let word: &[(&str, &str)] = match mine.is_file() {
        true => &[],
        // Named rather than pathed: what `join` writes into the project is a
        // word every machine has, so the file it writes can be committed.
        false => &[(GATE_WORD, crate::identity::NAME)],
    };
    let mut args: Vec<String> = vec![join.display().to_string(), root.display().to_string()];
    args.extend(said);
    run_python(&args, word)
}

fn join_for(root: &Path, dir: &Path) -> PathBuf {
    let mine = root.join(MACHINERY).join("join");
    if mine.is_file() {
        mine
    } else {
        dir.join(MACHINERY).join("join")
    }
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

fn mode_from(join: &Path, root: &Path) -> Result<Mode, String> {
    let said = run_python_output(&[
        join.display().to_string(),
        "--mode".to_string(),
        root.display().to_string(),
    ])?;
    match said.trim() {
        "beads" => Ok(Mode::Beads),
        "chat" => Ok(Mode::Chat),
        other => Err(format!(
            "Atelier could not determine this project's mode: {other}"
        )),
    }
}

pub fn project_mode(rest: &[String]) -> Result<String, String> {
    if rest.len() > 1 {
        return Err("`atelier project mode` accepts at most one folder".to_string());
    }
    let root = std::fs::canonicalize(rest.first().cloned().unwrap_or_else(|| ".".to_string()))
        .map_err(|e| format!("that folder cannot be read: {e}"))?;
    let dir = install()?;
    let join = join_for(&root, &dir);
    Ok(match mode_from(&join, &root)? {
        Mode::Beads => "beads",
        Mode::Chat => "chat",
    }
    .into())
}

fn run_python_output(args: &[String]) -> Result<String, String> {
    let mut refused = None;
    for word in ["python3", "python"] {
        match Command::new(word).args(args).output() {
            Ok(out) if out.status.success() => {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            }
            Ok(out) => return Err(String::from_utf8_lossy(&out.stderr).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => refused = Some(e),
            Err(e) => return Err(format!("{word}: {e}")),
        }
    }
    Err(format!(
        "this computer has no python on its path ({})",
        refused.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Run one session gate by name, on behalf of a project wired to a word.
///
/// A gate that is not here stands down rather than refusing: a copy whose rules
/// failed to land must not be a copy that cannot finish a turn.
pub fn hook(name: &str, rest: &[String]) -> Result<i32, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("`{name}` is not the name of a gate"));
    }
    // One gate the program answers to itself. Everything else here is a
    // script laid down beside the data and run with the reader's own python;
    // this one has to work on a computer that has no python at all, which is
    // most of the computers this ships to (bw-14ij.1).
    if crate::doing::is_ours(name) {
        return Ok(crate::doing::run());
    }
    let mut looked = Vec::new();
    let mut found = None;
    for place in gate_places(name) {
        if place.is_file() {
            found = Some(place);
            break;
        }
        looked.push(place);
    }
    let Some(gate) = found else {
        eprintln!(
            "{}: no gate called `{name}` — looked in {}",
            crate::identity::NAME,
            looked
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        return Ok(0);
    };
    let mut args = vec![gate.display().to_string()];
    args.extend(rest.iter().cloned());
    run_python(&args, &[])
}

/// Run one deliberately public workflow command from the installed rules.
///
/// The allowlist is the contract written into initialized projects. Accepting
/// an arbitrary relative path here would turn a documentation convenience into
/// a general script runner over application data.
pub fn tool(name: &str, rest: &[String]) -> Result<i32, String> {
    let dir = crate::identity::rules_dir()
        .ok_or_else(|| "this computer names no folder for Atelier's working rules".to_string())?;
    let script = tool_path(name, &dir)?;
    if !script.is_file() {
        return Err(format!(
            "the installed workflow tool is missing: {}",
            script.display()
        ));
    }
    let mut args = vec![script.display().to_string()];
    args.extend(rest.iter().cloned());
    run_python(&args, &[])
}

fn tool_path(name: &str, dir: &Path) -> Result<PathBuf, String> {
    let relative = match name {
        "board/job" => Path::new("board").join("job"),
        "board/land" => Path::new("board").join("land"),
        "checks" => PathBuf::from("checks"),
        _ => return Err(format!("`{name}` is not an Atelier workflow tool")),
    };
    Ok(dir.join(MACHINERY).join(relative))
}

fn gate_places(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = crate::identity::rules_dir() {
        out.push(dir.join(MACHINERY).join("hooks").join(name));
    }
    out
}

/// Run python with these arguments, standard input and all, and give back what
/// it exited with.
///
/// Python is the reader's own program, the same posture the chat helper takes
/// with node: a version pinned here would be a second python on their machine
/// to keep up to date. Both spellings are tried, because the one on a Windows
/// path is usually the shorter.
fn run_python(args: &[String], env: &[(&str, &str)]) -> Result<i32, String> {
    let mut refused = None;
    for word in ["python3", "python"] {
        let mut cmd = Command::new(word);
        cmd.args(args);
        for (name, value) in env {
            cmd.env(name, value);
        }
        match cmd.status() {
            Ok(status) => return Ok(status.code().unwrap_or(1)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => refused = Some(e),
            Err(e) => return Err(format!("{word}: {e}")),
        }
    }
    Err(format!(
        "this computer has no python3 on its path, and the working rules are written in it ({})",
        refused.map(|e| e.to_string()).unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn carried() -> crate::laid_down::Carried {
        let mut files = crate::laid_down::gather::<Machinery>(MACHINERY).unwrap();
        files.extend(crate::laid_down::gather::<Craft>(CRAFT).unwrap());
        files
    }

    #[test]
    fn the_rules_travel_in_the_binary() {
        let files = carried();
        for want in [
            "machinery/join",
            "machinery/project.py",
            "machinery/hooks/board-gate.py",
            "machinery/board/job",
            "machinery/skills/atelier/SKILL.md",
            "machinery/skills/beads/SKILL.md",
            "machinery/hooks/session-context.py",
            ".claude/output-styles/manager.md",
        ] {
            assert!(
                files.iter().any(|(name, _)| name == want),
                "{want} is not carried"
            );
        }
    }

    #[test]
    fn the_craft_sits_beside_the_machinery_and_not_inside_it() {
        // Claude Code reads a checkout's `.claude/` and nowhere else, and
        // `join` finds it one level above its own file. Nesting it under the
        // machinery would leave every worker and skill unread.
        let files = carried();
        assert!(files.iter().any(|(name, _)| name.starts_with(".claude/")));
        assert!(!files
            .iter()
            .any(|(name, _)| name.contains("machinery/.claude")));
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
        // Provider hooks are installed personally, never copied into a project.
        let files = carried();
        assert!(!files
            .iter()
            .any(|(name, _)| name == ".claude/settings.json"));
    }

    #[test]
    fn nothing_pythons_own_cache_left_behind_is_carried() {
        let files = carried();
        let junk: Vec<&String> = files
            .iter()
            .map(|(name, _)| name)
            .filter(|name| name.contains("__pycache__") || name.ends_with(".pyc"))
            .collect();
        assert!(junk.is_empty(), "carried python's own cache: {junk:?}");
    }

    #[test]
    fn everything_a_reader_types_arrives_runnable() {
        // Only the bytes travel; a file's mode does not. Anything opening with
        // a shebang is something somebody runs.
        let files = carried();
        let shebanged = files
            .iter()
            .filter(|(_, bytes)| bytes.starts_with(b"#!"))
            .count();
        assert!(
            shebanged > 10,
            "only {shebanged} carried files open with a shebang"
        );
    }

    #[test]
    fn a_project_that_ships_the_rules_is_joined_by_its_own_copy() {
        // Somebody editing the rules runs this on the checkout they are editing.
        // Joining that through the installed copy would move it onto whatever
        // version is installed and quietly stop their edits being the ones
        // running.
        let root = std::env::current_dir()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(
            root.join(MACHINERY).join("join").is_file(),
            "{}",
            root.display()
        );
    }

    #[test]
    fn a_gate_is_looked_for_under_the_rules() {
        let places = gate_places("board-gate.py");
        assert!(!places.is_empty());
        assert!(places[0].to_string_lossy().contains("machinery"));
    }

    #[test]
    fn the_one_gate_the_program_answers_to_itself_is_not_looked_for_on_disk() {
        // It is the only one that has to run where there is no python, so it
        // cannot be a script under the rules folder like the others.
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

    #[test]
    fn only_the_workflow_tools_named_in_project_instructions_are_public() {
        let dir = Path::new("/installed/rules");
        assert_eq!(
            tool_path("board/job", dir).unwrap(),
            dir.join("machinery/board/job")
        );
        assert_eq!(
            tool_path("board/land", dir).unwrap(),
            dir.join("machinery/board/land")
        );
        assert_eq!(
            tool_path("checks", dir).unwrap(),
            dir.join("machinery/checks")
        );
        for name in ["../join", "hooks/board-gate.py", "board/review", ""] {
            assert!(tool_path(name, dir)
                .unwrap_err()
                .contains("not an Atelier workflow tool"));
        }
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
}
