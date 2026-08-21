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
//! the screens it serves and the chat helper behind them come up together
//! under one process tree, because they always did — the frontend is inside
//! the binary and the helper is started beside it. What `run` adds is a name
//! for that, and a browser pointed at the right port so the reader does not
//! have to know one.
//!
//! Parsing is by hand rather than with an argument library. There are five
//! things to say and a library would be a dependency, a build, and a help
//! screen written in somebody else's voice.

use crate::identity::DISPLAY;

/// What the reader asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    /// Bring the whole thing up.
    Run { open_browser: bool },
    /// Print where this computer keeps the data, and nothing else.
    DataDir,
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
        return Ask::Run { open_browser: false };
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
  atelier run                 Start everything and open the board in your browser
  atelier run --no-browser    The same, without opening a browser
  atelier                     The same as `run --no-browser`
  atelier --data-dir          Print where this computer keeps {DISPLAY}'s data
  atelier --version           Print which build this is
  atelier --help              This

There is nothing else to start. The screens live inside this program and the
chat helper is started beside it, so one command is the whole product.

Where it listens:
  ATELIER_PORT                the port (default {PORT})
  ATELIER_HOST                the address to bind (default 0.0.0.0)
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
        assert_eq!(ask(&["run", "--no-browser"]), Ask::Run { open_browser: false });
    }

    #[test]
    fn started_with_nothing_it_still_serves_and_opens_no_window() {
        // Every launcher, script and test that already starts this binary
        // passes no arguments at all. Changing what that means would break
        // all of them at once.
        assert_eq!(ask(&[]), Ask::Run { open_browser: false });
    }

    #[test]
    fn the_data_directory_question_is_still_answerable() {
        // The report tools run from a shell and ask the program where the
        // data is rather than working the per-platform paths out again.
        assert_eq!(ask(&["--data-dir"]), Ask::DataDir);
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
        assert_eq!(ask(&["run", "--headless"]), Ask::Unknown("--headless".to_string()));
    }

    #[test]
    fn the_help_screen_names_run_among_the_things_it_can_do() {
        let help = help();
        assert!(help.contains("atelier run"), "run is not offered:\n{help}");
        assert!(help.contains("--data-dir"), "--data-dir is not offered:\n{help}");
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
    fn the_help_screen_says_there_is_no_second_thing_to_start() {
        assert!(
            help().contains("nothing else to start"),
            "the help screen does not say the frontend needs no separate process"
        );
    }
}
