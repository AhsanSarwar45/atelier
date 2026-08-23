//! One copy of the program giving way to another.
//!
//! Two faults sat here, and they are the same fault seen from two sides. A
//! reader who installed a newer build was left looking at the old one: nothing
//! told the running copy anything had changed and nothing restarted it, so the
//! install appeared to do nothing at all. And starting the program by hand
//! while that copy was serving died on a bind error and a debugger hint,
//! several healthy lines into a startup it then abandoned — when the honest
//! answer is one short paragraph: it is already running, here is where to open
//! it, and here is which copy that is (bw-8um.3.10).
//!
//! Everything that decides is a plain function over values, so the decisions
//! are tested rather than described.

use serde::Deserialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// How often the running copy looks at the program it would be restarted from.
const LOOK_EVERY: Duration = Duration::from_secs(10);

/// How long a change has to hold still before it counts.
///
/// An install is not atomic on every platform: for a moment the file can be
/// half written, or briefly absent. Handing over on that would restart into
/// something that cannot run.
const SETTLE: Duration = Duration::from_secs(3);

/* ------------------------------------------------------------------ *
 * Which build this is.
 * ------------------------------------------------------------------ */

/// The program file this process is running, as this computer names it.
pub fn program() -> Option<PathBuf> {
    std::env::current_exe().ok().map(|path| PathBuf::from(without_the_deleted_mark(&path.display().to_string())))
}

/// Linux answers "where is this program" with the path and, once a newer build
/// has been installed over it, the word `(deleted)` on the end. That is a note
/// about the old file, not part of any path, and printed as one it reads like
/// the program is missing when it is simply out of date.
pub fn without_the_deleted_mark(path: &str) -> &str {
    path.strip_suffix(" (deleted)").unwrap_or(path)
}

/// A short name for the exact file this process is running.
///
/// Two builds of the same version are the case this exists for: the version
/// alone cannot tell them apart, which is how a reader ended up with a build
/// that had no Reports tab and nothing to ask about it. This is a hash of the
/// file's own bytes — enough to say "not the same file", which is the only
/// question ever put to it, and never offered as a certified digest.
pub fn fingerprint() -> &'static str {
    static PRINT: OnceLock<String> = OnceLock::new();
    PRINT.get_or_init(|| match program().as_deref().and_then(look) {
        Some(seen) => print_of(&seen),
        None => "unknown".to_string(),
    })
}

/// When this copy started, in the one format that reads the same everywhere.
pub fn started_at() -> &'static str {
    static SINCE: OnceLock<String> = OnceLock::new();
    SINCE.get_or_init(|| chrono::Utc::now().to_rfc3339())
}

/// What one look at a program file found.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Seen {
    pub len: u64,
    pub mark: u64,
}

/// Look at a program file. Nothing if it is not there or cannot be read.
pub fn look(path: &Path) -> Option<Seen> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(Seen { len: bytes.len() as u64, mark: hasher.finish() })
}

/// The short name a look is reported under.
pub fn print_of(seen: &Seen) -> String {
    format!("{:016x}", seen.mark)
}

/* ------------------------------------------------------------------ *
 * Handing over to a newer build.
 * ------------------------------------------------------------------ */

