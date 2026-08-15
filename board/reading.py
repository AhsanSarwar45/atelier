#!/usr/bin/env python3
"""What proves a job was read, and by whom.

A job is read, never a card of it: the reading is a position in the run with no
card of its own (scripts/board/spine.py), so the goal carries the signature. This
file is the only place that says what a signature is worth — the run, the close
gate and the reader all ask here rather than each parsing the same note.

Everything that decides is a function of a goal card and a list of commits, so
scripts/board/selftest.py exercises it without touching a board.
See docs/board.md#4b-review-is-done-by-someone-who-did-not-write-the-change.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
import board_common as bc  # noqa: E402

# What a reader writes onto the goal it read: who it was, and what it was shown.
# The second line is what makes the signature expire — without it a reading signed
# once covers work written afterwards that nobody ever saw (cor-dqth).
RECEIPT = re.compile(r"reviewed-by:\s*(\S+)")
COVERS = re.compile(r"read-commits:\s*([0-9a-f][0-9a-f ]*)")
SIGNATURE = "reviewed-by: %s\nread-commits: %s"
# Long enough that a hook asking twice in a turn is not felt, short enough that a
# stalled repository cannot hold a tool call open.
GIT_TIMEOUT = 30


def commits(goal_id, root):
    """Every commit naming this job or any card of it, oldest first.

    Asked of the id rather than of the board's card list, so a commit still counts
    when the card it names has been closed or removed. Asked of every checkout the
    job declared, because a change that landed elsewhere is still change to read.
    Every ref, not the main line: a reader is shown the branch as it stands.
    """
    want = r"\b%s(\.[0-9a-z.]+)?\b" % re.escape(goal_id)
    found = []
    for where, _ in bc.landings(root, goal_id):
        try:
            run = subprocess.run(
                ["git", "log", "--all", "-E", "--grep", want, "--format=%H", "--reverse"],
                cwd=where, capture_output=True, text=True, timeout=GIT_TIMEOUT)
        except Exception:
            continue
        if run.returncode == 0:
            found += run.stdout.split()
    return list(dict.fromkeys(found))


def readers(goal):
    """The names that have signed this goal, in the order they signed."""
    return RECEIPT.findall(goal.get("notes") or "")


def covered(goal):
    """Every commit some reading of this goal was shown.

    The union of them all: a commit read once stays read, because a second reading
    is about what came after the first and not about the whole job again.
    """
    out = set()
    for line in COVERS.findall(goal.get("notes") or ""):
        out.update(line.split())
    return out


def unread(goal, shas):
    """The job's commits no reading was shown, oldest first."""
    seen = covered(goal)
    return [s for s in shas if s not in seen]


def outsiders(goal, wrote):
    """The names that signed this goal and are not among those that wrote it.

    `wrote` is every name that touched the job, the session asking included. The
    test this replaces compared the signature against the assignees of the job's
    other STEPS — a set the session doing the closing is never in, so no signature
    could ever fail it (cor-dqth).
    """
    return [n for n in readers(goal) if n not in set(wrote)]


def wrote(goal_id, root):
    """Every board name that holds, or has held, a card of this job."""
    ok, out = bc.bd(["list", "--parent", goal_id, "--status", "all", "--json"], root)
    try:
        # bd says `null` for an empty result, which json turns into nothing at all
        # rather than into no cards.
        rows = (json.loads(out or "[]") if ok else []) or []
    except Exception:
        rows = []
    return {r.get("assignee") for r in rows if r.get("assignee")}


def read_by(goal, goal_id, root, also=()):
    """Who read this job, or None. `also` carries names the board does not yet hold
    against it — the session asking, before it has claimed anything of the job."""
    return next(iter(outsiders(goal, wrote(goal_id, root) | set(also))), None)


def wanted(goal, shas, wrote_it=()):
    """Whether a reader should be sent to this job now.

    Never read, or written to since it was: either way what stands has not been
    read by anyone. A signature from a hand that wrote the job counts as none, so
    a job cannot talk itself out of being read by signing itself.
    """
    return not outsiders(goal, wrote_it) or bool(unread(goal, shas))
