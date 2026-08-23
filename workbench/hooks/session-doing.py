#!/usr/bin/env python3
"""Say, from inside a session, which of the things it is doing right now.

The marker Claude Code writes for a running process carries one bit — busy or
idle — so a chat summarising itself, a chat stopped on a permission prompt and a
chat halfway through a command all look identical from outside. This writes a
line beside that marker naming the state, at the moment the session enters it,
and removes the line at the moment it leaves (bw-jaoz.14.6).

    <CLAUDE_CONFIG_DIR>/sessions/<session_id>.doing.json
    {"doing": "summarising", "since": 1787138400000, "detail": "auto"}

The reader is `src/workbench/doing-told.ts`, which distrusts every byte of it:
a half-written, abandoned or nonsensical file reads as "nothing said" and the
screen falls back to what it can work out for itself. That contract is what lets
this script be as small as it is.

Registered on five events, and told them apart by `hook_event_name`:

    PreCompact         summarising begins, with its trigger as the detail
    PostCompact        summarising ends
    Stop               the turn ends, whatever it was doing
    SessionEnd         the session goes away
    Notification       a permission prompt begins the one wait that is a state
    PostToolUse        the tool ran, so the permission prompt is answered
    UserPromptSubmit   he typed instead of answering it

Two rules hold everywhere in here:

**Never fail.** A hook that exits non-zero or writes to stdout interrupts the
session it is describing, and no status line is worth that. Every path ends in
exit 0 with nothing said.

**Never widen.** Only a state the app has a word for is written, and only when
this event is the moment it starts. Everything else is left to the reader.
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

#: The states this script is allowed to claim. The app's vocabulary is wider —
#: thinking, retrying, a helper working — but those are read off the record, and
#: a hook writing a word the reader would have worked out anyway only adds a way
#: for the two to disagree.
SUMMARISING = "summarising"
WAITING = "waiting"

#: The one notification that is a state rather than a nudge. `idle_prompt` says
#: the session has been quiet, which the marker's own bit already says.
PERMISSION = "permission_prompt"

#: What the tool's own permission notification says, verbatim. There is no
#: tool_name on this payload to read instead: the Notification schema shipped in
#: 2.1.240 is session_id, transcript_path, cwd, hook_event_name, message, an
#: optional title and notification_type, and the tool is named only inside the
#: sentence — `Claude needs your permission to use ${tool}`. The chip has room
#: for the one word, so the one word is what comes out of it (bw-jaoz.14.13).
ASKING = "needs your permission to use "


def sessions_dir() -> Path:
    """Where the tool keeps its markers, resolved the way the tool resolves it."""
    root = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    return Path(root) / "sessions"


def line_for(session_id: str) -> Path:
    return sessions_dir() / f"{session_id}.doing.json"


def say(session_id: str, doing: str, detail=None) -> None:
    """Write the line, whole or not at all.

    Written to a neighbouring temporary file and renamed over the target, so a
    reader on the other side of the beat sees either the previous line or this
    one and never half of either.
    """
    target = line_for(session_id)
    body = json.dumps(
        {"doing": doing, "since": int(time.time() * 1000), "detail": detail},
        separators=(",", ":"),
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".doing-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as out:
            out.write(body)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def hush(session_id: str, only=None) -> None:
    """Remove the line — every state ends by there being nothing to say.

    `only` narrows it to one claim: the tool finishing running answers a
    permission prompt and says nothing at all about a compaction, and a clear
    that fires while one is in flight would otherwise blank the bar mid-fill.
    """
    target = line_for(session_id)
    if only is not None:
        try:
            standing = json.loads(target.read_text())
        except Exception:
            return
        if not isinstance(standing, dict) or standing.get("doing") != only:
            return
    try:
        target.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        pass


def a_word(data: dict, *keys):
    """The first of these keys holding a non-empty string, or nothing."""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:80]
    return None


def asked_about(data: dict):
    """The tool a permission prompt is asking about, in one word where it can be.

    `tool_name` first, so a version that starts sending one is read straight
    rather than parsed; the sentence next, which is where the tool is named
    today; and the sentence whole if it is worded some way this does not know —
    a long detail is worse than a short one and better than none.
    """
    said = a_word(data, "tool_name", "message", "title")
    if not said:
        return None
    at = said.find(ASKING)
    if at < 0:
        return said
    return said[at + len(ASKING):].strip().strip(".") or said


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if not isinstance(data, dict):
        return
    session_id = data.get("session_id")
    # The file is named after the conversation, because that is what the screen
    # is drawing. Without one there is nothing to name.
    if not isinstance(session_id, str) or not session_id or "/" in session_id or "\\" in session_id:
        return

    event = data.get("hook_event_name")

    if event == "PreCompact":
        # Its own word for why: `manual` is him typing /compact and watching,
        # `auto` is the window filling up, and the screen says which.
        say(session_id, SUMMARISING, a_word(data, "trigger", "matcher"))
    elif event in ("PostCompact", "SessionEnd"):
        hush(session_id)
    elif event == "Stop":
        # Stop fires when the turn ends, and also on clear, resume and compact.
        # A compaction in flight has its own end signal, so the summarising
        # claim is left alone here and only the wait is cleared.
        hush(session_id, only=WAITING)
    elif event == "Notification":
        # Six seconds after the prompt goes up, not the instant it does: the
        # tool holds this notification back that long and drops it entirely if
        # he answers first, so a wait the screen names is a wait he is actually
        # sitting in front of.
        if a_word(data, "notification_type") == PERMISSION:
            say(session_id, WAITING, asked_about(data))
    elif event in ("PostToolUse", "UserPromptSubmit"):
        hush(session_id, only=WAITING)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Nothing this script can discover is worth interrupting the session it
        # is describing.
        pass
    sys.exit(0)
