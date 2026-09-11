//! Signing an account in without leaving the app.
//!
//! A profile is an empty directory until somebody signs into it
//! (`profiles.rs`). The sign-in itself is the provider's own, run by the
//! provider's own program against that directory — this never sees a password,
//! never holds a token, and never copies one between directories. What it does
//! is start the official command with the profile's directory named in the
//! environment, read what the command prints, and show the person the link and
//! the code it printed.
//!
//! ## Why a terminal and not a pipe
//!
//! `claude auth login` draws nothing at all into a pipe. Given a terminal it
//! prints the address to open, then waits on a line for the code the browser
//! hands back. So the sign-in is run on a pty, which is also what lets the
//! pasted code be typed back in. Codex would be content with a pipe, but it
//! runs the same way for the sake of one path rather than two.
//!
//! ## Why Codex is asked for a device code
//!
//! `codex login` on its own opens a browser and waits on `127.0.0.1:1455`, a
//! fixed port. Two accounts signing in at once would fight over it, and so
//! would a sign-in here and a `codex login` in a terminal. `--device-auth`
//! asks for a code instead and binds nothing, so any number of them can be in
//! flight together. Claude needs no such flag: its flow already hands the code
//! back through the browser rather than through a port.
//!
//! ## Why the status is asked for rather than inferred
//!
//! Whether a sign-in worked is not a thing to read out of the words that
//! scrolled past. Both programs answer the question directly — `claude auth
//! status --json` and `codex login status` — so when the command ends, that is
//! what decides, and the output is only ever shown to the person.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

/// How long to wait on a program that answers a question, before deciding it
/// is not going to. Generous: `claude` is a node program and a cold start on a
/// loaded machine is not a failure.
const ANSWER_WITHIN: Duration = Duration::from_secs(30);

/// How long a sign-in nobody finished is kept. Codex says its code expires in
/// fifteen minutes, and a link left open past that is not worth holding a
/// process for.
const ABANDONED_AFTER: Duration = Duration::from_secs(20 * 60);

/// The last of the output kept for the screen. Enough to show what went wrong
/// when the reading below cannot tell, and not enough to grow without bound on
/// a program that decides to redraw itself in a loop.
const KEEP_LAST: usize = 8 * 1024;

/// Whether an account is signed in, and who as.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub signed_in: bool,
    /// Who, as the provider names them — an email address for Claude, and for
    /// Codex whatever it says it is signed in with.
    pub account: Option<String>,
    /// The plan, where the provider says one.
    pub plan: Option<String>,
    /// What was signed in with, where that is all the provider will say.
    /// Codex answers "Logged in using ChatGPT" and never names an account, so
    /// this is the method and not a person; drawing it after "signed in as"
    /// would put a name on somebody that nothing on this computer knows.
    pub how: Option<String>,
    /// Why this could not be answered at all, which is not the same as being
    /// signed out and must not be drawn as though it were.
    pub unknown: Option<String>,
}

impl Standing {
    fn unknown(why: impl std::fmt::Display) -> Self {
        Standing {
            unknown: Some(why.to_string()),
            ..Standing::default()
        }
    }
}

/// How far along a sign-in is, in the terms the screen draws.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `starting`, `open-the-link`, `paste-the-code`, `signed-in`, `failed`.
    pub state: &'static str,
    /// The address to open, once the program has printed one.
    pub url: Option<String>,
    /// The one-time code to type into that page, for the flow that uses one.
    pub code: Option<String>,
    /// The last of what the program printed, plainly, for the person to read
    /// when the state above is not enough to explain itself.
    pub said: String,
    /// What the provider says about the account, once the sign-in has ended.
    pub standing: Option<Standing>,
}

/// Where a brand keeps its identity, and what it is called on the command line.
fn program(brand: &str) -> Option<PathBuf> {
    match brand {
        "claude" | "codex" => crate::routes::find_tool(brand, &[]),
        _ => None,
    }
}

/// The command that signs `brand` in, after the program itself.
fn signing_in(brand: &str) -> &'static [&'static str] {
    match brand {
        "claude" => &["auth", "login"],
        // See the module note: a fixed port cannot be shared, a device code
        // can.
        _ => &["login", "--device-auth"],
    }
}

