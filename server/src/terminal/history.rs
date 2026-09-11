//! What has been typed at this computer's shell before now.
//!
//! The terminal in the app is a real shell, so up-arrow already walks the
//! history the shell itself keeps and nothing here is needed to make that work.
//! This is the other way in: a list you can search and pick from, for the
//! command you ran last week and remember three words of.
//!
//! ## Why the file and not the shell
//!
//! A running shell will not tell anyone what is in its history. There is no
//! signal for it and no socket; the only way to ask is to type `history` at it,
//! and typing at somebody's shell to answer a question they did not ask is not
//! something this app is going to do — it would land in the middle of a half
//! written command, and it would go into that shell's own history besides. So
//! the file each shell keeps is read directly, which has the further advantage
//! of being the same list whether a terminal is open in the app or not.
//!
//! The cost is honest and worth stating: the file is what the shell has
//! *written*, and a shell writes on its way out. Lines typed into a shell that
//! is still open are not in it yet. That is the same thing that is true of a
//! second Konsole window, so it is at least a familiar kind of wrong.
//!
//! ## Three formats, because there are three shells
//!
//! `bash` writes one line per command, with `#<seconds>` lines in between when
//! `HISTTIMEFORMAT` is set. `zsh` writes `: <seconds>:<elapsed>;<command>` when
//! extended history is on and a plain line when it is not, and continues a
//! command over a newline with a trailing backslash. `fish` writes a small
//! subset of YAML. Each is read by the reader for the shell that wrote it, and
//! a shell nothing here recognises is answered with an empty list rather than
//! with a guess: a wrong parse puts half a command on somebody's prompt, and
//! half a command is worse than none.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// How many commands are handed to the browser at most.
///
/// The list is searched in the browser rather than here, so this is the whole
/// of what can be found — but it is the most recent whole of it, and a history
/// file long enough to be cut by this holds years. Picked to be far more than
/// anyone scrolls and far less than a file that would take a moment to send.
const AT_MOST: usize = 5_000;

/// One command as the panel needs it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Ran {
    /// The command, exactly as it was typed.
    pub command: String,
    /// When it was run, in seconds since the epoch, when the file says. `bash`
    /// only records it if the person asked for it, so this is absent far more
    /// often than it is present and the panel must read without it.
    pub at: Option<i64>,
}

/// Which of the three a path is, by the name at the end of it.
///
/// By name rather than by asking the program, because asking means running it,
/// and the whole point of reading a file is not to start anything. The names
/// are matched with any version suffix removed — a person whose login shell is
/// `bash5` or `zsh-5.9` is running bash and zsh.
fn family(shell: &Path) -> Option<&'static str> {
    let name = shell.file_name()?.to_str()?;
    let stem = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-');
    match stem {
        // `sh` is bash's history format wherever `sh` is bash, and where it is
        // not, `sh` keeps no history at all and the file simply will not be
        // there — which this answers with an empty list, not an error.
        "bash" | "sh" => Some("bash"),
        "zsh" => Some("zsh"),
        "fish" => Some("fish"),
        _ => None,
    }
}

/// Where the shell of this family keeps what it has written.
///
/// `HISTFILE` first for bash and zsh, because that is the name the shell itself
/// reads and a person who moved their history moved it for every reader. It is
/// taken from this process's environment, which is the same environment the
/// shells opened by this app inherit — so the panel and the up-arrow in the
/// terminal beside it are looking at one file rather than two.
fn file_for(family: &str, home: &Path) -> Option<PathBuf> {
    let named = |key: &str| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    };
    match family {
        "bash" => Some(named("HISTFILE").unwrap_or_else(|| home.join(".bash_history"))),
        "zsh" => Some(named("HISTFILE").unwrap_or_else(|| home.join(".zsh_history"))),
        // fish's `fish_history` is the name of a session and not a path, and an
        // empty one means fish is keeping no history at all — which is what the
        // test harness sets, and is a list of nothing rather than the default
        // file read behind its back.
        "fish" => match std::env::var("fish_history") {
            Ok(session) if session.is_empty() => None,
            Ok(session) => Some(
                home.join(".local/share/fish")
                    .join(format!("{session}_history")),
            ),
            Err(_) => Some(home.join(".local/share/fish/fish_history")),
        },
        _ => None,
    }
}

/// bash: one command a line, `#<seconds>` for the time of the one after it.
///
/// A command with a newline in it is written by bash as several lines with no
/// marking of any kind, so there is no way to put it back together from the
/// file and nothing here tries. Each line stands as a command, which is what
/// bash's own up-arrow does with them too.
fn read_bash(text: &str) -> Vec<Ran> {
    let mut out = Vec::new();
    let mut at = None;
    for line in text.lines() {
        if let Some(seconds) = line.strip_prefix('#') {
            if let Ok(seconds) = seconds.trim().parse::<i64>() {
                at = Some(seconds);
                continue;
            }
        }
        if line.trim().is_empty() {
            continue;
        }
        out.push(Ran {
            command: line.to_owned(),
            at: at.take(),
        });
    }
    out
}

