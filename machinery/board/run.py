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
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "hooks"))
import board_common as bc  # noqa: E402
import inflight  # noqa: E402
import project  # noqa: E402
import reading  # noqa: E402
import spine  # noqa: E402

GATE_TITLE = "Gate: read by someone who did not write it"
GATE_WHY = ("A review is done by someone else; the board's own reader resolves "
            "this gate when one has read the change, and cancelling the job "
            "resolves it as a reading that was never owed.")

# The gate that asks a claim its questions. A hook's filename is not an
# identifier, so it is loaded the way board/land loads the merge gate — and
# lazily, at the one moment a hand-over needs it: that gate imports this module,
# and loading it from here at import time would be the two of them in a ring.
CLAIM_GATE = os.path.join(os.path.dirname(HERE), "hooks", "board-status-gate.py")
_RULES = None


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


def moved(goal_id, want, root):
    """Move a job into a column, and say so when the board will not have it.

    Two of the six columns are words this machinery invented rather than words bd
    ships with, and a board is told about them when its project joins. A board
    nobody told refuses the move and hands the refusal back to whoever asked —
    so swallowing it here is how the whole review half of a run went missing on
    two of three projects with nobody noticing. Said on stderr because this is a
    library the hooks call, and stderr is the one channel a session reads.
    """
    ok, _ = bc.bd(["update", goal_id, "-s", want], root)
    if ok:
        return True
    if want in project.untold(root):
        sys.stderr.write("the board would not move %s to %s: nobody ever told it "
                         "that state exists, so it refuses every card sent there. "
                         "`machinery/join %s` tells it, and until then the review "
                         "half of every job here does nothing.\n"
                         % (goal_id, want, root))
    else:
        sys.stderr.write("the board would not move %s to %s.\n" % (goal_id, want))
    return False


def column(goal_id, goal, live, root):
    """Where a job draws while `live` is the position it is at.

    Agent Review is the one position at which nobody is building — every piece of
    the job has closed, which is what put it there. Manager's ruling, 2026-08-13:
    docs/board.md#3a.
    """
    want = bc.AGENT_REVIEW if live == "review" else "in_progress"
    if goal.get("status") in ("closed", bc.MANAGER_REVIEW, want):
        return
    moved(goal_id, want, root)


def park(goal_id, goal, meta, root):
    """A job the manager signs off waits for him once its last step has run.

    It is already on main by then: he judges by playing the game, and a branch held
    open for a human blocks every session queued behind its rebase.
    """
    if meta.get("judge") != "manager" or goal.get("status") in ("closed", bc.MANAGER_REVIEW):
        return
    if not moved(goal_id, bc.MANAGER_REVIEW, root):
        return
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


def reading_gates(goal_id, root):
    """The gates holding this job shut FOR ITS READING, by id.

    By title rather than by every open gate: the manager's own sign-off is a gate
    too, and a reading that has run out of rounds is no reason to let a job past
    the one thing on the board he raised himself.
    """
    return [r["id"] for r in rows_of(*bc.bd(["gate", "list", goal_id, "--json"], root))
            if r.get("id") and r.get("status") != "closed"
            and r.get("title") == GATE_TITLE]


