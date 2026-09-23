//! A start of the program, watched from outside, and what it does to the
//! reader's own Claude settings: nothing.
//!
//! This file used to prove the opposite. A first start wrote this program's
//! chat-status gate into `<CLAUDE_CONFIG_DIR>/settings.json` and said so
//! (bw-14ij.4) — one file shared by every project on the computer, edited by a
//! program the person had only started, and outliving the app that wrote it.
//! That was taken out: the registration belongs to the PROJECT, written by
//! `atelier init` beside every other gate, and `atelier init` also takes the
//! old global ones back out (bw-t26l.20).
//!
//! The rule behind that removal is proved at a helper, against a folder handed
//! to it (`doing::unwire`). What no helper can see is a start of the program
//! itself reaching for the reader's file again — put a write back into
//! `serve()` and every one of those tests stays green. So: a real start
//! against a home folder that has never seen this program, and a second
//! against one that already holds settings of the reader's own, both read off
//! disk afterwards.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

/// The last of the fixed lines a start prints. Anything a start had to say
/// about wiring was said by here.
const SETTLED: &str = "Ready.";
/// Long enough for a cold binary to bind and print; short enough to fail a run
/// rather than hang it.
const PATIENCE: Duration = Duration::from_secs(60);
/// What a registration of ours looks like wherever it is written (doing.rs).
const OURS: &str = "hook doing";

/// A start of the program, with its output arriving line by line.
struct Started {
    running: Child,
    said: Receiver<String>,
}

impl Started {
    /// Run the program the way a person does: no arguments, its own port, and
    /// a home folder of this test's own.
    fn against(home: &Path, data: &Path, port: u16) -> Self {
        let mut program = Command::new(env!("CARGO_BIN_EXE_atelier"));
        // A shell the running copy started carries ATELIER_DATA_DIR and
        // ATELIER_PORT, and each beats what this test hands over: the folder
        // (identity.rs) and the port (main.rs). Inherited, the start below
        // looks at the owner's own data folder and finds his copy already
        // holding that port. The whole family goes, not the two that were seen
        // doing it, so this stays isolated as more of them are added.
        for (name, _) in std::env::vars() {
            if name.starts_with("ATELIER_") {
                program.env_remove(name);
            }
        }
        let mut running = program
            .env("CLAUDE_CONFIG_DIR", home)
            .env("XDG_DATA_HOME", data)
            .env("BEADS_WEB_HOST", "127.0.0.1")
            .env("BEADS_WEB_PORT", port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the program to start");

        // Read on a thread of its own: a start that never prints the line must
        // fail on the clock below rather than block this test for ever.
        let out = running.stdout.take().expect("somewhere to listen");
        let (tell, said) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tell.send(line).is_err() {
                    return;
                }
            }
        });
        Self { running, said }
    }

    /// Everything it says up to the line containing `until`, that line last.
    fn spoke_until(&self, until: &str) -> Vec<String> {
        let mut heard = Vec::new();
        loop {
            match self.said.recv_timeout(PATIENCE) {
                Ok(line) => {
                    let done = line.contains(until);
                    heard.push(line);
                    if done {
                        return heard;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    panic!("nothing said `{until}` in {PATIENCE:?}; it said {heard:?}")
                }
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("the program stopped before saying `{until}`; it said {heard:?}")
                }
            }
        }
    }

    /// Whatever else it finds to say in the next breath, which may be nothing.
    fn anything_more(&self, grace: Duration) -> Vec<String> {
        let mut heard = Vec::new();
        while let Ok(line) = self.said.recv_timeout(grace) {
            heard.push(line);
        }
        heard
    }
}

impl Drop for Started {
    fn drop(&mut self) {
        let _ = self.running.kill();
        let _ = self.running.wait();
    }
}

/// A port nothing on this machine is using, given up again before the program
/// is told to take it. Two starts get two ports, so the second never waits on
/// the first one's socket letting go.
fn a_free_port() -> u16 {
    let held = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
    held.local_addr().expect("its number").port()
}

/// Everything one start says, from its first line to a second after it has
/// settled.
fn everything_said(home: &Path, data: &Path) -> Vec<String> {
    let started = Started::against(home, data, a_free_port());
    let mut heard = started.spoke_until(SETTLED);
    // The wiring used to run in the same breath as those lines, so a start
    // that reached for the file again would have said so by the time the next
    // second is out.
    heard.extend(started.anything_more(Duration::from_secs(1)));
    heard
}

#[test]
fn a_start_writes_nothing_into_a_home_folder_that_has_never_seen_it() {
    let home = tempfile::tempdir().expect("a folder");
    let data = tempfile::tempdir().expect("a folder for its own files");
    let settings = home.path().join("settings.json");

    let heard = everything_said(home.path(), data.path());

    assert!(
        !std::path::Path::new(&settings).exists(),
        "a start made {}, which belongs to the reader: {}",
        settings.display(),
        std::fs::read_to_string(&settings).unwrap_or_default()
    );
    assert!(
        !heard.iter().any(|line| line.contains(&settings.display().to_string())),
        "a start announced itself into the reader's settings: {heard:?}"
    );
}

#[test]
fn a_start_leaves_settings_the_reader_already_had_exactly_as_they_were() {
    let home = tempfile::tempdir().expect("a folder");
    let data = tempfile::tempdir().expect("a folder for its own files");
    let settings = home.path().join("settings.json");
    // A file with a gate of the reader's own in it, so a start that rewrites
    // the file at all — even to add nothing — is caught.
    let theirs = r#"{
  "model": "opus",
  "hooks": {
    "PreCompact": [{"matcher": "", "hooks": [{"type": "command", "command": "their-own-gate.py"}]}]
  }
}
"#;
    std::fs::write(&settings, theirs).expect("a settings file to start from");

    everything_said(home.path(), data.path());

    let after = std::fs::read_to_string(&settings).expect("the settings still there");
    assert_eq!(after, theirs, "a start rewrote settings of the reader's own");
    assert!(
        !after.contains(OURS),
        "a start wrote this program's gate into the reader's own file: {after}"
    );
}
