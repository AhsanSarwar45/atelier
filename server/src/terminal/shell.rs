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
//! ## Which shell, and how it is started
//!
//! Not ours to decide. `CommandBuilder::new_default_prog()` already reads
//! `$SHELL`, checks it is a thing that can actually be executed, and falls back
//! to the password database when it is not — and it starts it as a login shell
//! the way a terminal emulator does, by putting a dash in front of the name in
//! the argument the shell reads its own name from, not by passing a flag. All we
//! add is what it deliberately leaves alone: what kind of terminal this is, and
//! that it can show every colour.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;

/// What the shell is told this terminal is.
///
/// The value a terminal emulator uses when it wants broad support without
/// asking the person to install a description of a terminal they have never
/// heard of. Anything richer buys nothing a browser can draw.
const TERM: &str = "xterm-256color";

/// Variables this server runs with that a person's shell has no business
/// inheriting.
///
/// A shell started from the app should feel like a shell, not like a child of
/// whatever supervises the app. Prefixes rather than whole names, because the
/// app's own settings all share theirs and enumerating them would go stale the
/// first time one is added.
const NOT_THE_SHELLS_BUSINESS: &[&str] = &["ATELIER_", "BEADS_", "RUST_LOG", "PORT"];

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
    /// Starts the person's own shell in `cwd`, on a terminal of the given size.
    pub fn open(cwd: &Path, cols: u16, rows: u16) -> std::io::Result<Self> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(other)?;

        let mut command = CommandBuilder::new_default_prog();
        command.cwd(cwd);
        command.env("TERM", TERM);
        command.env("COLORTERM", "truecolor");
        for (name, _) in std::env::vars() {
            if NOT_THE_SHELLS_BUSINESS
                .iter()
                .any(|ours| name.starts_with(ours))
            {
                command.env_remove(&name);
            }
        }

        let child = pair.slave.spawn_command(command).map_err(other)?;
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
        // puts the master last. Waiting after killing so the master outlives a
        // child that is still being torn down.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
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
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
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
        let mut shell = Shell::open(&where_to, 80, 24).expect("a shell should start");
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
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
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
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let output = shell.output().unwrap();

        shell
            .type_into(b"printf 'LEAK[%s]\\n' \"$ATELIER_SOMETHING_PRIVATE\"; exit\n")
            .unwrap();
        let said = read_until_the_shell_is_gone(output);
        std::env::remove_var("ATELIER_SOMETHING_PRIVATE");

        assert_eq!(
            answered(&said, "LEAK"),
            "",
            "the app's own settings should not reach a person's shell, said: {said:?}"
        );
    }
}
