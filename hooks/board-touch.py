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
BEAT_EVERY = 90  # seconds of activity between lease refreshes; lease TTL is 300
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")

# The two reasons a session may stop with work still open, recorded from the tool
# being used rather than from what the reply says: the reply's own wording is what
# a session writes when it stops early, so it cannot tell the two apart.
# docs/board.md#4f-when-a-session-may-stop
ASK_TOOLS = ("AskUserQuestion", "ExitPlanMode")

# Helpers that report back by name when they finish, so each one can be counted
# home again. Kept as the names still out and not as one mark: a session that
# sent three off is still waiting when the first of them comes back, and a mark
# cannot tell that from all three being home.
SENT_TOOLS = ("Agent", "Task")

# Sent off with nothing to answer to: a watcher, a message into a run already
# going, a queued piece of work. Nothing names these home again, so they hold
# the turn they were sent in and no longer.
LOOSE_TOOLS = ("Monitor", "TaskCreate", "SendMessage", "Workflow")

# The name a helper is reachable by, printed in what the tool hands back. No word
# boundary in front of it: the answer is read as it came, and in JSON the line
# before it ends in an escape rather than in a break.
HELPER_NAME = re.compile(r"agent[ _]?id\W{0,4}([0-9a-f]{6,})", re.IGNORECASE)

# Helpers out at once, and returns seen before the tool that sent them came
# back. Both are small in every real session; the cap is against a runaway.
HELPERS = 50


def card_ids(text, prefix):
    return re.findall(r"\b%s-[0-9a-z.-]{2,16}\b" % re.escape(prefix), text or "")


def aimed_at(cmd, verb, prefix):
    """The cards a board command is aimed at: the words after its verb that are a
    card id and nothing else, and never a switch or what one carries.

    A close names the card it closes; the reason it carries names whatever the
    session was thinking about — a card the work follows on from, one a brief
    quotes — and a card merely spoken of in a reason was ticked off by nobody.
    Read once by the gates as if it had been, it costs a whole turn.

    An id standing on its own is what tells the two apart, rather than where it
    stands in the line: a reason is a sentence and a sentence is not an id, so a
    switch may come before the card as easily as after it and the card is still
    found. The one line this cannot read is a reason that is nothing but a card
    id, which is a reason that says nothing.
    """
    found = []
    for seg in bc.segments(cmd):
        argv = bc.words(seg)
        if verb not in argv or "bd" not in [os.path.basename(a) for a in argv]:
            continue
        for word in argv[argv.index(verb) + 1:]:
            if word.startswith("-"):
                continue
            found += [c for c in card_ids(word, prefix) if c == word]
    return found


def sent_off(state, answer):
    """One more helper out, by the name it answers to.

    The name is read out of the whole of what the tool handed back, whatever
    shape that came in: which field of it carries the name is the harness's to
    change. A helper with no name in it cannot be struck off when it returns, so
    it is stamped instead and holds only the turn it was sent in — a record that
    can never be cleared would stand the gate down for good.
    """
    if not isinstance(answer, str):
        try:
            answer = json.dumps(answer)
        except Exception:
            answer = str(answer)
    name = HELPER_NAME.search(answer or "")
    if not name:
        state["helper"] = bc.now()
        return
    home = name.group(1)
    back = state.get("helper_back") or []
    if home in back:  # it reported back before the tool call returned
        state["helper_back"] = [h for h in back if h != home]
        return
    state["helper_out"] = ((state.get("helper_out") or []) + [home])[-HELPERS:]


def response_text(resp):
    if isinstance(resp, str):
        return resp
    if isinstance(resp, dict):
        return " ".join(str(resp.get(k) or "") for k in ("stdout", "stderr", "output"))
    return ""


