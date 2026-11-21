//! The one place this server starts another program from.
//!
//! Every child process is built here: git, the agents, a check's command, the
//! desktop's file manager. `scripts/checks/one-process-door.sh` fails when any
//! other file builds a command, so the rules below cannot be walked around by
//! a call site written later.
//!
//! What being the one place buys:
//!
//! * **Rules that hold for every launch.** A git this server starts never
//!   saves the index as a side effect of reading ([`git`]), wherever in the
//!   code it was asked for.
//! * **A count.** Each launch is counted under what it is for, and the counts
//!   of a busy minute are written to the log. A part of the app that starts
//!   processes without end is then named in the log rather than found with
//!   `strace` months later.
//! * **A limit.** git is what the app starts on its own, with nobody asking:
//!   for the Git panel, the task list, the chat list. Those launches draw on a
//!   budget ([`GIT_BURST`], [`GIT_PER_SECOND`]) that each folder has to
//!   itself, and once a folder's is spent git is refused there until it
//!   refills. Nothing the app is meant to do in one folder comes near the
//!   budget, so a refusal means a fault, and the fault costs the computer a
//!   bounded amount instead of everything it has. Work in other folders is
//!   not held up by it.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use agent_client_protocol::{AcpAgent, AcpAgentConfig};
use portable_pty::CommandBuilder;

/// What a launch is for. The count and the log are kept under these.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Purpose {
    /// git, for any reason. Only [`git`] and [`git_blocking`] launch under it.
    Git,
    /// An agent, or the program that speaks to one.
    Agent,
    /// A command a task, a grid or a workflow runs to check work.
    Check,
    /// A browser the app drives.
    Browser,
    /// Something opened on the desktop: a file manager, an editor.
    Desktop,
    /// A question asked of the computer: its name, a program's version, which
    /// processes are alive.
    Probe,
    /// Installing or restarting the app itself.
    Update,
    /// A helper program run to produce an answer: a search, a commit message.
    Tool,
}

impl Purpose {
    fn name(self) -> &'static str {
        match self {
            Purpose::Git => "git",
            Purpose::Agent => "agent",
            Purpose::Check => "check",
            Purpose::Browser => "browser",
            Purpose::Desktop => "desktop",
            Purpose::Probe => "probe",
            Purpose::Update => "update",
            Purpose::Tool => "tool",
        }
    }
}

/// How many git launches in one folder may come at once before the limit
/// bites.
///
/// Merging a line of work, or proving a grid cell, is a few dozen launches in
/// one folder in a moment; this is many times that.
pub const GIT_BURST: f64 = 600.0;

/// How many git launches a second a folder's budget refills by.
///
/// The fault this exists for ran 160 a second in one folder without end.
/// Twenty is several times what the busiest real use of one folder sustains.
pub const GIT_PER_SECOND: f64 = 20.0;

/// Folders with a budget on the books above which the full ones are dropped.
/// A full budget is the same as none, so nothing is lost by it.
const FOLDERS_KEPT: usize = 512;

/// How often the counts are written to the log, when there is anything to say.
const REPORT_EVERY: Duration = Duration::from_secs(60);

/// Launches in one report period, of one purpose, above which it is said.
const WORTH_SAYING: u64 = 120;

struct Ledger {
    /// Launches since the last report, by purpose.
    counts: HashMap<Purpose, u64>,
    /// Launches turned away since the last report.
    refused: u64,
    reported_at: Instant,
    /// What is left of git's budget in each folder, and when it was last
    /// topped up. A folder not here has all of it.
    git_left: HashMap<PathBuf, (f64, Instant)>,
    /// Launches since the server started, by purpose.
    total: HashMap<Purpose, u64>,
}

fn ledger() -> &'static Mutex<Ledger> {
    static LEDGER: OnceLock<Mutex<Ledger>> = OnceLock::new();
    LEDGER.get_or_init(|| {
        let now = Instant::now();
        Mutex::new(Ledger {
            counts: HashMap::new(),
            refused: 0,
            reported_at: now,
            git_left: HashMap::new(),
            total: HashMap::new(),
        })
    })
}

/// What a budget has left after `waited` has gone by.
fn refilled(left: f64, waited: Duration) -> f64 {
    (left + waited.as_secs_f64() * GIT_PER_SECOND).min(GIT_BURST)
}

/// Take one launch out of `folder`'s budget, and say whether there was one.
fn draw(budgets: &mut HashMap<PathBuf, (f64, Instant)>, folder: &Path, now: Instant) -> bool {
    if budgets.len() >= FOLDERS_KEPT && !budgets.contains_key(folder) {
        budgets.retain(|_, (left, filled_at)| refilled(*left, now - *filled_at) < GIT_BURST);
    }
    let (left, filled_at) = budgets.entry(folder.to_path_buf()).or_insert((GIT_BURST, now));
    *left = refilled(*left, now - *filled_at);
    *filled_at = now;
    if *left >= 1.0 {
        *left -= 1.0;
        true
    } else {
        false
    }
}