/// Whether a different program now sits where this copy would be restarted
/// from.
///
/// Never on a first look that found nothing: a path this copy could not read
/// at startup says nothing about what is there now, and guessing would restart
/// a healthy server for no reason.
pub fn a_newer_build_is_there(before: Option<Seen>, now: Option<Seen>) -> bool {
    match (before, now) {
        (Some(was), Some(is)) => was != is,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// Whether something will start this program again if it stops.
///
/// Handing over is only ever right when somebody is there to catch it. Started
/// by hand, exiting would leave the reader with nothing running and no word of
/// why — so this copy stays where it is and lets the reader restart it.
///
/// Windows keeps its own list and hands out no such mark; a scheduled task does
/// not restart a program that exits, so nothing hands over there.
pub fn something_would_start_it_again(
    label: &str,
    systemd_mark: Option<&str>,
    launchd_mark: Option<&str>,
) -> bool {
    systemd_mark.is_some_and(|mark| !mark.is_empty()) || launchd_mark == Some(label)
}

/// The same question, asked of this process's own environment.
pub fn started_by_this_computer() -> bool {
    let systemd = std::env::var("INVOCATION_ID").ok();
    let launchd = std::env::var("XPC_SERVICE_NAME").ok();
    something_would_start_it_again(
        &crate::service::agent_label(),
        systemd.as_deref(),
        launchd.as_deref(),
    )
}

/// Watch the program this copy would be restarted from, and stand down when a
/// newer one is installed over it.
///
/// The registered path rather than this process's own: an install through a
/// package manager retargets a link and leaves the file this process is
/// running deleted underneath it, so the only path that still names the next
/// build is the one the computer was told to start.
pub fn stand_down_for_a_newer_build(registered: PathBuf) {
    if !started_by_this_computer() {
        return;
    }
    // A registration written by an older build brings the program back only
    // when it dies, so standing down on purpose under that rule leaves the
    // reader with nothing running — worse than the stale build they had. One
    // line, and they know what to type.
    if crate::service::registration_comes_back_however_it_stops() != Some(true) {
        tracing::warn!(
            "this computer was told to start {} again only if it fails, so a newer build \
             installed over it will not take over on its own — run `{} service install` \
             from the copy you want it to start",
            crate::identity::DISPLAY,
            crate::identity::NAME
        );
        return;
    }
    let Some(at_start) = look(&registered) else {
        tracing::warn!(
            "the program this computer starts at login could not be read at {}, \
             so a newer build installed over it will not be noticed until the next restart",
            registered.display()
        );
        return;
    };
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(LOOK_EVERY).await;
            let now = look(&registered);
            if !a_newer_build_is_there(Some(at_start), now) {
                continue;
            }
            // Let it settle, then look once more. A half-written file is not a
            // newer build, and restarting into one serves nobody.
            tokio::time::sleep(SETTLE).await;
            let settled = look(&registered);
            if !a_newer_build_is_there(Some(at_start), settled) {
                continue;
            }
            if settled.is_none() {
                tracing::warn!(
                    "{} is gone from {}, standing down so this computer can start whatever replaced it",
                    crate::identity::DISPLAY,
                    registered.display()
                );
            } else {
                tracing::info!(
                    "a newer build of {} was installed at {}, standing down so it takes over",
                    crate::identity::DISPLAY,
                    registered.display()
                );
            }
            std::process::exit(0);
        }
    });
}

/* ------------------------------------------------------------------ *
 * Finding one already there.
 * ------------------------------------------------------------------ */

/// What a copy already holding the port says about itself.
#[derive(Debug, Default, Deserialize)]
pub struct Answering {
    pub product: Option<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    pub program: Option<String>,
    pub since: Option<String>,
}

