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
    r"(?:git\s+(?:[^;&|\n]+\s+)?(?:add|am|checkout|cherry-pick|clean|commit|"
    r"merge|mv|rebase|reset|restore|revert|rm|switch|update-ref))|"
    r"(?:bd\s+(?:[^;&|\n]+\s+)?(?:close|create|defer|dep|reopen|supersede|update))|"
    r"(?:cp|install|mkdir|mv|rm|touch|truncate)\b|"
    r"(?:npm|pnpm|yarn|cargo|go)\s+(?:install|add|remove|update)\b|"
    r"(?:perl|sed)\s+[^;&|\n]*\s-i(?:\s|$)"
    r")",
    re.I | re.M,
)
WORKTREE = re.compile(r"(?:^|/)worktrees/([^/\s]+)(?:/|\s|$)")
RECOVERY_FILES = {
    ".codex/hooks.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    "AGENTS.md",
    "CLAUDE.md",
    "machinery/hooks/workflow-gate.py",
    "machinery/workflow-policy.md",
}


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
    supplied = data.get("tool_input") or {}
    command = supplied.get("command", "") if isinstance(supplied, dict) else str(supplied)
    # These bootstrap operations must work before a ticket worktree exists.
    if re.match(r"^\s*bd\s+create\b", command, re.I):
        return False
    # The worktree gate requires an explicit `cd` because some hosts do not
    # propagate tool cwd into hook input. Accept that exact bootstrap prefix;
    # otherwise the two gates deadlock (one demands cd, the other demands bd
    # be the first word) before any child can be claimed.
    if re.match(r"^\s*(?:cd\s+\S+\s*&&\s*)?bd\s+update\s+\S+\s+--claim(?:\s|$)", command, re.I):
        return False
    # Landing necessarily runs from the main checkout. Other hooks verify the
    # merge slot and lifecycle; this gate only requires the safe fast-forward
    # form and a ticket-shaped source branch.
    if re.match(r"^\s*git\s+merge\s+--ff-only\s+[A-Za-z0-9_.-]+\s*$",
                command, re.I):
        return False
    branch = re.search(r"(?:^|[;&|]\s*)git\s+(?:-C\s+\S+\s+)?branch\b([^;&|\n]*)",
                       command, re.I)
    if branch and re.search(r"(?:^|\s)(?:-[dDmMcC]|--delete|--move|--copy)(?:\s|$)|\s+[A-Za-z0-9_.][A-Za-z0-9_.-]*\s*$",
                            branch.group(1)):
        return True
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


def checked_out_for(issue, cwd):
    """Recovery proof available without the board: registered tree + branch."""
    ok, branch = run(["git", "branch", "--show-current"], cwd)
    if not ok or branch != issue:
        return False
    ok, trees = run(["git", "worktree", "list", "--porcelain"], cwd)
    return ok and os.path.realpath(cwd) in {
        os.path.realpath(line.removeprefix("worktree "))
        for line in trees.splitlines() if line.startswith("worktree ")
    }


def children_for(issue, cwd):
    # Decomposition is durable history. Closed/landed children still prove the
    # epic was decomposed; excluding them deadlocks the final deployment step
    # as soon as earlier implementation children are correctly closed.
    ok, out = run(["bd", "list", "--parent", issue, "--all", "--limit", "0", "--json"], cwd)
    if not ok:
        return None
    try:
        children = json.loads(out)
        return children if isinstance(children, list) else None
    except (ValueError, TypeError):
        return None


def reason(data):
    """Return a refusal for a mutating call, or None when it may proceed."""
    if not mutates(data):
        return None
    supplied = data.get("tool_input") or {}
    if isinstance(supplied, dict):
        cwd = supplied.get("workdir") or data.get("cwd") or os.getcwd()
        patch = (supplied.get("patch") or supplied.get("input") or
                 supplied.get("command") or "")
    else:
        cwd = data.get("cwd") or os.getcwd()
        patch = str(supplied)
    # A broken workflow gate must never be able to prevent its own repair.
    # Changes through this escape hatch are limited to tracked policy/config
    # files, so the resulting Git diff is the audit record.
    if (data.get("tool_name") in EDIT_TOOLS and
            isinstance(patch, str)):
        edited = re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$",
                            patch, re.M)
        normalized = {next((part for part in RECOVERY_FILES
                            if path.endswith(part)), path) for path in edited}
        if edited and normalized.issubset(RECOVERY_FILES):
            return None
    targets = WORKTREE.findall(patch) if isinstance(patch, str) else []
    if targets:
        cwd = os.path.join(os.path.realpath(data.get("cwd") or os.getcwd()), "worktrees", targets[0])
    match = WORKTREE.search(os.path.realpath(cwd))
    if not match:
        return ("Repository changes require a dedicated ticket worktree. Claim a "
                "Beads issue, create worktrees/<issue-id>, and run the edit there.")
    issue = match.group(1)
    card = card_for(issue, cwd)
    if not card:
        # A board outage must not deadlock work already isolated and named. The
        # Git registration and exact branch name are the offline proof; status
        # transitions remain protected by the independent lifecycle gate.
        if checked_out_for(issue, cwd):
            return None
        return ("This worktree is not backed by a readable Beads issue named %s, "
                "and Git cannot prove this is its registered matching branch."
                % issue)
    children = None
    active = card.get("status") == "in_progress" and card.get("assignee")
    if card.get("issue_type") == "epic":
        children = children_for(issue, cwd)
        active = active or bool(children and any(
            child.get("status") == "in_progress" and child.get("assignee")
            for child in children))
    if not active:
        return ("Beads issue %s, or one of its epic children, must be claimed "
                "and in_progress before this worktree may be changed." % issue)
    if card.get("issue_type") == "epic":
        if children is None:
            return ("The child beads for epic %s could not be read. Restore the "
                    "board connection before implementing from this epic." % issue)
        if len(children) < 2:
            return ("Epic %s is not decomposed. Create at least two child beads "
                    "for its independently verifiable outcomes before changing "
                    "implementation files." % issue)
    return None


def main():
    data = json.load(sys.stdin)
    refused = reason(data)
    if refused:
        deny(refused)


if __name__ == "__main__":
    main()
