#!/usr/bin/env python3
"""PreToolUse — a question reaches the manager only behind the page carrying it.

The manager's rule: an agent may not put a question to him until it has handed
him the page that carries it. A question in chat costs him a decision with none
of what it turns on; the page is where the cost of each answer already is.
"""
import json
import os
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402

# Leaving plan mode is not here: plan mode forbids writing files, so an agent in
# it cannot build the page this would demand. A plan reaches the manager as a
# page by the same rule, written before the mode is entered.
ASKS = ("AskUserQuestion",)

REASON = (
    "You can only ask the manager a question from behind the page it belongs to, "
    "and this turn has not built one. Put the question in the page's own slot, "
    "giving each answer with what it costs. Then build the page: `report list` "
    "finds the one for this job and `report <slug>` brings it up to date. Ask "
    "after that, and put the link last in the message so nobody has to scroll for "
    "it."
)


def main():
    data = json.load(sys.stdin)
    if (data.get("tool_name") or "") not in ASKS or bc.reviewing():
        return
    root = bc.board_root(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not os.path.isdir(os.path.join(root, ".beads")):
        return
    # This session's own page, not any page anywhere: another session building
    # its own report is not this agent putting its question in writing.
    state = bc.load(data.get("session_id"))
    sid = data.get("session_id")
    mine = bc.held(bc.actor(sid, data.get("cwd")), root, sid) or []
    cards = set().union(*(bc.page_names(c, {}) for c in mine)) if mine else None
    if bc.page_built(cards, bc.project_name(root)) > (state.get("last_stop") or 0):
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": REASON,
    }}))


if __name__ == "__main__":
    main()