/// Ask whatever holds the port who it is. Nothing if it is not this product.
pub async fn who_is_there(port: u16) -> Option<Answering> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()?;
    let said: Answering = client
        .get(format!("http://127.0.0.1:{port}/api/health"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    (said.product.as_deref() == Some(crate::identity::NAME)).then_some(said)
}

/// What to say, and what to exit with, when the port is already taken.
///
/// Exit 0 when it is this product: nothing is wrong, the thing the reader
/// wanted running is running, and a failing exit code in a login script would
/// turn that into an error report. A stranger on the port is a real failure and
/// says so.
pub fn already_serving(
    who: Option<&Answering>,
    ours: Option<&str>,
    port: u16,
    openable: &[String],
) -> (String, i32) {
    let display = crate::identity::DISPLAY;
    let name = crate::identity::NAME;
    let Some(who) = who else {
        return (
            format!(
                "Something that is not {display} is already using port {port}, so nothing was started.\n\
                 Stop it, or start {name} on another port with ATELIER_PORT.\n"
            ),
            1,
        );
    };

    let mut said = format!("{display} is already running.\n");
    for line in openable {
        said.push_str(&format!("  {line}\n"));
    }
    said.push_str(&format!(
        "That copy is {} ({}), {}.\n",
        who.version.as_deref().unwrap_or("of an unknown version"),
        who.build
            .as_deref()
            .map(|b| format!("build {b}"))
            .unwrap_or_else(|| "build unknown".to_string()),
        who.since
            .as_deref()
            .and_then(|since| started_ago(since, chrono::Utc::now()))
            .unwrap_or_else(|| "started at an unknown time".to_string()),
    ));

    if let Some(note) = a_different_copy(who.program.as_deref(), ours) {
        said.push_str(&note);
    }
    said.push_str("Nothing new was started.\n");
    (said, 0)
}

/// How long the copy on the port has been up, in words.
///
/// A machine-readable moment, to the nanosecond, is the wrong answer to "how
/// long has this been running" — the reader has to subtract it from the clock
/// themselves. Nothing when the moment cannot be read, rather than a wrong
/// number.
pub fn started_ago(since: &str, now: chrono::DateTime<chrono::Utc>) -> Option<String> {
    let then = chrono::DateTime::parse_from_rfc3339(since).ok()?;
    let seconds = now.signed_duration_since(then.with_timezone(&chrono::Utc)).num_seconds();
    if seconds < 0 {
        return None;
    }
    let (count, unit) = match seconds {
        s if s < 90 => (s, "second"),
        s if s < 5400 => (s / 60, "minute"),
        s if s < 172_800 => (s / 3600, "hour"),
        s => (s / 86_400, "day"),
    };
    Some(format!("running for {count} {unit}{}", if count == 1 { "" } else { "s" }))
}

/// The paragraph printed when the copy that is serving is a different program
/// from the one just run.
///
/// This is the case that cost a reader an afternoon: the computer was told to
/// start one file at login, a newer build was installed somewhere else
/// entirely, and neither of them ever mentioned the other. Naming both paths
/// and the one command that repoints the computer is the whole fix.
pub fn a_different_copy(serving: Option<&str>, ours: Option<&str>) -> Option<String> {
    let (serving, ours) = (serving?, ours?);
    if same_program(serving, ours) {
        return None;
    }
    let name = crate::identity::NAME;
    Some(format!(
        "It is a different copy of the program from the one you just ran:\n\
         \x20 this computer starts  {serving}\n\
         \x20 you ran               {ours}\n\
         To have it start yours instead, run `{name} service install` from yours.\n"
    ))
}

/// Whether two paths name the same program, following links where it can.
fn same_program(one: &str, two: &str) -> bool {
    if one == two {
        return true;
    }
    match (std::fs::canonicalize(one), std::fs::canonicalize(two)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answering(program: &str, version: &str) -> Answering {
        Answering {
            product: Some(crate::identity::NAME.to_string()),
            version: Some(version.to_string()),
            build: Some("0123456789abcdef".to_string()),
            program: Some(program.to_string()),
            since: Some("2026-08-23T10:00:00Z".to_string()),
        }
    }

    #[test]
    fn handover_happens_when_a_different_program_sits_where_this_one_started() {
        let was = Seen { len: 10, mark: 1 };
        assert!(a_newer_build_is_there(Some(was), Some(Seen { len: 11, mark: 2 })));
        assert!(!a_newer_build_is_there(Some(was), Some(was)));
    }

    #[test]
    fn handover_happens_when_the_program_it_would_restart_from_is_taken_away() {
        // A package manager that replaces a link leaves the file this process
        // is running deleted underneath it.
        assert!(a_newer_build_is_there(Some(Seen { len: 10, mark: 1 }), None));
    }

    #[test]
    fn handover_never_happens_on_a_path_that_was_unreadable_to_begin_with() {
        assert!(!a_newer_build_is_there(None, Some(Seen { len: 10, mark: 1 })));
        assert!(!a_newer_build_is_there(None, None));
    }

    #[test]
    fn handover_only_where_something_would_start_it_again() {
        assert!(something_would_start_it_again("com.example.atelier", Some("abc123"), None));
        assert!(something_would_start_it_again("com.example.atelier", None, Some("com.example.atelier")));
        // A terminal on macOS carries this mark too, naming something else.
        assert!(!something_would_start_it_again(
            "com.example.atelier",
            None,
            Some("application.com.apple.Terminal.1.2")
        ));
        assert!(!something_would_start_it_again("com.example.atelier", None, None));
        assert!(!something_would_start_it_again("com.example.atelier", Some(""), None));
    }

    #[test]
    fn already_serving_names_where_to_open_it_and_calls_it_no_failure() {
        let who = answering("/usr/bin/atelier", "0.13.0");
        let (said, code) = already_serving(
            Some(&who),
            Some("/usr/bin/atelier"),
            3008,
            &["http://desk.local:3008".to_string(), "http://192.168.1.11:3008".to_string()],
        );
        assert_eq!(code, 0, "{said}");
        assert!(said.contains("http://192.168.1.11:3008"), "{said}");
        assert!(said.contains("0.13.0"), "{said}");
        assert!(said.contains("build 0123456789abcdef"), "{said}");
        assert!(!said.contains("service install"), "same program, nothing to repoint: {said}");
    }

    #[test]
    fn already_serving_a_stranger_on_the_port_is_a_failure_and_names_the_way_out() {
        let (said, code) = already_serving(None, Some("/usr/bin/atelier"), 3008, &[]);
        assert_eq!(code, 1, "{said}");
        assert!(said.contains("3008"), "{said}");
        assert!(said.contains("ATELIER_PORT"), "{said}");
    }

    #[test]
    fn already_serving_an_older_copy_names_both_programs_and_the_one_command() {
        let who = answering("/home/me/.local/bin/atelier", "0.12.2");
        let (said, code) = already_serving(
            Some(&who),
            Some("/home/linuxbrew/.linuxbrew/bin/atelier"),
            3008,
            &["http://192.168.1.11:3008".to_string()],
        );
        assert_eq!(code, 0, "{said}");
        assert!(said.contains("/home/me/.local/bin/atelier"), "{said}");
        assert!(said.contains("/home/linuxbrew/.linuxbrew/bin/atelier"), "{said}");
        assert!(said.contains("service install"), "{said}");
    }

    #[test]
    fn registered_elsewhere_says_nothing_when_the_two_paths_are_the_same_program() {
        assert!(a_different_copy(Some("/usr/bin/atelier"), Some("/usr/bin/atelier")).is_none());
    }

    #[test]
    fn registered_elsewhere_says_nothing_when_either_side_is_unknown() {
        assert!(a_different_copy(None, Some("/usr/bin/atelier")).is_none());
        assert!(a_different_copy(Some("/usr/bin/atelier"), None).is_none());
    }

    #[test]
    fn already_serving_says_how_long_it_has_been_up_in_words() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-23T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(started_ago("2026-08-23T11:59:59Z", now).as_deref(), Some("running for 1 second"));
        assert_eq!(started_ago("2026-08-23T11:50:00Z", now).as_deref(), Some("running for 10 minutes"));
        assert_eq!(started_ago("2026-08-23T09:00:00Z", now).as_deref(), Some("running for 3 hours"));
        assert_eq!(started_ago("2026-08-18T12:00:00Z", now).as_deref(), Some("running for 5 days"));
        // A clock that disagrees is not turned into a negative age.
        assert!(started_ago("2026-08-24T12:00:00Z", now).is_none());
        assert!(started_ago("some time last week", now).is_none());
    }

    #[test]
    fn a_look_tells_two_files_of_the_same_size_apart() {
        let dir = tempfile::tempdir().expect("a temporary folder");
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        std::fs::write(&one, b"aaaa").unwrap();
        std::fs::write(&two, b"bbbb").unwrap();
        let one = look(&one).expect("one is readable");
        let two = look(&two).expect("two is readable");
        assert_eq!(one.len, two.len);
        assert_ne!(one.mark, two.mark, "two different builds must not share a fingerprint");
        assert_ne!(print_of(&one), print_of(&two));
    }

    #[test]
    fn the_program_behind_a_copy_is_named_without_the_note_about_the_old_file() {
        assert_eq!(without_the_deleted_mark("/usr/bin/atelier (deleted)"), "/usr/bin/atelier");
        assert_eq!(without_the_deleted_mark("/usr/bin/atelier"), "/usr/bin/atelier");
        // A folder somebody really did call that keeps its name.
        assert_eq!(without_the_deleted_mark("/home/me/(deleted)/atelier"), "/home/me/(deleted)/atelier");
    }

    #[test]
    fn a_look_at_nothing_is_nothing() {
        assert!(look(Path::new("/nowhere/at/all/atelier")).is_none());
    }
}
