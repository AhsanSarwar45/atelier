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

The question both rules ask is what a command WRITES TO: never which word it
starts with, and never which project the session was started in. That is what
lets an agent stay current — bringing a protected line into its own work, and
rebasing its own work onto one, write to the agent's own line and are always
allowed, conflicts and all.
"""
import json
import os
import shlex
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402
sys.path.insert(0, os.path.dirname(__file__.rsplit("/", 1)[0]))
import project  # noqa: E402

GIT_TIMEOUT = 10

# What writes to a line. `commit` is here because standing on a protected line
# and committing is the quietest way onto it of all, and `branch`, `reset` and
# `update-ref` because pointing a line at your own work writes to it as surely as
# folding into it does.
WRITERS = ("merge", "rebase", "push", "commit", "cherry-pick", "revert", "am",
           "pull", "branch", "reset", "update-ref")
MOVE = ("checkout", "switch")

# The `branch` forms that move or destroy a line rather than list or make one,
# and which of their names each one writes to.
BRANCH_FORCES = ("-f", "--force")
BRANCH_RENAMES = ("-m", "-M", "--move")
BRANCH_DELETES = ("-d", "-D", "--delete")

# The `reset` forms that move the line you stand on. A reset naming paths only
# takes them out of what is staged and moves nothing.
RESET_MODES = ("--hard", "--soft", "--mixed", "--merge", "--keep")

# What a command means by the position it is standing at, rather than by a name.
HERE_NAMES = ("HEAD", "@")

# Mid-operation and look-only forms. None of them decides anything new: they
# finish or abandon a fold already under way, which is where conflicts are
# resolved. Asked of one command and never of the whole line — abandoning a fold
# and pushing a shipping line is two commands, and only the first is passive.
PASSIVE = ("--abort", "--continue", "--quit", "--skip", "--dry-run")

# `checkout` restores files as readily as it moves between lines, and these say it
# is doing the first. A conflict is resolved with `--ours`/`--theirs`, which must
# never read as stepping onto another line.
NOT_A_MOVE = ("--ours", "--theirs", "--patch", "-p", "--detach", "--")

# The git switches that swallow the word after them, so a value is never read as
# the verb. `-C` is the one that decides which checkout the command is judged in.
TAKES_VALUE = ("-C", "-c", "--git-dir", "--work-tree", "--namespace",
               "--exec-path", "--super-prefix", "--config-env")

# A push that names no line because it means every one of them. It cannot be a
# line's own name: git refuses that spelling for a branch.
EVERY = "*"

FF_ONLY = "--ff-only"
NOT_FF = (
    "A merge into main has to be a fast-forward: a code step lands as it closes, so "
    "the slot is taken many times over a job and must come straight back. Rebase in "
    "your own tree first, then merge with --ff-only."
)

REFUSED = (
    "%s is a line this project ships from, and putting work onto it is not the "
    "agent's to do here.\n\n"
    "Work on a line of your own and offer it up for review; the merge is the "
    "manager's. Staying current is always allowed — bring %s into your own line, "
    "or rebase your line onto it, and resolve the conflicts as usual.\n\n"
    "If this project's work should land without asking, say so once in its "
    "%s: `agent_merges = true`."
)


WEDGED = (
    "\n\nThis checkout also runs a board, and a card here closes only once a "
    "commit naming it reaches %s — the line just refused. Until this project says "
    "who lands its work, nothing here can finish: `agent_merges = true` if agents "
    "land their own, or a line they may land on in `lands_on` with only what they "
    "may not in `protected = [\"main\", \"staging\"]`."
)


def refusal(subject, name, where):
    """What to tell a command that would write to a protected line.

    A project running a board is told the rest of it: the same line its cards
    close against is the one being refused, so a project that joined and said
    nothing has no route at all until it answers.
    """
    said = REFUSED % (subject, name, project.DECLARATION)
    try:
        decl = project.of(where)
        board = os.path.isdir(os.path.join(project.root(where), ".beads"))
    except Exception:
        return said
    if board and decl.lands_on in decl.protected:
        said += WEDGED % decl.lands_on
    return said


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def segments(cmd):
    """Each command on the line, in the order the shell would run them.

    Quoted stretches, escapes and nested commands are stepped over rather than
    searched: a card note quoting a fold is words, a bracket in prose is not a
    separator, and the brackets of a nested command belong to the command around
    them. Reading any of those as a separator cuts a command in half and lets the
    harmless-looking half stand for the whole.
    """
    out, cur, quote, depth, i = [], [], "", 0, 0
    while i < len(cmd):
        ch = cmd[i]
        if ch == "\\" and i + 1 < len(cmd) and quote != "'":
            cur.append(cmd[i:i + 2])
            i += 2
            continue
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = ""
        elif depth:
            cur.append(ch)
            depth += 1 if ch == "(" else (-1 if ch == ")" else 0)
        elif cmd[i:i + 2] == "$(":
            cur.append("$(")
            depth, i = 1, i + 2
            continue
        elif ch in "'\"`":
            quote = ch
            cur.append(ch)
        elif ch in ";&|()\n":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    out.append("".join(cur))
    return [s for s in (part.strip() for part in out) if s]


# A value no reading of the text can settle, because a shell works it out at the
# moment it runs. Anything carrying one names a line nobody here can name.
GROWN = ("$(", "`", "${")


def unknowable(seg):
    """Whether this command's arguments are worked out as it runs."""
    return any(mark in seg for mark in GROWN)