def stamped_name(cmd):
    """The name a board command was stamped with, or None.

    Stamped on by hooks/board-actor.py in front of every board command, and read
    back off the line rather than worked out again here: a command that moves into
    another checkout first is stamped for that checkout, and a job handed to the
    session's own name would be handed to a name the board never sees it work
    under.

    Read off the words of a bd command the way aimed_at reads a card id, never off
    the line it is written on. Everything a close carries is free text, and a
    reason that speaks of the stamp — `--reason="wired up the --actor flag"`, which
    the cards building this very thing all say — hands the next step of the job to
    whatever word follows those letters in a sentence, under a name nobody works
    under. Quotes are what tells a value from a sentence, and quotes are what a
    search over the raw line cannot see.
    """
    for seg in bc.segments(cmd or ""):
        argv = bc.words(seg)
        if "bd" not in [os.path.basename(a) for a in argv]:
            continue
        for i, word in enumerate(argv):
            if word.startswith("--actor="):
                return word.split("=", 1)[1]
            if word == "--actor" and i + 1 < len(argv):
                return argv[i + 1]
    return None


def closing_actor(cmd, data):
    """Who closed this card, in the name the board holds claims under."""
    return stamped_name(cmd) or bc.actor(data.get("session_id"), bc.where(data))


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
    held_back = ""

    # A helper that has come back is struck off by name; until then the session
    # is waiting on it, however many turns that takes. A return that arrives
    # before the tool call that sent it is put aside rather than dropped — which
    # of the two lands first is the harness's business, not this record's.
    #
    # A return that says no name says one helper is home and never which, so it is
    # counted rather than guessed at: while fewer have come home that way than went
    # out, they all stay out; once as many have come home as went out, none of them
    # is still running. Guessing the oldest came home is how a helper still working
    # gets counted home and the turn read as idle; never clearing at all is how a
    # session stops being asked about its own unfinished work for good.
    if data.get("hook_event_name") == "SubagentStop":
        state["helper_done"] = bc.now()
        home = data.get("agent_id") or ""
        out = state.get("helper_out") or []
        if home and home in out:
            state["helper_out"] = [h for h in out if h != home]
        elif home:
            state["helper_back"] = ((state.get("helper_back") or []) + [home])[-HELPERS:]
        else:
            homes = (state.get("helper_home") or 0) + 1
            if homes >= len(out):
                state["helper_out"], state["helper_home"] = [], 0
            else:
                state["helper_home"] = homes
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
    elif tool in SENT_TOOLS:
        sent_off(state, data.get("tool_response"))
    elif tool in LOOSE_TOOLS:
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
            for cid in aimed_at(cmd, "update", bc.prefix(root)):
                # When, not just that: the stop gate judges each edit against the
                # cards standing over it at that moment (bc.unowned).
                state["claims"] = (state.get("claims") or [])[-200:] + [
                    {"id": cid, "t": bc.now()}
                ]
                run.started(cid, root)
        if CLOSED.search(cmd):
            # Either spelling of it, and the ids are the words of the line that
            # are a card and nothing else.
            named = bc.prefix(root)
            for cid in (aimed_at(cmd, "close", named)
                        or aimed_at(cmd, "update", named)):
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
                # once, not once a step (board/run.py, hand_over). Where this
                # session is standing goes with the name, because a step that
                # makes code is handed to nobody who has nowhere to make it — and
                # this hook is the only thing that knows the directory the close
                # was typed from.
                held_back = run.advance(cid, root, closing_actor(cmd, data),
                                        bc.where(data)) or held_back

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
    told = "%s is now %s: %s" % (answer.get("id"), answer.get("status"),
                                 answer.get("title") or "") if answer else ""
    # A step the run would not hand over is said here or nowhere. Nothing typed a
    # command for that hand-over, so there is no refusal for a gate to carry back
    # and the card would otherwise just sit there, open and owned by nobody.
    if held_back:
        told = (told + "\n\n" + held_back).strip()
    if told:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": told,
        }}))


if __name__ == "__main__":
    main()
