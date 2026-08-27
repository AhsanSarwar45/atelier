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
import shlex
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import board_common as bc  # noqa: E402

EDIT_TOOLS = {"apply_patch", "Edit", "Write", "MultiEdit", "NotebookEdit"}
GIT_MUTATIONS = {"add", "am", "checkout", "cherry-pick", "clean", "commit",
                 "merge", "mv", "rebase", "reset", "restore", "revert", "rm",
                 "switch", "update-ref"}
BD_MUTATIONS = {"close", "create", "defer", "dep", "reopen", "supersede", "update"}
FILE_MUTATIONS = {"apply_patch", "cp", "install", "mkdir", "mv", "rm", "touch",
                  "truncate"}
PACKAGE_MUTATIONS = {"install", "add", "remove", "update"}
BD_TAKES_VALUE = {"--actor", "--database", "--db", "--directory", "-C",
                  "--dolt-auto-commit", "--mem-profile"}
WORKTREE = re.compile(r"(?:^|/)worktrees/([^/\s]+)(?:/|\s|$)")
RECOVERY_FILES = {
    ".codex/hooks.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    "AGENTS.md",
    "ATELIER_WORKFLOW.md",
    "CLAUDE.md",
    "machinery/hooks/workflow-gate.py",
}


def copy_to_cut(command):
    """The root and card named by the exact copy-creation command, or None."""
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if len(words) != 8 or words[:2] != ["git", "-C"] or words[3:5] != ["worktree", "add"] or words[6] != "-b":
        return None
    root, target, issue = words[2], words[5], words[7]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", issue):
        return None
    expected = {
        os.path.join("worktrees", issue),
        os.path.join(root, "worktrees", issue),
        os.path.join(".claude", "worktrees", issue),
        os.path.join(root, ".claude", "worktrees", issue),
    }
    return (root, issue) if target in expected else None


def copy_to_remove(command):
    """The root, path and card named by the exact finished-copy teardown."""
    try:
        words = shlex.split(command)
    except ValueError:
        return None
    if len(words) != 16:
        return None
    path, root = words[2], words[6]
    if words[:2] != ["rm", "-rf"] or words[3:7] != ["&&", "git", "-C", root]:
        return None
    if words[7:10] != ["worktree", "prune", "&&"] or words[10:13] != ["git", "-C", root]:
        return None
    if words[13:15] != ["branch", "-d"]:
        return None
    issue = words[15]
    expected = {
        os.path.join(root, "worktrees", issue),
        os.path.join(root, ".claude", "worktrees", issue),
    }
    if path not in expected or not re.fullmatch(r"[A-Za-z0-9_.-]+", issue):
        return None
    return root, path, issue


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def bd_verb(argv):
    """The actual bd subcommand, ignoring its global switches and values."""
    if not argv or os.path.basename(argv[0]) != "bd":
        return ""
    i = 1
    while i < len(argv):
        arg = argv[i]
        if not arg.startswith("-"):
            return arg.lower()
        if "=" not in arg and arg in BD_TAKES_VALUE:
            i += 1
        i += 1
    return ""


def branch_mutates(argv):
    """Whether a git branch call changes a ref rather than listing it."""
    if bc.git_verb(argv) != "branch":
        return False
    args = argv[argv.index("branch") + 1:]
    changing = {"-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move",
                "--copy", "-f", "--force"}
    return any(a in changing for a in args) or any(not a.startswith("-") for a in args)


def shell_mutates(command):
    """Classify commands by parsed executable and verb, never argument prose."""
    for segment in bc.segments(bc.unshelled(command)):
        if re.search(r"(?:^|\s)(?:\d*>>?|&>)\s*\S", segment):
            return True
        argv = bc.plain(bc.words(segment))[1]
        if not argv:
            continue
        name = os.path.basename(argv[0]).lower()
        git_verb = bc.git_verb(argv).lower()
        if git_verb in GIT_MUTATIONS or branch_mutates(argv):
            return True
        if git_verb == "worktree" and any(a in {"add", "move", "remove", "prune", "repair"}
                                           for a in argv[2:3]):
            return True
        if bd_verb(argv) in BD_MUTATIONS:
            return True
        if name in FILE_MUTATIONS:
            return True
        if name in {"npm", "pnpm", "yarn", "cargo", "go"} \
                and len(argv) > 1 and argv[1].lower() in PACKAGE_MUTATIONS:
            return True
        if name in {"perl", "sed"} and any(a == "-i" or a.startswith("-i.")
                                             for a in argv[1:]):
            return True
    return False


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
    return shell_mutates(command)


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


def is_teardown(child):
    """Whether a child is the no-code land step that removes its own copy.

    That step must still be open while its copy is removed: the independent
    status gate refuses to close it until the copy is gone. Treating it as
    unfinished work here makes those two safety rules wait on each other.
    """
    labels = set(child.get("labels") or [])
    return "step:land" in labels and "no-code" in labels


def reason(data):
    """Return a refusal for a mutating call, or None when it may proceed."""
    supplied = data.get("tool_input") or {}
    if isinstance(supplied, dict):
        cwd = supplied.get("workdir") or data.get("cwd") or os.getcwd()
        patch = (supplied.get("patch") or supplied.get("input") or
                 supplied.get("command") or "")
    else:
        cwd = data.get("cwd") or os.getcwd()
        patch = str(supplied)
    command = supplied.get("command", "") if isinstance(supplied, dict) else str(supplied)

    # A copy is cut before its first child can be claimed. Validate the exact
    # root, folder, branch and readable card here instead of mistaking the
    # command's `add` for the unrelated staging command.
    cutting = copy_to_cut(command)
    if cutting:
        root, issue = cutting
        if card_for(issue, root):
            return None
        return "The separate copy names no readable Beads issue %s." % issue
    if not mutates(data):
        return None
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
    removing = copy_to_remove(command)
    targets = WORKTREE.findall(patch) if isinstance(patch, str) else []
    if removing:
        cwd = removing[1]
    elif targets:
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
    if removing:
        _, path, removing_issue = removing
        if removing_issue != issue or not checked_out_for(issue, path):
            return "The separate copy being removed is not the registered copy for %s." % issue
        # A container stays `in_progress` while the workflow advances through
        # checks and review, even after its build children have all closed. Its
        # own bookkeeping status is not live work inside the copy; its children
        # are the authoritative answer.
        removal_active = (bool(children and any(
            not is_teardown(child) and
            child.get("status") == "in_progress" and child.get("assignee")
            for child in children)) if card.get("issue_type") == "epic" else active)
        if removal_active:
            return "Beads issue %s still has active work, so its separate copy stays." % issue
        if card.get("issue_type") == "epic":
            if children is None:
                return "The child beads for epic %s could not be read." % issue
            if any(child.get("status") != "closed" and not is_teardown(child)
                   for child in children):
                return "Beads issue %s still has unfinished children, so its separate copy stays." % issue
        elif card.get("status") != "closed":
            return "Beads issue %s is not finished, so its separate copy stays." % issue
        return None
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