/// zsh: `: <seconds>:<elapsed>;<command>`, or a plain line, continued by a
/// trailing backslash.
fn read_zsh(text: &str) -> Vec<Ran> {
    let mut out: Vec<Ran> = Vec::new();
    // A line ending in an odd number of backslashes is continued by the next
    // one. Odd, because `\\` at the end of a command is an escaped backslash
    // and ends nothing.
    let mut carrying = false;
    for line in text.lines() {
        let continues = line.len() - line.trim_end_matches('\\').len();
        let continues = continues % 2 == 1;
        if carrying {
            if let Some(last) = out.last_mut() {
                last.command.push('\n');
                last.command.push_str(line.trim_end_matches('\\'));
            }
            carrying = continues;
            continue;
        }
        carrying = continues;
        let line = line.trim_end_matches('\\');
        if line.trim().is_empty() {
            continue;
        }
        let (at, command) = match line.strip_prefix(':') {
            Some(rest) => match rest.split_once(';') {
                Some((stamp, command)) => (
                    stamp
                        .split(':')
                        .find_map(|part| part.trim().parse::<i64>().ok()),
                    command,
                ),
                None => (None, line),
            },
            None => (None, line),
        };
        out.push(Ran {
            command: command.to_owned(),
            at,
        });
    }
    out
}

/// fish: a small, fixed subset of YAML, read as the fixed thing it is.
///
/// Only `cmd` and `when` are wanted, and fish writes them in that order, one
/// entry to a `- cmd:` line. The escapes are fish's own — it writes `\n` for a
/// newline and `\\` for a backslash — and they are undone here so that a
/// command is the command and not a picture of one.
fn read_fish(text: &str) -> Vec<Ran> {
    let mut out: Vec<Ran> = Vec::new();
    for line in text.lines() {
        if let Some(command) = line.strip_prefix("- cmd:") {
            out.push(Ran {
                command: unescape_fish(command.trim()),
                at: None,
            });
        } else if let Some(when) = line.trim_start().strip_prefix("when:") {
            if let (Some(last), Ok(seconds)) = (out.last_mut(), when.trim().parse::<i64>()) {
                last.at = Some(seconds);
            }
        }
    }
    out
}

