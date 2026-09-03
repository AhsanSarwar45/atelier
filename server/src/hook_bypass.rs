//! One escape hatch, honoured by every hook this binary answers to.
//!
//! A gate that cannot be stood down is a gate that can strand a session. The
//! refusals in `lifecycle.rs` are deliberately narrow, but "narrow" is a claim
//! about the cases we thought of, and `docs/hook-friction.md` is the record of
//! the ones we did not. So every hook — gate, stamper or bookkeeper — asks this
//! first, and stands down when the answer is yes.
//!
//! There are four ways to say yes, and all four are loud: the reason is written
//! to standard error and appended to `hook-bypass.log` in the application data
//! directory, so a bypass is a thing that happened rather than a thing that
//! quietly did not.
//!
//!   1. `ATELIER_HOOKS=off` in the environment — every gate, for as long as the
//!      variable is set. The owner's switch: it belongs in a settings file or a
//!      shell, where a person put it on purpose.
//!   2. `ATELIER_BYPASS=<why>` in the environment — the same, with a reason
//!      recorded.
//!   3. `.atelier-hooks-off` beside any ancestor of the working directory, or
//!      `hooks-off` in the application data directory. A file, so it also
//!      covers the tools that carry no text an agent can write in — `Edit`,
//!      `Write`, and the session-lifecycle hooks. Its contents are the reason.
//!   4. `ATELIER_BYPASS=<why>` written by the session itself: as a leading
//!      environment assignment on the shell command being gated, or on its own
//!      line in the reply a stop gate is judging. This is the deadlock exit —
//!      an agent that a gate has cornered can say so, in one word, and keep
//!      working.
//!
//! A bypass stands the whole hook down, not one of its checks. A bypassed
//! `bd` command is therefore not actor-stamped either; pass `--actor` yourself
//! when that matters.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The word that carries a reason.
pub const TOKEN: &str = "ATELIER_BYPASS";
/// The switch that turns every gate off without one.
pub const SWITCH: &str = "ATELIER_HOOKS";
/// The file a working tree keeps while its gates are meant to be down.
pub const MARKER: &str = ".atelier-hooks-off";
/// The same, for a whole machine, inside the application data directory.
pub const MACHINE_MARKER: &str = "hooks-off";
/// Where a bypass is written down.
pub const LOG: &str = "hook-bypass.log";

/// How far up the directory tree a working-tree marker is looked for.
const ANCESTORS: usize = 64;

/// A gate standing down, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bypass {
    /// Where the permission came from, in words a reader can act on.
    pub source: String,
    /// What the person or session said the reason was.
    pub reason: String,
}

impl Bypass {
    fn new(source: impl Into<String>, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        let reason = reason.trim().to_string();
        Bypass {
            source: source.into(),
            reason: if reason.is_empty() {
                "no reason given".to_string()
            } else {
                reason
            },
        }
    }
}

/// Is this hook invocation excused, and by what?
///
/// The environment is read here rather than passed in so that every caller
/// asks the same question the same way.
pub fn asked(event: &Value) -> Option<Bypass> {
    from_environment().or_else(|| from_files(&working_dir(event)).or_else(|| from_event(event)))
}

fn from_environment() -> Option<Bypass> {
    if let Ok(value) = std::env::var(SWITCH) {
        if off(&value) {
            return Some(Bypass::new(
                format!("{SWITCH}={value} in the environment"),
                "hooks are switched off for this environment",
            ));
        }
    }
    match std::env::var(TOKEN) {
        Ok(reason) if !reason.trim().is_empty() => Some(Bypass::new(
            format!("{TOKEN} in the environment"),
            reason,
        )),
        _ => None,
    }
}

fn off(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "off" | "0" | "false" | "no" | "none" | "disabled"
    )
}

fn from_files(here: &Path) -> Option<Bypass> {
    let mut probe = Some(here);
    for _ in 0..ANCESTORS {
        let Some(directory) = probe else { break };
        let marker = directory.join(MARKER);
        if marker.exists() {
            return Some(Bypass::new(
                format!("{}", marker.display()),
                std::fs::read_to_string(&marker).unwrap_or_default(),
            ));
        }
        probe = directory.parent();
    }
    let machine = crate::identity::data_dir()?.join(MACHINE_MARKER);
    machine.exists().then(|| {
        Bypass::new(
            format!("{}", machine.display()),
            std::fs::read_to_string(&machine).unwrap_or_default(),
        )
    })
}

