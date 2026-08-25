#!/usr/bin/env python3
"""PreToolUse — a picture is looked at by the helper built to look at pictures.

Reading a screenshot puts it into the conversation, and a conversation is read
again in full on every turn that follows. So a picture is not paid for once. It
is paid for on every turn it survives, until the memory holding it is squashed.

Measured over ten sessions: 53 pictures went in, worth about 1.4 million tokens
written down — and 77.5 million tokens re-read afterwards, which is about forty
dollars, the largest single thing those sessions spent money on. One screenshot
of 59,119 tokens was carried through 88 turns. In the same ten sessions the
helper built for this was used twice.

`screen-check` drives the browser, looks at the pictures itself and returns a
written verdict. The pictures die with it, so they never reach the conversation
that asked. That is the whole of the fix: the looking still happens, in a place
that is not carrying the rest of the work.

Fails open. A gate that cannot read its own input must not cost a session its
work, and the worst case here is one expensive turn rather than a wrong one.
"""
import json
import sys

PICTURES = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif")

# The helper whose whole job is looking at a screen. It reads pictures, reports
# words, and dies holding the pictures.
LOOKER = "screen-check"

REASON = (
    "A picture read here goes into this conversation, and the whole conversation "
    "is read again on every turn that follows. You pay for that picture on every "
    "one of those turns, not once. Ten sessions spent about forty dollars "
    "taking 53 of them, more than on anything else they did.\n\n"
    "Send `screen-check` instead. It looks at the picture itself and returns "
    "what it sees in words, and the picture dies with it:\n"
    "    Agent(subagent_type=\"screen-check\", prompt=\"Look at {where} and say "
    "whether <what you need to know>\")\n\n"
    "If you only need a fact about the file rather than what it shows, such as "
    "whether it exists, how big it is or when it changed, ask for that instead."
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def judge(tool, tool_input, agent_type):
    """The refusal this call earns, or None."""
    if tool != "Read":
        return None
    # The looker is meant to read them. So is anything it starts.
    if (agent_type or "") == LOOKER:
        return None
    where = (tool_input or {}).get("file_path") or ""
    if not where.lower().endswith(PICTURES):
        return None
    return REASON.replace("{where}", where)


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    reason = judge(data.get("tool_name"), data.get("tool_input"), data.get("agent_type"))
    if reason:
        deny(reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
