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

# `awk 'NR>=120 && NR<=240' path` and the same written as a range.
AWK = re.compile(r"\bawk\b[^|;&]*?NR\s*[<>=]{1,2}\s*\d+[^|;&]*?\s(\S+)$")

REASON = (
    "{where} is {lines} lines. Reading it in pieces costs a turn for each "
    "piece, and a turn is this whole conversation read again — about 117,000 "
    "tokens on the measured average, to see a part of a file that fits in one "
    "look.\n\n"
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


def selftest():
    failed = []
    sizes = {"/t/small.ts": 120, "/t/tiny.md": 17, "/t/huge.py": 6603}

    def measure(where):
        return sizes.get(where.strip("'\""))

    def check(name, got, want):
        if bool(got) != want:
            failed.append(f"{name}: wanted {'a refusal' if want else 'no refusal'}")

    check("a slice of a short file", judge("Bash", {"command": "sed -n '1,60p' /t/small.ts"}, measure), True)
    check("a slice written without quotes", judge("Bash", {"command": "sed -n 1,60p /t/tiny.md"}, measure), True)
    check("a slice written in double quotes",
          judge("Bash", {"command": 'sed -n "1,60p" /t/small.ts'}, measure), True)
    check("a slice of a long file in double quotes",
          judge("Bash", {"command": 'sed -n "1,60p" /t/huge.py'}, measure), False)
    check("a slice of a long file", judge("Bash", {"command": "sed -n '1,60p' /t/huge.py"}, measure), False)
    check("a slice piped onward", judge("Bash", {"command": "sed -n '1,60p' /t/small.ts | grep x"}, measure), True)
    check("a short file read whole", judge("Bash", {"command": "cat /t/small.ts"}, measure), False)
    check("a file nobody can measure", judge("Bash", {"command": "sed -n '1,60p' /t/gone.ts"}, measure), False)
    check("sed doing something else", judge("Bash", {"command": "sed -i 's/a/b/' /t/small.ts"}, measure), False)
    check("a part of a short file asked for by tool",
          judge("Read", {"file_path": "/t/small.ts", "offset": 40, "limit": 20}, measure), True)
    check("a short file read whole by tool", judge("Read", {"file_path": "/t/small.ts"}, measure), False)
    check("a part of a long file asked for by tool",
          judge("Read", {"file_path": "/t/huge.py", "offset": 40, "limit": 20}, measure), False)
    check("one short and one long in the same line",
          judge("Bash", {"command": "sed -n '1,9p' /t/huge.py; sed -n '1,9p' /t/small.ts"}, measure), True)

    if failed:
        for line in failed:
            print("FAILED  " + line)
        return 1
    print("all 13 cases pass")
    return 0


def main():
    if "--selftest" in sys.argv:
        return selftest()
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