/// The command that asks `brand` who it is signed in as.
fn asking(brand: &str) -> &'static [&'static str] {
    match brand {
        "claude" => &["auth", "status", "--json"],
        _ => &["login", "status"],
    }
}

/// Whether an account is signed in, asked of the provider itself.
///
/// `directory` is `None` for the system profile, which is asked with the
/// environment exactly as the server has it — the same as a `claude auth
/// status` typed into a terminal, and the same as `adapter.rs` does when it
/// starts a chat on that profile. Naming the directory instead would be a
/// different question: Claude keeps the account's address beside the config
/// directory rather than inside it, so pointing at `~/.claude` by hand made it
/// look for `~/.claude/.claude.json`, find nothing, and answer with a `null`
/// where the owner's own email belongs.
pub async fn standing(brand: &str, directory: Option<&Path>) -> Standing {
    let Some(variable) = super::profiles::variable(brand) else {
        return Standing::unknown(format!("{brand} does not sign in."));
    };
    let Some(program) = program(brand) else {
        return Standing::unknown(format!("{brand} is not installed on this computer."));
    };

    // Claude is asked on a terminal and Codex through a pipe, because that is
    // what each of them answers on. See `asked_on_a_terminal`.
    if brand == "claude" {
        return match asked_on_a_terminal(&program, asking(brand), variable, directory).await {
            Err(why) => Standing::unknown(why),
            Ok(said) => read_claude_status(&said),
        };
    }

    let mut command = tokio::process::Command::new(program);
    command.args(asking(brand));
    if let Some(directory) = directory {
        command.env(variable, directory);
    }
    command.stdin(std::process::Stdio::null());

    let finished = match tokio::time::timeout(ANSWER_WITHIN, command.output()).await {
        Err(_) => return Standing::unknown(format!("{brand} did not answer in time.")),
        Ok(Err(why)) => return Standing::unknown(why),
        Ok(Ok(finished)) => finished,
    };

    // Both streams, because Codex says whether it is signed in on stderr on
    // some machines and stdout on others. Reading only stdout answered every
    // Codex account with "could not tell".
    let mut said = String::from_utf8_lossy(&finished.stdout).into_owned();
    said.push('\n');
    said.push_str(&String::from_utf8_lossy(&finished.stderr));
    read_codex_status(&said)
}

/// Ask a program a question on a terminal, and hand back what it printed with
/// the terminal's own marks taken out.
///
/// `claude auth status --json` answers `email`, `orgId` and `orgName` as
/// `null` when its own input is a pipe — that lookup is one it only does when
/// it believes somebody is watching. Given a terminal it answers in full, so
/// the account on this screen is the address the provider knows rather than
/// the word that was typed into a box here. What a terminal costs is the
/// cursor moves it aligns the JSON with, which `plain` takes back out, and a
/// terminal wide enough that it wraps none of its own lines.
async fn asked_on_a_terminal(
    program: &Path,
    words: &[&str],
    variable: &str,
    directory: Option<&Path>,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 400,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|why| format!("A terminal could not be opened to ask on: {why}"))?;

    let mut command = CommandBuilder::new(program);
    for word in words {
        command.arg(word);
    }
    if let Some(directory) = directory {
        command.env(variable, directory);
    }
    command.env("NO_COLOR", "1");
    command.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|why| format!("{} could not be started: {why}", program.display()))?;
    drop(pair.slave);

    // Kept from before the reading starts, because the reading is what has to
    // be interrupted: a program that never exits holds the terminal open and
    // `read_to_end` waits on it forever.
    let mut killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|why| format!("The answer could not be read: {why}"))?;

    let reading = tokio::task::spawn_blocking(move || {
        // The master is held for as long as the reading, so the last handle on
        // the terminal is the child's own and the read ends when it exits.
        let _terminal = pair.master;
        let mut raw = Vec::new();
        let _ = reader.read_to_end(&mut raw);
        let _ = child.wait();
        String::from_utf8_lossy(&raw).into_owned()
    });

    match tokio::time::timeout(ANSWER_WITHIN, reading).await {
        Err(_) => {
            let _ = killer.kill();
            Err(format!(
                "{} did not answer in time.",
                program.display()
            ))
        }
        Ok(Err(why)) => Err(format!("The answer could not be read: {why}")),
        Ok(Ok(raw)) => Ok(plain(&raw)),
    }
}

