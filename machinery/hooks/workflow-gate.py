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
FILE_MUTATIONS = {"apply_patch", "cp", "install", "mkdir", "mv", "rm", "touch",
                  "truncate"}
PACKAGE_MUTATIONS = {"install", "add", "remove", "update"}
# What a file command writes to, which is not the same as what it names. `cp -r
# machinery /tmp/x` names the project and changes nothing in it: it reads there
# and writes elsewhere. `mv` writes at both ends, because the source is gone
# afterwards. Anything absent from both sets is judged by its name alone, as
# before — `apply_patch` carries its targets in a payload, not in argv.
WRITES_EVERY_OPERAND = {"mkdir", "mv", "rm", "touch", "truncate"}
WRITES_ITS_DESTINATION = {"cp", "install"}
# Switches that swallow the word after them, so that word is not an operand.
# A wrong answer here reads a mode or a date as a path, and a path as neither.
SWALLOWS = {
    "cp": {"-S", "--suffix", "-t", "--target-directory"},
    "install": {"-g", "--group", "-m", "--mode", "-o", "--owner", "-S",
                "--suffix", "-t", "--target-directory", "-Z", "--context"},
    "mkdir": {"-m", "--mode", "-Z", "--context"},
    "mv": {"-S", "--suffix", "-t", "--target-directory"},
    "rm": set(),
    "touch": {"-d", "--date", "-r", "--reference", "-t"},
    "truncate": {"-o", "--io-blocks", "-r", "--reference", "-s", "--size"},
}
# A word the shell has not finished with is not a path yet, and a gate that
# guessed at one would be judging a command it has never seen.
UNSETTLED = "*?[]${}`~"
WORKTREE = re.compile(r"(?:^|/)worktrees/([^/\s]+)(?:/|\s|$)")
RECOVERY_FILES = {
    ".codex/hooks.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
    "AGENTS.md",
    "machinery/skills/beads/SKILL.md",
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


def branch_mutates(argv):
    """Whether a git branch call changes a ref rather than listing it."""
    if bc.git_verb(argv) != "branch":
        return False
    args = argv[argv.index("branch") + 1:]
    changing = {"-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move",
                "--copy", "-f", "--force"}
    return any(a in changing for a in args) or any(not a.startswith("-") for a in args)


def operands(name, argv):
    """The paths a file command names, or None when they cannot all be read."""
    swallows = SWALLOWS.get(name, set())
    rest, named, ended = list(argv[1:]), [], False
    while rest:
        word, rest = rest[0], rest[1:]
        if not ended and word == "--":
            ended = True
            continue
        if not ended and word.startswith("-") and word != "-":
            if word in swallows:
                rest = rest[1:]
            elif "=" in word and word.split("=", 1)[0] in swallows:
                pass
            elif word.startswith("--") or word in swallows:
                pass
            else:
                # Bundled short switches: `-rf` is two, and either could be one
                # that eats the next word.
                if any("-" + letter in swallows for letter in word[1:]):
                    return None
            continue
        if not word or any(c in word for c in UNSETTLED):
            return None
        named.append(word)
    return named or None


def target_directory(name, argv):
    """The folder a `-t` switch aims this command at, if it carries one.

    `-t` takes the destination out of last place, so a reader that always took
    the last word would call the destination a source and a source the
    destination — the wrong half of `cp -t /tmp machinery/checks`.
    """
    if not {"-t", "--target-directory"} & SWALLOWS.get(name, set()):
        return None
    rest = list(argv[1:])
    while rest:
        word, rest = rest[0], rest[1:]
        if word == "--":
            return None
        if word in {"-t", "--target-directory"}:
            return rest[0] if rest else ""
        if word.startswith("--target-directory="):
            return word.split("=", 1)[1]
    return None


def written_by(name, argv):
    """Every path this command writes, or None when that cannot be read.

    Refusing to answer is the safe answer: the caller treats None as a change
    to the project, which is what the gate did for every one of these before.
    """
    named = operands(name, argv)
    if named is None:
        return None
    aimed = target_directory(name, argv)
    if aimed is not None and (not aimed or any(c in aimed for c in UNSETTLED)):
        return None
    if name in WRITES_ITS_DESTINATION:
        if aimed is not None:
            return [aimed]
        return named[-1:] if len(named) > 1 else None
    if name in WRITES_EVERY_OPERAND:
        # `mv` empties every source as well as filling the destination.
        return named + ([aimed] if aimed is not None else [])
    return None


def writes_outside(name, argv, outside):
    """Whether every path this command writes lies beyond this repository."""
    written = written_by(name, argv)
    return bool(written) and all(outside(path) for path in written)


def redirected_project_output(segment):
    """Whether shell output is aimed somewhere that may be project work."""
    targets = re.findall(r"(?:^|\s)(?:\d*>>?|&>)\s*([^\s;&|]+)", segment)
    for raw in targets:
        target = raw.strip("\"'")
        if target == "/dev/null" or target.startswith("/tmp/"):
            continue
        return True
    return False


def shell_mutates(command, outside=None):
    """Classify commands by parsed executable and verb, never argument prose.

    `outside` tells this where the repository ends. Without it every file
    command is a change, which is what this did before it was given one.
    """
    for segment in bc.segments(bc.unshelled(command)):
        if redirected_project_output(segment):
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
        if name in FILE_MUTATIONS:
            if outside is None or not writes_outside(name, argv, outside):
                return True
        if name in {"npm", "pnpm", "yarn", "cargo", "go"} \
                and len(argv) > 1 and argv[1].lower() in PACKAGE_MUTATIONS:
            return True
        if name in {"perl", "sed"} and any(a == "-i" or a.startswith("-i.")
                                             for a in argv[1:]):
            return True
    return False


def mutates(data, cwd=None):
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
    return shell_mutates(command, outside_project(cwd) if cwd else None)


def edit_targets(data, supplied, patch):
    """Every path an edit call names, however this host spells the call.

    Codex sends one `apply_patch` envelope naming its files inside the patch
    text. Claude Code sends the path beside the content instead, as `file_path`
    or `notebook_path`. A gate reading only the envelope sees no target at all
    for those tools, so it can neither recognise a machine-local edit nor let
    its own repair through, and every edit outside the repository is refused
    from those sessions.
    """
    if data.get("tool_name") not in EDIT_TOOLS:
        return []
    named = []
    if isinstance(patch, str):
        named.extend(re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$",
                                patch, re.M))
    if isinstance(supplied, dict):
        for key in ("file_path", "notebook_path"):
            value = supplied.get(key)
            if isinstance(value, str) and value.strip():
                named.append(value)
    return [path.strip() for path in named]


