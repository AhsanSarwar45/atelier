//! What a person types, and what it means.
//!
//! Before this there was no command line at all: the program looked at one
//! argument, `--data-dir`, and started the server for literally everything
//! else — a typo, a flag meant for something else, a word the reader had
//! guessed at. There was nothing to ask what the program could do, so the
//! answer to "how do I start it" lived in a README on a website rather than in
//! the thing itself (bw-8um.3.12).
//!
//! The shape is deliberately small. `run` is the whole product: the server,
//! the screens it serves and native chat services come up together
//! under one process, because the frontend and provider protocols are inside
//! the binary. What `run` adds is a name
//! for that, and a browser pointed at the right port so the reader does not
//! have to know one.
//!
//! Parsing is by hand rather than with an argument library. There are five
//! things to say and a library would be a dependency, a build, and a help
//! screen written in somebody else's voice.

use crate::identity::DISPLAY;
use crate::service::Action;

/// What the reader asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    /// Bring the whole thing up.
    Run { open_browser: bool },
    /// Have the computer start it, stop having it, or ask which it is.
    Service(Action),
    /// Print the addresses it can be opened at, and start nothing.
    Where,
    /// Print where this computer keeps the data, and nothing else.
    DataDir,
    /// Print each outside program the app starts and whether it is here.
    Tools,
    /// Set a project up: lay the working rules down and wire that project to
    /// them. The words after it are passed to the rules' own joining tool.
    Init(Vec<String>),
    /// Say whether Beads is enabled for a folder.
    ProjectBeads(Vec<String>),
    /// Run one session gate by name, on behalf of a project whose settings
    /// name a word rather than a path.
    Hook { name: String, rest: Vec<String> },
    /// Run one public workflow tool from the machinery bundled with this
    /// installed application.
    Tool { name: String, rest: Vec<String> },
    /// Print what the program can do.
    Help,
    /// Print which build this is.
    Version,
    /// Something the program has no meaning for, kept so it can be named back.
    Unknown(String),
}

/// The default port, written down once so the help screen and the server
/// cannot disagree about which one to tell the reader to open.
pub const PORT: u16 = 3008;

/// Read the arguments, without the program's own name.
///
/// Bare — no arguments — is `run` with the browser left alone. That is what
/// the program has always done when started with nothing, and a service
/// manager or a test harness that starts it must not have a browser window
/// open on top of whatever the machine was doing.
pub fn asked<I: IntoIterator<Item = String>>(args: I) -> Ask {
    let args: Vec<String> = args.into_iter().collect();
    let Some(first) = args.first() else {
        return Ask::Run {
            open_browser: false,
        };
    };

    match first.as_str() {
        "run" => {
            let mut open_browser = true;
            for rest in &args[1..] {
                match rest.as_str() {
                    "--no-browser" => open_browser = false,
                    other => return Ask::Unknown(other.to_string()),
                }
            }
            Ask::Run { open_browser }
        }
        "service" => match args.get(1).map(String::as_str) {
            // Asking is what a bare `service` means: it is the only one of the
            // three that changes nothing, so it is the safe thing to do when
            // the reader has not finished the sentence.
            None | Some("status") => Ask::Service(Action::Status),
            Some("install") => Ask::Service(Action::Install),
            Some("uninstall") | Some("remove") => Ask::Service(Action::Uninstall),
            Some(other) => Ask::Unknown(other.to_string()),
        },
        // Everything after the word goes to the joining tool untouched, so
        // its flags do not have to be listed in two places to keep working.
        "init" => Ask::Init(args[1..].to_vec()),
        "project" if args.get(1).map(String::as_str) == Some("beads") => {
            Ask::ProjectBeads(args[2..].to_vec())
        }
        // Not for typing. It is what a project's own settings file names, so
        // the gates it runs are a word every machine has instead of one
        // person's home folder (bw-8um.3.3).
        "hook" => match args.get(1) {
            Some(name) => Ask::Hook {
                name: name.clone(),
                rest: args[2..].to_vec(),
            },
            None => Ask::Unknown("hook".to_string()),
        },
        "tool" => match args.get(1) {
            Some(name) => Ask::Tool {
                name: name.clone(),
                rest: args[2..].to_vec(),
            },
            None => Ask::Unknown("tool".to_string()),
        },
        "where" => Ask::Where,
        // "What do I have to install?" had only ever been answerable by
        // reading our own code. This is the answer, from the same lookup the
        // server itself starts things with (bw-dwxw).
        "tools" => Ask::Tools,
        "--data-dir" => Ask::DataDir,
        "--help" | "-h" | "help" => Ask::Help,
        "--version" | "-V" | "version" => Ask::Version,
        other => Ask::Unknown(other.to_string()),
    }
}

