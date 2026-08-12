#!/usr/bin/env python3
"""The board, read as a report's checklist.

A spec that names a card owns no status text of its own: the ticks, the now
line and the next-up line are whatever the board says at build time. One level
only — the children of a goal are jobs written as observables, while their own
spine steps are internal and never reach a report.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from blocks import ReportError

# closed is a tick, claimed work is the half-tick, everything else is unticked.
STATE = {
    "closed": "done",
    "in_progress": "draft",
    "open": "todo",
    "blocked": "todo",
    "deferred": "todo",
}

# Finished first, then what is moving, then what nobody has touched: a reader
# runs down the list once and stops where the work stops.
ORDER = {"done": 0, "draft": 1, "todo": 2}


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


def status(card: str, project: Path) -> dict:
    """The whole status slot: what is happening now, what is next, and the list.

    Both lines are about the whole board, not its first row: naming one of three
    live items reads as the only one, and a board with nothing left to start
    still has everything left to finish.
    """
    kids = children(card, project)
    items = []
    for k in kids:
        state = STATE.get(k.get("status", "open"), "todo")
        if state != "done" and (state == "draft" or _under_way(k["id"], project)):
            state = "draft"
        items.append({"state": state, "text": k.get("title", k["id"])})
    items.sort(key=lambda i: ORDER[i["state"]])

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
