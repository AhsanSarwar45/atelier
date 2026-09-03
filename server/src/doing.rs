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
//!   * `wire_up` writes that command into the reader's own Claude settings the
//!     first time the app runs, and says one line about having done it.
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
use serde_json::{json, Map, Value};
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

/// The seven events, and whether the entry carries an empty matcher.
///
/// The shapes are the ones already proven to fire in this repository's own
/// settings file rather than a guess at what the schema tolerates: three of
/// these events are written there with `"matcher": ""` and four with no matcher
/// at all, and both have been running the gate for weeks.
const EVENTS: [(&str, bool); 7] = [
    // A compaction begins, and ends.
    ("PreCompact", true),
    ("PostCompact", true),
    // A permission prompt is the one wait that is a state.
    ("Notification", true),
    // The turn ends, whatever it was doing.
    ("Stop", false),
    // The session goes away.
    ("SessionEnd", false),
    // The tool ran, so the permission prompt was answered.
    ("PostToolUse", false),
    // He typed instead of answering it.
    ("UserPromptSubmit", false),
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
        Some("PostCompact") | Some("SessionEnd") => hush(sessions, id, None),
        // Stop fires when the turn ends, and also on clear, resume and compact.
        // A compaction in flight has its own end signal, so the summarising
        // claim is left alone here and only the wait is cleared.
        Some("Stop") => hush(sessions, id, Some(WAITING)),
        // Six seconds after the prompt goes up, not the instant it does: the
        // tool holds this notification back that long and drops it entirely if
        // he answers first, so a wait the screen names is a wait he is actually
        // sitting in front of.
        Some("Notification") => {
            if a_word(&data, &["notification_type"]).as_deref() == Some(PERMISSION) {
                say(sessions, id, WAITING, asked_about(&data));
            }
        }
        Some("PostToolUse") | Some("UserPromptSubmit") => hush(sessions, id, Some(WAITING)),
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

/// Remove the line — every state ends by there being nothing to say.
///
/// `only` narrows it to one claim: the tool finishing running answers a
/// permission prompt and says nothing at all about a compaction, and a clear
/// that fires while one is in flight would otherwise blank the bar mid-fill.
fn hush(sessions: &Path, id: &str, only: Option<&str>) {
    let target = line_for(sessions, id);
    if let Some(claim) = only {
        let Ok(text) = std::fs::read_to_string(&target) else {
            return;
        };
        let Ok(Value::Object(standing)) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        if standing.get("doing").and_then(Value::as_str) != Some(claim) {
            return;
        }
    }
    let _ = std::fs::remove_file(&target);
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

/// What the wiring found to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Wired {
    /// It was already wired to this copy. Nothing was written.
    Already,
    /// It was not wired at all, and now is.
    Added,
    /// It was wired to a copy that has since moved, and now names this one.
    Moved,
}

/// Wire the reader's own chats up to say what they are doing.
///
/// The registration goes in the settings that hold for every project on this
/// computer rather than one checkout's, because a chat is a chat wherever it
/// was opened, and a per-project file would leave the states appearing in the
/// one folder somebody remembered to set up.
///
/// Everything already in that file is kept: it is read, one branch of it is
/// added to, and it is written back whole. A file that cannot be read is an
/// error and is not touched, because a settings file this could not parse is a
/// settings file it must not overwrite.
pub fn wire_up() -> Result<(Wired, PathBuf), String> {
    let Some(dir) = claude_dir() else {
        return Err("this computer names no home folder".to_string());
    };
    let settings = dir.join("settings.json");
    let exe = std::env::current_exe().map_err(|e| format!("this program cannot say where it is: {e}"))?;
    let done = wire(&settings, &exe)?;
    Ok((done, settings))
}

/// The one line it says about having done it.
pub fn said_it(done: &Wired, settings: &Path) -> Option<String> {
    match done {
        Wired::Already => None,
        Wired::Added => Some(format!(
            "{} wired your chats up to say what they are doing — added to {}.",
            crate::identity::DISPLAY,
            settings.display()
        )),
        Wired::Moved => Some(format!(
            "{} moved, so your chats were wired up to it again in {}.",
            crate::identity::DISPLAY,
            settings.display()
        )),
    }
}

/// The rule behind it, kept apart from the environment so it can be run
/// against a folder that is not the reader's own.
fn wire(settings: &Path, exe: &Path) -> Result<Wired, String> {
    // Quoted, because a hook command is handed to a shell and the folder a
    // person installs into has a space in it more often than not.
    let want = format!("\"{}\" hook {GATE}", exe.display());

    let mut root = match std::fs::read_to_string(settings) {
        Ok(text) if text.trim().is_empty() => Map::new(),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(held)) => held,
            _ => {
                return Err(format!(
                    "{} is not something this can read, so it was left alone",
                    settings.display()
                ))
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(format!("{}: {e}", settings.display())),
    };

    let hooks = match root.entry("hooks").or_insert_with(|| Value::Object(Map::new())) {
        Value::Object(hooks) => hooks,
        _ => {
            return Err(format!(
                "the gates in {} are not written the way this understands, so it was left alone",
                settings.display()
            ))
        }
    };

    let mut done = Wired::Already;
    for (event, matcher) in EVENTS {
        let listed = match hooks.entry(event).or_insert_with(|| Value::Array(Vec::new())) {
            Value::Array(listed) => listed,
            _ => {
                return Err(format!(
                    "the {event} gates in {} are not written the way this understands, so it was left alone",
                    settings.display()
                ))
            }
        };
        match standing(listed) {
            Some(held) if held == want => {}
            // The copy it names has moved — a new install, or a binary carried
            // to another folder. Left alone, the gate would be a command that
            // is not there and every chat would quietly stop saying anything.
            Some(_) => {
                point_at(listed, &want);
                if done == Wired::Already {
                    done = Wired::Moved;
                }
            }
            None => {
                listed.push(entry(&want, matcher));
                done = Wired::Added;
            }
        }
    }

    if done == Wired::Already {
        return Ok(done);
    }
    write_whole(settings, &Value::Object(root))?;
    Ok(done)
}

/// One registration, in the shape a settings file holds them.
fn entry(command: &str, matcher: bool) -> Value {
    let mut held = Map::new();
    if matcher {
        held.insert("matcher".to_string(), Value::String(String::new()));
    }
    held.insert(
        "hooks".to_string(),
        json!([{ "type": "command", "command": command }]),
    );
    Value::Object(held)
}

/// The command this gate is registered as here already, if it is at all.
fn standing(listed: &[Value]) -> Option<String> {
    for held in listed {
        let Some(hooks) = held.get("hooks").and_then(Value::as_array) else {
            continue;
        };
        for hook in hooks {
            if let Some(command) = hook.get("command").and_then(Value::as_str) {
                if ours(command) {
                    return Some(command.to_string());
                }
            }
        }
    }
    None
}

/// Point the registration already there at this copy, wherever it sits.
fn point_at(listed: &mut [Value], want: &str) {
    for held in listed.iter_mut() {
        let Some(hooks) = held.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        for hook in hooks.iter_mut() {
            let is_ours = hook.get("command").and_then(Value::as_str).map(ours).unwrap_or(false);
            if is_ours {
                if let Some(command) = hook.get_mut("command") {
                    *command = Value::String(want.to_string());
                }
            }
        }
    }
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

    #[test]
    fn a_computer_that_has_never_run_it_gets_the_gate_and_one_line_saying_so() {
        // What the manager asked for: it wires itself up the first time it
        // runs, and tells him it did.
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());

        let done = wire(&settings, Path::new("/opt/atelier")).expect("the wiring to happen");

        assert_eq!(done, Wired::Added);
        let held = read(&settings);
        for (event, _) in EVENTS {
            assert_eq!(
                commands(&held, event),
                vec!["\"/opt/atelier\" hook doing".to_string()],
                "{event} was not wired"
            );
        }
        let said = said_it(&done, &settings).expect("a line saying it did");
        assert_eq!(said.lines().count(), 1, "more than one line: {said}");
        assert!(said.contains("what they are doing"), "{said}");
    }

    #[test]
    fn running_it_a_second_time_changes_nothing_at_all() {
        // A settings file rewritten on every start is a settings file whose
        // history is this program's log.
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        wire(&settings, Path::new("/opt/atelier")).expect("the first run");
        let after_first = std::fs::read(&settings).expect("a settings file");

        let done = wire(&settings, Path::new("/opt/atelier")).expect("the second run");

        assert_eq!(done, Wired::Already);
        assert_eq!(said_it(&done, &settings), None, "it announced itself twice");
        assert_eq!(
            std::fs::read(&settings).expect("a settings file"),
            after_first,
            "the second run rewrote the file"
        );
    }

    #[test]
    fn everything_the_reader_already_had_is_still_there() {
        // It writes into a file somebody maintains by hand. Anything of theirs
        // this drops, they find out about by something of theirs stopping.
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        std::fs::write(
            &settings,
            serde_json::to_string_pretty(&json!({
                "model": "opus",
                "hooks": {
                    "Stop": [{"hooks": [{"type": "command", "command": "their-own-gate.py"}]}],
                    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "theirs.py"}]}]
                }
            }))
            .unwrap(),
        )
        .expect("a settings file to start from");

        wire(&settings, Path::new("/opt/atelier")).expect("the wiring to happen");

        let held = read(&settings);
        assert_eq!(held["model"], json!("opus"), "a setting of theirs was dropped");
        assert!(
            commands(&held, "Stop").contains(&"their-own-gate.py".to_string()),
            "their own Stop gate was dropped"
        );
        assert!(
            commands(&held, "PreToolUse").contains(&"theirs.py".to_string()),
            "an event this does not touch was rewritten"
        );
        assert!(commands(&held, "Stop").iter().any(|c| ours(c)), "and ours is not there");
    }

    #[test]
    fn a_settings_file_it_cannot_read_is_left_exactly_as_it_was() {
        // Overwriting a file it failed to parse would take somebody's whole
        // configuration with it, and it would do so silently.
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        std::fs::write(&settings, "{ this is not json").expect("a settings file");

        let refused = wire(&settings, Path::new("/opt/atelier"));

        assert!(refused.is_err(), "it wrote over a file it could not read");
        assert_eq!(
            std::fs::read_to_string(&settings).expect("a settings file"),
            "{ this is not json"
        );
    }

    #[test]
    fn the_program_moving_takes_the_wiring_with_it() {
        // An upgrade, or a binary carried to another folder. Left alone, the
        // gate names a command that is not there and every chat quietly stops
        // saying anything.
        let home = tempfile::tempdir().expect("a folder");
        let settings = settings_in(home.path());
        wire(&settings, Path::new("/somewhere/old/atelier")).expect("the first run");

        let done = wire(&settings, Path::new("/somewhere/new/atelier")).expect("the second run");

        assert_eq!(done, Wired::Moved);
        for (event, _) in EVENTS {
            assert_eq!(
                commands(&read(&settings), event),
                vec!["\"/somewhere/new/atelier\" hook doing".to_string()],
                "{event} was left pointing at the copy that moved, or wired twice"
            );
        }
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
    fn a_compaction_ending_takes_the_line_away() {
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");
        fire(&sessions, json!({"hook_event_name": "PreCompact", "session_id": CHAT}));
        fire(&sessions, json!({"hook_event_name": "PostCompact", "session_id": CHAT}));

        assert_eq!(line(&sessions), None);
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
    fn the_turn_ending_clears_a_wait_and_leaves_a_compaction_alone() {
        // Stop fires on clear, resume and compact as well as at the end of a
        // turn, and a compaction has its own end signal. Clearing here would
        // blank the bar halfway through filling.
        let home = tempfile::tempdir().expect("a folder");
        let sessions = home.path().join("sessions");

        fire(&sessions, json!({"hook_event_name": "PreCompact", "session_id": CHAT}));
        fire(&sessions, json!({"hook_event_name": "Stop", "session_id": CHAT}));
        assert_eq!(
            line(&sessions).expect("the compaction to still stand")["doing"],
            json!("summarising")
        );

        fire(
            &sessions,
            json!({"hook_event_name": "Notification", "session_id": CHAT,
                   "notification_type": "permission_prompt",
                   "message": "Claude needs your permission to use Edit"}),
        );
        fire(&sessions, json!({"hook_event_name": "PostToolUse", "session_id": CHAT}));
        assert_eq!(line(&sessions), None, "the answered wait was left standing");
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
