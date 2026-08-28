//! What one shell prints, gathered up and handed on without swamping anything.
//!
//! A pseudo-terminal reader blocks and there is no other kind to be had —
//! `shell.rs` says so and means it — so a shell that is being watched costs a
//! thread whether we like it or not. This is that thread, and since it is being
//! spent anyway it is also where the three ways a terminal's output can hurt the
//! app are dealt with: too many messages, too much remembered, and too much in
//! flight. All three are about volume, and all three are cheapest to answer at
//! the point the bytes arrive.
//!
//! ## Too many messages
//!
//! `yes` writes as fast as the kernel will take it, and a pty master hands back
//! whatever is in the tty buffer at that instant, which is a few kilobytes at
//! most. Sending one message per read — which is what ttyd does, with no
//! debounce anywhere — turns a second of that into hundreds of websocket
//! frames, each of them a wake-up and a repaint of a screen nobody could read at
//! that speed anyway. So a message here is not a read. The first read of a burst
//! opens a window of twenty milliseconds and everything that turns up inside it
//! goes out together, which makes a firehose tens of large frames a second
//! instead of thousands of small ones.
//!
//! The window is only opened when the shell is visibly ahead of us: either there
//! is already another read queued behind the one in hand, or that read filled
//! the buffer. Both mean more is coming. Neither is true of a keystroke's echo,
//! which is a handful of bytes arriving on its own, so the thing a person can
//! actually feel is not delayed by the thing they cannot.
//!
//! ## Too much remembered
//!
//! Someone who reloads the page wants the screen they left, so the last quarter
//! of a megabyte is kept and replayed to them. It is kept as raw bytes in the
//! order they arrived, and it is never parsed, re-wrapped, or split into lines:
//! colour, cursor position, character set and screen mode are all carried by
//! escape sequences that span runs of bytes, and a terminal handed a tidied-up
//! version of those draws something other than what was there.
//!
//! Which leaves the seam. Trimming the oldest end can cut an escape sequence in
//! half, and a replay starting on the tail of one begins by telling the terminal
//! something nobody said. There is no honest fix short of keeping everything
//! ever printed, so what is done instead is an approximation and is admitted as
//! one: once anything has been trimmed at all, the replay starts at the first
//! line break it can find and is prefixed with a reset. That drops a partial
//! line and puts the colours back to normal. It does not restore a cursor
//! position, an alternate screen, or a character set chosen before the trim, so
//! a full-screen program that was running when the page was reloaded will still
//! come back looking wrong. Getting that right means keeping a parsed screen
//! rather than bytes, which is a different piece of work.
//!
//! ## Too much in flight
//!
//! Whoever streams this to a browser is slower than a shell can print, and
//! tokio-tungstenite's sink pushes back not at all — feed it faster than the
//! socket drains and its send queue grows until the process dies. So the queue
//! that matters is this one, and it is bounded. Nothing here is ever unbounded.
//!
//! What happens when it fills is the whole decision. `tokio::sync::broadcast` is
//! the obvious shape for one writer and several readers, and it is the wrong
//! one: a receiver that falls behind is handed `Lagged` and the bytes it missed
//! are gone. A terminal that quietly loses a run of bytes is not a slow
//! terminal, it is a broken one, because the missing run is as likely to be half
//! an escape sequence as it is to be text and the screen never recovers on its
//! own. So each viewer gets its own bounded channel and the pump waits when one
//! of them is full.
//!
//! Waiting is the right answer rather than a compromise. Stop reading the master
//! and the kernel's tty buffer fills; once it is full the shell's own write
//! blocks. That is precisely what happens to a program printing into a terminal
//! that is not keeping up, so the shell is being told the truth. The cost is
//! that one wedged viewer holds up all the others, which means whatever streams
//! this has to let go of its receiver the moment its socket dies instead of
//! leaving it lying about.

use crate::terminal::shell::Shell;
use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// How much is asked for in one read of the master.
///
/// Far more than a pty will ever have ready, which is the point: the read
/// returns what there is instead of the buffer size deciding it.
const READ_AT_ONCE: usize = 32 * 1024;