def fire(goal_id, root):
    """Send a reader at a job, detached, and let it outlive the tool call.

    The reader is the machinery's, standing in the project's own checkout: `cwd`
    is what tells it whose job this is. Its console goes to a file of this run's
    own — two readers fired at one job used to share a path, and the second wiped
    the first (cor-987e).

    One command closing several cards of a job reaches here once per card, so the
    job is claimed first and a sending that finds a reader already out does
    nothing (board/inflight.py, mch-m1t). The claim is named after the reader as
    soon as there is one to name.

    The reader is told it is already the detached copy. This sending IS the
    hand-off, so a reader started here does the reading itself rather than
    spawning a second copy of itself to do it (bw-k0w.5).
    """
    if not inflight.take(goal_id):
        return
    reader = None
    try:
        os.makedirs(inflight.home(), exist_ok=True)
        fd, log = tempfile.mkstemp(prefix=goal_id + ".", suffix=".run.log",
                                   dir=inflight.home())
        # A reader sent from inside another reader would otherwise inherit that
        # one's run directory and write its attempts on top of them, which is
        # cor-987e again by another route. This one allocates its own.
        env = dict(os.environ, **{inflight.DETACHED: "1",
                                  inflight.CONSOLE: log})
        env.pop(inflight.RUN_DIR, None)
        reader = subprocess.Popen([os.path.join(HERE, "review"), goal_id],
                                  cwd=root, stdout=fd, stderr=fd,
                                  stdin=subprocess.DEVNULL, start_new_session=True,
                                  env=env)
        # The console goes down with the name so a firing that finds this claim
        # held has somewhere to point whoever asked (bw-5e8.4).
        inflight.name(goal_id, reader.pid, log)
        os.close(fd)
    except Exception:
        # Only a reader that never started leaves the claim behind: past this
        # point one is out, and clearing would let the next closed card send a
        # second at the same job.
        if reader is None:
            inflight.clear(goal_id)


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


def at_reading(order, rows):
    """Whether the job's run stands at its reading: it has one, and everything
    before it has closed. Written once, because the run and a reader letting go
    both ask it and two copies of it drift (mch-m1t.13)."""
    if "review" not in order or before_reading(order, rows):
        return False
    return True


def reading_due(goal_id, goal, order, rows, root):
    """Whether a reader should be sent to this job now.

    Three things at once: every piece before the reading has closed, the run has
    not already gone past it, and what stands has not been read — never, or not
    since it was last written to (board/reading.py).

    The last of those is what makes a job sent back come round again: the reader's
    findings are the job's own items, so answering them empties the job exactly as
    finishing the work did, and the same test fires. No branch of its own.
    """
    if not at_reading(order, rows):
        return False
    if steps_of(rows) & set(order[order.index("review") + 1:]):
        return False
    return (reading.wanted(goal, reading.commits(goal_id, root),
                           reading.wrote(goal_id, root))
            or answered_findings(goal_id, goal, rows, root))


def answered_findings(goal_id, goal, rows, root):
    """Whether a prior reading's last work item has now been answered.

    A finding may be settled by a no-code decision, producing no new commit.
    The open reading gate and an existing signature prove a reading happened;
    once every work item is closed, its answers still need the gated re-read.
    Without this route both `wanted` callers wait forever for a SHA that a
    legitimate decision does not create.
    """
    if not reading.readers(goal) or not reading_gates(goal_id, root):
        return False
    items = [r for r in rows if "step:work" in (r.get("labels") or [])]
    return bool(items) and all(r.get("status") == "closed" for r in items)


def due_again(goal_id, root):
    """Whether a reader that has just let go should be followed by one more.

    Only ever for a commit no reading was shown — never for `wanted`'s other
    half, a job no outsider has signed. That half is true of a job whose reader
    counts among the hands that wrote it, and a reader answering it would send
    the next, without end (mch-m1t.9). Work open again because this very reading
    filed some is not sent anybody either (mch-m1t.11); the step the reading has
    just opened after itself is, because a clean reading opens one before it lets
    go and the change that landed underneath still has to be read (mch-m1t.12).
    """
    goal = card(goal_id, root) or {}
    if goal.get("status") == "closed":
        return False
    # Under the same ceiling as every other sending: this one is fired from inside
    # a reader, so a reader that could send its own successor past the ceiling is
    # the one place the ceiling would buy nothing (board/reading.py `spent`).
    if reading.spent(goal):
        return False
    rows = children(goal_id, root)
    if not at_reading(spine.stored(tags(goal).get("spine")), rows):
        return False
    return bool(reading.unread(goal, reading.commits(goal_id, root)))