/// The two places a session itself can ask: the command a gate is judging, and
/// the reply a stop gate is judging.
fn from_event(event: &Value) -> Option<Bypass> {
    let command = event
        .get("tool_input")
        .or_else(|| event.get("toolInput"))
        .and_then(|input| input.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if let Some(reason) = crate::lifecycle::leading_assignment(command, TOKEN) {
        return Some(Bypass::new(
            format!("{TOKEN} on the command being run"),
            reason,
        ));
    }
    let message = event
        .get("last_assistant_message")
        .and_then(Value::as_str)
        .unwrap_or("");
    let spoken = message.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&format!("{TOKEN}="))
            .filter(|reason| !reason.trim().is_empty())
    })?;
    Some(Bypass::new(format!("{TOKEN} in the reply"), spoken))
}

fn working_dir(event: &Value) -> PathBuf {
    event
        .get("tool_input")
        .or_else(|| event.get("toolInput"))
        .and_then(|input| input.get("workdir"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| event.get("cwd").and_then(Value::as_str).map(PathBuf::from))
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Say out loud that a gate stood down, and write it where it survives the
/// session that did it.
pub fn record(name: &str, bypass: &Bypass) {
    let line = format!(
        "{} {name} stood down — {} (via {})",
        crate::identity::NAME,
        bypass.reason,
        bypass.source
    );
    eprintln!("{line}");
    let Some(directory) = crate::identity::data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&directory);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(LOG))
    {
        let _ = writeln!(file, "{} {line}", chrono::Utc::now().to_rfc3339());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bypass_reads_a_leading_assignment_on_the_command_it_gates() {
        let event = json!({"tool_name":"Bash","tool_input":{
            "command":"ATELIER_BYPASS='landing is deadlocked' git merge --ff-only bw-1"}});
        let asked = from_event(&event).expect("the session may excuse itself");
        assert_eq!(asked.reason, "landing is deadlocked");
    }

    #[test]
    fn bypass_ignores_the_word_when_it_is_only_being_written_about() {
        for command in [
            "echo ATELIER_BYPASS=whatever",
            "grep -n ATELIER_BYPASS=x docs/hooks.md",
            "cat > docs/hooks.md <<'EOF'\nATELIER_BYPASS=example\nEOF",
        ] {
            let event = json!({"tool_name":"Bash","tool_input":{"command":command}});
            assert!(from_event(&event).is_none(), "excused by prose: {command}");
        }
    }

    #[test]
    fn bypass_hears_a_stop_gate_being_told_why() {
        let event = json!({"last_assistant_message":
            "I cannot close this card and the gate will not let the turn end.\nATELIER_BYPASS=the close gate wants a landed commit that cannot land"});
        let asked = from_event(&event).expect("a stop gate can be excused too");
        assert!(asked.reason.contains("landed commit"));
        let empty = json!({"last_assistant_message":"ATELIER_BYPASS="});
        assert!(from_event(&empty).is_none(), "a reason is required");
    }

    #[test]
    fn bypass_finds_a_marker_beside_any_ancestor_of_the_working_directory() {
        let tree = tempfile::tempdir().unwrap();
        let deep = tree.path().join("worktrees/bw-1/src");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(from_files(&deep).is_none());
        std::fs::write(tree.path().join(MARKER), "owner turned the gates off\n").unwrap();
        assert_eq!(
            from_files(&deep).unwrap().reason,
            "owner turned the gates off"
        );
    }

    #[test]
    fn bypass_marker_without_words_still_names_itself() {
        let tree = tempfile::tempdir().unwrap();
        std::fs::write(tree.path().join(MARKER), "").unwrap();
        let asked = from_files(tree.path()).unwrap();
        assert_eq!(asked.reason, "no reason given");
        assert!(asked.source.ends_with(MARKER));
    }

    #[test]
    fn bypass_switch_words_are_the_ones_a_person_would_type() {
        for value in ["off", "0", "false", "No", " none "] {
            assert!(off(value), "{value} should turn the gates off");
        }
        for value in ["on", "1", "true", ""] {
            assert!(!off(value), "{value} should leave the gates up");
        }
    }
}