/// `claude auth status --json`.
///
/// Read out of the answer rather than from the whole of what was printed: on a
/// terminal it saves and restores the cursor around its own output, and one of
/// those marks survives `plain` as a stray letter on the end. The answer is
/// the object, so the object is what is taken.
fn read_claude_status(said: &str) -> Standing {
    let object = match (said.find('{'), said.rfind('}')) {
        (Some(open), Some(close)) if close > open => &said[open..=close],
        _ => return Standing::unknown("Claude did not answer in the form it says it does."),
    };
    let Ok(answer) = serde_json::from_str::<serde_json::Value>(object) else {
        return Standing::unknown("Claude did not answer in the form it says it does.");
    };
    let text = |name: &str| {
        answer
            .get(name)
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    Standing {
        signed_in: answer
            .get("loggedIn")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        account: text("email").or_else(|| text("orgName")),
        plan: text("subscriptionType"),
        how: None,
        unknown: None,
    }
}

/// `codex login status`, which answers in a sentence.
///
/// Read by the one word that decides it rather than by matching the whole
/// sentence: the wording has changed between versions, and "Not logged in" is
/// the half that has to be got right.
fn read_codex_status(said: &str) -> Standing {
    // Codex prefixes warnings of its own on some machines. The answer is the
    // last line that says anything about being logged in.
    let line = said
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("Logged in") || line.starts_with("Not logged in"))
        .next_back();

    match line {
        None => Standing::unknown("Codex did not say whether it is signed in."),
        Some(line) if line.starts_with("Not logged in") => Standing::default(),
        // "Logged in using ChatGPT" names a method, not a person. Codex has
        // no question that answers who, and `auth.json` is not ours to open,
        // so this says what it was signed in with and stops there.
        Some(line) => Standing {
            signed_in: true,
            account: None,
            plan: None,
            how: line
                .split_once(" using ")
                .map(|(_, how)| how.trim().to_string()),
            unknown: None,
        },
    }
}

/// One sign-in, running.
struct Attempt {
    brand: String,
    /// The account's directory, or `None` for the system profile, which signs
    /// in with the environment left alone. See `standing`.
    directory: Option<PathBuf>,
    started: Instant,
    /// What the program has printed, with the terminal's own marks taken out.
    said: Arc<Mutex<String>>,
    /// The terminal's own end of the conversation, for typing a code back.
    typing: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// What the provider said when the program ended, read once and kept.
    ended: Mutex<Option<Standing>>,
    /// Held so the reader and the writer above stay attached to something.
    /// Behind a lock because a terminal is `Send` and not `Sync`, and this
    /// whole registry is shared across tasks.
    _terminal: Mutex<Box<dyn MasterPty + Send>>,
}

/// The sign-ins in flight, one per account at most.
#[derive(Default)]
pub struct SignIns {
    running: Mutex<HashMap<String, Arc<Attempt>>>,
}

/// One account, named the one way, so a Claude profile and a Codex profile of
/// the same name are two sign-ins and not one.
fn key(brand: &str, profile: &str) -> String {
    format!("{brand}/{profile}")
}

