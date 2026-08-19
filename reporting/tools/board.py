#!/usr/bin/env python3
"""The board, read as a report's checklist.

A spec that names a card owns no status text of its own: the ticks, the now
line and the next-up line are whatever the board says at build time. One level
only — the children of a goal are jobs written as observables, while their own
spine steps are internal and never reach a report.
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
from pathlib import Path

from blocks import ReportError

# closed is a tick, work that has started is the half-tick, everything else is
# unticked. Written but not yet merged, and waiting for the manager's own
# signature, are both started: a row nobody has touched is the only empty one.
STATE = {
    "closed": "done",
    "in_progress": "draft",
    "in_review": "draft",
    "manager_review": "draft",
    "open": "todo",
    "pinned": "todo",
    "blocked": "todo",
    "deferred": "todo",
}
# Work that is not happening is not work waiting, so it leaves the list. A board
# may drop a card by status or by putting the word on it and closing it, and the
# second reads as a finished tick unless both are watched for.
DROPPED = ("cancelled", "dropped", "wontfix")

def _order(kid: dict):
    """Where this row sits in the run of the job.

    When the card was made, then its own number: a job's steps are made one at a
    time as each opens, and its work items are poured in a single second, so the
    number is what tells those apart. Sorting by state instead reads as two lists
    running in opposite directions, which is what a checklist must never be.
    """
    return (kid.get("created_at") or "",
            re.sub(r"\d+", lambda m: m.group().zfill(6), kid.get("id", "")))

# A job's own steps are titled in this system's vocabulary and repeat the goal's
# title after it. What the reader is owed is the step's purpose, in their words.
STEP_LABEL = "step:"
STEPS = {
    "worktree": "Get a clean workspace",
    "clarify": "Settle what is unclear",
    "prove": "Reproduce it",
    "ground": "Read the sources",
    "design": "Decide the shape",
    "work": "Build it",
    "build": "Build it",
    "verify": "Check that it works",
    "benchmark": "Measure before and after",
    "test": "Stop it coming back",
    "review": "Have someone else read it",
    "record": "Write it up",
    "land": "Merge it",
}


def _step(kid: dict) -> str:
    """The step this card belongs to, or "" for a card that is not one."""
    for label in kid.get("labels", []):
        if label.startswith(STEP_LABEL):
            return label[len(STEP_LABEL):]
    return ""


def _title(kid: dict, shared: set) -> str:
    """What this row of the checklist is called.

    A step's own title repeats the goal's, so a lone step reads better as its
    purpose. A step that holds many cards is the job's work: they are told apart
    only by their own titles, and printing the step's name would print it once
    per card.
    """
    name = _step(kid)
    if name and name not in shared:
        return STEPS.get(name, name.capitalize())
    return kid.get("title", kid["id"])


def board_home(spec_dir: Path, fallback: Path) -> Path:
    """Where the board lives for the project this spec is about.

    The spec's own folder names the project, and the board screen's project
    list says where that project's checkout is — so a build finds the right
    board from any directory, not only when run inside the project. The list
    sits beside the reports themselves (reports/<project>/ -> ../settings.db).
    A project the list does not know falls back to the directory the command
    was run from, which is where an unregistered project's board would be.
    """
    db = spec_dir.parent.parent / "settings.db"
    if db.is_file():
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                for (path,) in con.execute("SELECT path FROM projects"):
                    if path and Path(path).name == spec_dir.name and Path(path).is_dir():
                        return Path(path)
            finally:
                con.close()
        except sqlite3.Error:
            pass
    return fallback


def children(card: str, project: Path) -> list[dict]:
    """The card's direct children, in board order, closed ones included."""
    try:
        out = subprocess.run(
            ["bd", "list", "--parent", card, "--all", "--json"],
            capture_output=True, text=True, cwd=project, timeout=20,
        )
    except FileNotFoundError:
        raise ReportError(
            "this report reads its checklist from the board, and the board command is not "
            "installed here — remove status.card to write the checklist by hand instead"
        )
    if out.returncode != 0:
        raise ReportError(f"the board refused to list {card}: {out.stderr.strip() or 'no reason given'}")

    try:
        kids = json.loads(out.stdout or "[]")
    except json.JSONDecodeError:
        raise ReportError(f"the board's answer for {card} was not readable")

    if not kids:
        raise ReportError(
            f"{card} has no work under it, so there is no checklist to read — "
            "give the card children, or write the checklist by hand without status.card"
        )
    return kids


def _under_way(kid: str, project: Path) -> bool:
    """A goal is under way when anything beneath it is claimed or already closed."""
    try:
        out = subprocess.run(
            ["bd", "list", "--parent", kid, "--all", "--json"],
            capture_output=True, text=True, cwd=project, timeout=20,
        )
        below = json.loads(out.stdout or "[]") if out.returncode == 0 else []
    except Exception:
        return False
    if any(b.get("status") in ("in_progress", "closed") for b in below):
        return True
    return any(_under_way(b["id"], project) for b in below)


