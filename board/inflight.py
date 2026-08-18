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

# A claim nothing can be told about is judged by its age, and this is the
# ceiling. Nothing this file writes leaves a claim in that state — the owner goes
# down inside `take` — so what is left here is a claim from an older run of these
# tools, one whose mark could not be written, and one whose owner was written
# without a birth to check it by.
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


def _said(goal_id, what):
    """What this claim wrote down under that name, or nothing."""
    try:
        with open(os.path.join(where(goal_id), what)) as fh:
            return fh.read().strip()
    except OSError:
        return None


def _write(goal_id, what, value):
    """Write one of the claim's marks, and touch the claim so its age is its own."""
    try:
        with open(os.path.join(where(goal_id), what), "w") as fh:
            fh.write(str(value))
        os.utime(where(goal_id), None)
    except OSError:
        pass


def _number(goal_id, what):
    try:
        return int(_said(goal_id, what))
    except (TypeError, ValueError):
        return None


def _pid(goal_id):
    return _number(goal_id, "pid")


def _born(pid):
    """When that process started, which is what tells it from a later one.

    A process number is handed back out once the process behind it is gone, so
    the number on its own says nothing about who holds it now. The start time is
    fixed for the life of a process, so the number and the start time together
    are an identity, and that is what a claim writes down. It is the twenty-
    second field of /proc/<pid>/stat; the program's own name is the second and
    sits inside brackets that may hold spaces of their own, so the fields are
    counted from after the last bracket rather than from the beginning.
    """
    try:
        with open("/proc/%d/stat" % pid) as fh:
            rest = fh.read().rsplit(")", 1)[1]
        return int(rest.split()[19])
    except (OSError, IndexError, ValueError):
        return None


def _mine():
    """This process written down the way a claim's owner is: number, then birth."""
    born = _born(os.getpid())
    if born is None:
        return str(os.getpid())
    return "%d %d" % (os.getpid(), born)


def _owner(goal_id):
    """The process that took this claim and when it started, as a pair.

    Marked from the instant the claim was taken. The birth is missing on a claim
    written where the start time could not be read, and on one left by an older
    run of these tools that wrote the number alone.
    """
    said = (_said(goal_id, "owner") or "").split()
    try:
        pid = int(said[0])
    except (IndexError, ValueError):
        return None, None
    try:
        return pid, int(said[1])
    except (IndexError, ValueError):
        return pid, None


def _alive(pid):
    """Whether that process is still there at all.

    The owner is asked this and not whether it is a reader: between the claim and
    the spawn the holder is whoever took the claim — the run tool inside a hook,
    or a reading fired by hand — and none of them answers to a reader's name.
    Asked alone it cannot tell the owner from whoever inherited its number later,
    so it is only what is left where the claim carries no birth to check.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


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
    Before the reader exists the holder is whoever took the claim, and the job is
    held for as long as that process is alive — a claim marked from the instant it
    is taken is never mistaken for one nobody is behind, which is how one goal was
    read by two readers a minute apart (bw-5e8.4). A sending that died between
    claiming and spawning still cannot hold a job shut: its owner is gone, and
    gone means the process that took the claim, not the number it was using. A
    number outlives its process and is handed to the next one along, so asking
    only whether something is alive at that number hands the job to a stranger
    to hold shut for good, with no clock left to get it back (bw-5e8.7).
    """
    path = where(goal_id)
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        return False
    pid = _pid(goal_id)
    if pid is not None:
        return _reading(pid, goal_id)
    owner, born = _owner(goal_id)
    if owner is not None:
        if born is not None:
            return _born(owner) == born
        # Nothing to tell the owner from whoever holds its number now, so the
        # claim is worth no more than a bare one and the clock guards it.
        return _alive(owner) and age <= UNNAMED_GRACE
    return age <= UNNAMED_GRACE


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
            # The mark goes down in the same breath as the claim. Taken and left
            # bare, the claim would have nothing but its age to be judged by, and
            # a firing a minute later would read a holder still at work as one
            # that had died and send a second reader at the job (bw-5e8.4).
            _write(goal_id, "owner", _mine())
            return True
        except FileExistsError:
            if held(goal_id):
                return False
            clear(goal_id)
        except OSError:
            return False
    return False


def name(goal_id, pid, log=None):
    """Say which process is behind the claim, once it exists, and where it writes.

    The console goes down beside the name so a second firing has somewhere to
    send whoever asked: told a reading is already under way, an agent can read
    that run rather than start one of its own (bw-5e8.4).
    """
    _write(goal_id, "pid", pid)
    if log:
        _write(goal_id, "console", log)


def console(goal_id):
    """Where the reader holding this claim is writing, if it said."""
    return _said(goal_id, "console")


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

    A run that holds nothing must not clear the claim of a reader that is
    genuinely out: the mark is what tells the two apart, and it is the reader's
    own name where there is one and the name of whoever took the claim before
    that.
    """
    mine = _pid(goal_id)
    if mine is None:
        mine = _owner(goal_id)[0]
    if mine is not None and mine != os.getpid():
        return False
    if mine is None and not os.path.isdir(where(goal_id)):
        return False
    clear(goal_id)
    return True