impl SignIns {
    /// Start signing `profile` in, replacing any attempt already running for
    /// it. Replacing rather than refusing: a person who closed the dialog and
    /// opened it again is asking to start over, and the old process is holding
    /// a code that has already scrolled off their screen.
    pub async fn start(
        &self,
        brand: &str,
        profile: &str,
        directory: Option<&Path>,
    ) -> Result<Progress, String> {
        let variable = super::profiles::variable(brand)
            .ok_or_else(|| format!("{brand} does not sign in."))?;
        let program = program(brand)
            .ok_or_else(|| format!("{brand} is not installed on this computer."))?;

        // The directory has to be there before the program is told to keep an
        // identity in it, or the first thing it does is fail to write. The
        // system profile names no directory and needs none made.
        if let Some(directory) = directory {
            std::fs::create_dir_all(directory).map_err(|why| {
                format!(
                    "The account's folder could not be made at {}: {why}",
                    directory.display()
                )
            })?;
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|why| format!("A terminal could not be opened to sign in with: {why}"))?;

        let mut command = CommandBuilder::new(&program);
        for word in signing_in(brand) {
            command.arg(word);
        }
        if let Some(directory) = directory {
            command.env(variable, directory);
        }
        // Colour is what the reading below has to undo, and nothing here draws
        // it. Both programs take the hint.
        command.env("NO_COLOR", "1");
        command.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|why| format!("{} could not be started: {why}", program.display()))?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|why| format!("The sign-in's output could not be read: {why}"))?;
        let typing = pair
            .master
            .take_writer()
            .map_err(|why| format!("The sign-in could not be typed into: {why}"))?;

        let said = Arc::new(Mutex::new(String::new()));
        drain(reader, Arc::clone(&said));

        let attempt = Arc::new(Attempt {
            brand: brand.to_string(),
            directory: directory.map(Path::to_path_buf),
            started: Instant::now(),
            said,
            typing: Mutex::new(typing),
            child: Mutex::new(child),
            ended: Mutex::new(None),
            _terminal: Mutex::new(pair.master),
        });

        if let Ok(mut running) = self.running.lock() {
            self.forget_the_abandoned(&mut running);
            if let Some(before) = running.insert(key(brand, profile), Arc::clone(&attempt)) {
                stop(&before);
            }
        }

        Ok(look(&attempt).await)
    }

    /// How far along the sign-in is now.
    pub async fn read(&self, brand: &str, profile: &str) -> Result<Progress, String> {
        let attempt = self.held(brand, profile)?;
        Ok(look(&attempt).await)
    }

    /// Type the code the browser handed back. Claude's flow asks for one;
    /// Codex's does not, and there is nothing waiting to read it.
    pub async fn paste(&self, brand: &str, profile: &str, code: &str) -> Result<Progress, String> {
        let attempt = self.held(brand, profile)?;
        let line = format!("{}\r", code.trim());
        {
            let mut typing = attempt
                .typing
                .lock()
                .map_err(|_| "The sign-in cannot be typed into.".to_string())?;
            typing
                .write_all(line.as_bytes())
                .and_then(|()| typing.flush())
                .map_err(|why| format!("The code could not be handed over: {why}"))?;
        }
        Ok(look(&attempt).await)
    }

    /// Stop a sign-in nobody is going to finish.
    pub fn cancel(&self, brand: &str, profile: &str) -> Result<(), String> {
        let mut running = self
            .running
            .lock()
            .map_err(|_| "The sign-ins cannot be reached.".to_string())?;
        if let Some(attempt) = running.remove(&key(brand, profile)) {
            stop(&attempt);
        }
        Ok(())
    }

    fn held(&self, brand: &str, profile: &str) -> Result<Arc<Attempt>, String> {
        let running = self
            .running
            .lock()
            .map_err(|_| "The sign-ins cannot be reached.".to_string())?;
        running
            .get(&key(brand, profile))
            .cloned()
            .ok_or_else(|| "That sign-in is not running.".to_string())
    }

    /// Drop the sign-ins that were opened and walked away from. Their codes
    /// have expired, and each one is a process and a terminal held open.
    fn forget_the_abandoned(&self, running: &mut HashMap<String, Arc<Attempt>>) {
        let stale: Vec<String> = running
            .iter()
            .filter(|(_, attempt)| attempt.started.elapsed() > ABANDONED_AFTER)
            .map(|(named, _)| named.clone())
            .collect();
        for named in stale {
            if let Some(attempt) = running.remove(&named) {
                stop(&attempt);
            }
        }
    }
}

/// End a sign-in's process, whatever state it is in.
fn stop(attempt: &Attempt) {
    if let Ok(mut child) = attempt.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Read the terminal until it ends, keeping the last of what came out.
///
/// A thread rather than a task: this is a blocking read on a file descriptor,
/// and the one thing that must not happen is an executor thread parked on it.
fn drain(mut reader: Box<dyn Read + Send>, said: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let Ok(mut held) = said.lock() else { break };
                    held.push_str(&plain(&String::from_utf8_lossy(&buffer[..n])));
                    if held.len() > KEEP_LAST {
                        // Kept from a character boundary, or the next read
                        // appends to a string cut through the middle of one.
                        let from = held.len() - KEEP_LAST;
                        let from = (from..held.len())
                            .find(|at| held.is_char_boundary(*at))
                            .unwrap_or(held.len());
                        *held = held[from..].to_string();
                    }
                }
            }
        }
    });
}

