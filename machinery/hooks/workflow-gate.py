#!/usr/bin/env python3
"""PreToolUse — require a claimed Beads card and its worktree for mutations.

This is deliberately the small, provider-neutral workflow boundary.  It does
not decide how an agent reads, writes, asks questions, delegates, or reports.
Claude and Codex both send the same useful PreToolUse fields, so one gate can
protect both without importing either provider's interaction style.
"""
import json
import os
import re
import subprocess
import sys


EDIT_TOOLS = {"apply_patch", "Edit", "Write", "MultiEdit", "NotebookEdit"}
MUTATING_SHELL = re.compile(
    r"(?:^|[;&|]\s*)(?:"
    r"apply_patch|"
    r"(?:git\s+(?:[^;&|\n]+\s+)?(?:add|am|branch|checkout|cherry-pick|clean|commit|"
    r"merge|mv|rebase|reset|restore|revert|rm|switch|update-ref))|"
    r"(?:bd\s+(?:[^;&|\n]+\s+)?(?:close|create|defer|dep|reopen|supersede|update))|"
    r"(?:cp|install|mkdir|mv|rm|touch|truncate)\b|"
    r"(?:npm|pnpm|yarn|cargo|go)\s+(?:install|add|remove|update)\b|"
    r"(?:perl|sed)\s+[^;&|\n]*\s-i(?:\s|$)"
    r")",
    re.I | re.M,
)
WORKTREE = re.compile(r"(?:^|/)worktrees/([^/]+)(?:/|$)")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def mutates(data):
    tool = data.get("tool_name") or ""
    if tool in EDIT_TOOLS:
        return True
    if tool != "Bash":
        return False
    command = (data.get("tool_input") or {}).get("command") or ""
    return bool(MUTATING_SHELL.search(command))


def run(args, cwd):
    try:
        done = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                              timeout=10)
        return done.returncode == 0, done.stdout.strip()
    except Exception:
        return False, ""


def card_for(issue, cwd):
    ok, out = run(["bd", "show", issue, "--json"], cwd)
    if not ok:
        return None
    try:
        card = json.loads(out)
        return card[0] if isinstance(card, list) else card
    except (ValueError, TypeError, IndexError):
        return None


def reason(data):
    """Return a refusal for a mutating call, or None when it may proceed."""
    if not mutates(data):
        return None
    cwd = data.get("cwd") or os.getcwd()
    match = WORKTREE.search(os.path.realpath(cwd))
    if not match:
        return ("Repository changes require a dedicated ticket worktree. Claim a "
                "Beads issue, create worktrees/<issue-id>, and run the edit there.")
    issue = match.group(1)
    card = card_for(issue, cwd)
    if not card:
        return ("This worktree is not backed by a readable Beads issue named %s. "
                "Restore the board connection or use the claimed issue worktree."
                % issue)
    if card.get("status") != "in_progress" or not card.get("assignee"):
        return ("Beads issue %s must be claimed and in_progress before this "
                "worktree may be changed." % issue)
    return None


def main():
    data = json.load(sys.stdin)
    refused = reason(data)
    if refused:
        deny(refused)


if __name__ == "__main__":
    main()
