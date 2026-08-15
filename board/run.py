#!/usr/bin/env python3
"""How a job's run moves from one step to the next.

A closed step opens the following one: steps are never all created up front,
because until the step before it has run a step can carry nothing but the
template's own words.

The reading stands between the work and the record and has no card of its own,
so this is driven from two places rather than one — a reading that found nothing
closes no card, and nothing else on the board would move the run past it.
See docs/board.md#4c-the-steps-a-job-picked.
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "hooks"))
import board_common as bc  # noqa: E402
import reading  # noqa: E402
import spine  # noqa: E402

GATE_TITLE = "Gate: read by someone who did not write it"
GATE_WHY = ("A review is done by someone else; the board's own reader resolves "
            "this gate when one has read the change, and cancelling the job "
            "resolves it as a reading that was never owed.")


def card(cid, root):
    ok, out = bc.bd(["show", cid, "--json"], root)
    if not ok:
        return None
    try:
        got = json.loads(out or "{}")
        return got[0] if isinstance(got, list) else got
    except Exception:
        return None


def rows_of(ok, out):
    """A list of cards from a bd answer. bd says `null` for an empty result, which
    json turns into nothing at all rather than into no cards."""
    try:
        return (json.loads(out or "[]") if ok else []) or []
    except Exception:
        return []


def children(goal_id, root):
    """Every card of a job whatever its status. The work position waits on items
    closing one by one, and a listing of the open ones alone reads an emptying job
    as an empty one."""
    return rows_of(*bc.bd(["list", "--parent", goal_id, "--status", "all", "--brief",
                           "--json"], root))


def tags(goal):
    """The goal's own answers. A goal poured before a tag existed carries it only as
    a label, and a step opened from the metadata alone would take the default
    instead of its job's answer."""
    meta = dict(goal.get("metadata") or {})
    for tag in ("area", "kind"):
        if not meta.get(tag):
            meta[tag] = next((l[len(tag) + 1:] for l in goal.get("labels") or []
                              if l.startswith(tag + ":")), meta.get(tag))
    return meta


def steps_of(rows):
    """Which positions of the run this job already has a card for."""
    return {spine.now(l[5:]) for r in rows for l in r.get("labels") or []
            if l.startswith("step:")}


def started(cid, root):
    """A job is being worked from the moment one of its pieces is."""
    goal_id = next((l[3:] for l in (card(cid, root) or {}).get("labels") or []
                    if l.startswith("of:")), None)
    if goal_id:
        bc.bd(["update", goal_id, "-s", "in_progress", "--if-status", "open"], root)


def column(goal_id, goal, live, root):
    """Where a job draws while `live` is the position it is at.

    Agent Review is the one position at which nobody is building — every piece of
    the job has closed, which is what put it there. Manager's ruling, 2026-08-13:
    docs/board.md#3a.
    """
    want = "in_review" if live == "review" else "in_progress"
    if goal.get("status") in ("closed", bc.MANAGER_REVIEW, want):
        return
    bc.bd(["update", goal_id, "-s", want], root)


