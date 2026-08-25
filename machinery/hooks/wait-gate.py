#!/usr/bin/env python3
"""PreToolUse (Bash) — a wait spent sleeping is a wait paid for by the turn.

`until curl -s http://127.0.0.1:3018/; do sleep 2; done` in the foreground buys
nothing. The session blocks anyway, and the agent pays a turn for the look, and
a turn is the whole conversation read again.

Over 537 sessions there were 339 of them: 154 polling a port, 185 polling a log
with `while ! grep -q DONE build.log; do sleep 5; done` or with `sleep 30` and a
`tail` typed again and again. Together they spent 3.9 hours of agent clock.

Claude Code has two ways to wait that cost nothing. The Bash tool takes
`run_in_background`, and with it the same loop runs detached and wakes the agent
when it exits. The Monitor tool takes a command whose every printed line becomes
a notification, which is the one to reach for when the answer wanted is every
hit rather than the first.

So the loop is not the fault. Running it in the foreground is, and that is the
only thing refused here.

Fails open on anything it cannot read. The word sleep inside a quoted program,
inside a heredoc that writes a script, or as a word being searched for is not a
wait, and a plain regex would call all three one. Quoted runs and heredoc bodies
are blanked out first, character for character, so what is left lines up with
the command the agent typed and can be quoted back to it.
"""
import json
import re
import sys

# The three loop shapes, with whatever runs between `do` and `done`.
LOOP = re.compile(r"\b(while|until|for)\b(.*?)\bdo\b(.*?)\bdone\b", re.S)

# `sleep 2` standing where a command belongs: at the start, after a separator,
# or as the first thing a loop body runs. `grep -rn asleep machinery/` never
# reaches it, because there the word is an argument and not a command.
NAP = re.compile(r"(?:^|[;&|(){}\n]|\bdo\b|\bthen\b|\belse\b)\s*"
                 r"sleep\s+(?:[\d.]+[smhd]?|\$\{?\w+\}?)", re.M)
ONLY_NAP = re.compile(r"^sleep\s+(?:[\d.]+[smhd]?|\$\{?\w+\}?)$")

# Where one command in a line ends and the next begins.
SPLIT = re.compile(r";|&&|\|\||\||\n|&")

# Where a command sends its output. A poll that writes each look to a file of
# its own is the same look, so this comes off before two are compared.
REDIRECT = re.compile(r"\s*\d?>>?\s*\S+")

# A heredoc, and the word that closes it. `<<-` is the same thing with the
# closing word allowed to be indented.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1(.*?)(^[ \t]*\2[ \t]*$)", re.S | re.M)
OPENER = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?")
QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", re.S)

OPENING = (
    "You are waiting by sleeping, and each look costs you a turn. A turn means "
    "this whole conversation is read again. Over 537 sessions, 339 commands of "
    "this shape spent 3.9 hours of your clock doing nothing.\n\n"
    "Two ways to wait that cost you nothing:\n\n"
)

# A loop ends by itself the moment its test passes, so the very same command run
# detached wakes the agent at the right minute and costs it one turn.
KEEP_IT = (
    "1. Keep this command and set run_in_background to true on the Bash tool. "
    "It runs detached, ends when the test passes, and wakes you then:\n"
    "       Bash(command=\"{command}\", run_in_background=true)\n\n"
)

# A run of sleeps around a command typed again and again has no ending in it, so
# there is nothing here the background could wake anyone about.
START_IT = (
    "1. Start the command you are waiting for with run_in_background set to "
    "true on the Bash tool, and you get woken when it exits. If it is already "
    "running, write your check as a loop that ends when it passes and run that "
    "loop in the background.\n\n"
)

# Monitor turns every line its command prints into a notification and stops when
# that command exits, so what it wants is something that keeps printing.
WATCHING = (
    "2. If you want a line each time it happens rather than one when it is "
    "over, use the Monitor tool. What you are watching is:\n"
    "       {watched}\n"
    "   Give Monitor a command that goes on printing while you wait, such as a "
    "tail piped through grep --line-buffered.\n"
)

