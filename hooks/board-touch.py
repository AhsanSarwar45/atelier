#!/usr/bin/env python3
"""PostToolUse — records what this session touched and keeps its claims alive.

A claim carries a five-minute lease; a session that dies stops refreshing it
and `bd reclaim` hands the card back. Tool activity is the liveness signal, so
nothing has to be remembered by the agent.

Closing a card is also what moves a job's run on, but the rule for that is not
here: board/run.py owns it, because the board's own reader has to drive
the same rule from outside any session.
"""
import json
import os
import re
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "board"))
import board_common as bc  # noqa: E402
import run  # noqa: E402

CLOSED = re.compile(r"\bbd\b[^|;&]*(?:\bclose\b|(?:-s|--status)[= ]closed\b)")
CLAIMED = re.compile(r"\bbd\b[^|;&]*\bupdate\b[^|;&]*--claim\b")

BEAT_EVERY = 90  # seconds of activity between lease refreshes; lease TTL is 300
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")

# The two reasons a session may stop with work still open, recorded from the tool
# being used rather than from what the reply says: the reply's own wording is what
# a session writes when it stops early, so it cannot tell the two apart.
# docs/board.md#4f-when-a-session-may-stop
ASK_TOOLS = ("AskUserQuestion", "ExitPlanMode")
HELPER_TOOLS = ("Agent", "Task", "Monitor", "TaskCreate",
                "SendMessage", "Workflow")


def card_ids(text, prefix):
    return re.findall(r"\b%s-[0-9a-z.-]{2,16}\b" % re.escape(prefix), text or "")


def response_text(resp):
    if isinstance(resp, str):
        return resp
    if isinstance(resp, dict):
        return " ".join(str(resp.get(k) or "") for k in ("stdout", "stderr", "output"))
    return ""


def main():
    data = json.load(sys.stdin)
    root = bc.board_root(data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if bc.reviewing():
        return
    sid = data.get("session_id")
    state = bc.load(sid)
    tool = data.get("tool_name") or ""
    tin = data.get("tool_input") or {}

    # A helper that has come back stamps this; until then the session is waiting
    # on it, however many turns that takes.
    if data.get("hook_event_name") == "SubagentStop":
        state["helper_done"] = bc.now()
        bc.save(sid, state)
        return

    # Anything sent off to run on its own is a helper: a background command, a
    # watcher on one, an agent. A session waiting on one is not idling.
    if tool == "Bash" and (tin.get("run_in_background")
                           or re.search(r"(^|\s)(setsid|nohup)\b|&\s*$",
                                        tin.get("command") or "")):
        state["helper"] = bc.now()


    if tool in ASK_TOOLS:
        state["asked"] = bc.now()
    elif tool in HELPER_TOOLS:
        state["helper"] = bc.now()
    elif tool in EDIT_TOOLS:
        path = tin.get("file_path") or tin.get("notebook_path")
        if bc.project_edit(path, root):
            state["edits"] = (state.get("edits") or [])[-400:] + [
                {"p": path, "t": bc.now()}
            ]
    elif tool == "Bash":
        cmd = tin.get("command") or ""
        if re.search(r"\bbd\b.*\bcreate\b|board/job\b", cmd):
            found = card_ids(response_text(data.get("tool_response")), bc.prefix(root))
            state["created"] = (state.get("created") or [])[-200:] + [
                {"id": i, "t": bc.now()} for i in found
            ]
        if re.search(r"\bbd\b.*\b(update|close|comment|note|dep)\b", cmd):
            state["last_write"] = bc.now()
        if CLAIMED.search(cmd):
            for cid in card_ids(cmd, bc.prefix(root)):
                # When, not just that: the stop gate judges each edit against the
                # cards standing over it at that moment (bc.unowned).
                state["claims"] = (state.get("claims") or [])[-200:] + [
                    {"id": cid, "t": bc.now()}
                ]
                run.started(cid, root)
        if CLOSED.search(cmd):
            for cid in card_ids(cmd, bc.prefix(root)):
                # The same exemption the close gate applies: nothing was finished
                # on these, so neither gate asks for a page or a link.
                if not set((run.card(cid, root) or {}).get("labels") or []) & set(bc.UNREPORTED):
                    state["closed"] = (state.get("closed") or [])[-200:] + [
                        {"id": cid, "t": bc.now()}
                    ]
                run.advance(cid, root)

    if bc.now() - (state.get("last_beat") or 0) > BEAT_EVERY:
        state["last_beat"] = bc.now()
        name = bc.actor(sid, data.get("cwd"))
        mine = bc.held(name, root)
        if mine:
            bc.bd(["heartbeat", "--actor", name] + mine, root)

    bc.save(sid, state)


if __name__ == "__main__":
    main()