def park(goal_id, goal, meta, root):
    """A job the manager signs off waits for him once its last step has run.

    It is already on main by then: he judges by playing the game, and a branch held
    open for a human blocks every session queued behind its rebase.
    """
    if meta.get("judge") != "manager" or goal.get("status") in ("closed", bc.MANAGER_REVIEW):
        return
    bc.bd(["update", goal_id, "-s", bc.MANAGER_REVIEW], root)
    # When his wait started, which is not when the job was opened: his column is
    # drawn longest-waiting first, and a job poured months ago is not one he has
    # been kept waiting on.
    bc.bd(["update", goal_id, "--set-metadata", "waiting_since=%s"
           % datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")],
          root)
    bc.bd(["update", goal_id, "--append-notes",
           "Landed and waiting on the manager. What he has to look at: %s"
           % (meta.get("judge_why") or "stated when this job was poured.")], root)


def gated(goal_id, root):
    """Whether something is already holding this job shut."""
    return any(r.get("status") != "closed"
               for r in rows_of(*bc.bd(["gate", "list", goal_id, "--json"], root)))


def fire(goal_id, root):
    """Send a reader at a job, detached, and let it outlive the tool call.

    The reader is the machinery's, standing in the project's own checkout: `cwd`
    is what tells it whose job this is. Its console goes to a file of this run's
    own — two readers fired at one job used to share a path, and the second wiped
    the first (cor-987e).
    """
    log_dir = os.path.join(os.environ.get("CLAUDE_CODE_TMPDIR") or "/tmp",
                           "board-reviews")
    try:
        os.makedirs(log_dir, exist_ok=True)
        fd, _ = tempfile.mkstemp(prefix=goal_id + ".", suffix=".run.log", dir=log_dir)
        subprocess.Popen([os.path.join(HERE, "review"), goal_id],
                         cwd=root, stdout=fd, stderr=fd,
                         stdin=subprocess.DEVNULL, start_new_session=True)
        os.close(fd)
    except Exception:
        pass


def open_reading(goal_id, goal, root):
    """Draw the job in its column, hold it shut, and send someone to read it.

    The gate is bd's own refusal (`cannot close blocked issue`) and it is raised
    before any reader exists: a reader that never starts leaves the job visibly
    stuck, which is the failure someone notices, rather than one that quietly
    closes itself. The board's own reader is what resolves it.
    """
    column(goal_id, goal, "review", root)
    if not gated(goal_id, root):
        bc.bd(["gate", "create", "--blocks", goal_id, "--type", "human",
               "--title", GATE_TITLE, "--reason", GATE_WHY], root)
    fire(goal_id, root)


def before_reading(order, rows):
    """Positions standing before the reading that this job has not run yet.

    The work position is answered by its items rather than by a card of its own,
    and one closed item is not the position: a job with any item still open has not
    reached the reading, however many of its steps have closed.
    """
    if "review" not in order:
        return []
    done = set()
    for r in rows:
        if r.get("status") == "closed":
            done |= {spine.now(l[5:]) for l in r.get("labels") or []
                     if l.startswith("step:")}
    items = [r for r in rows if any(l.startswith("step:") and spine.now(l[5:]) == "work"
                                    for l in r.get("labels") or [])]
    done.discard("work")
    if items and all(r.get("status") == "closed" for r in items):
        done.add("work")
    return [s for s in order[:order.index("review")] if s not in done]


def reading_due(goal_id, goal, order, rows, root):
    """Whether a reader should be sent to this job now.

    Three things at once: every piece before the reading has closed, the run has
    not already gone past it, and what stands has not been read — never, or not
    since it was last written to (board/reading.py).

    The last of those is what makes a job sent back come round again: the reader's
    findings are the job's own items, so answering them empties the job exactly as
    finishing the work did, and the same test fires. No branch of its own.
    """
    if "review" not in order or before_reading(order, rows):
        return False
    if steps_of(rows) & set(order[order.index("review") + 1:]):
        return False
    return reading.wanted(goal, reading.commits(goal_id, root),
                          reading.wrote(goal_id, root))


def open_next(rest, have, goal_id, goal, meta, root):
    """Open the first position of `rest` this job has no card for.

    A position with no card is stepped over rather than waited on: the work is
    waited on by its own items, and a reading due would have been opened before
    this ran.
    """
    for nxt in rest:
        if spine.evidence(nxt) == spine.READ:
            continue
        if spine.evidence(nxt) == spine.WORK or nxt in have:
            return
        ok, out = bc.bd(spine.card(nxt, goal_id, meta, goal.get("priority", 2))
                        + ["--json"], root)
        try:
            new_id = json.loads(out or "{}").get("id") if ok else None
        except Exception:
            new_id = None
        if new_id:
            bc.bd(spine.settle(new_id, spine.step_labels(nxt, goal_id, meta)), root)
            column(goal_id, goal, nxt, root)
        return


def after_reading(goal_id, root):
    """Open the position that follows the reading.

    The reader calls this. A reading that found nothing closes no card, so nothing
    else on the board would move the run on.
    """
    goal = card(goal_id, root) or {}
    meta = tags(goal)
    order = spine.stored(meta.get("spine"))
    if "review" not in order:
        return
    rows = children(goal_id, root)
    rest = order[order.index("review") + 1:]
    if not rest:
        park(goal_id, goal, meta, root)
        return
    open_next(rest, steps_of(rows), goal_id, goal, meta, root)


def advance(cid, root):
    """A closed step opens the next one, or hands the job to a reader."""
    step = card(cid, root) or {}
    if step.get("status") != "closed":
        return
    labels = step.get("labels") or []
    which = next((spine.now(l[5:]) for l in labels if l.startswith("step:")), None)
    goal_id = next((l[3:] for l in labels if l.startswith("of:")), None)
    if not which or not goal_id:
        return
    goal = card(goal_id, root) or {}
    meta = tags(goal)
    order = spine.stored(meta.get("spine"))
    if which not in order:
        return
    rows = children(goal_id, root)
    # The work position is the job's own items rather than a card, so the run waits
    # there for the last of them — and a job that reached it with none never gets
    # past it.
    if which == "work":
        items = [r for r in rows if any(l.startswith("step:")
                                        and spine.now(l[5:]) == "work"
                                        for l in r.get("labels") or [])]
        if not items or any(r.get("status") != "closed" for r in items):
            return
    if reading_due(goal_id, goal, order, rows, root):
        open_reading(goal_id, goal, root)
        return
    if which == order[-1]:
        park(goal_id, goal, meta, root)
        return
    open_next(order[order.index(which) + 1:], steps_of(rows), goal_id, goal, meta, root)
