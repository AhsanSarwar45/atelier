//! What a chat says it is doing, written by the program itself.
//!
//! The screens draw five states — summarising, thinking, waiting on a
//! permission prompt, retrying, a helper working — and two of them cannot be
//! read off a chat's own record at all. A compaction and a permission prompt
//! are only visible from inside the session, as events, so the session has to
//! say so itself: a line beside the marker Claude Code already writes, naming
//! the state at the moment it begins and gone at the moment it ends.
//!
//! ```text
//! <CLAUDE_CONFIG_DIR>/sessions/<session_id>.doing.json
//! {"doing":"summarising","since":1787138400000,"detail":"auto"}
//! ```
//!
//! That line used to be written by `workbench/hooks/session-doing.py`, which
//! only runs where python3 is on the path. This product ships as one binary
//! with the screens inside it and no interpreter beside it, and its releases
//! target Windows, where python3 usually is not there — so on every computer
//! but the one this was built on the hook was registered and never ran, and
//! every chat read Working forever. The binary is the one thing that is always
//! present, so the binary writes the line (bw-14ij.1).
//!
//! Two halves, and they meet at a word:
//!
//!   * `atelier hook doing` is the gate, fed one event on standard input.
//!   * `join::install` writes that command into the PROJECT's own
//!     `.claude/settings.json` when somebody runs `atelier init`, beside every
//!     other gate this program registers, and `join::remove` takes it out
//!     again.
//!
//! It used to write itself into the reader's global `~/.claude/settings.json`
//! at every startup instead. That is one file for every project on the
//! computer, edited by a program the person only started, and it outlived the
//! app — so `unwire_global` now takes those registrations back out, and
//! nothing here writes there again (bw-t26l.20).
//!
//! The reader of what this writes is `src/workbench/doing-told.ts`, which
//! distrusts every byte: a half-written, abandoned or nonsensical line reads as
//! "nothing said" and the screen falls back to what it can work out for itself.
//! That contract is what lets this be as small as it is.
//!
//! Two rules hold throughout:
//!
//! **Never fail.** A gate that exits non-zero or writes to standard output
//! interrupts the session it is describing, and no status line is worth that.
//! Every path through the gate ends in 0 with nothing said.
//!
//! **Never widen.** Only a state the app has a word for is written, and only
//! when this event is the moment it begins. Everything else is left to the
//! reader, which can work it out from the record.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The word a settings file names, and the one gate this program answers to
/// itself rather than looking for on disk.
pub const GATE: &str = "doing";

/// The states this gate is allowed to claim. The app's vocabulary is wider —
/// thinking, retrying, a helper working — but those are read off the record,
/// and a gate writing a word the reader would have worked out anyway only adds
/// a way for the two to disagree.
const SUMMARISING: &str = "summarising";
const WAITING: &str = "waiting";

/// The one notification that is a state rather than a nudge. `idle_prompt`
/// says the session has been quiet, which the marker's own bit already says.
const PERMISSION: &str = "permission_prompt";

/// What the tool's own permission notification says, verbatim. There is no
/// tool name on that payload to read instead: the Notification schema shipped
/// in 2.1.240 is session_id, transcript_path, cwd, hook_event_name, message, an
/// optional title and notification_type, and the tool is named only inside the
/// sentence — `Claude needs your permission to use ${tool}`. The chip has room
/// for the one word, so the one word is what comes out of it (bw-jaoz.14.13).
const ASKING: &str = "needs your permission to use ";

/// A detail is a few words on a chip, never a paragraph.
const MOST: usize = 80;

/// The two events this gate answers to.
///
/// One per state, and no event whose only job is to take a state back. A
/// claim ends when the conversation writes its next line, which the reader
/// already watches for (`workbench::external::told`) — the record is the
/// authority on "something happened", and asking a session to report it a
/// second time bought nothing but five more registrations in somebody's
/// settings file (bw-t26l.20).
///
/// `join::install` is what registers them, in the project's own settings; this
/// list is here because it is this module's business which events it needs, and
/// `join`'s table names them beside every other gate.
pub const EVENTS: [(&str, bool); 2] = [
    // A compaction begins. It ends when the record's boundary line lands.
    ("PreCompact", true),
    // A permission prompt is the one wait that is a state. It ends when the
    // answer — approved, denied, or typed past — writes the next line.
    ("Notification", true),
];

/// Is this the gate the program answers to itself?
pub fn is_ours(name: &str) -> bool {
    name == GATE
}

/// Run the gate: one event on standard input, one line written or removed.
///
/// Gives back what to exit with, which is always 0.
pub fn run(heard: &str) -> i32 {
    if let Some(dir) = sessions_dir() {
        note(heard, &dir);
    }
    0
}