# The commands that read their target out of their own arguments. Every other one
# writes to whatever is being stood on, where a value the shell works out cannot
# change the answer — and a commit message built from one is an ordinary command.
NAMED_TARGET = ("push", "rebase", "branch", "update-ref")


def words(seg):
    """One command as the shell would hand it over, quotes taken off.

    A line naming its target in quotes names the same target, and reading the
    quoted spelling as no target at all is how every refusal is walked past.
    """
    try:
        return shlex.split(seg)
    except ValueError:
        return seg.split()


def plain(argv):
    """The command itself, with what only decorates the call taken off."""
    while argv and "=" in argv[0] and not argv[0].startswith("-"):
        argv = argv[1:]  # FOO=bar git …
    if argv[:2] == ["rtk", "proxy"]:
        return argv[2:]
    if argv[:1] == ["rtk"]:
        return argv[1:]
    return argv


def git_call(argv, here):
    """A git command split into where it runs, its verb, and the verb's own
    arguments — or None when it is not git.

    The switches before the verb are git's own, and one of them sends the whole
    command into another checkout. Reading them as the verb, or not reading them
    at all, leaves every route through that checkout open.
    """
    if not argv or os.path.basename(argv[0]) != "git":
        return None
    where, i = here, 1
    while i < len(argv):
        arg = argv[i]
        if not arg.startswith("-"):
            return where, arg, argv[i + 1:]
        if arg in TAKES_VALUE and i + 1 < len(argv):
            if arg == "-C":
                where = os.path.join(where, argv[i + 1])
            i += 2
            continue
        if arg.startswith("-C") and len(arg) > 2:
            where = os.path.join(where, arg[2:])
        i += 1
    return None


def standing_on(where):
    """The line a command would write to by default, or None off any line."""
    try:
        run = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                             cwd=where, capture_output=True, text=True,
                             timeout=GIT_TIMEOUT)
    except Exception:
        return None
    name = (run.stdout or "").strip()
    return None if run.returncode or not name or name == "HEAD" else name


def is_branch(name, where):
    """Whether a name is a line in this checkout, so a path is never read as one."""
    try:
        return subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", "refs/heads/" + name],
            cwd=where, capture_output=True, timeout=GIT_TIMEOUT).returncode == 0
    except Exception:
        return False


def positionals(rest):
    """The arguments of a git subcommand that are not switches."""
    return [a for a in rest if not a.startswith("-")]


