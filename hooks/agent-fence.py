#!/usr/bin/env python3
"""PreToolUse — the Opus worker answers the lead, and nobody else.

`builder` arrives with no memory of the conversation, so it is only as good as
the brief it is handed, and writing that brief is the lead's whole job. Where an
agent lives cannot say so: `.claude/agents/` is read by every session in the
repo, which puts the worker in reach of all of them.

A subagent's call carries `agent_type` naming the caller; a session's own call
carries no such field, and that is what tells the two apart.
"""
import json
import sys

WORKER = "builder"
CALLER = "lead"

REASON = (
    "`builder` is the lead's worker, not a helper to call directly. It arrives "
    "with no memory of this conversation and cannot see the manager, so a brief "
    "written by anyone but the lead running the job is the one way the "
    "arrangement fails. Start the work with the lead instead — `/lead <what you "
    "want done>`, or the Agent tool with subagent_type \"lead\" — and let it "
    "write the brief and judge what comes back."
)


def main():
    data = json.load(sys.stdin)
    if (data.get("tool_name") or "") != "Agent":
        return
    if ((data.get("tool_input") or {}).get("subagent_type") or "") != WORKER:
        return
    if (data.get("agent_type") or "") == CALLER:
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": REASON,
    }}))


if __name__ == "__main__":
    main()