/// Where the tool keeps its markers, resolved the way the tool resolves it.
fn sessions_dir() -> Option<PathBuf> {
    claude_dir().map(|dir| dir.join("sessions"))
}

/// Where the reader's own Claude Code settings and markers live.
fn claude_dir() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.trim().is_empty() => Some(PathBuf::from(dir)),
        _ => directories::UserDirs::new().map(|dirs| dirs.home_dir().join(".claude")),
    }
}

/// One event, read and acted on. Anything it cannot make sense of is dropped.
fn note(heard: &str, sessions: &Path) {
    let Ok(Value::Object(data)) = serde_json::from_str::<Value>(heard) else {
        return;
    };
    // The file is named after the conversation, because that is what the screen
    // is drawing. Without one there is nothing to name, and a name holding a
    // separator is a path to somewhere else.
    let Some(id) = data.get("session_id").and_then(Value::as_str) else {
        return;
    };
    if id.is_empty() || id.contains('/') || id.contains('\\') {
        return;
    }

    match data.get("hook_event_name").and_then(Value::as_str) {
        // Its own word for why: `manual` is him typing /compact and watching,
        // `auto` is the window filling up, and the screen says which.
        Some("PreCompact") => say(sessions, id, SUMMARISING, a_word(&data, &["trigger", "matcher"])),
        // Six seconds after the prompt goes up, not the instant it does: the
        // tool holds this notification back that long and drops it entirely if
        // he answers first, so a wait the screen names is a wait he is actually
        // sitting in front of.
        Some("Notification") => {
            if a_word(&data, &["notification_type"]).as_deref() == Some(PERMISSION) {
                say(sessions, id, WAITING, asked_about(&data));
            }
        }
        _ => {}
    }
}

/// What a line says, in the order the reader's own tests read it.
#[derive(Serialize)]
struct Said<'a> {
    doing: &'a str,
    since: u128,
    detail: Option<&'a str>,
}

/// Write the line, whole or not at all.
///
/// Written to a neighbouring temporary file and renamed over the target, so a
/// reader on the other side of the beat sees either the previous line or this
/// one and never half of either.
fn say(sessions: &Path, id: &str, doing: &str, detail: Option<String>) {
    let body = serde_json::to_string(&Said {
        doing,
        since: now_ms(),
        detail: detail.as_deref(),
    })
    .unwrap_or_default();

    if std::fs::create_dir_all(sessions).is_err() {
        return;
    }
    let tmp = sessions.join(format!(".doing-{}-{}.tmp", std::process::id(), next()));
    if std::fs::write(&tmp, body).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return;
    }
    if std::fs::rename(&tmp, line_for(sessions, id)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn line_for(sessions: &Path, id: &str) -> PathBuf {
    sessions.join(format!("{id}.doing.json"))
}

/// The first of these keys holding something that reads as a word.
fn a_word(data: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(said) = data.get(*key).and_then(Value::as_str) {
            let said = said.trim();
            if !said.is_empty() {
                return Some(said.chars().take(MOST).collect());
            }
        }
    }
    None
}

/// The tool a permission prompt is asking about, in one word where it can be.
///
/// A tool name first, so a version that starts sending one is read straight
/// rather than parsed; the sentence next, which is where the tool is named
/// today; and the sentence whole if it is worded some way this does not know —
/// a long detail is worse than a short one and better than none.
fn asked_about(data: &Map<String, Value>) -> Option<String> {
    let said = a_word(data, &["tool_name", "message", "title"])?;
    let Some(at) = said.find(ASKING) else {
        return Some(said);
    };
    let tool = said[at + ASKING.len()..].trim().trim_matches('.').to_string();
    Some(if tool.is_empty() { said } else { tool })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0)
}

/// A number that is different every time inside one process, so two events
/// landing together cannot pick the same temporary name.
fn next() -> u64 {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    COUNT.fetch_add(1, Ordering::Relaxed)
}

/// Take this gate back out of the reader's global Claude settings.
///
/// Older copies of this program wrote themselves in there at every startup.
/// Nothing does now — the registration belongs to the project, written by
/// `atelier init` — so what those runs left behind is removed here rather than
/// left pointing at a binary that may not even be there. Only entries that are
/// this gate are touched; everything else in the file is written back exactly
/// as it was found, and a file that cannot be read is left alone.
///
/// Says how many registrations it took out, which is 0 on every computer that
/// never ran one of those copies.
pub fn unwire_global() -> Result<(usize, PathBuf), String> {
    let Some(dir) = claude_dir() else {
        return Err("this computer names no home folder".to_string());
    };
    let settings = dir.join("settings.json");
    let taken = unwire(&settings)?;
    Ok((taken, settings))
}

