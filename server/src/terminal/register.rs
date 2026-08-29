//! Every shell this server has open, and how one stops being open.
//!
//! A shell outlives the page that opened it, and that is the whole point of the
//! feature: someone reloads the browser, or shuts the laptop and comes back in
//! the morning, and the build they left running is still running. So the shells
//! cannot hang off a socket, a tab, or a request. They hang off the process,
//! and this is where.
//!
//! ## Why the shell is behind a lock of its own
//!
//! A pseudo-terminal master is `Send` but not `Sync`: it may be moved from one
//! thread to another, but two threads may not hold it at the same time. A
//! register shared by every request handler needs exactly the thing it does not
//! have, so the shell is given a lock and the session around it becomes
//! shareable. There is no way past this short of `unsafe`, and nothing here
//! wants one — the lock is held for the length of a write or a question to the
//! kernel about a child, never across an await, so it is not contended for long
//! enough to be worth the risk of pretending.
//!
//! Where two locks are taken at once, the register's is always the outer one.
//! Sweeping asks each session whether its shell has ended, which reaches for the
//! shell's lock while the register's is held; nothing anywhere goes the other
//! way, and nothing should start.
//!
//! The pump needs no lock of its own — everything it holds is already behind
//! one — and it is started at the same instant as the shell rather than when a
//! browser first asks to watch. A shell nobody is draining fills the kernel's
//! buffer and then blocks on its own output, so someone who opened a tab and
//! went to make tea would come back to a build that stopped ten seconds in.
//!
//! ## What becomes of a shell that has ended
//!
//! Someone types `exit` and the shell is gone, but the session is not finished
//! being useful: the browser watching it still has the last of what it printed
//! to draw, and a page reloaded a second later still wants the tab back so it
//! can show that and close it. So an ended shell is kept a few minutes and then
//! forgotten.
//!
//! Forgotten by what is the part worth writing down, because there is no timer
//! and no background task here. A register can only grow through the same three
//! calls that sweep it — nothing opens a shell without asking this type to, and
//! this type answers nothing without first dropping the long dead — so a
//! register nobody is touching cannot be a register that is filling up. The
//! price is that the last few ended shells of a sitting are held until something
//! asks again, which is one file descriptor and up to a quarter of a megabyte of
//! remembered output each. A thread that woke every minute to find nothing to do
//! would cost more than that and buy a bound that is already there.

use crate::terminal::pump::Pump;
use crate::terminal::shell::Shell;
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// How long a shell that has ended is kept before it is forgotten.
///
/// Long enough that a reload, a locked screen, or a walk to the kettle still
/// finds the tab that was there to be told what became of it. Short enough that
/// a day of opening and closing shells adds up to nothing.
const KEPT_AFTER_ENDING: Duration = Duration::from_secs(5 * 60);

/// One shell, what it has printed, and what is known about it from outside.
pub struct Session {
    pub id: Uuid,
    /// Where it was started, so a restored tab can say which folder it is
    /// looking at without interrupting the shell to ask.
    pub cwd: PathBuf,
    /// When it was started, which is the order tabs should come back in.
    pub started: DateTime<Utc>,
    /// Locked because a pty master is not `Sync`, for the reason above.
    pub shell: Mutex<Shell>,
    /// Started at open and not at first viewing, because a shell nobody drains
    /// is a shell that stops: the tty buffer fills and the next write blocks.
    /// Every socket in `stream.rs` attaches to this one.
    pub pump: Pump,
    /// When the shell was first seen to have ended. Written once, by `ended`.
    ended: OnceLock<Instant>,
}

impl Session {
    /// When this shell ended, or `None` while it is still running.
    ///
    /// Nothing announces a shell's end. Someone types `exit`, and the only
    /// trace is a child that has quietly become an exit status, so the question
    /// has to be asked after the fact. It is asked at most once per shell: the
    /// answer cannot turn back into "still running", so the first sighting is
    /// written down and every question after it is answered from that.
    pub fn ended(&self) -> Option<Instant> {
        if let Some(when) = self.ended.get() {
            return Some(*when);
        }

        let over = match self
            .shell
            .lock()
            .expect("the shell lock is never poisoned")
            .finished()
        {
            Ok(status) => status.is_some(),
            // A child the operating system will no longer answer questions
            // about is not a child that is running, and treating the error as
            // "still going" would leave a session nothing could ever sweep.
            Err(_) => true,
        };
        if !over {
            return None;
        }

        let _ = self.ended.set(Instant::now());
        self.ended.get().copied()
    }
}