/// What the program can do, in the words a person would use to ask for it.
pub fn help() -> String {
    format!(
        "\
{DISPLAY} — the board, the screens and the chat, in one program.

Usage:
  atelier run                 Start Atelier and open it
  atelier run --no-browser    Start without opening a browser
  atelier                     Same as `run --no-browser`
  atelier init [folder]       Configure a project
  atelier project beads [folder]
                              Print whether Beads is enabled for this folder
  atelier tool <name> [...]   Run an Atelier tool
  atelier where               Show app addresses
  atelier tools               Show dependencies
  atelier service install     Start at login
  atelier service uninstall   Disable start at login
  atelier service status      Show service status
  atelier --data-dir          Show the data directory
  atelier --version           Show the version
  atelier --help              Show help

`atelier run` starts the app and chat service.

`init` asks whether the project uses Beads. Use `--beads` or `--chat` to skip
that question. Run `atelier tools` to check Beads dependencies.

Environment:
  ATELIER_PORT                Port (default {PORT})
  ATELIER_HOST                Host (default 0.0.0.0; use 127.0.0.1 for local only)

Use `atelier where` to show available addresses.
"
    )
}

/// Which build this is.
pub fn version() -> String {
    format!("{DISPLAY} {}", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(words: &[&str]) -> Ask {
        asked(words.iter().map(|w| w.to_string()))
    }

    #[test]
    fn run_is_the_one_command_that_brings_everything_up() {
        assert_eq!(ask(&["run"]), Ask::Run { open_browser: true });
    }

    #[test]
    fn run_can_be_told_to_leave_the_browser_alone() {
        // What a service manager starts, and what the proof scripts start.
        assert_eq!(
            ask(&["run", "--no-browser"]),
            Ask::Run {
                open_browser: false
            }
        );
    }

    #[test]
    fn started_with_nothing_it_still_serves_and_opens_no_window() {
        // Every launcher, script and test that already starts this binary
        // passes no arguments at all. Changing what that means would break
        // all of them at once.
        assert_eq!(
            ask(&[]),
            Ask::Run {
                open_browser: false
            }
        );
    }

    #[test]
    fn a_running_copy_can_be_asked_where_it_is() {
        // The computer starts it at login and prints its lines into a log
        // nobody reads. Asking has to be a thing a person can type.
        assert_eq!(ask(&["where"]), Ask::Where);
    }

    #[test]
    fn the_data_directory_question_is_still_answerable() {
        // Helpers can ask the program where the data is rather than working
        // the per-platform paths out again.
        assert_eq!(ask(&["--data-dir"]), Ask::DataDir);
    }

    #[test]
    fn setting_a_project_up_is_one_word_and_a_folder() {
        assert_eq!(ask(&["init"]), Ask::Init(vec![]));
        assert_eq!(ask(&["init", "."]), Ask::Init(vec![".".to_string()]));
    }

    #[test]
    fn project_beads_is_a_read_only_question_with_an_optional_folder() {
        assert_eq!(ask(&["project", "beads"]), Ask::ProjectBeads(vec![]));
        assert_eq!(
            ask(&["project", "beads", "."]),
            Ask::ProjectBeads(vec![".".into()])
        );
    }

    #[test]
    fn the_joining_tools_own_flags_reach_it_untouched() {
        // Listing them here would be a second help screen to keep in step
        // with the first, and it would go stale on the next flag.
        assert_eq!(
            ask(&["init", "--forward", "/somewhere"]),
            Ask::Init(vec!["--forward".to_string(), "/somewhere".to_string()])
        );
    }

    #[test]
    fn a_gate_is_run_by_name_and_carries_its_own_words() {
        assert_eq!(
            ask(&["hook", "board-gate.py", "--why"]),
            Ask::Hook {
                name: "board-gate.py".to_string(),
                rest: vec!["--why".to_string()]
            }
        );
    }

    #[test]
    fn a_gate_with_no_name_is_not_a_gate() {
        // A settings file that lost the name would otherwise run the server.
        assert_eq!(ask(&["hook"]), Ask::Unknown("hook".to_string()));
    }

    #[test]
    fn a_bundled_workflow_tool_carries_its_arguments_untouched() {
        assert_eq!(
            ask(&["tool", "board/job", "under", "bw-one"]),
            Ask::Tool {
                name: "board/job".to_string(),
                rest: vec!["under".to_string(), "bw-one".to_string()]
            }
        );
    }

    #[test]
    fn a_tool_with_no_name_is_not_a_request_to_start_the_server() {
        assert_eq!(ask(&["tool"]), Ask::Unknown("tool".to_string()));
    }

    #[test]
    fn the_help_screen_names_setting_a_project_up() {
        // The one command a teammate needs after installing, so it cannot be
        // a thing they have to be told about out of band.
        assert!(help().contains("atelier init"));
    }

    #[test]
    fn help_answers_to_all_three_spellings_a_person_tries() {
        assert_eq!(ask(&["--help"]), Ask::Help);
        assert_eq!(ask(&["-h"]), Ask::Help);
        assert_eq!(ask(&["help"]), Ask::Help);
    }

    #[test]
    fn version_answers_to_all_three_spellings_a_person_tries() {
        assert_eq!(ask(&["--version"]), Ask::Version);
        assert_eq!(ask(&["-V"]), Ask::Version);
        assert_eq!(ask(&["version"]), Ask::Version);
    }

    #[test]
    fn a_word_the_program_has_no_meaning_for_is_named_back() {
        // It used to start the server, so a mistyped flag looked like it had
        // been taken and quietly wasn't.
        assert_eq!(ask(&["srve"]), Ask::Unknown("srve".to_string()));
        assert_eq!(ask(&["--port", "3010"]), Ask::Unknown("--port".to_string()));
        assert_eq!(
            ask(&["run", "--headless"]),
            Ask::Unknown("--headless".to_string())
        );
    }

    #[test]
    fn the_computer_can_be_asked_to_start_it_and_to_stop_starting_it() {
        assert_eq!(ask(&["service", "install"]), Ask::Service(Action::Install));
        assert_eq!(
            ask(&["service", "uninstall"]),
            Ask::Service(Action::Uninstall)
        );
        assert_eq!(ask(&["service", "remove"]), Ask::Service(Action::Uninstall));
        assert_eq!(ask(&["service", "status"]), Ask::Service(Action::Status));
    }

    #[test]
    fn a_half_finished_service_sentence_changes_nothing() {
        // Asking is the only one of the three that touches nothing, so it is
        // what a reader who stopped mid-sentence gets.
        assert_eq!(ask(&["service"]), Ask::Service(Action::Status));
        assert_eq!(
            ask(&["service", "instal"]),
            Ask::Unknown("instal".to_string())
        );
    }

    #[test]
    fn the_help_screen_names_run_among_the_things_it_can_do() {
        let help = help();
        assert!(help.contains("atelier run"), "run is not offered:\n{help}");
        assert!(
            help.contains("atelier where"),
            "where is not offered:\n{help}"
        );
        assert!(
            help.contains("--data-dir"),
            "--data-dir is not offered:\n{help}"
        );
        assert!(
            help.contains("service install"),
            "service install is not offered:\n{help}"
        );
        assert!(
            help.contains("service uninstall"),
            "service uninstall is not offered:\n{help}"
        );
    }

    #[test]
    fn the_help_screen_tells_the_reader_the_port_the_server_really_binds() {
        // The reader is told to open a port by a sentence, and binds one by
        // code. One constant so the two cannot drift.
        assert!(
            help().contains(&PORT.to_string()),
            "the help screen does not name the default port"
        );
    }

    #[test]
    fn the_help_screen_says_run_starts_both_services() {
        assert!(
            help().contains("`atelier run` starts the app and chat service"),
            "the help screen does not describe what run starts"
        );
    }
}