/// The rule behind it, kept apart from the environment so it can be run
/// against a folder that is not the reader's own.
fn unwire(settings: &Path) -> Result<usize, String> {
    let text = match std::fs::read_to_string(settings) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("{}: {e}", settings.display())),
    };
    let mut root: Value = match serde_json::from_str(&text) {
        Ok(Value::Object(held)) => Value::Object(held),
        _ => {
            return Err(format!(
                "{} is not something this can read, so it was left alone",
                settings.display()
            ))
        }
    };
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(0);
    };
    let mut taken = 0;
    for (_, listed) in hooks.iter_mut() {
        let Some(blocks) = listed.as_array_mut() else {
            continue;
        };
        for block in blocks.iter_mut() {
            if let Some(held) = block.get_mut("hooks").and_then(Value::as_array_mut) {
                let before = held.len();
                held.retain(|hook| {
                    !hook.get("command").and_then(Value::as_str).is_some_and(ours)
                });
                taken += before - held.len();
            }
        }
        // A block left with nothing in it is this program's litter, not the
        // reader's: it only ever held this gate.
        blocks.retain(|block| {
            block["hooks"]
                .as_array()
                .is_none_or(|held| !held.is_empty())
        });
    }
    if taken == 0 {
        return Ok(0);
    }
    // An event this program emptied out entirely goes too, for the same reason.
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        hooks.retain(|_, listed| listed.as_array().is_none_or(|blocks| !blocks.is_empty()));
        let empty = hooks.is_empty();
        if empty {
            root.as_object_mut().expect("an object").remove("hooks");
        }
    }
    write_whole(settings, &root)?;
    Ok(taken)
}

/// Is this command line this gate, whichever copy of the program it names?
fn ours(command: &str) -> bool {
    command.trim_end().ends_with(&format!("hook {GATE}"))
}

