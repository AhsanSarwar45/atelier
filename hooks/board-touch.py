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
# A write to one card, whose answer is worth handing back rather than asked for
# again in a turn of its own.
WROTE = re.compile(r"\bbd\b[^|;&]*\b(?:update|close|reopen)\b")
# The name the board knows this command by. Stamped on by hooks/board-actor.py in
# front of every board command, and read back off the line rather than worked out
# again here: a command that moves into another checkout first is stamped for that
# checkout, and a job handed to the session's own name would be handed to a name
# the board never sees it work under.
ACTOR = re.compile(r"--actor[= ]\s*['\"]?([^\s'\"]+)")

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


def closing_actor(cmd, data):
    """Who closed this card, in the name the board holds claims under."""
    got = ACTOR.search(cmd or "")
    return got.group(1) if got else bc.actor(data.get("session_id"), bc.where(data))


def main():
    data = json.load(sys.stdin)
    root = bc.board_root(bc.where(data))
    if bc.reviewing():
        return
    sid = data.get("session_id")
    state = bc.load(sid)
    tool = data.get("tool_name") or ""
    tin = data.get("tool_input") or {}
    # Without the move that got it there: a worktree named after the card it
    # holds spells that card in every line run inside it, and the ids read here
    # become claims and closes.
    cmd = bc.said(data) if tool == "Bash" else ""
    answer = None

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
                # Asked once and kept: the answer below is the same card, and a
                # hook that asks the board twice for one thing pays twice.
                answer = run.card(cid, root) or {}
                # The same exemption the close gate applies: nothing was finished
                # on these, so neither gate asks for a page or a link.
                if not set(answer.get("labels") or []) & set(bc.UNREPORTED):
                    state["closed"] = (state.get("closed") or [])[-200:] + [
                        {"id": cid, "t": bc.now()}
                    ]
                # Whatever opens next is this session's: a job is claimed
                # once, not once a step (board/run.py, hand_over).
                run.advance(cid, root, closing_actor(cmd, data))

    # A write answers with the card it made, so nothing has to ask again. Two
    # sessions measured asked the board what they had just written to it 72 and
    # 33 times in a day, purely because writing said nothing back (mch-aa9).
    # Only ever for a write naming exactly one card: a line naming several is a
    # line whose answer nobody could read anyway.
    if tool == "Bash" and WROTE.search(cmd):
        named = set(card_ids(cmd, bc.prefix(root)))
        if len(named) != 1:
            answer = None
        elif not answer or answer.get("id") not in named:
            answer = run.card(named.pop(), root) or None
    else:
        answer = None

    if bc.now() - (state.get("last_beat") or 0) > BEAT_EVERY:
        state["last_beat"] = bc.now()
        name = bc.actor(sid, data.get("cwd"))
        mine = bc.held(name, root)
        if mine:
            bc.bd(["heartbeat", "--actor", name] + mine, root)

    bc.save(sid, state)
    if answer:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": "%s is now %s: %s" % (
                answer.get("id"), answer.get("status"), answer.get("title") or ""),
        }}))


if __name__ == "__main__":
    main()
