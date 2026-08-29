//! One shell, running on a pseudo-terminal.
//!
//! This is the piece that has a deadlock in it if the pieces are let go in the
//! wrong order, so the order is the point of the module and is spelled out
//! below rather than left to be rediscovered.
//!
//! ## What must be dropped, and when
//!
//! A pseudo-terminal has two ends. The child gets the slave end; we keep the
//! master. The kernel only reports the end of the output when *every* handle on
//! the slave side is closed — and the moment `spawn_command` returns, the child
//! has its own copy, so ours is pure ballast. Keep it and the reader blocks
//! forever on a shell that exited minutes ago. So the slave is dropped the
//! instant the child exists, and `open` is written so there is no path where it
//! is not.
//!
//! The master goes the other way: it is held until the child has been waited
//! for. The crate's own example warns that some platforms are unhappy if it goes
//! sooner, so `Drop` here takes the child down first and lets the master go
//! after.
//!
//! The writer is a third trap. It has to be taken off the master even by a
//! caller with nothing to type, because the writer is what can produce an end of
//! input at all; the crate's example says so in as many words. It lives here for
//! the shell's whole life for that reason.
//!
//! None of that ordering runs when the program leaves through
//! `std::process::exit`, which is how it leaves on every path out of `main.rs`
//! and when a newer build is installed over it (`handover.rs`): that call runs
//! no `Drop`. What ends the shells there is the operating system closing the
//! master along with every other handle the process held: the kernel hangs the
//! terminal up on the way out, and the shell goes. Whether its jobs go with it
//! is then down to the shell's manners — fish's are good, bash's depend on
//! whether it was idle when the hangup came (see `sweep`, which is what makes
//! the ordinary path certain and does not run on this one).
//!
//! ## Which shell, and how it is started
//!
//! The person's to decide; what this computer records is only the default. The
//! app carries a setting for it (`settings.rs`), because the shell
//! somebody actually uses and the shell `/etc/passwd` records for them are
//! routinely not the same one — bash in the password file and fish in every
//! window of the day — and until there was a setting the app opened the record
//! and there was nothing to be done about it. It is kept on the server rather
//! than in the browser because the server is what spawns the shell, and a
//! choice kept in a browser would be a different choice on every device in the
//! house.
//!
//! With nothing chosen, `CommandBuilder::new_default_prog()` decides, and it
//! decides well: it reads `$SHELL`, checks it is a thing that can actually be
//! executed, falls back to the password database when it is not, and starts
//! what it settles on as a login shell the way a terminal emulator does — by
//! putting a dash in front of the name in the argument the shell reads its own
//! name from, not by passing a flag. `system_default` below is that same rule
//! written out for the settings screen to report, so what a person is told the
//! default is, is what a spawn would actually open.
//!
//! With a shell chosen, the crate is told about it through the builder's own
//! `SHELL` rather than by handing it an argument vector: `get_shell` reads that
//! first, so everything after it — the dash-prefixed argv0, the `SHELL` the
//! child inherits — is the crate's login-shell path walked for the chosen shell
//! instead of the recorded one. A builder given an explicit argv could not have
//! the dash at all, because the same string is both what it looks the program
//! up by and what it passes as argv0, and no program is named `-fish`.
//!
//! The one thing not left to the crate is the refusal. `get_shell` falls back
//! to the password database, quietly, when what it was given cannot be run — so
//! a person whose chosen shell was uninstalled last week would get bash and no
//! explanation. It is checked here before the spawn and refused by name
//! instead.
//!
//! All we add is what the crate deliberately leaves alone: what kind of
//! terminal this is, and that it can show every colour.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// What the shell is told this terminal is.
///
/// The value a terminal emulator uses when it wants broad support without
/// asking the person to install a description of a terminal they have never
/// heard of. Anything richer buys nothing a browser can draw.
const TERM: &str = "xterm-256color";

/// What the shell is told opened it.
///
/// `TERM_PROGRAM` is where a script already looks to find out which terminal it
/// is inside — iTerm.app, vscode and WezTerm all answer there — so a marker
/// under any other name is a marker nobody reads. It is also the only name
/// available: anything spelled `ATELIER_...` would be taken straight back off
/// again by the rule below.
const TERM_PROGRAM: &str = "atelier";

