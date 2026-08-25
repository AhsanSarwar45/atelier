#!/usr/bin/env python3
"""PreToolUse — a file short enough to read whole is read whole, once.

Opening a file in pieces costs a turn per piece, and a turn is the whole
conversation read again. On the measured average that is about 117,000 tokens
for the second look at a file that would have fitted in one.

Ten sessions did this 176 times on files of 800 lines or fewer. A 17-line file
was opened six times. A 142-line one, eleven times. A 414-line one, fifteen
times. None of those files was ever too long to hold; each was opened in slices
out of habit, and the habit was paid for at the price of a whole conversation
each time.

A long file is a different thing and is left alone. Nothing here objects to
reading part of six thousand lines — only to reading a short file in halves.

Fails open. A file that cannot be counted is allowed through: a gate that
cannot read the disk must not cost a session its work.
"""
import json
import os
import re
import sys

# Short enough that reading it whole is cheaper than deciding which part to read.
SHORT = 800

# `sed -n '120,240p' path`, anywhere in a line of shell. The range may be
# written in single quotes, in double quotes, or bare — all three are ordinary
# shell habits, and a gate that knew only two of them left the third as a way
# round it (bw-nqll.7).
SED = re.compile(r"\bsed\b[^|;&]*?-n\s+['\"]?(\d+),(\d+)p['\"]?\s+(\S+)")

# `awk 'NR>=120 && NR<=240' path` and the same written as a range. The two
# conditions are joined by `&&`, so the run between them must be allowed to
# contain `&` — barring it meant this never matched the one form it was
# written to catch, and the case that would have said so was never written
# (bw-nqll.12).
AWK = re.compile(r"\bawk\b[^|;]*?NR\s*[<>=]{1,2}\s*\d+[^|;]*?\s(\S+)$")

REASON = (
    "{where} is {lines} lines. Reading it in pieces costs you a turn for each "
    "piece, and a turn means this whole conversation is read again. On the "
    "measured average that is about 117,000 tokens to see part of a file that "
    "fits in one look.\n\n"
    "Read it whole, once:\n"
    "    cat {where}\n\n"
    "Slicing is for files too long to hold. Over {short} lines this gate says "
    "nothing."
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def length(where):
    """How many lines a file has, or None when that cannot be known."""
    try:
        path = os.path.expanduser(where.strip("'\""))
        if not os.path.isfile(path):
            return None
        with open(path, "rb") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return None


def sliced(command):
    """Every file this command reads a part of."""
    out = []
    for m in SED.finditer(command or ""):
        out.append(m.group(3))
    for m in AWK.finditer(command or ""):
        out.append(m.group(1))
    return out


def judge(tool, tool_input, measure=length):
    """The refusal this call earns, or None."""
    tool_input = tool_input or {}
    wanted = []

    if tool == "Bash":
        wanted = sliced(tool_input.get("command") or "")
    elif tool == "Read":
        if tool_input.get("offset") or tool_input.get("limit"):
            wanted = [tool_input.get("file_path") or ""]

    for where in wanted:
        if not where:
            continue
        lines = measure(where)
        if lines is None or lines > SHORT:
            continue
        return REASON.format(where=where, lines=lines, short=SHORT)
    return None


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    reason = judge(data.get("tool_name"), data.get("tool_input"))
    if reason:
        deny(reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
