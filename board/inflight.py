#!/usr/bin/env python3
"""Which jobs have a reader out right now, so a second is never sent.

A job is sent a reader by board/run.py whenever a step of it closes, and one
command can close several: the hook hands `advance` every card id it finds on
the command line, so six ids reach it at once and six readers set off carrying
the same brief. They are the same reading done six times, and they spend the
account's allowance between them until none of them answers.

The claim is a directory rather than a lock inside the board, because the two
sides of it are two processes: the one that sends the reader, and the reader
itself, which outlives its sender. `os.mkdir` asks and takes in a single call,
so two sendings in the same second cannot both believe they won.

No failure leaves a job nobody can read: a claim lost, wiped with the temporary
directory, or left behind by a reader that died is not held, and the next card
to close sends a reader. What it will not do is answer that a job is claimed
when it is not — an unguarded reading is the storm itself.
See docs/board.md#4b-review-is-done-by-someone-who-did-not-write-the-change.
"""
import os
import time

# One attempt's ceiling, and how many a reader makes — board/review holds a
# reader to both. They live here rather than there because board/review carries
# no suffix to import by, and a number written out in two files is two numbers.
ATTEMPT_TIMEOUT = 3600
ATTEMPTS = 2

# A claim is taken before the reader exists, so there is a moment with no process
# to point at. Longer than a spawn, far shorter than a reading.
UNNAMED_GRACE = 60

# What a run of board/review is told when it is the detached copy that does the
# reading, rather than the run that spawned one. Both places that spawn a reader
# set it — run.fire and board/review's own hand-off — and board/review reads it
# before it would hand off, so no reader can spawn another. Here for the same
# reason the numbers above are: the reader is a script with no suffix to import
# by, and a name written out in two files is two names.
DETACHED = "MACHINERY_REVIEW_DETACHED"
# The directory that copy writes its console and its attempts into, when the run
# that spawned it had already allocated one. Unset when nobody has: the reader
# allocates its own.
RUN_DIR = "MACHINERY_REVIEW_RUN_DIR"


def home():
    return os.path.join(os.environ.get("CLAUDE_CODE_TMPDIR") or "/tmp",
                        "board-reviews")


def where(goal_id):
    return os.path.join(home(), goal_id + ".reading")


def _pid(goal_id):
    try:
        with open(os.path.join(where(goal_id), "pid")) as fh:
            return int(fh.read().strip())
    except Exception:
        return None


def _reading(pid, goal_id):
    """Whether that process is still there AND is this job's reader.

    Named rather than counted: a reader is legitimately out for as long as its
    attempts take, and judging it by a clock declares a working reader dead and
    sends a second at the same job (mch-m1t.10). What the clock is left guarding
    is a number that now belongs to somebody else, so the command line is read
    rather than trusted.
    """
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            args = fh.read().decode("utf-8", "replace").split("\0")
    except OSError:
        return False
    except Exception:
        return True
    return any(a.endswith("review") for a in args) and goal_id in args


def held(goal_id):
    """Whether a reader is genuinely out on this job.

    The reader itself is the answer wherever there is one to ask: a job is held
    for exactly as long as its own reader is running, however long that takes.
    The clock only decides the moment before the reader exists, so a sending that
    died between claiming and spawning cannot hold a job shut for good.
    """
    path = where(goal_id)
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        return False
    pid = _pid(goal_id)
    if pid is None:
        return age <= UNNAMED_GRACE
    return _reading(pid, goal_id)


def take(goal_id):
    """Claim this job, or answer no because a reader is already out.

    A claim nobody is behind any more is cleared and the claim retaken, so the
    job does not wait out a reader that has already died.

    ⛔ Yes means the claim is held. Answering yes without one leaves the job
    unguarded for a whole reading, which is the storm this exists to stop
    (mch-m1t.16) — so every way of not holding it answers no, and the job waits
    for the next closed card instead.
    """
    path = where(goal_id)
    try:
        os.makedirs(home(), exist_ok=True)
    except OSError:
        return False
    for _ in (1, 2):
        try:
            os.mkdir(path)
            return True
        except FileExistsError:
            if held(goal_id):
                return False
            clear(goal_id)
        except OSError:
            return False
    return False


def name(goal_id, pid):
    """Say which process is behind the claim, once it exists."""
    try:
        with open(os.path.join(where(goal_id), "pid"), "w") as fh:
            fh.write(str(pid))
        os.utime(where(goal_id), None)
    except OSError:
        pass


def clear(goal_id):
    """Remove the claim whoever holds it."""
    path = where(goal_id)
    try:
        for f in os.listdir(path):
            os.unlink(os.path.join(path, f))
        os.rmdir(path)
    except OSError:
        pass


def drop(goal_id):
    """Let go of a claim this process holds, and say whether it held one.

    A reader run by hand holds nothing, and must not clear the claim of a reader
    that is genuinely out: the pid is what tells the two apart.
    """
    mine = _pid(goal_id)
    if mine is not None and mine != os.getpid():
        return False
    if mine is None and not os.path.isdir(where(goal_id)):
        return False
    clear(goal_id)
    return True
