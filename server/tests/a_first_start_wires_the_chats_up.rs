//! The first start of the program itself, watched from outside.
//!
//! Everything else about this feature is proved at a helper with a folder
//! handed to it: `wire()` given a settings file, `said_it()` given an answer.
//! None of that touches the two steps a person actually takes — running the
//! program, and reading the line it prints. Take the whole
//! `doing::wire_up()` block out of `serve()` and every one of those tests
//! stays green while a fresh download wires up nothing and says nothing,
//! which is the fault this job exists to fix (bw-14ij.4).
//!
//! So: a real start against a folder that has never seen this program, the
//! line read off its own standard output, the settings file read off disk —
//! and then a second start against the same folder, which must say nothing
//! and change nothing.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

/// The sentence a first start owes the reader (doing.rs, `said_it`).
const SAID: &str = "wired your chats up to say what they are doing";
/// The last of the fixed lines a start prints before it wires anything up.
const SETTLED: &str = "Ready.";
/// Long enough for a cold binary to bind and print; short enough to fail a run
/// rather than hang it.
const PATIENCE: Duration = Duration::from_secs(60);

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
        // looks at the owner's own data folder, finds his copy already
        // holding that port, and says so rather than wiring anything up. The
        // whole family goes, not the two that were seen doing it, so this
        // stays isolated as more of them are added.
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

#[test]
fn a_first_start_wires_the_chats_up_and_says_so_once() {
    let home = tempfile::tempdir().expect("a folder");
    let data = tempfile::tempdir().expect("a folder for its own files");
    let settings = home.path().join("settings.json");

    // ---- the first start, on a computer that has never run this -----------
    let first = Started::against(home.path(), data.path(), a_free_port());
    let heard = first.spoke_until(SAID);
    let line = heard.last().expect("a line");
    assert!(
        line.contains(&settings.display().to_string()),
        "it said it wired the chats up but not where: {line}"
    );
    drop(first);

    let written = std::fs::read_to_string(&settings)
        .unwrap_or_else(|e| panic!("nothing was written to {}: {e}", settings.display()));
    let written: serde_json::Value =
        serde_json::from_str(&written).expect("something the tool can read");
    let hooks = written["hooks"]
        .as_object()
        .unwrap_or_else(|| panic!("no hooks were written: {written}"));
    assert!(
        hooks.contains_key("PreCompact"),
        "the event this whole feature turns on is not among {:?}",
        hooks.keys().collect::<Vec<_>>()
    );
    let whole = serde_json::to_string(&written).expect("readable");
    assert!(
        whole.contains("hook doing"),
        "the settings name no command of ours: {whole}"
    );

    // ---- and the second, against the same folder --------------------------
    let second = Started::against(home.path(), data.path(), a_free_port());
    let again = second.spoke_until(SETTLED);
    // The wiring runs in the same breath as those lines, so anything it had to
    // say has been said by the time the next second is out.
    let after = second.anything_more(Duration::from_secs(3));
    drop(second);

    let spoken: Vec<&String> = again.iter().chain(after.iter()).collect();
    assert!(
        !spoken.iter().any(|l| l.contains(SAID)),
        "a second start announced itself all over again: {spoken:?}"
    );
    let untouched = std::fs::read_to_string(&settings).expect("the settings still there");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&untouched).expect("readable"),
        written,
        "a second start rewrote settings it had already written"
    );
}