/// Count one launch, and say whether it may go ahead. `at` is the folder a
/// git runs in; nothing else has a budget.
fn admit(purpose: Purpose, at: Option<&Path>) -> bool {
    let mut ledger = ledger().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();

    let allowed = match at {
        Some(folder) => draw(&mut ledger.git_left, folder, now),
        None => true,
    };

    if allowed {
        *ledger.counts.entry(purpose).or_default() += 1;
        *ledger.total.entry(purpose).or_default() += 1;
    } else {
        if ledger.refused == 0 {
            tracing::error!(
                "git is being started in {} more than {GIT_PER_SECOND} times a second and has been refused there; \
                 this is a fault in the app",
                at.unwrap_or(Path::new("")).display()
            );
        }
        ledger.refused += 1;
    }

    if now - ledger.reported_at >= REPORT_EVERY {
        let busy: Vec<String> = ledger
            .counts
            .iter()
            .filter(|(_, count)| **count >= WORTH_SAYING)
            .map(|(purpose, count)| format!("{}={count}", purpose.name()))
            .collect();
        if !busy.is_empty() || ledger.refused > 0 {
            tracing::warn!(
                "processes started in the last {} s: {}; refused: {}",
                (now - ledger.reported_at).as_secs(),
                if busy.is_empty() { "nothing unusual".to_string() } else { busy.join(" ") },
                ledger.refused
            );
        }
        ledger.counts.clear();
        ledger.refused = 0;
        ledger.reported_at = now;
    }
    allowed
}

/// How many launches of `purpose` there have been since the server started.
pub fn launched(purpose: Purpose) -> u64 {
    let ledger = ledger().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    ledger.total.get(&purpose).copied().unwrap_or(0)
}

fn over_budget() -> std::io::Error {
    std::io::Error::other(
        "Atelier is starting git too often and has stopped itself. Try again in a moment.",
    )
}

/// The rules every git this server starts runs under.
///
/// `GIT_OPTIONAL_LOCKS=0` is git's own switch for a program that reads a
/// repository in the background: a read such as `git status` then never saves
/// the index as a side effect. Commands that must write the index, such as
/// `add` and `commit`, are not affected.
const GIT_RULES: [(&str, &str); 1] = [("GIT_OPTIONAL_LOCKS", "0")];

/// git at `program`, run in the folder `at`, to be awaited. Refused when that
/// folder's budget is spent.
pub fn git(program: impl AsRef<OsStr>, at: &Path) -> std::io::Result<tokio::process::Command> {
    if !admit(Purpose::Git, Some(at)) {
        return Err(over_budget());
    }
    let mut command = tokio::process::Command::new(program);
    command.envs(GIT_RULES).current_dir(at);
    Ok(command)
}

/// git at `program`, run in the folder `at`, for code that waits on it in
/// place. Refused when that folder's budget is spent.
pub fn git_blocking(program: impl AsRef<OsStr>, at: &Path) -> std::io::Result<std::process::Command> {
    if !admit(Purpose::Git, Some(at)) {
        return Err(over_budget());
    }
    let mut command = std::process::Command::new(program);
    command.envs(GIT_RULES).current_dir(at);
    Ok(command)
}

/// A program to be awaited.
pub fn command(purpose: Purpose, program: impl AsRef<OsStr>) -> tokio::process::Command {
    debug_assert!(purpose != Purpose::Git, "git is started with launch::git");
    admit(purpose, None);
    tokio::process::Command::new(program)
}

/// A program for code that waits on it in place.
pub fn blocking(purpose: Purpose, program: impl AsRef<OsStr>) -> std::process::Command {
    debug_assert!(purpose != Purpose::Git, "git is started with launch::git_blocking");
    admit(purpose, None);
    std::process::Command::new(program)
}

/// A program to run inside a terminal of its own.
pub fn in_a_terminal(purpose: Purpose, program: impl AsRef<OsStr>) -> CommandBuilder {
    admit(purpose, None);
    CommandBuilder::new(program)
}

/// An agent reached over the agent client protocol; the kit starts its
/// process when the connection is made.
pub fn acp_agent(config: AcpAgentConfig) -> AcpAgent {
    admit(Purpose::Agent, None);
    AcpAgent::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A budget refills at its rate and never past its burst.
    #[test]
    fn a_spent_budget_refills_at_its_rate_and_stops_at_the_burst() {
        assert_eq!(refilled(0.0, Duration::from_secs(1)), GIT_PER_SECOND);
        assert_eq!(refilled(GIT_BURST - 1.0, Duration::from_secs(60)), GIT_BURST);
    }

    /// A folder that has spent its budget is refused, and that holds nothing
    /// up anywhere else.
    #[test]
    fn a_folder_that_spends_its_budget_is_refused_and_no_other_folder_is() {
        let mut budgets = HashMap::new();
        let now = Instant::now();
        let (looping, quiet) = (Path::new("/looping"), Path::new("/quiet"));

        let allowed = (0..10_000).filter(|_| draw(&mut budgets, looping, now)).count();

        assert_eq!(allowed as f64, GIT_BURST);
        assert!(draw(&mut budgets, quiet, now));
        assert!(!draw(&mut budgets, looping, now));
        assert!(draw(&mut budgets, looping, now + Duration::from_secs(1)));
    }

    /// Git started here reads without writing, whoever asked for it.
    #[test]
    fn git_is_started_under_the_rule_that_reads_do_not_write() {
        let command = git_blocking("git", Path::new(".")).unwrap();
        let rule = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("GIT_OPTIONAL_LOCKS"))
            .and_then(|(_, value)| value);
        assert_eq!(rule, Some(OsStr::new("0")));
    }
}