fn unescape_fish(written: &str) -> String {
    let mut out = String::with_capacity(written.len());
    let mut letters = written.chars();
    while let Some(letter) = letters.next() {
        if letter != '\\' {
            out.push(letter);
            continue;
        }
        match letters.next() {
            Some('n') => out.push('\n'),
            Some('\\') => out.push('\\'),
            // Anything else fish did not escape, so the backslash was itself.
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Whether this server can read the history of the shell at `path` at all.
///
/// Asked separately from `recent` so that the panel can tell the two empty
/// lists apart: a shell nothing here parses, and a shell whose file is simply
/// empty. They look the same in a list and they are not the same to the reader
/// — one is worth a sentence explaining itself, the other is worth nothing.
pub fn readable(path: &Path) -> bool {
    family(path).is_some()
}

/// The commands this computer's shell has written down, newest first.
///
/// Newest first because that is the order they are wanted in: a search that
/// finds four matches should offer the most recent one at the top, and a panel
/// opened with nothing typed should show what was run a minute ago rather than
/// what was run in 2019.
///
/// Repeats are dropped, keeping the newest of each. A history file is mostly
/// the same twenty commands over and over, and a list that showed `git status`
/// four hundred times would be a list with nothing else visible in it.
pub fn recent(shell: &Path, home: &Path) -> Vec<Ran> {
    let Some(family) = family(shell) else {
        return Vec::new();
    };
    let Some(path) = file_for(family, home) else {
        return Vec::new();
    };
    // Lossily, on purpose. A history file is whatever bytes were typed, and one
    // command with a stray byte in it from a paste years ago is not a reason to
    // have no history panel at all.
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let written = match family {
        "bash" => read_bash(&text),
        "zsh" => read_zsh(&text),
        "fish" => read_fish(&text),
        _ => Vec::new(),
    };

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for ran in written.into_iter().rev() {
        if ran.command.trim().is_empty() {
            continue;
        }
        if !seen.insert(ran.command.clone()) {
            continue;
        }
        out.push(ran);
        if out.len() == AT_MOST {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_is_known_by_its_name_whatever_version_is_on_the_end() {
        assert_eq!(family(Path::new("/bin/bash")), Some("bash"));
        assert_eq!(family(Path::new("/usr/bin/bash5")), Some("bash"));
        assert_eq!(family(Path::new("/bin/zsh")), Some("zsh"));
        assert_eq!(family(Path::new("/usr/local/bin/zsh-5.9")), Some("zsh"));
        assert_eq!(family(Path::new("/usr/bin/fish")), Some("fish"));
        assert_eq!(family(Path::new("/bin/sh")), Some("bash"));
        // Not a guess. A shell nothing here can parse is no history at all.
        assert_eq!(family(Path::new("/usr/bin/nu")), None);
        assert_eq!(family(Path::new("/bin/tcsh")), None);
    }

    #[test]
    fn bash_lines_are_commands_and_hashes_are_the_times_of_the_next_one() {
        let read = read_bash("#1700000000\ngit status\nls -la\n#1700000100\ncargo test\n");
        assert_eq!(
            read,
            vec![
                Ran { command: "git status".into(), at: Some(1_700_000_000) },
                Ran { command: "ls -la".into(), at: None },
                Ran { command: "cargo test".into(), at: Some(1_700_000_100) },
            ]
        );
    }

    #[test]
    fn a_hash_that_is_not_a_time_is_a_command_because_it_is_a_comment() {
        // `# TODO` typed at a prompt is a line bash records like any other, and
        // a reader that swallowed it would drop a command and then hand the
        // wrong time to the one after it.
        let read = read_bash("# TODO: come back to this\nls\n");
        assert_eq!(read.len(), 2, "the comment should have stayed a command");
        assert_eq!(read[0].command, "# TODO: come back to this");
        assert_eq!(read[1].at, None, "the comment is not a timestamp for `ls`");
    }

    #[test]
    fn zsh_reads_both_its_formats_and_joins_a_continued_command() {
        let read = read_zsh(": 1700000000:0;git status\nls -la\n: 1700000100:5;for f in *; do \\\necho $f; done\n");
        assert_eq!(read[0], Ran { command: "git status".into(), at: Some(1_700_000_000) });
        assert_eq!(read[1], Ran { command: "ls -la".into(), at: None });
        assert_eq!(read[2].command, "for f in *; do \necho $f; done");
        assert_eq!(read[2].at, Some(1_700_000_100));
    }

    #[test]
    fn a_zsh_command_ending_in_an_escaped_backslash_is_not_continued() {
        let read = read_zsh(": 1:0;printf 'a\\\\'\n: 2:0;ls\n");
        assert_eq!(read.len(), 2, "the two lines are two commands");
        assert_eq!(read[1].command, "ls");
    }

    #[test]
    fn fish_gives_up_its_command_and_its_time_with_the_escapes_undone() {
        let read = read_fish("- cmd: git status\n  when: 1700000000\n- cmd: echo a\\nb\n  when: 1700000100\n");
        assert_eq!(read[0], Ran { command: "git status".into(), at: Some(1_700_000_000) });
        assert_eq!(read[1], Ran { command: "echo a\nb".into(), at: Some(1_700_000_100) });
    }

    #[test]
    fn the_newest_of_a_repeated_command_is_the_one_kept_and_it_comes_first() {
        let home = tempfile::tempdir().expect("a temporary home");
        std::fs::write(
            home.path().join(".bash_history"),
            "git status\nls\ngit status\ncargo test\n",
        )
        .expect("a history file");

        let read = temporarily_without_histfile(|| recent(Path::new("/bin/bash"), home.path()));

        assert_eq!(
            read.iter().map(|ran| ran.command.as_str()).collect::<Vec<_>>(),
            vec!["cargo test", "git status", "ls"],
            "newest first, each command once"
        );
    }

    #[test]
    fn a_history_file_that_is_not_there_is_no_history_rather_than_a_failure() {
        let home = tempfile::tempdir().expect("a temporary home");
        let read = temporarily_without_histfile(|| recent(Path::new("/bin/bash"), home.path()));
        assert!(read.is_empty(), "a missing file should read as nothing");
    }

    /// One at a time, because the environment is the process's and the tests
    /// in a binary share it. Two cases taking `HISTFILE` away at once is one of
    /// them putting it back while the other is still reading.
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// `HISTFILE` is read from this process's environment, and the test binary
    /// is one process shared by every test in it — so a machine that has one
    /// set would otherwise send these two cases off to the developer's own
    /// history instead of to the temporary home they built.
    fn temporarily_without_histfile<T>(run: impl FnOnce() -> T) -> T {
        // The lock outlives the whole swap, and a case that panicked holding it
        // must not make every case after it panic too — the environment it left
        // behind is the one this function is about to overwrite anyway.
        let _held = ONE_AT_A_TIME.lock().unwrap_or_else(|held| held.into_inner());
        let was = std::env::var_os("HISTFILE");
        std::env::remove_var("HISTFILE");
        let out = run();
        if let Some(was) = was {
            std::env::set_var("HISTFILE", was);
        }
        out
    }
}
