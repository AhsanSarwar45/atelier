#!/usr/bin/env python3
"""PreToolUse (Bash) — what a command writes to decides whether it may run.

Two rules, both answered by the same question, and only the second needs a board.

Protected lines. An agent may not put work onto a line other people ship from.
Which lines those are is each project's own to declare, and a project that has
declared nothing is protected rather than open — the checkout nobody has thought
about is the one most likely to be somebody else's. Manager's ruling, 2026-08-16.

One merge at a time. Where a board is running, merges into its main line are
serialised through a single slot and must be fast-forwards, because a code step
lands as it closes and the slot is taken many times a job.

The question both rules ask is what a command WRITES TO, never which word it
starts with. That is what lets an agent stay current: bringing a protected line
into its own work, and rebasing its own work onto one, write to the agent's own
line and are always allowed, conflicts and all.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402
sys.path.insert(0, os.path.dirname(__file__.rsplit("/", 1)[0]))
import project  # noqa: E402

GIT_TIMEOUT = 10

# A command start: the beginning, or past a separator. Matched against text whose
# quoted parts have been blanked, so a card's own words describing a merge are
# words. A literal bracket in prose reads as a separator, which is how a note
# quoting one of these once refused itself.
START = r"(?:^|[;&|(]+\s*)(?:rtk\s+)?"
# The arguments stop at a separator, so a second command on the same line is a
# second command rather than the first one's arguments.
GIT = re.compile(START + r"git\s+((?:-\S+\s+)*)(\w[\w-]*)((?:\s+[^\s;&|]+)*)", re.M)
GH_MERGE = re.compile(START + r"gh\s+pr\s+merge\b", re.M)

# Mid-operation and look-only forms. None of them decides anything new: they
# finish or abandon a fold already under way, which is where conflicts are
# resolved.
PASSIVE = re.compile(r"--(abort|continue|quit|skip|dry-run)\b")

# What writes to a line. `commit` is here because standing on a protected line
# and committing is the quietest way onto it of all.
WRITERS = ("merge", "rebase", "push", "commit", "cherry-pick", "revert", "am")

FF_ONLY = re.compile(r"--ff-only\b")
NOT_FF = (
    "A merge into main has to be a fast-forward: a code step lands as it closes, so "
    "the slot is taken many times over a job and must come straight back. Rebase in "
    "your own tree first, then merge with --ff-only."
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def bare(cmd):
    """The command with quoted values blanked, for deciding what it IS.

    A quoted value is somebody's words as often as it is an argument, and a card
    note quoting a fold is not a fold. Targets are read off the original text,
    never off this.
    """
    return re.sub(r"(['\"]).*?\1", " ", cmd, flags=re.S)


def standing_on(where):
    """The line the command would write to by default, or None off any line."""
    try:
        run = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                             cwd=where, capture_output=True, text=True,
                             timeout=GIT_TIMEOUT)
    except Exception:
        return None
    name = (run.stdout or "").strip()
    return None if run.returncode or not name or name == "HEAD" else name


def positionals(rest):
    """The arguments of a git subcommand that are not switches."""
    return [a for a in rest.split() if not a.startswith("-")]


def push_targets(rest, here):
    """Every line a push would land on.

    A refspec names its destination after the colon and is otherwise the name on
    both sides. With no refspec at all the line being stood on is the target,
    which is the form that walks past a guard reading only what was typed.
    """
    args = positionals(rest)
    refs = args[1:] if args else []
    if not refs:
        return [here] if here else []
    return [r.split(":")[-1].split("/")[-1] for r in refs]


MOVE = ("checkout", "switch")
# `checkout` restores files as readily as it moves between lines, and these say it
# is doing the first. A conflict is resolved with `--ours`/`--theirs`, which must
# never read as stepping onto another line.
NOT_A_MOVE = re.compile(r"--(ours|theirs|patch|detach)\b|\s--\s|(?:^|\s)-p\b")


def is_branch(name, where):
    """Whether a name is a line in this checkout, so a path is never read as one."""
    try:
        return subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", "refs/heads/" + name],
            cwd=where, capture_output=True, timeout=GIT_TIMEOUT).returncode == 0
    except Exception:
        return False


def moved_to(switches, rest, where):
    """The line a move lands on, or None when it is not a move at all."""
    if NOT_A_MOVE.search(switches + " " + rest):
        return None
    args = positionals(rest)
    if not args:
        return None
    fresh = re.search(r"(?:^|\s)-[bcB]\b", switches + " " + rest)
    # A line being made does not exist to be verified; one being stepped onto
    # does, and a name that is no line at all is a file.
    return args[0] if fresh or is_branch(args[0], where) else None


def written_by(verb, switches, rest, here):
    """The lines this command writes to, given the line it is run from.

    Empty means it writes to nothing anyone is protecting — which is the answer
    for every way of staying current with a protected line, and for resolving the
    conflicts that come with it.
    """
    if verb == "push":
        return push_targets(rest, here)
    if verb == "rebase":
        args = positionals(rest)
        # `--onto <newbase> <upstream> [<branch>]`, else `<upstream> [<branch>]`.
        # The last positional names the line being rewritten only when the form
        # is full; short of that it is whatever is being stood on.
        want = 3 if "--onto" in switches + rest else 2
        return [args[want - 1]] if len(args) >= want else ([here] if here else [])
    return [here] if here else []


def routes(said, here, where):
    """Every line this command writes to, walking it in the order it runs.

    A command may step onto a line before it writes to one: stepping onto what a
    team ships from and folding into it is a single command, and reading only the
    line the shell started on would let it straight through.
    """
    at, written = here, []
    for m in GIT.finditer(said):
        switches, verb, rest = m.group(1) or "", m.group(2), m.group(3) or ""
        if verb in MOVE:
            at = moved_to(switches, rest, where) or at
        elif verb in WRITERS:
            written += written_by(verb, switches, rest, at)
    return written


def protected_by(root):
    """The lines this project says an agent may not write to."""
    try:
        return project.of(root).protected
    except Exception:
        # A declaration that cannot be read is not permission. The default set is
        # what an undeclared project gets, and this is less known than that.
        return frozenset(project.DEFAULT_PROTECTED)


REFUSED = (
    "%s is a line this project ships from, and putting work onto it is not the "
    "agent's to do here.\n\n"
    "Work on a line of your own and offer it up for review; the merge is the "
    "manager's. Staying current is always allowed — bring %s into your own line, "
    "or rebase your line onto it, and resolve the conflicts as usual.\n\n"
    "If this project's work should land without asking, say so once in its "
    "%s: `agent_merges = true`."
)


def main():
    data = json.load(sys.stdin)
    cmd = bc.said(data)
    said = bare(cmd)
    where = bc.where(data)
    root = bc.board_root(where)

    gh = GH_MERGE.search(said)
    # Every git in the command, not the first: one that steps onto a line before
    # it writes leads with a verb that writes to nothing.
    verbs = [m.group(2) for m in GIT.finditer(said)]
    if not gh and not any(v in WRITERS for v in verbs):
        return
    if PASSIVE.search(said):
        return

    guarded = protected_by(root)
    here = standing_on(where)

    if gh:
        # Which line a waiting piece of work would land on is the forge's answer,
        # not this machine's, and asking costs a network call on every command. A
        # project that protects anything protects this.
        if guarded:
            deny(REFUSED % ("The line a waiting piece of work lands on",
                            "it", project.DECLARATION))
            return
        return

    written = routes(said, here, where)

    onto = [w for w in written if w in guarded]
    if onto:
        deny(REFUSED % (onto[0], onto[0], project.DECLARATION))
        return

    # The slot, and the shape of what goes through it. Only where a board is
    # running, and only for what actually writes to the line that board measures
    # every close against.
    if not os.path.isdir(os.path.join(root, ".beads")):
        return
    # Folds only. The slot exists so two sessions never resolve conflicts in the
    # same tree at once; an ordinary commit on the main line resolves nothing and
    # was never what it queued.
    if not any(v in ("merge", "rebase") for v in verbs):
        return
    if project.of(root).lands_on not in written:
        return
    if "merge" in verbs and not FF_ONLY.search(said):
        deny(NOT_FF)
        return
    name = bc.actor(data.get("session_id"), data.get("cwd"))
    ok, out = bc.bd(["merge-slot", "check", "--json", "--actor", name], root)
    if not ok:
        return
    try:
        slot = json.loads(out or "{}")
    except Exception:
        return
    # By session rather than by name: one session works in two trees, taking the
    # slot in its own copy and merging from the main one, and a name carries the
    # tree it was made in.
    if bc.held_by(slot.get("holder"), data.get("session_id")):
        return
    reason = (
        "Merges are serialised through the board's single slot and you are not "
        "holding it. Run `bd merge-slot acquire` (add `--wait` to queue), merge, "
        "then `bd merge-slot release`."
    )
    if slot.get("holder"):
        reason += " Held right now by %s." % slot["holder"]
    deny(reason)


if __name__ == "__main__":
    main()
