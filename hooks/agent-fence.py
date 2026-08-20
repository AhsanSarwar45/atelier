#!/usr/bin/env python3
"""PreToolUse — the Opus worker answers the lead, and the lead answers the manager.

Two refusals, and they lean on each other.

`builder` arrives with no memory of the conversation, so it is only as good as
the brief it is handed, and writing that brief is the lead's whole job. Where an
agent lives cannot say so: `.claude/agents/` is read by every session in the
repo, which puts the worker in reach of all of them.

A lead is the manager's to start. It is a Fable session that runs a whole piece
of work and spends accordingly, and deciding which piece deserves one is his
call, not a session's. Nothing enforced that until a session, refused a builder,
read the refusal's own advice to "use the Agent tool with subagent_type lead"
and started two leads he had never asked for (mch-1p2). So the builder's refusal
no longer names a route the reader may not take, and the lead has a fence of its
own.

What tells the manager's own `/lead` from a session reaching for one: the turn
it was called in. A slash command he types is written into the transcript as his
own message carrying `<command-name>/lead</command-name>`, and a session that
decides on its own has no such line behind it. Asking for the lead by its skill
name is the same act and is answered by the same rule, or it would simply be the
way round. A turn that already started a lead does not start a second: the
command asks for one.

A subagent's call carries `agent_type` naming the caller; a session's own call
carries no such field, and that is what tells the two apart.

This gate fails closed. Everywhere else in the machinery an unreadable gate lets
the work through, because a broken gate must not cost a session its work — but
what this one guards is a thing the manager said must never happen without him,
and a fence that cannot read the turn cannot prove he asked. The cost of being
wrong here is one line typed again.
"""
import json
import os
import re
import sys

WORKER = "builder"
CALLER = "lead"
LEAD = "lead"

# His own `/lead`, as the transcript records a command he typed. The slash is
# optional because the recording has spelled it both ways.
TYPED = re.compile(r"<command-name>\s*/?lead\s*</command-name>", re.IGNORECASE)

WORKER_REASON = (
    "`builder` is the lead's worker, not a helper to call directly. It arrives "
    "with no memory of this conversation and cannot see the manager, so a brief "
    "written by anyone but the lead running the job is the one way the "
    "arrangement fails. Either do the work yourself under a claimed card, or "
    "tell the manager in one line that it wants a lead — he starts one by "
    "typing `/lead` himself, and you may not start one for him."
)

LEAD_REASON = (
    "A lead is the manager's to start, and he starts it by typing `/lead` "
    "himself. Nothing in this turn says he did, so this would be a lead he "
    "never asked for — which has happened, and is what this fence exists to "
    "stop (mch-1p2). Do the work yourself under a claimed card, or say in one "
    "line that it wants a lead and leave the asking to him."
)

HELPER_REASON = (
    "A lead is the manager's to start, and only ever from his own session. A "
    "helper agent cannot see him, so a lead it starts is one nobody asked for. "
    "Report what you have and let the session you answer to put it to him."
)

SECOND_REASON = (
    "The manager asked for one lead this turn and one has already been started. "
    "A second is work he has not asked for. Wait for the first to report, and "
    "if another piece needs a lead of its own, say so and let him type `/lead` "
    "again."
)

UNREADABLE_REASON = (
    "This turn cannot be read, so there is no proving the manager typed "
    "`/lead` — and a lead he did not ask for is the one thing this fence "
    "exists to stop (mch-1p2). If he did ask, the answer is for him to ask "
    "again; if he did not, this is the refusal working."
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def entries(path):
    """The turn as it stands, oldest first, or None when it cannot be read."""
    if not path or not os.path.exists(path):
        return None
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return None
    return out


def spoken(entry):
    """The manager's own words in one entry, or '' if this is not him speaking.

    A tool's answer is recorded as a user entry too, and so is everything the
    hooks add; neither is a thing he typed. His own message carries its text
    directly — a string, or blocks of text — and nothing else does.
    """
    if (entry.get("type") or "") != "user" or entry.get("isMeta"):
        return ""
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    said = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_result":
            return ""
        if block.get("type") == "text":
            said.append(block.get("text") or "")
    return "\n".join(said)


def asked_for_lead(block):
    """Whether one recorded tool call is a lead being started, either way round."""
    if not isinstance(block, dict) or block.get("type") != "tool_use":
        return False
    got = block.get("input") or {}
    if block.get("name") == "Agent":
        return (got.get("subagent_type") or "") == LEAD
    if block.get("name") == "Skill":
        return (got.get("skill") or "") == LEAD
    return False


def leads_since(turn, at):
    """How many leads have been started since the manager last spoke."""
    count = 0
    for entry in turn[at + 1:]:
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        count += sum(1 for block in content if asked_for_lead(block))
    return count


def refusal(data):
    """Why this call is refused, or None to let it through."""
    tool = data.get("tool_name") or ""
    got = data.get("tool_input") or {}
    caller = data.get("agent_type") or ""

    if tool == "Agent" and (got.get("subagent_type") or "") == WORKER:
        return None if caller == CALLER else WORKER_REASON

    wants_lead = (tool == "Agent" and (got.get("subagent_type") or "") == LEAD) \
        or (tool == "Skill" and (got.get("skill") or "") == LEAD)
    if not wants_lead:
        return None

    if caller:
        return HELPER_REASON

    turn = entries(data.get("transcript_path") or "")
    if turn is None:
        return UNREADABLE_REASON
    for at in range(len(turn) - 1, -1, -1):
        said = spoken(turn[at])
        if not said:
            continue
        if not TYPED.search(said):
            return LEAD_REASON
        return SECOND_REASON if leads_since(turn, at) else None
    return LEAD_REASON


def main():
    said = refusal(json.load(sys.stdin))
    if said:
        deny(said)


if __name__ == "__main__":
    main()