# What the goal is told when its last reading's points have been answered and no
# reader is coming. Written down because the alternative — a job that simply stops
# being read — is indistinguishable from the fault this replaced, where a job sat
# behind an open gate with nothing after the reading ever opening (mch-4cl).
SPENT_NOTE = (
    "The last reading's findings are answered and this job has had the %d readings "
    "a job gets, so the run goes on past the reading rather than sending another "
    "reader. A third round was measured raising fresh objections to code the round "
    "before it had read and accepted (bw-7e8), and settled nothing."
    % reading.ROUNDS)


def past_reading(order, rows):
    """Whether the run has actually gone on past the reading.

    Not whether a position after the reading has a card — the reading itself hands
    the job the one that comes next, so a card there is as much a sign the reading
    just finished as a sign the run left it behind. It is whether one of them has
    CLOSED. A job whose reader came back a second time with something to fix, after
    the finishing position had already been handed out, is standing at its reading
    again and not past it, and reading a card as "past" left exactly that job shut
    for good with nothing on the board able to move it (mch-6f5).
    """
    if "review" not in order:
        return False
    after = set(order[order.index("review") + 1:])
    return any(r.get("status") == "closed" for r in rows
               for l in r.get("labels") or []
               if l.startswith("step:") and spine.now(l[5:]) in after)


def reading_over(goal_id, goal, order, rows, root):
    """Let a job past a reading it will get no more of, and say so.

    A reading that finds nothing opens the step after itself; a reading that files
    findings leaves the job shut until answering them brings the reader back. When
    the reader will not come back — the job has had its rounds — nothing else on
    the board would ever move the run on, and the job would sit behind its own open
    gate exactly as it did before any of this. So the run treats the answered
    findings as the clean reading that never happened: the gate goes, a line goes
    on the goal, and the step after the reading opens.

    The gate is the latch. Once it is down this is false however often a card of
    the job closes, so the note is written once.
    """
    if not at_reading(order, rows) or not reading.spent(goal):
        return False
    if past_reading(order, rows):
        return False
    gates = reading_gates(goal_id, root)
    if not gates:
        return False
    for gate in gates:
        bc.bd(["gate", "resolve", gate], root)
    bc.bd(["update", goal_id, "--append-notes", SPENT_NOTE], root)
    after_reading(goal_id, root)
    return True


def rules():
    """The claim gate, as a module, for the questions it asks about a copy.

    Loaded once and kept: reading a hook off disk is cheap, and doing it for
    every piece of a job that closes is not.
    """
    global _RULES
    if _RULES is None:
        spec = importlib.util.spec_from_loader(
            "board_status_gate",
            importlib.machinery.SourceFileLoader("board_status_gate", CLAIM_GATE))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _RULES = mod
    return _RULES


def nowhere_to_work(piece, root, here):
    """The refusal handing this card over earns for having nowhere to change code.

    Asked of the claim's own code rather than of a second copy of the rule: what
    a job's own copy is, which checkout it has to stand in and what to say when
    it has none are written down once, in the gate that asks a claim the same
    question (hooks/board-status-gate.py).

    Nothing is asked of a card that makes none — a note, a ruling, the landing —
    and nothing is asked when the caller cannot say where the session is
    standing: the board's own reader opens steps from outside any session, and a
    directory nobody named is not a directory in the shared tree.
    """
    if not here:
        return ""
    gate = rules()
    if not gate.makes_code(piece):
        return ""
    goal = next((l[3:] for l in piece.get("labels") or [] if l.startswith("of:")),
                None)
    if not goal:
        return ""
    return gate.without_a_copy(piece.get("id"), goal, root, here)


# What a session is told about the piece it was not handed. The refusal is the
# claim's own, word for word — it names the one command that cuts the copy — and
# this line says why it arrived without anybody having claimed anything.
HELD_BACK = ("%s is open and owned by nobody: the run does not hand a piece that "
             "makes code to a session with nowhere to make it.\n%s")


