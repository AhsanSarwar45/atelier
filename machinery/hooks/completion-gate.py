#!/usr/bin/env python3
"""Stop hook — narrow completion gate. Blocks the turn from ending only on
explicit deferral language: work pushed to a future agent/session/date.

Deliberately narrow after a broad promise-detector false-positived on
descriptive "I'll" phrases. Style and length are the output style's job;
this gate exists solely for CLAUDE.md's "never flag work for a future
agent" rule.
"""
import json
import re
import sys

DEFERRAL = re.compile(
    r"\b(future (agent|session)|follow-up session|left for later|"
    r"TODO for later|deferred to (a|the) (later|next)|in a later session|"
    r"a future pass will|next session (will|should))\b",
    re.IGNORECASE,
)


def main() -> None:
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):
        return
    msg = data.get("last_assistant_message") or ""
    m = DEFERRAL.search(msg)
    if m:
        print(json.dumps({
            "decision": "block",
            "reason": (
                f'Reply defers work ("{m.group(0)}"). Never flag work for a '
                "future agent or session: do it now, or state the concrete "
                "blocker and what input is needed."
            ),
        }))


if __name__ == "__main__":
    main()