/// Every shell this server has open.
pub struct Register {
    live: Mutex<HashMap<Uuid, Arc<Session>>>,
    /// How long an ended shell is kept. A field rather than the constant it is
    /// built from so the forgetting can be proved in a test instead of waited
    /// out for five minutes.
    forget_after: Duration,
}

/// The register as everything that serves a shell holds it.
pub type Shells = Arc<Register>;

impl Default for Register {
    fn default() -> Self {
        Self {
            live: Mutex::default(),
            forget_after: KEPT_AFTER_ENDING,
        }
    }
}

impl Register {
    /// A register that forgets an ended shell after the given wait.
    #[cfg(test)]
    pub fn forgetting_after(wait: Duration) -> Self {
        Self {
            live: Mutex::default(),
            forget_after: wait,
        }
    }

    /// Starts a shell in `cwd` and remembers it.
    ///
    /// The caller is trusted about the folder. Whether it is a folder at all is
    /// the route's question, asked there because the answer to a bad one is an
    /// HTTP refusal and not an error out of a pty.
    pub fn open(&self, cwd: PathBuf, cols: u16, rows: u16) -> std::io::Result<Arc<Session>> {
        let shell = Shell::open(&cwd, cols, rows)?;
        let pump = Pump::start(&shell)?;
        let session = Arc::new(Session {
            id: Uuid::new_v4(),
            cwd,
            started: Utc::now(),
            shell: Mutex::new(shell),
            pump,
            ended: OnceLock::new(),
        });

        let mut live = self
            .live
            .lock()
            .expect("the register lock is never poisoned");
        forget_the_long_dead(&mut live, self.forget_after);
        live.insert(session.id, Arc::clone(&session));
        Ok(session)
    }

    /// Every shell still worth a tab, oldest first.
    pub fn list(&self) -> Vec<Arc<Session>> {
        let mut live = self
            .live
            .lock()
            .expect("the register lock is never poisoned");
        forget_the_long_dead(&mut live, self.forget_after);
        let mut all: Vec<Arc<Session>> = live.values().cloned().collect();
        drop(live);
        all.sort_by_key(|session| session.started);
        all
    }

    /// One shell by name, or `None` when this server has no such shell.
    ///
    /// Gives back a share of the session rather than anything borrowed from
    /// inside the lock, because whoever asked is about to hold it for as long
    /// as a person keeps a tab open, and the register cannot be shut for that.
    pub fn get(&self, id: Uuid) -> Option<Arc<Session>> {
        let mut live = self
            .live
            .lock()
            .expect("the register lock is never poisoned");
        forget_the_long_dead(&mut live, self.forget_after);
        live.get(&id).cloned()
    }

    /// Ends a shell and forgets it. `false` when there was no such shell.
    pub fn close(&self, id: Uuid) -> bool {
        let session = {
            let mut live = self
                .live
                .lock()
                .expect("the register lock is never poisoned");
            forget_the_long_dead(&mut live, self.forget_after);
            live.remove(&id)
        };
        let Some(session) = session else {
            return false;
        };

        // Killed outright rather than left to whatever drops the session last.
        // A socket still streaming this shell holds a share of it, and without
        // this the shell would go on running — and go on printing — behind a
        // tab the person has already closed.
        let _ = session
            .shell
            .lock()
            .expect("the shell lock is never poisoned")
            .kill();
        true
    }
}

/// Drops every session whose shell ended longer ago than `after`.
///
/// Letting go of the last share of a session is what kills the child, waits for
/// it, and closes the master, which is in turn what ends the pump's thread. So
/// this is the whole of the cleaning up, and there is nothing else to remember
/// to do.
fn forget_the_long_dead(live: &mut HashMap<Uuid, Arc<Session>>, after: Duration) {
    live.retain(|_, session| match session.ended() {
        Some(when) => when.elapsed() < after,
        None => true,
    });
}