/// Write the settings whole, or leave what was there.
fn write_whole(settings: &Path, root: &Value) -> Result<(), String> {
    let mut body = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    body.push('\n');
    if let Some(dir) = settings.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // Renamed over the file rather than written into it, so a copy stopped
    // halfway leaves the reader the settings they had rather than half of them.
    let tmp = settings.with_extension(format!("atelier-{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, settings).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", settings.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A chat's name, which is what the line is filed under.
    const CHAT: &str = "a-conversation";

    fn settings_in(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    fn read(at: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(at).expect("a settings file")).expect("json")
    }

    /// Every command registered for one event.
    fn commands(root: &Value, event: &str) -> Vec<String> {
        root["hooks"][event]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .flat_map(|held| held["hooks"].as_array().cloned().unwrap_or_default())
            .filter_map(|hook| hook["command"].as_str().map(str::to_string))
            .collect()
    }

    fn fire(sessions: &Path, event: Value) {
        note(&event.to_string(), sessions);
    }

    fn line(sessions: &Path) -> Option<Value> {
        let text = std::fs::read_to_string(line_for(sessions, CHAT)).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// What older copies wrote into the reader's global settings, taken back
    /// out — and nothing else in that file touched (bw-t26l.20).
    #[test]
    fn what_older_copies_wrote_into_the_global_settings_is_taken_back_out() {
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        std::fs::write(
            &settings,
            serde_json::to_string_pretty(&json!({
                "model": "opus",
                "hooks": {
                    "PreCompact": [{"matcher": "", "hooks": [
                        {"type": "command", "command": "\"/opt/atelier\" hook doing"}
                    ]}],
                    "Stop": [{"hooks": [
                        {"type": "command", "command": "their-own-gate.py"},
                        {"type": "command", "command": "\"/opt/atelier\" hook doing"}
                    ]}]
                }
            }))
            .unwrap(),
        )
        .expect("a settings file to start from");

        assert_eq!(unwire(&settings).expect("the removal"), 2);

        let held = read(&settings);
        assert_eq!(held["model"], json!("opus"), "a setting of theirs was dropped");
        assert_eq!(
            commands(&held, "Stop"),
            vec!["their-own-gate.py".to_string()],
            "their own gate went with ours"
        );
        assert!(
            held["hooks"].get("PreCompact").is_none(),
            "an event holding nothing but ours was left behind: {held}"
        );

        // Nothing of ours left, so a second run has nothing to do and does not
        // rewrite the file.
        let after = std::fs::read(&settings).expect("a settings file");
        assert_eq!(unwire(&settings).expect("the second run"), 0);
        assert_eq!(std::fs::read(&settings).expect("a settings file"), after);
    }

    #[test]
    fn a_settings_file_it_cannot_read_is_left_exactly_as_it_was() {
        // Overwriting a file it failed to parse would take somebody's whole
        // configuration with it, and it would do so silently.
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        std::fs::write(&settings, "{ this is not json").expect("a settings file");

        let refused = unwire(&settings);

        assert!(refused.is_err(), "it wrote over a file it could not read");
        assert_eq!(
            std::fs::read_to_string(&settings).expect("a settings file"),
            "{ this is not json"
        );
    }

    /// A computer that never ran one of those copies has no global settings
    /// file at all, and this must not make one.
    #[test]
    fn a_computer_with_no_global_settings_is_left_without_any() {
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        assert_eq!(unwire(&settings).expect("nothing to do"), 0);
        assert!(!settings.exists(), "it wrote a settings file of its own");
    }

    #[test]
    fn a_compaction_beginning_is_written_down_with_its_reason() {
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");
        fire(
            &sessions,
            json!({"hook_event_name": "PreCompact", "session_id": CHAT, "trigger": "auto"}),
        );

        let said = line(&sessions).expect("a line");
        assert_eq!(said["doing"], json!("summarising"));
        assert_eq!(said["detail"], json!("auto"));
        assert!(said["since"].as_u64().unwrap_or(0) > 1_700_000_000_000);
    }

    #[test]
    fn a_permission_prompt_names_the_tool_out_of_the_sentence_it_is_asked_in() {
        // There is no tool name on that payload. The sentence is where the tool
        // is named, and the chip has room for the one word (bw-jaoz.14.13).
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");
        fire(
            &sessions,
            json!({
                "hook_event_name": "Notification",
                "session_id": CHAT,
                "notification_type": "permission_prompt",
                "message": "Claude needs your permission to use Bash"
            }),
        );

        let said = line(&sessions).expect("a line");
        assert_eq!(said["doing"], json!("waiting"));
        assert_eq!(said["detail"], json!("Bash"));
    }

    #[test]
    fn a_notification_that_is_only_a_nudge_says_nothing() {
        // `idle_prompt` says the session has been quiet, which the marker's own
        // bit already says.
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");
        fire(
            &sessions,
            json!({
                "hook_event_name": "Notification",
                "session_id": CHAT,
                "notification_type": "idle_prompt",
                "message": "Claude is waiting for your input"
            }),
        );

        assert_eq!(line(&sessions), None);
    }

    #[test]
    fn the_events_it_asks_to_be_wired_to_are_the_ones_it_answers() {
        // Every registration costs a line in somebody's settings file, so a
        // gate that asks for an event it does nothing with is asking for
        // nothing. The two it asks for are the two states it can claim.
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");

        for (event, _) in EVENTS {
            fire(
                &sessions,
                json!({"hook_event_name": event, "session_id": CHAT,
                       "notification_type": "permission_prompt",
                       "message": "Claude needs your permission to use Edit"}),
            );
            assert!(
                line(&sessions).is_some(),
                "{event} is registered and says nothing"
            );
            std::fs::remove_file(sessions.join(format!("{CHAT}.doing.json"))).expect("the line");
        }
    }

    #[test]
    fn the_events_that_only_took_a_claim_back_are_not_asked_for_any_more() {
        // The record says "something happened" already, and the reader ends a
        // claim on the conversation's next line, so these five bought only
        // registrations (bw-t26l.20).
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");
        fire(&sessions, json!({"hook_event_name": "PreCompact", "session_id": CHAT}));

        for gone in ["PostCompact", "Stop", "SessionEnd", "PostToolUse", "UserPromptSubmit"] {
            assert!(
                !EVENTS.iter().any(|(event, _)| *event == gone),
                "{gone} is still registered"
            );
            fire(&sessions, json!({"hook_event_name": gone, "session_id": CHAT}));
        }

        assert_eq!(
            line(&sessions).expect("the compaction to still stand")["doing"],
            json!("summarising"),
            "an event it no longer asks for still moved the line"
        );
    }

    #[test]
    fn nothing_it_cannot_make_sense_of_is_worth_interrupting_a_session_for() {
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");

        note("not json at all", &sessions);
        note("[]", &sessions);
        note(&json!({"hook_event_name": "PreCompact"}).to_string(), &sessions);
        note(
            &json!({"hook_event_name": "PreCompact", "session_id": "../elsewhere"}).to_string(),
            &sessions,
        );
        note(&json!({"hook_event_name": "Whatever", "session_id": CHAT}).to_string(), &sessions);

        assert_eq!(line(&sessions), None);
        assert!(
            !home.path().join("elsewhere.doing.json").exists(),
            "a name holding a path wrote outside the folder"
        );
    }

}
