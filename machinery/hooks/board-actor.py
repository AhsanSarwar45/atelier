#!/usr/bin/env python3
"""PreToolUse (Bash) — stamps every board command with this session's identity.

Claims are exclusive per actor name and bd defaults the name to the git user,
which every session on this machine shares; without the stamp two sessions
would both hold the same card.

The name is the session and nothing else. Which copy the work is being done in
is recorded on the card instead, as the `copy:` label this hook adds to a claim:
a name that opened with the folder meant a card claimed in the shared tree could
not be closed from the job's copy, and bd turned down 89 of those over 537
sessions.
"""
import json
import re
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402

# `bd` at the start of the command or of a chained segment.
BD_CALL = re.compile(r"(^|[;&|(]\s*|\bxargs\s+)bd(\s)", re.M)
# A claim, which is where a card learns which copy it is being worked in.
CLAIM = re.compile(r"\bbd\b[^|;&\n]*\bupdate\b[^|;&\n]*--claim(?![\w-])", re.M)
# A line that moves a card the board may already hold under an older name.
MOVES = re.compile(r"\bbd\b[^|;&\n]*\b(?:close|reopen|heartbeat|update)\b", re.M)
# Where a board line stops naming cards and starts explaining itself.
PROSE = re.compile(r"\s--?(?:reason|notes|append-notes|description|title|d|m)\b")


def under(cmd, session_id, cwd):
    """The name to stamp this line with.

    This session's own (`board_common.actor`), except for a card the board still
    holds under the name this session claimed with before the name lost its
    folder: bd refuses a close or a heartbeat whose actor is not the assignee, so
    those have to be made under the name they were claimed with. Compat, and the
    only reason this asks the board anything — it can go once no old-style claim
    is open.
    """
    fresh = bc.actor(session_id, cwd)
    if not MOVES.search(cmd):
        return fresh
    root = bc.board_root(cwd)
    named = re.compile(r"\b(?:%s)-[0-9a-z.-]{2,16}\b"
                       % "|".join(re.escape(p) for p in bc.prefixes(root)))
    # Only the ids the line moves, not the ones its reason mentions: a close whose
    # reason named an older card still held under a compat name was stamped with
    # that stale name, and the board refused it (bw-aczr.15).
    ids = set(named.findall(PROSE.split(cmd, 1)[0]))
    if not ids:
        return fresh
    for who, cards in sorted((bc.holders(session_id, root) or {}).items()):
        if who != fresh and ids & set(cards):
            return who
    return fresh


def with_copy(line, label):
    """The same claim, saying which copy the work is being done in.

    Written in beside `--claim` rather than at the end of the line: `--claim`
    takes no value, and a line routinely carries a second command after this one
    that the flag would otherwise land in.
    """
    if not CLAIM.search(line) or bc.COPY in line:
        return line
    return re.sub(r"--claim(?![\w-])", "--claim --add-label " + label, line, count=1)


def main():
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if bc.reviewing() or not BD_CALL.search(cmd):
        return
    lines = cmd.split("\n")
    # The directory the command runs in, not the one the session was started in:
    # that is the copy the claim records, and a session reaches a copy by moving
    # into it as often as by being started there.
    here = bc.where(data)
    label = bc.copy_label(here)
    out = []
    for line in lines:
        if BD_CALL.search(line):
            if "--actor" not in line:
                # Named line by line: one line closing a card held under a compat
                # name must not rename the line under it (bw-aczr.15).
                name = under(line, data.get("session_id"), here)
                stamp = lambda m, n=name: "%sbd --actor %s%s" % (m.group(1), n, m.group(2))
                line = BD_CALL.sub(stamp, line)
            line = with_copy(line, label)
        out.append(line)
    stamped = "\n".join(out)
    if stamped == cmd:
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        # A PreToolUse response that changes the input is a decision, not merely
        # context. Both Claude and Codex reject `updatedInput` without the
        # matching explicit allow and report the hook itself as failed.
        "permissionDecision": "allow",
        "permissionDecisionReason": "board identity",
        "updatedInput": dict(data.get("tool_input") or {}, command=stamped),
    }}))


if __name__ == "__main__":
    main()