/// What a terminal's output says, without the marks that move the cursor.
///
/// Two kinds are taken out. `ESC [ … letter` is colour and cursor movement.
/// `ESC ] … BEL` is an operating-system command, which is how a terminal is
/// told that a piece of text is a link — and the address inside one of those
/// is repeated as ordinary text right after it, so dropping the whole command
/// loses nothing a reader needs.
fn plain(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut letters = raw.chars().peekable();
    while let Some(c) = letters.next() {
        if c != '\u{1b}' {
            // A carriage return with no newline is a program drawing over its
            // own line. Kept as a newline so the reading below still sees
            // lines, rather than one line that grows forever.
            out.push(if c == '\r' { '\n' } else { c });
            continue;
        }
        match letters.next() {
            Some('[') => {
                for c in letters.by_ref() {
                    if c.is_ascii_alphabetic() || c == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = letters.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && letters.peek() == Some(&'\\') {
                        letters.next();
                        break;
                    }
                }
            }
            // An escape followed by anything else is a key or a mode change,
            // and the character after it is part of it either way.
            _ => {}
        }
    }
    out
}

/// The first web address in what was printed.
fn address_in(said: &str) -> Option<String> {
    let at = said.find("https://")?;
    let rest = &said[at..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c.is_control())
        .unwrap_or(rest.len());
    let found = rest[..end].trim_end_matches(['.', ',', ')', '"', '\'']);
    (found.len() > "https://".len()).then(|| found.to_string())
}

/// The one-time code Codex prints, which is the only line shaped like one.
fn code_in(said: &str) -> Option<String> {
    said.lines()
        .map(str::trim)
        .find(|line| {
            let Some((left, right)) = line.split_once('-') else {
                return false;
            };
            !left.is_empty()
                && !right.is_empty()
                && line.len() <= 16
                && line
                    .chars()
                    .all(|c| c == '-' || (c.is_ascii_alphanumeric() && !c.is_ascii_lowercase()))
        })
        .map(str::to_string)
}