def moved_to(rest, where):
    """The line a move lands on, or None when it is not a move at all."""
    if any(a in NOT_A_MOVE for a in rest):
        return None
    args = positionals(rest)
    if not args:
        return None
    fresh = any(a in ("-b", "-c", "-B", "-C") for a in rest)
    # A line being made does not exist to be verified; one being stepped onto
    # does, and a name that is no line at all is a file.
    return args[0] if fresh or is_branch(args[0], where) else None


def line_named(ref, here):
    """The line one end of a refspec names.

    Only git's own prefix comes off, and the leading plus that forces the write is
    not part of a name. A working line called `fix/main` is not the line called
    `main`, and cutting at the last slash makes every line whose name happens to
    end in a protected word unpushable. A refspec that names the position rather
    than the line means the line being stood on, which is the canonical way of
    pushing what you are on.
    """
    ref = ref.lstrip("+")
    for lead in ("refs/heads/", "heads/"):
        if ref.startswith(lead):
            ref = ref[len(lead):]
            break
    return here if ref in HERE_NAMES else ref


def push_targets(rest, here):
    """Every line a push would land on.

    A refspec names its destination after the colon and is otherwise the name on
    both sides. With no refspec at all the line being stood on is the target,
    which is the form that walks past a guard reading only what was typed.
    """
    if any(a in ("--all", "--mirror") for a in rest):
        return [EVERY]
    args = positionals(rest)
    refs = args[1:] if args else []
    if not refs:
        return [here] if here else []
    return [line_named(r.split(":")[-1], here) for r in refs]


def branch_targets(rest, here):
    """The lines a `git branch` writes to, empty when it only lists or makes one.

    Each form writes somewhere different: a forced one points its first name at a
    commit, a rename lands on the new name, a delete takes every name it is given.
    """
    args = positionals(rest)
    if not args:
        return []
    if any(a in BRANCH_DELETES for a in rest):
        return [line_named(a, here) for a in args]
    if any(a in BRANCH_RENAMES for a in rest):
        # A rename writes to both ends: the new name is made and the old one stops
        # existing. Given one name, the old one is the line being stood on — and
        # renaming a shipping line away is deleting it by another word.
        old = line_named(args[0], here) if len(args) > 1 else here
        return [n for n in (old, line_named(args[-1], here)) if n]
    if any(a in BRANCH_FORCES for a in rest):
        return [line_named(args[0], here)]
    return []


def reset_targets(rest, here, where):
    """Whether a reset moves the line being stood on.

    A reset naming paths only takes them out of what is staged, and it names a
    commit as well as the paths — so a second name is what tells the two apart
    where the switch does not. One naming a commit alone moves the line, and
    discarding history on a protected line is a write to it however gently it is
    spelled.
    """
    if "--" in rest:
        return []
    args = positionals(rest)
    if not args:
        # `git reset --hard` alone throws the working tree away and moves nothing.
        return []
    if any(os.path.exists(os.path.join(where, a)) for a in args):
        return []
    if len(args) > 1 and not any(a in RESET_MODES for a in rest):
        return []
    return [here] if here else []


def remade_by(rest, where):
    """The line a move also resets, for the form that steps onto it by force.

    `checkout -B x` and `switch -C x` step onto x and point it at where you were
    standing, so a protected line is rewritten with no verb of the usual list
    appearing anywhere on the command.
    """
    if not any(a in ("-B", "-C") for a in rest):
        return []
    args = positionals(rest)
    return [args[0]] if args and is_branch(args[0], where) else []


def written_by(verb, rest, here, where):
    """The lines this command writes to, given the line it is run from.

    Empty means it writes to nothing anyone is protecting — which is the answer
    for every way of staying current with a protected line, and for resolving the
    conflicts that come with it.
    """
    if verb == "push":
        return push_targets(rest, here)
    if verb == "branch":
        return branch_targets(rest, here)
    if verb == "reset":
        return reset_targets(rest, here, where)
    if verb == "update-ref":
        args = positionals(rest)
        return [line_named(args[0], here)] if args else []
    if verb == "rebase":
        args = positionals(rest)
        # `--onto <newbase> <upstream> [<branch>]`, else `<upstream> [<branch>]`.
        # The last positional names the line being rewritten only when the form
        # is full; short of that it is whatever is being stood on.
        want = 3 if "--onto" in rest else 2
        return [args[want - 1]] if len(args) >= want else ([here] if here else [])
    return [here] if here else []


