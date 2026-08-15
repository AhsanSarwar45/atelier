#!/usr/bin/env python3
"""PreToolUse (Bash) — one merge at a time, across every session, and each one an
instant long.

Two sessions resolving conflicts in the same tree at once produce conflicts that
cascade, so the board hands out a single merge slot and this refuses the merge to
whoever is not holding it. A merge into main must also be a fast-forward: every
code step lands as it closes, so the slot is taken many times a job and has to be
given back in the time a pointer takes to move. Rebase first, in your own tree,
where nobody is waiting.
"""
import json
import os
import re
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402

# Anchored at a command start, so prose that quotes a merge is not a merge.
MERGE = re.compile(r"(?:^|[;&|(]\s*)(?:rtk\s+)?git\s+(?:-\S+\s+)*(merge|rebase)\b", re.M)
PASSIVE = re.compile(r"--(abort|continue|quit|skip|no-commit\s+--no-ff\s+--dry-run)\b|--dry-run\b")
MERGING = re.compile(r"(?:^|[;&|(]\s*)(?:rtk\s+)?git\s+(?:-\S+\s+)*merge\b", re.M)
FF_ONLY = re.compile(r"--ff-only\b")
NOT_FF = (
    "A merge into main has to be a fast-forward: a code step lands as it closes, so "
    "the slot is taken many times over a job and must come straight back. Rebase in "
    "your own tree first — `git rebase main` — then `git merge --ff-only <branch>`."
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def main():
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not MERGE.search(cmd) or PASSIVE.search(cmd):
        return
    root = bc.board_root(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not os.path.isdir(os.path.join(root, ".beads")):
        return
    # Before the slot, and whoever holds it: a merge that rewrites main is refused
    # outright, so main stays the straight line every close is measured against.
    if MERGING.search(cmd) and not FF_ONLY.search(cmd):
        deny(NOT_FF)
        return
    name = bc.actor(data.get("session_id"), data.get("cwd"))
    ok, out = bc.bd(["merge-slot", "check", "--json", "--actor", name], root)
    if not ok:
        return
    try:
        slot = json.loads(out or "{}")
    except Exception:
        return
    if slot.get("holder") == name:
        return
    reason = (
        "Merges are serialised through the board's single slot and you are not "
        "holding it. Run `bd merge-slot acquire` (add `--wait` to queue), merge, "
        "then `bd merge-slot release`."
    )
    if slot.get("holder"):
        reason += " Held right now by %s." % slot["holder"]
    deny(reason)


if __name__ == "__main__":
    main()