/// Families of variable this server runs with that a person's shell has no
/// business inheriting.
///
/// A shell started from the app should feel like a shell, not like a child of
/// whatever supervises the app. Prefixes rather than whole names for these two,
/// because the app's own settings all share theirs and enumerating them would
/// go stale the first time one is added.
const OURS_BY_PREFIX: &[&str] = &["ATELIER_", "BEADS_"];

/// Variables the app reads under a name it does not own.
///
/// `RUST_LOG` and `PORT` are borrowed conventions, so the prefix test that is
/// right for our own families is wrong here: it took `RUST_LOG_STYLE` (which
/// tells Rust's logging how to colour itself), `RUST_LOGGER`, `PORTABLE_HOME`
/// and `PORTFOLIO_DIR` out of a person's shell, and none of those was ever
/// ours. Only the exact name is.
const OURS_BY_NAME: &[&str] = &["RUST_LOG", "PORT"];

/// Where this computer lists the shells it has.
///
/// A plain file of one path per line, `#` for a comment, kept by the package
/// manager. It is a list of what may be chosen and not a list of what exists,
/// so every line is checked before it is offered: a shell uninstalled last
/// month is still named there on most distributions.
#[cfg(unix)]
const LISTED_IN: &str = "/etc/shells";

/// Whether this computer will actually run what is at `path`.
///
/// Not `exists`. A directory exists, a README exists, and a person who typed
/// one of those into the setting would find out at the next tab they opened
/// rather than at the moment they pressed Save — which is the whole difference
/// this function is here to make.
pub fn runnable(path: &Path) -> bool {
    let Ok(what) = std::fs::metadata(path) else {
        return false;
    };
    if !what.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Any of the three bits, not the caller's own access: this asks whether
        // the file is a program at all, which is the question a person typing a
        // path is getting wrong when they get it wrong.
        what.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// What this computer would open if nobody had chosen.
///
/// portable-pty's rule written out — `$SHELL` when it is set and can be run,
/// this user's entry in the password database when it is not, `/bin/sh` when
/// neither answers. Written out rather than asked of the crate because the
/// crate only ever answers it on the way into a spawn, and the settings screen
/// has to be able to say what the default is without starting a shell to find
/// out. The two answers being the same one is the point; if this drifts from
/// `cmdbuilder.rs`, the screen is lying about what Save-nothing means.
#[cfg(unix)]
pub fn system_default() -> PathBuf {
    if let Some(named) = std::env::var_os("SHELL") {
        let named = PathBuf::from(named);
        if runnable(&named) {
            return named;
        }
    }
    if let Some(recorded) = recorded_shell() {
        if runnable(&recorded) {
            return recorded;
        }
    }
    PathBuf::from("/bin/sh")
}

/// The shell the password database records for whoever this process is running
/// as, which on a desktop is the person at the keyboard.
#[cfg(unix)]
fn recorded_shell() -> Option<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;

    // SAFETY: `getpwuid` hands back a pointer into a static buffer libc owns,
    // good until this thread calls it again. The bytes are copied out before
    // this function returns and nothing here calls it twice. A null answer is
    // "this uid is in no password database", which is what the check is for.
    let entry = unsafe { libc::getpwuid(libc::getuid()) };
    if entry.is_null() {
        return None;
    }
    let recorded = unsafe { CStr::from_ptr((*entry).pw_shell) };
    let recorded = recorded.to_bytes();
    if recorded.is_empty() {
        return None;
    }
    Some(PathBuf::from(OsStr::from_bytes(recorded)))
}

/// The shells this computer lists, in the order it lists them, with the ones
/// that are no longer there left out.
///
/// Deduplicated because `/etc/shells` routinely names the same program twice
/// under two paths that are the same path — `/bin/bash` and `/usr/bin/bash` on
/// anything with a merged `/usr` — and a menu that offers the same shell twice
/// looks broken rather than thorough. Compared as written and not resolved:
/// `/bin/bash` is what a person expects to see, and canonicalising them all
/// would turn the list into symlink targets nobody recognises.
#[cfg(unix)]
pub fn listed() -> Vec<PathBuf> {
    let Ok(file) = std::fs::read_to_string(LISTED_IN) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = Vec::new();
    for line in file.lines() {
        let named = line.split('#').next().unwrap_or_default().trim();
        if named.is_empty() {
            continue;
        }
        let named = PathBuf::from(named);
        if runnable(&named) && !found.contains(&named) {
            found.push(named);
        }
    }
    found
}