def protected_by(where):
    """The lines the project holding this directory says an agent may not write to."""
    try:
        return project.of(where).protected
    except Exception:
        # A declaration that cannot be read is not permission. The default set is
        # what an undeclared project gets, and this is less known than that.
        return frozenset(project.DEFAULT_PROTECTED)


def routes(cmd, home):
    """Every write this command makes, as (verb, checkout, line), in running order.

    Walked command by command because one may step onto a line, or into a checkout,
    before it writes: stepping onto what a team ships from and folding into it is a
    single line of shell, and so is changing into somebody else's checkout and
    pushing it. Reading only where the shell started lets both straight through.
    """
    at, made, cwd = {}, [], home

    def line_of(where):
        if where not in at:
            at[where] = standing_on(where)
        return at[where]

    for seg in segments(cmd):
        argv = plain(words(seg))
        if argv[:1] == ["cd"]:
            # Changing into a checkout is the ordinary spelling of the reach that
            # `-C` spells as a switch, and the two must answer alike.
            cwd = os.path.expanduser(os.path.join(cwd, argv[1])) if len(argv) > 1 \
                else home
            continue
        if argv[:3] == ["gh", "pr", "merge"]:
            made.append(("gh", cwd, None))
            continue
        call = git_call(argv, cwd)
        if not call:
            continue
        where, verb, rest = call
        if any(a in PASSIVE for a in rest):
            continue
        if verb in MOVE:
            if unknowable(seg):
                at[where] = EVERY
                continue
            made += [(verb, where, line) for line in remade_by(rest, where)]
            at[where] = moved_to(rest, where) or line_of(where)
        elif verb in WRITERS:
            if verb in NAMED_TARGET and unknowable(seg):
                # A name the shell works out as it runs is a name nothing here can
                # read, so it stands for any of them.
                made.append((verb, where, EVERY))
            else:
                made += [(verb, where, line)
                         for line in written_by(verb, rest, line_of(where), where)]
    return made


def main():
    data = json.load(sys.stdin)
    cmd = bc.said(data)
    home = bc.where(data)
    made = routes(cmd, home)
    if not made:
        return

    for verb, where, line in made:
        guarded = protected_by(where)
        if verb == "gh":
            # Which line a waiting piece of work would land on is the forge's
            # answer, not this machine's, and asking costs a network call on every
            # command. A project that protects anything protects this.
            if guarded:
                deny(refusal("The line a waiting piece of work lands on", "it", where))
                return
        elif line == EVERY:
            # Sending every line at once sends the protected ones with them, and
            # which lines exist is not worth a command to find out: a project
            # protecting anything protects this.
            if guarded:
                deny(refusal("Every line in this checkout at once", "one of them", where))
                return
        elif line in guarded:
            deny(refusal(line, line, where))
            return

    # The slot, and the shape of what goes through it. Only where a board is
    # running, and only for what actually writes to the line that board measures
    # every close against.
    root = bc.board_root(home)
    if not os.path.isdir(os.path.join(root, ".beads")):
        return
    lands_on = project.of(root).lands_on
    # Folds only. The slot exists so two sessions never resolve conflicts in the
    # same tree at once; an ordinary commit on the main line resolves nothing and
    # was never what it queued.
    folds = [(verb, where, line) for verb, where, line in made
             if verb in ("merge", "rebase") and line == lands_on
             and bc.board_root(where) == root]
    if not folds:
        return
    if any(verb == "merge" for verb, _, _ in folds) and FF_ONLY not in words(cmd):
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