def hand_over(piece, actor, root, only_if_free=False, here=None):
    """Give this card to the session that closed the one before it.

    One claim a job, not one a step. A job used to be claimed eleven times, and
    every one of those was a command somebody had to remember: the board knows
    who closed the last piece, and the next piece is that session's until it says
    otherwise. `--claim` sets the assignee to whoever runs it, so the name is set
    outright rather than claimed on somebody else's behalf.

    A step that makes code is handed over only where the change can be made, and
    `here` is the directory the session that closed the last piece typed from.
    That question is asked here because a hand-over is not a claim: nothing types
    a command for it, so the gate standing in front of `--claim` never sees one,
    and a job that opened with a step making no code reached its first code step
    already held — from whatever checkout that session happened to be standing in
    (bw-kszy). A step that earns the refusal is left open and unowned, and the
    refusal is what comes back, so the session is told how to cut the copy
    instead of being handed work it has nowhere to do.

    `only_if_free` is for a card the board did not just create: another session
    may already hold it, and handing it over would take work off somebody's desk.
    bd writes nothing and exits 13 when the guard does not hold.
    """
    cid = (piece or {}).get("id")
    if not actor or not cid:
        return ""
    nowhere = nowhere_to_work(piece, root, here)
    if nowhere:
        return HELD_BACK % (cid, nowhere)
    args = ["update", cid, "-a", actor, "-s", "in_progress"]
    # Which copy the work is being done in, written onto the card because the
    # board name no longer carries it (board_common.copy_label). Never a second
    # time: a card that already says which copy it belongs to keeps that answer.
    if here and not any(l.startswith(bc.COPY) for l in (piece or {}).get("labels") or []):
        args += ["--add-label", bc.copy_label(here)]
    if only_if_free:
        args += ["--if-assignee", ""]
    bc.bd(args, root)
    return ""


def free_item(rows):
    """The next piece of this job nobody is holding, in the order they were poured.

    The card itself rather than its id: what is asked before it is handed to
    anybody is whether it makes code, and that is read off the labels the listing
    already carries (`hand_over`).

    A reader's findings arrive as several at once and the session answering them
    takes one; the rest are handed over as each closes. A piece somebody else has
    already taken is never moved — one claim a job is not one claim a board.
    """
    for r in rows:
        if r.get("status") == "open" and not (r.get("assignee") or ""):
            return r
    return None


def open_next(rest, have, goal_id, goal, meta, root, actor=None, here=None):
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
        labels = spine.step_labels(nxt, goal_id, meta)
        ok, out = bc.bd(spine.card(nxt, goal_id, meta, goal.get("priority", 2))
                        + ["--json"], root)
        try:
            new_id = json.loads(out or "{}").get("id") if ok else None
        except Exception:
            new_id = None
        if new_id:
            bc.bd(spine.settle(new_id, labels), root)
            column(goal_id, goal, nxt, root)
            # The card as it now stands rather than asked for again: the pour
            # above made it a task and the line before this one is what its
            # labels are, which is everything the hand-over asks about it.
            return hand_over({"id": new_id, "issue_type": "task", "labels": labels},
                             actor, root, here=here)
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


def advance(cid, root, actor=None, here=None):
    """A closed step opens the next one, or hands the job to a reader.

    `actor` is the session that closed this one, and whatever opens next is its
    work: the board hands the job on rather than asking for a claim per step.
    Nobody is named when the reader is what called this — a reading is not a hand
    that then owns the record step.

    `here` is where that session typed from, and what comes back is the refusal a
    hand-over earned there, if one did: a step making code goes to nobody unless
    the job has a copy of its own to make it in (`hand_over`).
    """
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
            # Still building. The next piece of this job nobody holds goes to the
            # session that just finished one, so a job is claimed once however
            # many pieces it was broken into.
            return hand_over(free_item(items), actor, root, only_if_free=True,
                             here=here)
    if reading_due(goal_id, goal, order, rows, root):
        open_reading(goal_id, goal, root)
        return
    if reading_over(goal_id, goal, order, rows, root):
        return
    if which == order[-1]:
        park(goal_id, goal, meta, root)
        return
    return open_next(order[order.index(which) + 1:], steps_of(rows), goal_id, goal,
                     meta, root, actor, here)