/// Windows has no password database and no `/etc/shells`; the shell it opens is
/// whatever `%ComSpec%` names, which is what the pty crate ends up running too.
#[cfg(not(unix))]
pub fn system_default() -> PathBuf {
    std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"))
}

/// Nothing lists them here, so the setting offers the default alone and a path
/// typed by hand.
#[cfg(not(unix))]
pub fn listed() -> Vec<PathBuf> {
    Vec::new()
}

/// A live shell and everything it needs let go of in the right order.
pub struct Shell {
    /// Held until the child has been waited for, never dropped before it.
    master: Box<dyn MasterPty + Send>,
    /// Taken at open even when nobody types, because this is what can end the
    /// shell's input at all.
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Shell {
    /// Starts a shell in `cwd`, on a terminal of the given size.
    ///
    /// `chosen` is the shell the person picked on the settings screen, and
    /// `None` is nobody having picked one — in which case this computer's own
    /// record decides, exactly as it did before there was a setting.
    pub fn open(
        cwd: &Path,
        cols: u16,
        rows: u16,
        chosen: Option<&Path>,
    ) -> std::io::Result<Self> {
        // Before the pty is opened, so a chosen shell that is no longer there
        // costs nothing and the person gets a sentence naming it rather than a
        // silent bash.
        if let Some(chosen) = chosen {
            if !runnable(chosen) {
                return Err(std::io::Error::other(format!(
                    "{} is the shell chosen in Settings, and there is nothing this \
                     computer can run at that path. Choose another in Settings.",
                    chosen.display()
                )));
            }
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(other)?;

        let mut command = CommandBuilder::new_default_prog();
        // The chosen shell is handed over as the builder's own `SHELL`, which is
        // the first place its `get_shell` looks. Everything that follows is then
        // the crate's, unchanged: the dash-prefixed argv0 that makes it a login
        // shell, and the `SHELL` the child itself inherits.
        if let Some(chosen) = chosen {
            command.env("SHELL", chosen);
        }
        command.cwd(cwd);
        command.env("TERM", TERM);
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", TERM_PROGRAM);
        // Under test the shell is still the person's own login shell, running
        // as them, so bash and fish would write everything a test typed into
        // the history file they read from every day. Neither name is anything
        // this module strips, so it is set rather than removed, and it is set
        // here rather than in each test because every shell in the suite —
        // this module's, the pump's, the register's — comes through here.
        #[cfg(test)]
        {
            command.env("HISTFILE", "/dev/null");
            command.env("fish_history", "");
        }
        for (name, _) in std::env::vars() {
            let ours = OURS_BY_PREFIX.iter().any(|ours| name.starts_with(ours))
                || OURS_BY_NAME.contains(&name.as_str());
            if ours {
                command.env_remove(&name);
            }
        }

        let child = pair.slave.spawn_command(command).map_err(|why| match chosen {
            // Named, because the one thing a person can do about this is change
            // it, and they cannot change what they are not told.
            Some(chosen) => std::io::Error::other(format!(
                "{} is the shell chosen in Settings, and it would not start: {why}. \
                 Choose another in Settings.",
                chosen.display()
            )),
            None => other(why),
        })?;
        // The child has its own handle now. Ours is what would keep the reader
        // waiting on a shell that has already gone.
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(other)?;

        Ok(Self {
            master: pair.master,
            writer,
            child,
        })
    }

    /// A second view of everything the shell prints.
    ///
    /// Blocking, and there is no other kind — this crate offers no reader that
    /// can be awaited. Whoever takes one owns a thread for as long as they read
    /// it, and must not hold it inside anything that shares a thread with other
    /// work.
    pub fn output(&self) -> std::io::Result<Box<dyn Read + Send>> {
        self.master.try_clone_reader().map_err(other)
    }

    /// Sends keystrokes to the shell.
    ///
    /// Blocks until the shell takes them, which is not always at once: a
    /// program that is not reading its input leaves a write waiting. `stream.rs`
    /// keeps that off the runtime.
    pub fn type_into(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    /// Tells the shell the window changed shape.
    ///
    /// Safe to call while a reader is blocked: it is one ioctl on the master,
    /// touching nothing the reader holds. The kernel raises the window-change
    /// signal on the shell's behalf.
    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(other)
    }

    /// Whether the shell has finished, without waiting for it.
    pub fn finished(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self
            .child
            .try_wait()?
            .map(|status| status.exit_code() as i32))
    }

    /// Ends the shell now.
    pub fn kill(&mut self) -> std::io::Result<()> {
        self.child.kill()
    }
}

impl Drop for Shell {
    fn drop(&mut self) {
        // The child first, then this struct's fields in declaration order, which
        // puts the master last. Waiting after the hangup so the master outlives a
        // child that is still being torn down.
        //
        // `kill` is the crate's, and on Unix it is a hangup rather than a
        // `SIGKILL`: the shell leaves the way it would if the terminal it sat in
        // had been closed. What it leaves behind is dealt with by `sweep`.
        let session = self.child.process_id();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(session) = session {
            std::thread::spawn(move || sweep(session));
        }
    }
}

/// Ends what a shell left running.
///
/// A hung-up shell is meant to pass the hangup on to its jobs, and fish does.
/// Bash does too — but only if it is idle at its prompt when the hangup lands.
/// Hung up a moment after starting a job, which is exactly what closing a tab
/// on a build just launched with `&` is, it leaves the job behind: alive,
/// re-parented to init, with nobody to notice it. Measured on this machine with
/// `sleep 1000 &`, and the difference between the two outcomes is a few
/// hundred milliseconds of timing. So the promise that nothing started in a
/// terminal outlives it is kept here and not by the shell.
///
/// The shell was started as a session leader (`new_default_prog` calls
/// `setsid`), and every process it starts, in whatever process group job
/// control put it, carries the shell's pid as its session id. That is the one
/// mark they all share and cannot shed short of a `setsid` of their own — which
/// is honoured: a job that asked for its own session, or that ignores hangups
/// the way `nohup` arranges, asked to outlive the terminal and is left alone,
/// exactly as a terminal emulator closing would leave it. Everything else is
/// hung up first, so a job that traps the hangup can tidy up, and shot after a
/// moment if it is still there.
///
/// Read from `/proc`, which is why this is Linux only; elsewhere the shell's
/// manners are all there is. On its own thread because `Drop` runs wherever
/// the last handle went, which is inside a request, and a request should not
/// wait on somebody's build noticing it has been hung up on.
///
/// The session id is a pid that has just been freed, and a new process could
/// in principle take it and `setsid` within the grace period; that needs both
/// to happen inside half a second on a machine with four million pids to hand
/// out, and the cost would be a hangup to a process that has only just
/// started. Accepted.
#[cfg(target_os = "linux")]
fn sweep(session: u32) {
    use std::time::Duration;

    for pid in session_members(session) {
        let _ = unsafe { libc::kill(pid, libc::SIGHUP) };
    }
    std::thread::sleep(Duration::from_millis(500));
    for pid in session_members(session) {
        if !ignores_hangups(pid) {
            let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn sweep(_session: u32) {}

/// Every live process whose session is `session`.
#[cfg(target_os = "linux")]
fn session_members(session: u32) -> Vec<i32> {
    let Ok(all) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    all.flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|pid| {
            // `pid (comm) state ppid pgrp session ...`, and `comm` may hold
            // anything, spaces and brackets included, so the split is after the
            // last closing bracket rather than on whitespace from the front.
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| {
                    let (_, rest) = stat.rsplit_once(") ")?;
                    rest.split_whitespace().nth(3)?.parse::<u32>().ok()
                })
                == Some(session)
        })
        .collect()
}

/// Whether `pid` has set `SIGHUP` to be ignored — what `nohup` does.
///
/// `SigIgn` in `/proc/<pid>/status` is a hexadecimal mask with signal 1 in its
/// lowest bit.
#[cfg(target_os = "linux")]
fn ignores_hangups(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|status| {
            let line = status.lines().find(|line| line.starts_with("SigIgn:"))?;
            let mask = u64::from_str_radix(line.split_whitespace().nth(1)?, 16).ok()?;
            Some(mask & 1 == 1)
        })
        .unwrap_or(false)
}

fn other(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Reads until the shell is gone, or gives up.
    ///
    /// The giving up is the assertion: if the end of the output never arrives,
    /// this is the deadlock the module exists to avoid, and a test that hung
    /// would report nothing at all.
    fn read_until_the_shell_is_gone(mut output: Box<dyn Read + Send>) -> String {
        let (tell, heard) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match output.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => all.extend_from_slice(&chunk[..n]),
                }
            }
            let _ = tell.send(String::from_utf8_lossy(&all).into_owned());
        });
        heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the shell exited but its output never ended — the slave handle was kept")
    }

    /// Every chunk the shell prints, as it prints it.
    ///
    /// For a shell that is meant to still be running afterwards, so it cannot
    /// wait for the output to end the way the reader above does. The thread
    /// ends by itself when the shell does, because that is when the read
    /// returns nothing.
    fn every_chunk(mut output: Box<dyn Read + Send>) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tell, heard) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                match output.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tell.send(chunk[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        heard
    }

    /// The same as `answered`, but nothing until the closing bracket has
    /// arrived.
    ///
    /// Output comes in whatever sized pieces the kernel hands over, so a
    /// question read halfway through would otherwise answer with half a number.
    fn fully_answered(said: &str, name: &str) -> Option<String> {
        let (_, rest) = said.rsplit_once(&format!("{name}["))?;
        let (inside, _) = rest.split_once(']')?;
        Some(inside.to_string())
    }

    /// What the shell printed between `name[` and `]`, taking the last one.
    ///
    /// A terminal echoes what is typed at it, so the command asking the question
    /// appears in the output before the answer does. The first match is the
    /// question; the last is the answer.
    fn answered(said: &str, name: &str) -> String {
        said.rsplit_once(&format!("{name}["))
            .and_then(|(_, rest)| rest.split(']').next())
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn the_reader_is_told_when_the_shell_has_ended() {
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().expect("a reader should be available");

        shell.type_into(b"exit\n").unwrap();

        let started = Instant::now();
        let said = read_until_the_shell_is_gone(output);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the end of the output should arrive as soon as the shell goes"
        );
        assert!(!said.is_empty(), "a shell should have printed something");
    }

    /// Proves the hazard the module is built around is real.
    ///
    /// `Shell` never stores the slave, so the deadlock cannot happen there and a
    /// test against `Shell` can only ever show the end of the output arriving.
    /// This one keeps a slave handle deliberately and shows the output does not
    /// end while it is held — which is the reason the type is shaped the way it
    /// is, and the thing that would silently stop being true if someone parked
    /// the slave in a field for later.
    #[test]
    fn the_output_does_not_end_while_any_slave_handle_is_held() {
        use std::sync::mpsc;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut child = pair
            .slave
            .spawn_command(CommandBuilder::new_default_prog())
            .unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();

        let (tell, heard) = mpsc::channel();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
            }
            let _ = tell.send(());
        });

        writer.write_all(b"exit\n").unwrap();
        writer.flush().unwrap();
        child.wait().unwrap();

        // The shell is gone, but this test still holds a handle on the end it
        // was given.
        assert!(
            heard.recv_timeout(Duration::from_secs(2)).is_err(),
            "the output ended while a slave handle was still held, so the hazard \
             this module is shaped around is not real and the shaping is cargo cult"
        );

        drop(pair.slave);
        heard.recv_timeout(Duration::from_secs(10)).expect(
            "letting go of the last slave handle should end the output — this is \
             the deadlock Shell::open is written to avoid",
        );
    }

    #[test]
    fn the_shell_is_started_as_a_login_shell() {
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();

        // A login shell is one whose own name, as it was handed to it, begins
        // with a dash. That is the whole convention, and it is what the shell
        // itself reports.
        shell.type_into(b"printf 'ARGV0[%s]\\n' \"$0\"; exit\n").unwrap();
        let said = read_until_the_shell_is_gone(output);

        let reported = answered(&said, "ARGV0");
        assert!(
            reported.starts_with('-'),
            "the shell should have been started as a login shell, but it calls itself {reported:?}"
        );
    }

    #[test]
    fn the_shell_runs_where_it_was_told_to() {
        let where_to = std::env::temp_dir();
        let mut shell = Shell::open(&where_to, 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();

        shell.type_into(b"printf 'CWD[%s]\\n' \"$PWD\"; exit\n").unwrap();
        let said = read_until_the_shell_is_gone(output);

        let reported = answered(&said, "CWD");
        let wanted = std::fs::canonicalize(&where_to).unwrap_or(where_to);
        assert_eq!(
            std::fs::canonicalize(&reported).ok(),
            Some(wanted),
            "the shell should have started in the folder it was given"
        );
    }

    #[test]
    fn the_shell_is_told_what_kind_of_terminal_it_is_on() {
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();

        shell
            .type_into(b"printf 'TERM[%s]COLS[%s]\\n' \"$TERM\" \"$(tput cols)\"; exit\n")
            .unwrap();
        let said = read_until_the_shell_is_gone(output);

        assert_eq!(
            answered(&said, "COLS"),
            "80",
            "the shell should see the width it was opened at, said: {said:?}"
        );
        assert_eq!(
            answered(&said, "TERM"),
            TERM,
            "the shell should know what terminal it is on, said: {said:?}"
        );
    }

    #[test]
    fn the_server_own_settings_do_not_leak_into_the_shell() {
        std::env::set_var("ATELIER_SOMETHING_PRIVATE", "leaked");
        std::env::set_var("RUST_LOG", "leaked");
        std::env::set_var("PORT", "leaked");
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();

        shell
            .type_into(
                b"printf 'PREFIX[%s]LOG[%s]PORT[%s]\\n' \
                  \"$ATELIER_SOMETHING_PRIVATE\" \"$RUST_LOG\" \"$PORT\"; exit\n",
            )
            .unwrap();
        let said = read_until_the_shell_is_gone(output);
        std::env::remove_var("ATELIER_SOMETHING_PRIVATE");
        std::env::remove_var("RUST_LOG");
        std::env::remove_var("PORT");

        assert_eq!(
            answered(&said, "PREFIX"),
            "",
            "the app's own settings should not reach a person's shell, said: {said:?}"
        );
        // The two borrowed names, which are matched whole rather than by
        // prefix, still have to go.
        assert_eq!(
            answered(&said, "LOG"),
            "",
            "RUST_LOG is the app's while it runs, said: {said:?}"
        );
        assert_eq!(
            answered(&said, "PORT"),
            "",
            "PORT is the app's while it runs, said: {said:?}"
        );
    }

    /// The other half of the rule above, and the one that was wrong.
    ///
    /// `RUST_LOG` and `PORT` were matched by prefix like the app's own
    /// families, so a person who keeps `RUST_LOG_STYLE` or `PORTFOLIO_DIR` in
    /// their environment lost it every time they opened a terminal here, with
    /// nothing to say why. Neither name was ever the app's to take.
    #[test]
    fn a_setting_that_merely_starts_the_same_way_is_left_alone() {
        std::env::set_var("RUST_LOG_STYLE_FOR_THIS_TEST", "mine");
        std::env::set_var("PORTFOLIO_DIR_FOR_THIS_TEST", "mine");
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();

        shell
            .type_into(
                b"printf 'LOG[%s]PORT[%s]\\n' \
                  \"$RUST_LOG_STYLE_FOR_THIS_TEST\" \"$PORTFOLIO_DIR_FOR_THIS_TEST\"; exit\n",
            )
            .unwrap();
        let said = read_until_the_shell_is_gone(output);
        std::env::remove_var("RUST_LOG_STYLE_FOR_THIS_TEST");
        std::env::remove_var("PORTFOLIO_DIR_FOR_THIS_TEST");

        assert_eq!(
            answered(&said, "LOG"),
            "mine",
            "a person's own RUST_LOG_STYLE is not the app's to remove, said: {said:?}"
        );
        assert_eq!(
            answered(&said, "PORT"),
            "mine",
            "a person's own PORTFOLIO_DIR is not the app's to remove, said: {said:?}"
        );
    }

    #[test]
    fn the_shell_is_told_which_program_opened_it() {
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();

        shell
            .type_into(b"printf 'OPENER[%s]\\n' \"$TERM_PROGRAM\"; exit\n")
            .unwrap();
        let said = read_until_the_shell_is_gone(output);

        assert_eq!(
            answered(&said, "OPENER"),
            TERM_PROGRAM,
            "a script in here should be able to tell where it is running, said: {said:?}"
        );
    }

    /// Nothing a person started in a shell outlives the shell.
    ///
    /// The one guarantee the terminal owes the machine it runs on. A build left
    /// running with an `&`, a dev server, a watch loop — all of them are
    /// children of a shell that hangs off this process, and if letting the
    /// shell go left them behind, a day of opening and closing tabs would fill
    /// the machine with work nobody can see or stop.
    ///
    /// Two things have to hold for it, and this pins both at once: `Drop` hangs
    /// the shell up rather than shooting it, and a shell that has been hung up
    /// on passes the hangup to its own jobs.
    ///
    /// Asked of `/proc` because that is the one way to ask "is this pid still
    /// there" without a signal crate, and it is only there on Linux.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_background_job_goes_when_the_shell_does() {
        let mut shell = Shell::open(Path::new("/"), 80, 24, None).expect("a shell should start");
        let output = shell.output().unwrap();
        let heard = every_chunk(output);

        // Plain shell syntax, which is what `$SHELL` is on the machines this
        // runs on. The shell echoes the question before it answers, so the
        // first `JOB[` holds `$!` unexpanded and only the answer holds digits.
        shell.type_into(b"sleep 1000 & echo JOB[$!]\n").unwrap();

        let mut said = String::new();
        let started = Instant::now();
        let job = loop {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the shell never said which job it started, said: {said:?}"
            );
            if let Ok(chunk) = heard.recv_timeout(Duration::from_millis(200)) {
                said.push_str(&String::from_utf8_lossy(&chunk));
            }
            if let Some(number) = fully_answered(&said, "JOB").and_then(|n| n.parse::<u32>().ok()) {
                break number;
            }
        };

        let footprint = format!("/proc/{job}");
        assert!(
            Path::new(&footprint).exists(),
            "the job should be running before the shell is let go"
        );

        drop(shell);

        // The kernel takes the entry away once the job has been reaped by
        // whatever adopted it, which is prompt but not instant.
        let started = Instant::now();
        let mut gone = false;
        while started.elapsed() < Duration::from_secs(2) {
            if !Path::new(&footprint).exists() {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if !gone {
            // Failing is one thing; leaving a `sleep` behind for every future
            // run of the suite is another.
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(job.to_string())
                .status();
        }
        assert!(
            gone,
            "job {job} was still running two seconds after the shell was let go, \
             so anything started in a terminal outlives the terminal"
        );
    }
    #[test]
    fn the_chosen_shell_is_the_one_that_starts_and_it_starts_as_a_login_shell() {
        // `/bin/sh` because every machine that can run this suite has one, and
        // because it is almost never the shell the suite would otherwise open —
        // so `-sh` is an answer only a chosen shell could have given.
        let mut shell = Shell::open(Path::new("/"), 80, 24, Some(Path::new("/bin/sh")))
            .expect("a shell should start");
        let output = shell.output().unwrap();

        shell
            .type_into(b"printf 'ARGV0[%s]\\n' \"$0\"; exit\n")
            .unwrap();
        let said = read_until_the_shell_is_gone(output);

        // The dash is the whole of the login convention, and it is here for the
        // chosen shell because the crate put it there: this asserts the choice
        // and the login start in one string, since either one missing gives a
        // different answer.
        assert_eq!(
            answered(&said, "ARGV0"),
            "-sh",
            "the chosen shell should have been started, as a login shell"
        );
    }

    #[test]
    fn a_chosen_shell_that_is_not_there_is_refused_by_name() {
        // The shape of the bug this prevents: somebody chooses fish, fish is
        // uninstalled, and the crate's own fallback hands them bash without a
        // word. A refusal naming the path is the only thing they can act on.
        let gone = Path::new("/nonexistent/place/fish");
        let Err(why) = Shell::open(Path::new("/"), 80, 24, Some(gone)) else {
            panic!("a shell that is not there should not have started");
        };
        let why = why.to_string();
        assert!(
            why.contains("/nonexistent/place/fish"),
            "the refusal should name the shell that was chosen, and says {why:?}"
        );
        assert!(
            why.contains("Settings"),
            "the refusal should say where to change it, and says {why:?}"
        );
    }

    #[test]
    fn the_default_is_a_shell_this_computer_can_actually_run() {
        let default = system_default();
        assert!(
            runnable(&default),
            "the settings screen would offer {default:?} as the default, and it \
             is not something this computer will run"
        );
    }

    #[test]
    fn nothing_that_cannot_be_run_is_offered() {
        // `/etc/shells` is a list of what may be chosen, not of what is there;
        // it outlives the packages it names. Nothing unrunnable should reach a
        // menu, or the first thing a person picks may be the thing that is gone.
        for named in listed() {
            assert!(
                runnable(&named),
                "{named:?} is offered as a shell and this computer will not run it"
            );
        }
    }
}