def status(card: str, project: Path, spec_dir: Path | None = None) -> dict:
    """The whole status slot: what is happening now, what is next, and the list.

    Both lines are about the whole board, not its first row: naming one of three
    live items reads as the only one, and a board with nothing left to start
    still has everything left to finish.
    """
    if spec_dir is not None:
        project = board_home(spec_dir, project)
    kids = children(card, project)
    seen: dict[str, int] = {}
    for k in kids:
        name = _step(k)
        if name:
            seen[name] = seen.get(name, 0) + 1
    shared = {name for name, n in seen.items() if n > 1}

    items = []
    for k in sorted(kids, key=_order):
        if k.get("status") in DROPPED or set(k.get("labels") or []) & set(DROPPED):
            continue
        state = STATE.get(k.get("status", "open"), "todo")
        if state != "done" and (state == "draft" or _under_way(k["id"], project)):
            state = "draft"
        # The card behind this row, so a reader of the facts document can look
        # it up on the board itself rather than only the text printed here.
        items.append({"state": state, "text": _title(k, shared), "card": k["id"]})

    doing = [i["text"] for i in items if i["state"] == "draft"]
    waiting = [i["text"] for i in items if i["state"] == "todo"]

    # The list below already names every live item, so this counts the rest
    # rather than repeating them.
    if not doing:
        now = "Nothing is being worked on right now."
    elif len(doing) == 1:
        now = doing[0]
    else:
        now = "%s — and %d more, marked below" % (doing[0], len(doing) - 1)

    if waiting:
        next_up = waiting[0]
    elif doing:
        next_up = "Nothing is waiting to start; everything left is already under way."
    else:
        next_up = "Nothing left — every piece of this is finished."

    return {"now": now, "next_up": next_up, "items": items}


class NoBoard(Exception):
    """There is no board command on this machine to ask."""


class BoardSilent(Exception):
    """The board is here and could not answer; it carries its own reason."""


def _ask(card: str, project: Path) -> dict | None:
    """The board's raw answer for one card, or None when it has never heard of it.

    `card_state` and `card_info` both need to tell an unknown card apart from a
    board that could not answer at all, so this is the one place that asks `bd`
    and reads what came back; each caller then decides what to keep.
    """
    try:
        out = subprocess.run(
            ["bd", "show", card, "--json"],
            capture_output=True, text=True, cwd=project, timeout=20,
        )
    except FileNotFoundError:
        raise NoBoard
    try:
        data = json.loads(out.stdout or "null")
    except json.JSONDecodeError:
        data = None
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, dict):
        # An unknown card is still an answer, and the board writes one: an error
        # it can name. Nothing on that channel at all means it never got as far
        # as looking, and telling the reader to rename their card would send
        # them after the wrong thing entirely.
        if out.returncode != 0:
            raise BoardSilent(out.stderr.strip() or "no reason given")
        return None
    if data.get("error") or not data.get("id"):
        return None
    return data


# Same raw-status -> board-column reading the app's own kanban screen uses
# (src/types/index.ts's STATUS_MAP): a card's column is what a reader would
# see it filed under, not only whether it is still open. A status this map
# has never heard of lands on Todo, matching that screen's own fallback.
COLUMN = {
    "open": "Todo",
    "pending": "Todo",
    "blocked": "Todo",
    "deferred": "Todo",
    "pinned": "Todo",
    "in_progress": "In Progress",
    "hooked": "In Progress",
    "inreview": "Agent Review",
    "in_review": "Agent Review",
    "manager_review": "Manager Review",
    "closed": "Done",
    "done": "Done",
    "resolved": "Done",
    "cancelled": "Cancelled",
}


def _status_of(data: dict) -> str:
    """A card's status, a dropped card read as `cancelled` whichever way it was dropped.

    A board drops a card by status or by putting the word on it and closing it,
    and either way the work is not happening — so it cannot be holding a
    question open either. Watching only the label leaves half the drops alive.
    """
    if data.get("status") in DROPPED or set(data.get("labels") or []) & set(DROPPED):
        return "cancelled"
    return data.get("status") or "open"


def card_state(card: str, project: Path, spec_dir: Path | None = None) -> str | None:
    """The board's own word for one card, or None when it does not know it.

    Three answers, and the difference between them is the whole point. A card
    the board knows comes back as its state. A card it has never heard of comes
    back as None, which is a real answer and gets the reader told to name a card
    that exists. Anything that stopped the board answering at all — none
    installed, none of this project's own to read — raises, because a report
    built where nothing could be checked must not read as one that was.
    """
    if spec_dir is not None:
        project = board_home(spec_dir, project)
    data = _ask(card, project)
    if data is None:
        return None
    return _status_of(data)


def is_container(card: str, project: Path, spec_dir: Path | None = None) -> bool:
    """Whether this card carries other work underneath it rather than being one piece.

    A card does not finish until everything under it does, so a question that
    names one outlives every answer it could ever be given — which is how a
    settled question keeps being printed for weeks. Work poured underneath is
    what tells the two apart, and every kind of it counts: a job's own spine
    steps are the longest-lived thing under a goal, so filtering them out by
    their label would let back in exactly the goals this exists to refuse.
    """
    if spec_dir is not None:
        project = board_home(spec_dir, project)
    try:
        out = subprocess.run(
            ["bd", "list", "--parent", card, "--all", "--json"],
            capture_output=True, text=True, cwd=project, timeout=20,
        )
    except FileNotFoundError:
        raise NoBoard
    try:
        kids = json.loads(out.stdout or "[]")
    except json.JSONDecodeError:
        kids = None
    if not isinstance(kids, list):
        # Same reading as everywhere else here: a card with nothing under it is
        # an answer the board writes down, and silence on a failed run is not.
        if out.returncode != 0:
            raise BoardSilent(out.stderr.strip() or "no reason given")
        return False
    return bool(kids)


def card_info(card: str, project: Path, spec_dir: Path | None = None) -> dict | None:
    """The board's fuller word on one card: id, title and status, not only the state.

    Same three answers as `card_state` — this is for a reader that wants to
    show which card a question is about, not only whether it is still open.
    """
    if spec_dir is not None:
        project = board_home(spec_dir, project)
    data = _ask(card, project)
    if data is None:
        return None
    status = _status_of(data)
    return {
        "id": data["id"],
        "title": data.get("title", data["id"]),
        "status": status,
        "column": COLUMN.get(status, "Todo"),
    }