def outside_project(cwd):
    """A test for paths this repository does not hold, or None if it cannot say.

    Use Git's common directory so a linked worktree cannot mistake the shared
    checkout for an external path.
    """
    ok, common = run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)
    if not ok:
        return None
    project_root = os.path.dirname(os.path.realpath(common))

    def outside(path):
        target = os.path.realpath(path if os.path.isabs(path) else os.path.join(cwd, path))
        try:
            return os.path.commonpath([project_root, target]) != project_root
        except ValueError:
            return True

    return outside


def external_edit_only(edited, cwd):
    """Whether every explicit edit target is outside this Git project.

    The hook belongs to one repository. Personal skills and other machine-local
    configuration are not repository changes, even when the host reports the
    session's project cwd for every tool call. Mixed edits stay guarded.
    """
    outside = outside_project(cwd)
    if not edited or outside is None:
        return False
    return all(outside(path) for path in edited)


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


def already_removed(root, path, issue):
    """Whether this copy is gone for good and its branch holds nothing unlanded.

    The teardown is three commands joined by `&&`, and a run that stops after
    the first leaves the copy gone and the branch behind. Every retry was then
    refused for want of the copy the first part had removed, so the branch
    could never be deleted at all and the land step could never finish. What
    the refusal protects is unlanded work; `git branch -d` refuses a branch
    holding any, and a branch already merged into this line holds none.
    """
    if os.path.exists(path):
        return False
    ok, trees = run(["git", "worktree", "list", "--porcelain"], root)
    if not ok:
        return False
    if os.path.realpath(path) in {
            os.path.realpath(line.removeprefix("worktree "))
            for line in trees.splitlines() if line.startswith("worktree ")}:
        return False
    ok, merged = run(["git", "branch", "--list", "--merged", "HEAD", issue], root)
    return ok and merged.strip().lstrip("*").strip() == issue


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
        cwd = (bc.where(data) if data.get("tool_name") == "Bash" else
               supplied.get("workdir") or data.get("cwd") or os.getcwd())
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
    if not mutates(data, cwd):
        return None
    # The manager may explicitly take the board off one session for a small,
    # direct change. board/waive records their words against this exact session
    # and expires the exemption automatically; every other session and every
    # unwaived turn still follows the normal ticket-worktree lifecycle.
    if bc.waived(data.get("session_id")):
        return None
    named = edit_targets(data, supplied, patch)
    if data.get("tool_name") in EDIT_TOOLS and external_edit_only(named, cwd):
        return None
    # A broken workflow gate must never be able to prevent its own repair.
    # Changes through this escape hatch are limited to tracked policy/config
    # files, so the resulting Git diff is the audit record.
    if data.get("tool_name") in EDIT_TOOLS:
        normalized = {next((part for part in RECOVERY_FILES
                            if path.endswith(part)), path) for path in named}
        if named and normalized.issubset(RECOVERY_FILES):
            return None
    removing = copy_to_remove(command)
    targets = (WORKTREE.findall(patch)
               if data.get("tool_name") in EDIT_TOOLS and isinstance(patch, str)
               else [])
    if removing:
        # The copy named here is the one about to go, or the one already gone.
        # Either way it is not a folder to ask questions from.
        cwd = removing[1]
    elif targets:
        cwd = os.path.join(os.path.realpath(data.get("cwd") or os.getcwd()), "worktrees", targets[0])
    # Whatever is being changed, the questions are asked somewhere that exists.
    asked_in = removing[0] if removing else cwd
    match = WORKTREE.search(os.path.realpath(cwd))
    if not match:
        return ("Repository changes require a dedicated ticket worktree. Claim a "
                "Beads issue, create worktrees/<issue-id>, and run the edit there.")
    issue = match.group(1)
    card = card_for(issue, asked_in)
    if not card:
        # A board outage must not deadlock work already isolated and named. The
        # Git registration and exact branch name are the offline proof; status
        # transitions remain protected by the independent lifecycle gate.
        if checked_out_for(issue, cwd) or (
                removing and already_removed(removing[0], removing[1], issue)):
            return None
        return ("This worktree is not backed by a readable Beads issue named %s, "
                "and Git cannot prove this is its registered matching branch."
                % issue)
    children = None
    active = card.get("status") == "in_progress" and card.get("assignee")
    if card.get("issue_type") == "epic":
        children = children_for(issue, asked_in)
        active = active or bool(children and any(
            child.get("status") == "in_progress" and child.get("assignee")
            for child in children))
    if removing:
        where, path, removing_issue = removing
        if removing_issue != issue or not (checked_out_for(issue, path)
                                           or already_removed(where, path, issue)):
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
