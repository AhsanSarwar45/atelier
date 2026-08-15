#!/usr/bin/env python3
"""PreToolUse (Bash) — stamps every board command with this session's identity.

Claims are exclusive per actor name and bd defaults the name to the git user,
which every session on this machine shares; without the stamp two sessions
would both hold the same card.
"""
import json
import re
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402

# `bd` at the start of the command or of a chained segment.
BD_CALL = re.compile(r"(^|[;&|(]\s*|\bxargs\s+)bd(\s)", re.M)


def main():
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    # One stamp per line, so a second board command below the first is not left
    # running under the machine name every session shares.
    if bc.reviewing() or not BD_CALL.search(cmd) \
            or all("--actor" in line for line in cmd.splitlines()
                   if BD_CALL.search(line)):
        return
    name = bc.actor(data.get("session_id"), data.get("cwd"))
    stamp = lambda m: "%sbd --actor %s%s" % (m.group(1), name, m.group(2))
    stamped = "\n".join(line if "--actor" in line else BD_CALL.sub(stamp, line)
                        for line in cmd.split("\n"))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecisionReason": "board identity",
        "updatedInput": dict(data.get("tool_input") or {}, command=stamped),
    }}))


if __name__ == "__main__":
    main()