# Enough of the command to recognise it, and not so much that the refusal is
# longer than the thing it refuses.
SHOWN = 400


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def blank(text):
    """The same text with every character but a newline turned into a space."""
    return re.sub(r"[^\n]", " ", text)


def unclosed(command):
    """Where a heredoc opens and its closing word never comes, or None.

    Everything after that point is the body of a file being written, whatever it
    looks like. Asked of the command as typed, before any blanking, because
    blanking takes the closing word away too.
    """
    for m in OPENER.finditer(command):
        if not re.search(r"(?m)^[ \t]*%s[ \t]*$" % re.escape(m.group(1)),
                         command[m.end():]):
            return m.end()
    return None


def hush(command):
    """The command with quoted runs and heredoc bodies blanked out.

    Character for character the same length as what came in, so an offset into
    the result points at the same character of the original.
    """
    cut = unclosed(command)
    out = HEREDOC.sub(lambda m: m.group(0)[:m.start(3) - m.start(0)]
                      + blank(m.group(3)) + blank(m.group(4)), command)
    if cut is not None:
        out = out[:cut] + blank(out[cut:])
    return QUOTED.sub(
        lambda m: m.group(0)[0] + blank(m.group(0)[1:-1]) + m.group(0)[-1], out)


def pieces(text, base=0):
    """Each command in a run of them, with where it starts and ends."""
    out, at = [], 0
    for m in SPLIT.finditer(text):
        out.append((text[at:m.start()], base + at, base + m.start()))
        at = m.end()
    out.append((text[at:], base + at, base + len(text)))
    said = []
    for word, a, b in out:
        if not word.strip():
            continue
        said.append((word.strip(),
                     a + len(word) - len(word.lstrip()),
                     b - (len(word) - len(word.rstrip()))))
    return said


def test_of(head, base):
    """Where the test a while or until loop repeats starts and ends."""
    a, b = base, base + len(head)
    while a < b and head[a - base] in " \t\n":
        a += 1
    while b > a and head[b - base - 1] in " \t\n;":
        b -= 1
    while a < b and head[a - base] in "! \t":
        a += 1
    return a, b


def looping(quiet):
    """Where the thing a sleeping loop is waiting for is written, or None."""
    for m in LOOP.finditer(quiet):
        if not NAP.search(m.group(3)):
            continue
        if m.group(1) == "for":
            # `for i in 1 2 3` names a counter, not the thing being waited for.
            # What the body runs besides the sleep is what the agent wants.
            for word, a, b in pieces(m.group(3), m.start(3)):
                if not ONLY_NAP.match(word) and word not in ("break", "continue"):
                    return a, b
            continue
        a, b = test_of(m.group(2), m.start(2))
        if b > a:
            return a, b
    return None


def repeated(quiet):
    """Where a command spaced out by two or more sleeps is written, or None."""
    said = pieces(quiet)
    if len([w for w, _, _ in said if ONLY_NAP.match(w)]) < 2:
        return None
    seen = {}
    for word, a, b in said:
        if ONLY_NAP.match(word):
            continue
        seen.setdefault(REDIRECT.sub("", word).strip(), []).append((a, b))
    for word, where in seen.items():
        if len(where) > 1:
            return where[0]
    return None


def shorten(text):
    text = " ".join(text.split())
    return text if len(text) <= SHOWN else text[:SHOWN] + " ..."


def judge(tool, tool_input):
    """The refusal this call earns, or None."""
    tool_input = tool_input or {}
    if tool != "Bash":
        return None
    if tool_input.get("run_in_background") in (True, "true", "True"):
        return None
    command = tool_input.get("command") or ""
    quiet = hush(command)
    loop = looping(quiet)
    where = loop or repeated(quiet)
    if not where:
        return None
    a, b = where
    first = KEEP_IT if loop else START_IT
    return (OPENING + first + WATCHING).format(
        command=shorten(command), watched=shorten(command[a:b]))


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