/// What the screen should draw for this attempt, now.
async fn look(attempt: &Attempt) -> Progress {
    let said = attempt
        .said
        .lock()
        .map(|held| held.clone())
        .unwrap_or_default();

    let over = attempt
        .child
        .lock()
        .ok()
        .and_then(|mut child| child.try_wait().ok().flatten())
        .is_some();

    // Asked of the provider once, and kept: the answer cannot change again
    // without somebody starting another sign-in, and asking on every poll
    // would start a process a second.
    let ended = if over {
        let already = attempt.ended.lock().ok().and_then(|held| held.clone());
        match already {
            Some(standing) => Some(standing),
            None => {
                let standing = standing(&attempt.brand, attempt.directory.as_deref()).await;
                if let Ok(mut held) = attempt.ended.lock() {
                    *held = Some(standing.clone());
                }
                Some(standing)
            }
        }
    } else {
        None
    };

    let state = match &ended {
        Some(standing) if standing.signed_in => "signed-in",
        Some(_) => "failed",
        // Claude asks for the code on a line of its own, and until it does
        // there is nothing to hand it.
        None if said.contains("Paste code here") => "paste-the-code",
        None if address_in(&said).is_some() => "open-the-link",
        None => "starting",
    };

    Progress {
        state,
        url: address_in(&said),
        code: code_in(&said),
        said: said.trim().to_string(),
        standing: ended,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminals_own_marks_are_not_part_of_what_was_said() {
        let raw = "\u{1b}[90mWelcome\u{1b}[0m to Codex\n";
        assert_eq!(plain(raw), "Welcome to Codex\n");
    }

    #[test]
    fn a_link_survives_being_written_as_a_terminal_link() {
        // How `claude auth login` prints its address: the whole thing once
        // inside the terminal's link command, and once again as text.
        let raw = "visit: \u{1b}]8;;https://claude.com/cai/oauth/authorize?code=true\u{7}\
                   https://claude.com/cai/oauth/authorize?code=true\u{1b}]8;;\u{7}\r\n";
        let said = plain(raw);
        assert_eq!(
            address_in(&said).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true"),
            "the address the person has to open was lost, and what is left is {said:?}"
        );
    }

    #[test]
    fn the_one_time_code_is_picked_out_of_what_codex_printed() {
        let said = plain(
            "2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m\n   \
             \u{1b}[94m7LBI-A3KBA\u{1b}[0m\n",
        );
        assert_eq!(code_in(&said).as_deref(), Some("7LBI-A3KBA"));
        assert_eq!(
            address_in(&said),
            None,
            "there is no address in this, and reading one out of it would send somebody nowhere"
        );
    }

    #[test]
    fn ordinary_prose_is_not_mistaken_for_a_code() {
        for said in [
            "Follow these steps to sign in with ChatGPT using device code authorization:",
            "sign-in",
            "-",
            "Not logged in",
        ] {
            assert_eq!(code_in(said), None, "{said:?} was read as a one-time code");
        }
    }

    #[test]
    fn claude_answers_who_it_is_signed_in_as() {
        let said = r#"{
            "loggedIn": true, "authMethod": "claude.ai", "email": "someone@example.com",
            "orgName": "someone@example.com's Organization", "subscriptionType": "max"
        }"#;
        let standing = read_claude_status(said);
        assert!(standing.signed_in);
        assert_eq!(standing.account.as_deref(), Some("someone@example.com"));
        assert_eq!(standing.plan.as_deref(), Some("max"));
        assert_eq!(standing.unknown, None);
    }

    #[test]
    fn claude_answered_on_a_terminal_is_read_through_its_own_cursor_marks() {
        // What `claude auth status --json` really prints to a terminal: the
        // cursor is saved and restored around the answer, and every value is
        // moved into a column of its own.
        let said = plain(concat!(
            "\u{1b}7\u{1b}[r\u{1b}8\u{1b}[?25h{\r\n",
            "\u{1b}[3G\"loggedIn\":\u{1b}[15Gtrue,\r\n",
            "\u{1b}[3G\"email\":\u{1b}[12G\"someone@example.com\",\r\n",
            "\u{1b}[3G\"subscriptionType\":\u{1b}[23G\"max\"\r\n",
            "}\r\n\u{1b}[?25h\u{1b}(B\u{1b}[?2004l",
        ));
        let standing = read_claude_status(&said);
        assert!(standing.signed_in);
        assert_eq!(
            standing.account.as_deref(),
            Some("someone@example.com"),
            "asked through a pipe this field is null, which is why it is asked \
             on a terminal at all"
        );
        assert_eq!(standing.plan.as_deref(), Some("max"));
        assert_eq!(standing.unknown, None);
    }

    #[test]
    fn an_empty_account_is_signed_out_and_not_unknown() {
        let said = r#"{"loggedIn": false, "authMethod": "none"}"#;
        let standing = read_claude_status(said);
        assert!(!standing.signed_in);
        assert_eq!(
            standing.unknown, None,
            "signed out is an answer, and drawing it as 'we could not tell' \
             would send somebody looking for a problem that is not there"
        );
    }

    #[test]
    fn an_answer_in_no_shape_at_all_is_not_read_as_signed_out() {
        let standing = read_claude_status("command not found");
        assert!(!standing.signed_in);
        assert!(
            standing.unknown.is_some(),
            "a broken install was drawn as an account that is merely signed out"
        );
    }

    #[test]
    fn codex_answers_in_a_sentence_and_warns_above_it() {
        let standing = read_codex_status(
            "WARNING: proceeding, even though we could not create PATH aliases\n\
             Logged in using ChatGPT\n",
        );
        assert!(standing.signed_in);
        assert_eq!(standing.how.as_deref(), Some("ChatGPT"));
        assert_eq!(
            standing.account, None,
            "'using ChatGPT' is how it signed in, and drawing it as who would \
             put a name on an account nothing here knows the name of"
        );

        let standing = read_codex_status("Not logged in\n");
        assert!(!standing.signed_in);
        assert_eq!(standing.unknown, None);

        let standing = read_codex_status("");
        assert!(standing.unknown.is_some());
    }
}