/// How long a burst is gathered before it is sent on.
///
/// One frame at sixty hertz, so nothing a browser could have drawn any sooner is
/// being held back.
const GATHER_FOR: Duration = Duration::from_millis(20);

/// Where gathering stops, whatever is left of the window.
///
/// Without it a fast enough shell could grow one message without limit inside
/// the window, which is the thing this module exists to prevent. It is where
/// gathering stops rather than a ceiling on the result: the read that carries a
/// message past it is already in hand, so a message can run one read over.
const MOST_IN_ONE_MESSAGE: usize = 128 * 1024;

/// How much of a shell's output is remembered for someone who comes back.
const KEPT_PER_SHELL: usize = 256 * 1024;

/// Reads the thread may run ahead by while a message is being sent on.
///
/// Enough that reading and sending do not take turns; small enough that the
/// slack is a quarter of a megabyte rather than a shell's whole output.
const READS_IN_HAND: usize = 8;

/// Messages a viewer may fall behind by before the pump waits for it.
const MESSAGES_PER_VIEWER: usize = 4;

/// Puts colour, brightness and inversion back to nothing.
///
/// What a trimmed replay opens with, because the sequence that turned any of
/// them on may have been trimmed away.
const COLOURS_BACK_TO_NORMAL: &[u8] = b"\x1b[0m";

/// A run of output, shared rather than copied to each viewer.
pub type Message = Arc<[u8]>;

/// What has been kept, who is listening, and whether it is over.
///
/// One lock over all three, which is the point of the type rather than an
/// economy. A viewer arriving has to be handed the past and put on the list for
/// the future in the same breath: do it in two steps and it either misses a
/// message published between them or is given one twice.
#[derive(Default)]
struct Kept {
    /// Oldest first. The messages themselves, not a copy of their bytes.
    runs: VecDeque<Message>,
    /// How much of the oldest run has been trimmed off its front.
    skip: usize,
    /// Bytes actually retained, which is every run's length less `skip`.
    held: usize,
    /// Whether anything has ever been dropped from the oldest end.
    trimmed: bool,
    listeners: Vec<mpsc::Sender<Message>>,
    over: bool,
}

impl Kept {
    /// Remembers a message and forgets whatever no longer fits.
    ///
    /// Trimming is by the byte and not by the run, so what is kept is the last
    /// `KEPT_PER_SHELL` bytes exactly and not whatever a run boundary happens to
    /// leave. The oldest run is kept whole and read from an offset, so trimming
    /// costs nothing but the arithmetic.
    fn remember(&mut self, run: Message) {
        self.held += run.len();
        self.runs.push_back(run);
        while self.held > KEPT_PER_SHELL {
            let alive = {
                let oldest = self.runs.front().expect("bytes held with no run holding them");
                oldest.len() - self.skip
            };
            let over = self.held - KEPT_PER_SHELL;
            if over >= alive {
                self.runs.pop_front();
                self.skip = 0;
                self.held -= alive;
            } else {
                self.skip += over;
                self.held -= over;
            }
            self.trimmed = true;
        }
    }

    /// What a viewer should be shown before the live output starts.
    ///
    /// Untrimmed, this is every byte the shell has printed, in order and
    /// untouched. Trimmed, it is the approximation the module doc admits to.
    fn replay(&self) -> Vec<u8> {
        let mut raw = Vec::with_capacity(self.held);
        let mut skip = self.skip;
        for run in &self.runs {
            raw.extend_from_slice(&run[skip..]);
            skip = 0;
        }
        if !self.trimmed {
            return raw;
        }

        // A partial line is the one piece of damage worth undoing without a
        // parser: everything from the line break on is whole, whatever was cut
        // in half sat before it. If there is no line break at all in a quarter
        // of a megabyte then the shell has printed no lines and there is
        // nothing to align to, so the reset goes in front of the lot.
        let from = raw.iter().position(|byte| *byte == b'\n').unwrap_or(0);
        let mut replay = Vec::with_capacity(COLOURS_BACK_TO_NORMAL.len() + raw.len() - from);
        replay.extend_from_slice(COLOURS_BACK_TO_NORMAL);
        replay.extend_from_slice(&raw[from..]);
        replay
    }
}

/// The one thread draining a shell, and what it does with what it reads.
///
/// Lives as long as the shell's output does, and is ended by that output ending
/// and by nothing else. Letting go of this handle deliberately does not stop it:
/// the viewers holding receivers from `attach` outlive whoever started the pump,
/// and a shell the register still has is a shell whose output still has to go
/// somewhere. Dropping the `Shell` is what closes the master, ends the read, and
/// brings all of this down.
pub struct Pump {
    kept: Arc<Mutex<Kept>>,
    taken: Arc<AtomicUsize>,
}

impl Pump {
    /// Starts draining a shell.
    ///
    /// Takes the shell by reference rather than owning it because the register
    /// above still has to type into it and resize it; all the pump wants is the
    /// one reader, and taking it here is what makes it the only one.
    ///
    /// Must be called with a tokio runtime running: the gathering and sending
    /// half is a task, and only the reading half is a thread.
    pub fn start(shell: &Shell) -> std::io::Result<Self> {
        Ok(Self::draining(shell.output()?))
    }

    /// The same, for output that did not come from a shell.
    ///
    /// Exists so the byte-level behaviour can be exercised against bytes chosen
    /// on purpose, which a real shell will not print on demand.
    pub fn draining(mut output: Box<dyn Read + Send>) -> Self {
        let kept: Arc<Mutex<Kept>> = Arc::default();
        let taken = Arc::new(AtomicUsize::new(0));
        let (hand_over, reads) = mpsc::channel(READS_IN_HAND);

        let counted = Arc::clone(&taken);
        std::thread::spawn(move || {
            // On the heap, because this is a thread's stack and the buffer is a
            // good fraction of a small one.
            let mut buffer = vec![0u8; READ_AT_ONCE];
            loop {
                match output.read(&mut buffer) {
                    // A pty master reports the child's end as an error rather
                    // than as nothing to read, and both mean the same thing
                    // here: there will never be more.
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        counted.fetch_add(read, Ordering::Relaxed);
                        // Blocking, and that is the backpressure: when the
                        // gathering half cannot keep up this thread stops
                        // reading, the tty buffer fills, and the shell's own
                        // write waits. No runtime is running on this thread, so
                        // the blocking form is the correct one.
                        if hand_over.blocking_send(buffer[..read].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        tokio::spawn(gather_and_send(reads, Arc::clone(&kept)));

        Self { kept, taken }
    }

    /// Gives a viewer what it missed and puts it on the list for what is next.
    ///
    /// One step, under one lock, because the two halves have to agree on where
    /// the past stops and the future starts. Attaching to a shell that has
    /// already ended is not an error and does not need to be handled by the
    /// caller: the receiver simply reports the end straight away, after the
    /// replay it was given.
    pub fn attach(&self) -> (Vec<u8>, mpsc::Receiver<Message>) {
        let (to_viewer, from_pump) = mpsc::channel(MESSAGES_PER_VIEWER);
        let mut kept = self.kept.lock().expect("the kept output lock is never poisoned");
        let missed = kept.replay();
        if !kept.over {
            kept.listeners.push(to_viewer);
        }
        (missed, from_pump)
    }

    /// What a viewer arriving now would be shown.
    pub fn replay(&self) -> Vec<u8> {
        self.kept
            .lock()
            .expect("the kept output lock is never poisoned")
            .replay()
    }

    /// How many bytes are being remembered.
    ///
    /// The cap applies to this and not to `replay`, which adds a reset and drops
    /// a partial line on top of it.
    pub fn held(&self) -> usize {
        self.kept
            .lock()
            .expect("the kept output lock is never poisoned")
            .held
    }

    /// How much has been taken off the master since the pump started.
    ///
    /// Not a statistic anybody displays. It is the only way from outside to tell
    /// a pump that is waiting for room from one that is quietly buffering
    /// everything, which is the difference the bounded queue exists to make.
    pub fn taken(&self) -> usize {
        self.taken.load(Ordering::Relaxed)
    }

    /// Whether the shell's output has ended.
    pub fn over(&self) -> bool {
        self.kept
            .lock()
            .expect("the kept output lock is never poisoned")
            .over
    }
}

/// Turns a stream of reads into a stream of messages, and waits when it must.
async fn gather_and_send(mut reads: mpsc::Receiver<Vec<u8>>, kept: Arc<Mutex<Kept>>) {
    while let Some(first) = reads.recv().await {
        let mut message = first;
        let mut ended = false;

        // Only wait for more when there is reason to think more is coming.
        // Another read already queued says the shell is ahead of us; a read that
        // filled the buffer says the tty had at least that much ready. A lone
        // echo is neither, and goes out at once.
        if !reads.is_empty() || message.len() == READ_AT_ONCE {
            let closes = Instant::now() + GATHER_FOR;
            while message.len() < MOST_IN_ONE_MESSAGE {
                let left = closes.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match tokio::time::timeout(left, reads.recv()).await {
                    Ok(Some(more)) => message.extend_from_slice(&more),
                    // The reading thread is gone. Send what is in hand first;
                    // the end is reported after it, never instead of it.
                    Ok(None) => {
                        ended = true;
                        break;
                    }
                    Err(_) => break,
                }
            }
        }

        send_on(&kept, message.into()).await;
        if ended {
            break;
        }
    }

    // A channel ends when its last sender goes, so letting go of the list is
    // what tells every viewer the shell is over. Setting the flag under the same
    // lock means a viewer that sees the end and then asks cannot be told no.
    let mut kept = kept.lock().expect("the kept output lock is never poisoned");
    kept.over = true;
    kept.listeners.clear();
}

/// Remembers a message and gives it to everyone watching.
///
/// The listeners are copied out from under the lock and sent to outside it,
/// because sending is where this waits and holding the lock through the wait
/// would stop a viewer attaching until whichever one is wedged reads again.
async fn send_on(kept: &Mutex<Kept>, message: Message) {
    let listeners = {
        let mut kept = kept.lock().expect("the kept output lock is never poisoned");
        kept.remember(Arc::clone(&message));
        kept.listeners.clone()
    };

    let mut any_gone = false;
    for listener in &listeners {
        if listener.send(Arc::clone(&message)).await.is_err() {
            any_gone = true;
        }
    }

    if any_gone {
        kept.lock()
            .expect("the kept output lock is never poisoned")
            .listeners
            .retain(|listener| !listener.is_closed());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Reads everything a viewer is sent until the shell is over, or gives up.
    ///
    /// The giving up is an assertion, the same way it is in `shell.rs`: a pump
    /// that never reports the end would otherwise hang the whole suite with
    /// nothing at all to show for it.
    async fn watch_until_over(viewer: &mut mpsc::Receiver<Message>) -> Vec<u8> {
        let mut seen = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), viewer.recv()).await {
                Ok(Some(message)) => seen.extend_from_slice(&message),
                Ok(None) => return seen,
                Err(_) => panic!(
                    "the shell ended but the pump never said so — a viewer would wait for ever"
                ),
            }
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|run| run == needle)
    }

    /// Twenty thousand numbered lines, which comes to a little over a megabyte
    /// once the tty has turned every line break into two bytes.
    ///
    /// Numbered because the whole question is which end was kept, and sixty
    /// digits wide so the first line is a run of zeroes that appears nowhere
    /// else.
    const PRINT_A_LOT: &[u8] =
        b"awk 'BEGIN{for(i=0;i<20000;i++) printf \"%060d\\n\", i}'; printf 'THEEND\\n'; exit\n";

    #[tokio::test(flavor = "multi_thread")]
    async fn the_kept_output_is_the_most_recent_quarter_megabyte_and_no_more() {
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let pump = Pump::start(&shell).expect("the pump should take the shell's output");
        let (_, mut viewer) = pump.attach();

        shell.type_into(PRINT_A_LOT).unwrap();
        let printed = watch_until_over(&mut viewer).await;

        assert!(
            printed.len() > 1_200_000,
            "this case is only worth anything if more than a megabyte went past, and only \
             {} bytes did",
            printed.len()
        );
        assert_eq!(
            pump.held(),
            KEPT_PER_SHELL,
            "a shell that printed {} bytes should be holding exactly its cap",
            printed.len()
        );

        let replay = pump.replay();
        assert!(
            replay.len() <= KEPT_PER_SHELL + COLOURS_BACK_TO_NORMAL.len(),
            "a replay is what is held plus a reset and no more, and this one is {} bytes",
            replay.len()
        );
        assert!(
            contains(&replay, b"019999\r\n"),
            "the last line printed is the one thing a viewer coming back most needs to see, \
             and it is not in the replay"
        );
        assert!(
            contains(&replay, b"THEEND"),
            "the replay should reach the end of what was printed"
        );
        assert!(
            !contains(&replay, &[b'0'; 60]),
            "the first line printed is still in the replay, so what was dropped was not the \
             oldest end"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_viewer_that_stops_reading_stalls_the_pump_instead_of_filling_memory() {
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let pump = Pump::start(&shell).expect("the pump should take the shell's output");
        // Attached and then deliberately left alone. Nothing reads from this
        // until the last part of the case.
        let (_, mut viewer) = pump.attach();

        // Eight megabytes, which is more than every queue in the pump put
        // together could hold however generously they were sized.
        const OFFERED: usize = 8_000_000;
        shell
            .type_into(b"head -c 8000000 /dev/zero | tr '\\0' 'x'; printf 'THEEND\\n'; exit\n")
            .unwrap();

        // Everything the pump can be holding at once, counted out of its own
        // constants: the read in hand, the reads queued behind it, the message
        // being gathered, the message being sent, and the viewer's backlog.
        let room = READ_AT_ONCE * (1 + READS_IN_HAND)
            + (MOST_IN_ONE_MESSAGE + READ_AT_ONCE) * (2 + MESSAGES_PER_VIEWER);

        tokio::time::sleep(Duration::from_secs(1)).await;
        let stalled_at = pump.taken();
        assert!(
            stalled_at > READ_AT_ONCE,
            "the pump took only {stalled_at} bytes in a whole second, so the shell never got \
             going and this case would prove nothing about what happens when it does"
        );
        // Deliberately not phrased in terms of `room`, which grows if somebody
        // grows the constants: a pump that has taken a large fraction of
        // everything offered is buffering it, whatever its queues claim to be.
        assert!(
            stalled_at < OFFERED / 2,
            "{OFFERED} bytes were offered to a viewer reading none of them and the pump took \
             {stalled_at} of them, so it is growing a queue rather than waiting for one"
        );
        assert!(
            stalled_at <= room,
            "the pump is holding {stalled_at} bytes, which is more than the {room} bytes its \
             own queues add up to — something in here is buffering without a bound"
        );

        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(
            pump.taken(),
            stalled_at,
            "the pump went on taking bytes off the shell with nowhere to put them"
        );

        // Nothing was thrown away while it waited: the viewer that stopped
        // reading gets every byte once it starts again.
        let printed = watch_until_over(&mut viewer).await;
        assert!(
            printed.len() > OFFERED,
            "a viewer that fell behind and caught up should have missed nothing, and it was \
             sent only {} of {OFFERED} bytes",
            printed.len()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_firehose_is_gathered_into_messages_larger_than_one_read() {
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let pump = Pump::start(&shell).expect("the pump should take the shell's output");
        let (_, mut viewer) = pump.attach();

        shell.type_into(PRINT_A_LOT).unwrap();

        let mut messages = 0usize;
        let mut biggest = 0usize;
        let mut bytes = 0usize;
        loop {
            match tokio::time::timeout(Duration::from_secs(10), viewer.recv()).await {
                Ok(Some(message)) => {
                    messages += 1;
                    biggest = biggest.max(message.len());
                    bytes += message.len();
                }
                Ok(None) => break,
                Err(_) => panic!("the shell ended but the pump never said so"),
            }
        }

        assert!(bytes > 1_200_000, "only {bytes} bytes went past");
        assert!(
            biggest > READ_AT_ONCE,
            "no message was larger than a single read could hold, so nothing was gathered at \
             all: the largest of {messages} was {biggest} bytes"
        );
        assert!(
            messages <= bytes / READ_AT_ONCE,
            "{bytes} bytes went out in {messages} messages, which is no better than sending \
             one per read"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_untrimmed_replay_is_byte_for_byte_what_the_shell_printed() {
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let pump = Pump::start(&shell).expect("the pump should take the shell's output");
        // A shell prints its prompt the moment it starts, so some of it may
        // already have gone by. What was missed plus what comes next is the
        // whole of it, however the two happen to divide.
        let (before, mut viewer) = pump.attach();

        shell
            .type_into(b"printf 'MARK\\033[31mRED\\033[0mMARK\\n'; exit\n")
            .unwrap();
        let live = watch_until_over(&mut viewer).await;

        let mut whole = before;
        whole.extend_from_slice(&live);
        assert_eq!(
            pump.held(),
            whole.len(),
            "nothing should have been trimmed from so little output"
        );
        assert_eq!(
            pump.replay(),
            whole,
            "what is kept should be the live stream itself, in order and unaltered"
        );
        assert!(
            contains(&whole, b"MARK\x1b[31mRED\x1b[0mMARK"),
            "an escape sequence should reach the replay whole, with the text either side of it \
             still attached"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_trimmed_replay_starts_on_a_line_boundary_behind_a_reset() {
        // Four hundred kilobytes of lines exactly a hundred bytes long, so where
        // the trim lands is arithmetic rather than luck: it falls fifty-six bytes
        // into line one thousand three hundred and seventy-eight.
        let mut written = Vec::new();
        for line in 0..4000u32 {
            written.extend_from_slice(format!("{line:05}").as_bytes());
            written.extend_from_slice(&[b'z'; 94]);
            written.push(b'\n');
        }

        let pump = Pump::draining(Box::new(std::io::Cursor::new(written)));
        let (_, mut viewer) = pump.attach();
        watch_until_over(&mut viewer).await;

        assert_eq!(pump.held(), KEPT_PER_SHELL, "the cap should have been reached");

        let replay = pump.replay();
        assert!(
            replay.starts_with(COLOURS_BACK_TO_NORMAL),
            "a replay that begins in the middle of what was printed should open by putting the \
             colours back, in case what turned them on was trimmed away"
        );
        assert_eq!(
            replay[COLOURS_BACK_TO_NORMAL.len()],
            b'\n',
            "a trimmed replay should begin at a line break and not in the middle of a line"
        );

        let lines = &replay[COLOURS_BACK_TO_NORMAL.len() + 1..];
        assert_eq!(
            lines.len() % 100,
            0,
            "everything after the line break should be whole lines, and {} bytes is not",
            lines.len()
        );
        assert_eq!(
            &lines[..5],
            b"01379",
            "the replay should pick up at the first line that survived the trim whole"
        );
        assert_eq!(
            &lines[lines.len() - 100..lines.len() - 95],
            b"03999",
            "the replay should run to the last line printed"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pump_ends_when_the_shell_does() {
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let pump = Pump::start(&shell).expect("the pump should take the shell's output");
        let (_, mut viewer) = pump.attach();

        shell.type_into(b"exit\n").unwrap();

        let printed = watch_until_over(&mut viewer).await;
        assert!(!printed.is_empty(), "a shell should have printed something");
        assert!(
            pump.over(),
            "a viewer was told the output ended, so the pump should agree that it did"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_viewer_arriving_after_the_shell_is_over_is_told_so_at_once() {
        let mut shell = Shell::open(Path::new("/"), 80, 24).expect("a shell should start");
        let pump = Pump::start(&shell).expect("the pump should take the shell's output");
        let (_, mut viewer) = pump.attach();
        shell.type_into(b"printf 'THEEND\\n'; exit\n").unwrap();
        watch_until_over(&mut viewer).await;

        let (missed, mut late) = pump.attach();
        assert!(
            contains(&missed, b"THEEND"),
            "a viewer arriving late should still be shown what the shell printed"
        );
        assert!(
            matches!(
                tokio::time::timeout(Duration::from_secs(2), late.recv()).await,
                Ok(None)
            ),
            "a viewer attaching to a shell that has already ended should be told so immediately \
             rather than waiting on output that will never come"
        );
    }
}
