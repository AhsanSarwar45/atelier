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
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402
sys.path.insert(0, os.path.dirname(__file__.rsplit("/", 1)[0]))
import project  # noqa: E402

GIT_TIMEOUT = 10

# What writes to a line. `commit` is here because standing on a protected line
# and committing is the quietest way onto it of all, and `fetch`, `branch`,
# `reset` and `update-ref` because pointing a line at your own work writes to it
# as surely as folding into it does.
WRITERS = ("merge", "rebase", "push", "commit", "cherry-pick", "revert", "am",
           "pull", "fetch", "branch", "reset", "update-ref")
MOVE = ("checkout", "switch")

# The `branch` forms that move or destroy a line rather than list or make one,
# and which of their names each one writes to.
BRANCH_FORCES = ("-f", "--force")
BRANCH_RENAMES = ("-m", "-M", "--move")
BRANCH_DELETES = ("-d", "-D", "--delete")
# A copy lands on the name it is copied TO, and the forced form lands on it even
# when a line of that name is already there — which is pointing a shipping line
# at any commit, in two words and with none of the folding verbs.
BRANCH_COPIES = ("-c", "-C", "--copy")
# The move switches that make a line rather than step onto one, and the two of
# those that also point an EXISTING line at where you are standing. Both
# spellings of each: the short one refused and the long one allowed is the same
# rewrite, typed differently.
MAKES = ("-b", "-c", "-B", "-C", "--create", "--force-create", "--orphan")
REMAKES = ("-B", "-C", "--force-create")
BRANCH_WRITES = BRANCH_DELETES + BRANCH_RENAMES + BRANCH_COPIES + BRANCH_FORCES

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
TAKES_VALUE = bc.GIT_TAKES_VALUE

# A push that names no line because it means every one of them, a name only the
# running shell can settle, and a line with more commands on it than the walk
# reads. None can be a line's own name: git refuses all three spellings.
EVERY = "*"
UNREADABLE = "?"
UNENDING = "!"

# How many commands one line is read through. A line longer than this is refused
# rather than half-read: letting the tail past is the one failure direction a
# guard must not have, because padding a line with harmless commands would then
# walk around every refusal on it.
READ_CAP = 200

TOO_MANY = (
    "This line puts more than %d commands on one call, and what the ones past "
    "that write to is not read — so nothing here can say whether it reaches a "
    "line this project ships from.\n\nSplit it into separate calls."
)

UNREAD = (
    "This names the line by running something, and which line that comes out as "
    "is not settled until the shell runs it — so nothing here can tell whether it "
    "is one this project ships from.\n\n"
    "Spell it out, or name the position you are standing at: `git push origin "
    "HEAD` pushes the line you are on and is read as that line."
)

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


# A value no reading of the text can settle, because a shell works it out at the
# moment it runs. Anything carrying one names a line nobody here can name. The
# bare dollar covers the plain variable as well as the braced and run-it forms:
# working the line out on one command and pushing it on the next is the two-step
# spelling of the very thing this refuses.
GROWN = ("$", "`")


def unknowable(seg):
    """Whether this command's arguments are worked out as it runs."""
    return any(mark in seg for mark in GROWN)


# The commands that read their target out of their own arguments. Every other one
# writes to whatever is being stood on, where a value the shell works out cannot
# change the answer — and a commit message built from one is an ordinary command.
NAMED_TARGET = ("push", "rebase", "branch", "update-ref")


def repo_dir(named):
    """The working tree a git directory belongs to."""
    return os.path.dirname(named.rstrip("/")) \
        if os.path.basename(named.rstrip("/")) == ".git" else named


# The settings that send a git command at another checkout without a switch, and
# what each one names: the working tree itself, or the git directory inside it.
# Read where a command is followed, so adding a third here is all adding a third
# takes — a list nothing reads is the one that gets extended in that belief.
POINTERS = (("GIT_WORK_TREE", lambda named: named), ("GIT_DIR", repo_dir))


def under(here, named):
    """A directory a command names, as this machine spells it.

    The shortcut for a home directory is expanded before anything is joined onto
    it — joined first it becomes a path that exists nowhere, and a walk up from
    nowhere lands back on the session's own project.
    """
    named = os.path.expanduser(named)
    return named if os.path.isabs(named) else os.path.join(here, named)


def git_call(argv, here):
    """A git command split into where it runs, its verb, and the verb's own
    arguments — or None when it is not git.

    The switches before the verb are git's own, and three of them send the whole
    command into another checkout — by name, by working tree, or by the git
    directory itself. Reading one as the verb, or not reading it at all, leaves
    every route through that checkout open.
    """
    if not argv or os.path.basename(argv[0]) != "git":
        return None
    where, i = here, 1
    while i < len(argv):
        arg = argv[i]
        if not arg.startswith("-"):
            return where, arg, argv[i + 1:]
        name, _, value = arg.partition("=")
        if not value and arg in TAKES_VALUE and i + 1 < len(argv):
            name, value, i = arg, argv[i + 1], i + 1
        elif not value and arg.startswith("-C") and len(arg) > 2:
            name, value = "-C", arg[2:]
        if value:
            if name == "-C" or name == "--work-tree":
                where = under(where, value)
            elif name == "--git-dir":
                where = repo_dir(under(where, value))
        i += 1
    return None


def tree_of(where):
    """The checkout a directory sits in, so a subdirectory of it is the same one."""
    try:
        run = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=where,
                             capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except Exception:
        return where
    return (run.stdout or "").strip() or where


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


def ref_exists(ref, where):
    """Whether this checkout holds a ref of exactly this name."""
    try:
        return subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", ref],
            cwd=where, capture_output=True, timeout=GIT_TIMEOUT).returncode == 0
    except Exception:
        return False


def is_branch(name, where):
    """Whether a name is a line in this checkout, so a path is never read as one.

    A line that so far exists only on the remote counts: `git checkout release`
    in a fresh clone makes a local one of that name and steps onto it, and a
    fresh clone is the ordinary case rather than the exception.
    """
    if ref_exists("refs/heads/" + name, where):
        return True
    try:
        run = subprocess.run(
            ["git", "for-each-ref", "--format=%(refname)", "refs/remotes/*/" + name],
            cwd=where, capture_output=True, text=True, timeout=GIT_TIMEOUT)
        return bool((run.stdout or "").strip())
    except Exception:
        return False


def steps_onto(name, where):
    """The line this name steps onto, or None when it is no line at all.

    A remote-tracking name lands on the line it TRACKS: `git checkout
    origin/main` and `git checkout --track origin/main` both make a local `main`
    and step onto it, and reading the name as written finds no line at all.
    """
    if is_branch(name, where):
        return name
    if "/" in name and ref_exists("refs/remotes/" + name, where):
        return name.split("/", 1)[1]
    return None


# The switches whose next word is a value, by the verb that takes them. A value
# does not start with a dash, so read as one of the command's own arguments it
# moves every argument after it one place along — and which line a command writes
# to is read by position. `-b`, `-B`, `-c`, `-C` and `--orphan` are deliberately
# absent from the two move verbs: what follows those IS the line being written
# to, and that is the argument this is asked for.
TAKES_ARG = {
    "commit": ("-m", "--message", "-F", "--file", "-C", "--reuse-message",
               "-c", "--reedit-message", "--author", "--date", "--cleanup",
               "--fixup", "--squash", "--trailer", "-t", "--template",
               "--pathspec-from-file"),
    "merge": ("-m", "--message", "-F", "--file", "-s", "--strategy",
              "-X", "--strategy-option", "--into-name"),
    "rebase": ("-s", "--strategy", "-X", "--strategy-option", "--onto",
               "-x", "--exec", "--whitespace"),
    "push": ("-o", "--push-option", "--receive-pack", "--exec", "--repo"),
    "pull": ("-s", "--strategy", "-X", "--strategy-option", "-m", "--message",
             "--upload-pack"),
    "fetch": ("--upload-pack", "--depth", "--deepen", "--shallow-since",
              "--shallow-exclude", "--negotiation-tip", "-j", "--jobs",
              "--refmap", "-o", "--server-option"),
    "branch": ("-u", "--set-upstream-to", "--points-at", "--format", "--sort"),
    "checkout": ("--conflict", "--pathspec-from-file"),
    "switch": ("--conflict",),
    "reset": ("--pathspec-from-file",),
    "cherry-pick": ("-s", "--strategy", "-X", "--strategy-option",
                    "-m", "--mainline"),
    "revert": ("-s", "--strategy", "-X", "--strategy-option",
               "-m", "--mainline"),
    "am": ("--patch-format", "--exclude", "--include", "--directory",
           "-p", "--whitespace"),
    "update-ref": ("-m",),
    "worktree": ("--reason", "-b", "-B"),
}


def positionals(rest, verb=""):
    """The arguments of a git subcommand that are neither switches nor the value
    of one."""
    out, skip = [], False
    for arg in rest:
        if skip:
            skip = False
            continue
        if arg.startswith("-"):
            skip = "=" not in arg and arg in TAKES_ARG.get(verb, ())
            continue
        out.append(arg)
    return out


def passive(verb, rest):
    """Whether this command only finishes or abandons a fold already under way.

    Asked of the switches alone. The word after `-m` is a message, and a message
    that happens to read like one of these would otherwise stand the whole
    command down: `git commit -m --abort` commits, on whatever line it stands on.
    """
    skip = False
    for arg in rest:
        if skip:
            skip = False
            continue
        if not arg.startswith("-"):
            continue
        if arg in PASSIVE:
            return True
        skip = "=" not in arg and arg in TAKES_ARG.get(verb, ())
    return False


def previous(where):
    """The line stood on before this one, or None when there is not one."""
    try:
        run = subprocess.run(["git", "rev-parse", "--abbrev-ref", "@{-1}"],
                             cwd=where, capture_output=True, text=True,
                             timeout=GIT_TIMEOUT)
    except Exception:
        return None
    name = (run.stdout or "").strip()
    return None if run.returncode or not name or name == "HEAD" else name


# How a move names the line it was standing on before. It reads as a switch and
# would be dropped as one, which fails open — the commit behind it then lands on
# a line nobody looked at.
BACK = ("-", "@{-1}")


def moved_to(verb, rest, where):
    """The line a move lands on, or None when it is not a move at all."""
    if any(a in NOT_A_MOVE for a in rest):
        return None
    if any(a in BACK for a in rest):
        return previous(where)
    args = positionals(rest, verb)
    if not args:
        return None
    fresh = any(a in MAKES for a in rest)
    # A line being made does not exist to be verified; one being stepped onto
    # does, and a name that is no line at all is a file.
    return args[0] if fresh else steps_onto(args[0], where)


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
    args = positionals(rest, "push")
    refs = args[1:] if args else []
    if not refs:
        return [here] if here else []
    return [line_named(r.split(":")[-1], here) for r in refs]


def pull_targets(rest, here):
    """Whether a pull puts anything new onto the line being stood on.

    Bringing the same line down from the remote is staying current: it takes
    other people's work into this checkout and sends nothing of the agent's
    anywhere anyone else can see. Bringing a DIFFERENT line down folds that work
    into the one being stood on, which is landing it by another word.
    """
    args = positionals(rest, "pull")
    came = [line_named(a, here) for a in args[1:]] if len(args) > 1 else []
    if not came or all(name == here for name in came):
        return []
    return [here] if here else []


def fetch_targets(rest, here):
    """The local lines a fetch writes to.

    A refspec's right-hand side is a local ref, so a fetch moves a line without
    ever standing on it and without a fold — the same quiet write as pointing a
    line at a commit. Bringing a line down onto the line of the SAME name is
    staying current and puts nothing of the agent's anywhere; bringing a
    different one down onto it is landing that work by another word.
    """
    out = []
    for ref in positionals(rest, "fetch")[1:]:
        if ":" not in ref:
            continue
        came, _, onto = ref.partition(":")
        if line_named(came, here) != line_named(onto, here):
            out.append(line_named(onto, here))
    return out


def branch_targets(rest, here):
    """The lines a `git branch` writes to, empty when it only lists or makes one.

    Each form writes somewhere different: a forced one points its first name at a
    commit, a rename lands on the new name, a delete takes every name it is given.
    """
    args = positionals(rest, "branch")
    if not args:
        return []
    if any(a in BRANCH_DELETES for a in rest):
        return [line_named(a, here) for a in args]
    if any(a in BRANCH_COPIES for a in rest):
        # A copy writes to the name it lands on and never to the one it reads
        # from. Given one name, the source is the line being stood on. Asked
        # before the force switch, which the long-hand form carries as well.
        return [line_named(args[-1], here)]
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
    args = positionals(rest, "reset")
    if not args:
        # `git reset --hard` alone throws the working tree away and moves nothing.
        return []
    if any(os.path.exists(os.path.join(where, a)) for a in args):
        return []
    if all(a in HERE_NAMES for a in args):
        # Naming the position you stand at moves the line nowhere. This throws
        # the working tree away, which is the agent's own to throw away, and
        # refusing it says the opposite of what it does.
        return []
    if len(args) > 1 and not any(a in RESET_MODES for a in rest):
        return []
    return [here] if here else []


def remade_by(verb, rest, where):
    """The line a move also resets, for the form that steps onto it by force.

    `checkout -B x` and `switch -C x` step onto x and point it at where you were
    standing, so a protected line is rewritten with no verb of the usual list
    appearing anywhere on the command.
    """
    if not any(a in REMAKES for a in rest):
        return []
    args = positionals(rest, verb)
    return [args[0]] if args and is_branch(args[0], where) else []


def added_tree(rest, where):
    """The second checkout a `worktree add` makes, and the line it will stand on.

    Named right here, which is the only place it can be read: the directory does
    not exist until the command runs. With no line named, git makes one called
    after the directory.
    """
    args = positionals(rest[1:], "worktree")
    if not args:
        return None
    path = under(where, args[0])
    fresh = next((rest[i + 1] for i, a in enumerate(rest)
                  if a in ("-b", "-B") and i + 1 < len(rest)), "")
    return path, (fresh or (args[1] if len(args) > 1
                            else os.path.basename(path.rstrip("/"))))


def rebase_target(rest):
    """The line a rebase rewrites when it names one, else "" for the one stood on.

    `[--onto <newbase>] <upstream> [<branch>]`. The new base is a switch's value
    and so is not one of these, which makes the branch the second argument in
    both forms; a rebase naming only the upstream rewrites whatever is stood on.
    """
    args = positionals(rest, "rebase")
    return args[1] if len(args) >= 2 else ""


def written_by(verb, rest, here, where):
    """The lines this command writes to, given the line it is run from.

    Empty means it writes to nothing anyone is protecting — which is the answer
    for every way of staying current with a protected line, and for resolving the
    conflicts that come with it.
    """
    if verb == "push":
        return push_targets(rest, here)
    if verb == "pull":
        return pull_targets(rest, here)
    if verb == "fetch":
        return fetch_targets(rest, here)
    if verb == "branch":
        return branch_targets(rest, here)
    if verb == "reset":
        return reset_targets(rest, here, where)
    if verb == "update-ref":
        if "--stdin" in rest:
            # The batch form carries every line it writes to in its own input,
            # so the command names none of them.
            return [UNREADABLE]
        args = positionals(rest, verb)
        return [line_named(args[0], here)] if args else []
    if verb == "rebase":
        named = rebase_target(rest)
        return [named] if named else ([here] if here else [])
    return [here] if here else []


def names_its_target(verb, rest):
    """Whether this command reads the line it writes to out of its own arguments.

    Everything else writes to whatever is being stood on, where a value the shell
    works out cannot change the answer. Three are in-between, and each is asked
    about the argument that actually decides: a fetch names a line only when it
    carries a refspec, a branch command only in the forms that write, and a
    rebase only when the line it rewrites is the one that was worked out —
    rebasing your own line onto a base worked out on the spot is the everyday
    command the design says must always be allowed.
    """
    if verb == "fetch":
        return any(":" in a for a in positionals(rest, "fetch")[1:])
    if verb == "branch":
        return any(a in BRANCH_WRITES for a in rest)
    if verb == "rebase":
        return unknowable(rebase_target(rest) or "")
    return verb in NAMED_TARGET


# The `gh api` switches that swallow the word after them, so a value is never
# read as the path being called; and the ones that make the call a write with no
# method typed at all, because the forge posts as soon as it is given a field to
# send. A call that only reads answers "is it merged"; one that writes merges it.
GH_TAKES_VALUE = ("--method", "-X", "--field", "-F", "--raw-field", "-f",
                  "--header", "-H", "--hostname", "--input", "--jq", "-q",
                  "--template", "-t", "--cache", "--preview", "-p")
GH_SENDS = ("--field", "-F", "--raw-field", "-f", "--input")
GH_READS = ("", "GET", "HEAD")


def api_call(rest):
    """The method, the path and the field values a raw forge call carries.

    The path is the first word that is neither a switch nor a switch's value. The
    fields matter because one path — the site's single query endpoint — takes the
    instruction itself as a field value and says nothing in the path at all.
    """
    method, path, sends, i, fields = "", "", False, 0, []
    while i < len(rest):
        arg = rest[i]
        if arg.startswith("-"):
            name, eq, value = arg.partition("=")
            if not eq and name in GH_TAKES_VALUE and i + 1 < len(rest):
                value, i = rest[i + 1], i + 1
            if name in ("--method", "-X"):
                method = value
            elif name.startswith("-X") and len(name) > 2:
                method = name[2:]
            if name in GH_SENDS:
                sends = True
                fields.append(value)
        elif not path:
            path = arg
        i += 1
    return (method or ("POST" if sends else "")).upper(), path, fields


# What a written instruction to the query endpoint says when it changes something
# rather than merely asking. The path says nothing at all there.
MUTATION = "mutation"


def writes_a_line(path, fields=()):
    """Whether a forge call is one that puts work onto a line.

    Five of them are, and every one is another way to the same place: the call
    that lands a waiting piece of work, the one that folds a line into another
    with no waiting piece at all, the one that points a named line at any commit,
    the one that writes a file straight onto a named line, and the single query
    endpoint — which carries the instruction as a field and spells nothing in its
    path, so it is the fields that are read there.
    """
    parts = path.split("?")[0].strip("/").split("/")
    if len(parts) >= 3 and parts[-1] == "merge" and parts[-3] == "pulls":
        return True
    if parts and parts[-1] == "merges":
        return True
    if "contents" in parts:
        return True
    if parts and parts[-1] == "graphql":
        return any(MUTATION in (value or "") for value in fields)
    return "git" in parts and "refs" in parts


def forge_merge(argv):
    """Whether this forge command lands a waiting piece of work.

    Two spellings reach the same line: the subcommand everyone types, and the raw
    call it is built on. Refusing only the first hands an agent turned away from
    it a second route to the same place.
    """
    if not argv or os.path.basename(argv[0]) != "gh":
        return False
    if argv[1:3] == ["pr", "merge"]:
        return True
    if argv[1:2] != ["api"]:
        return False
    method, path, fields = api_call(argv[2:])
    return writes_a_line(path, fields) and method not in GH_READS


def common_dir(where):
    """The one git directory a checkout and all of its worktrees share, or None.

    None for a directory that is no repository at all — including one that does
    not exist, which is most of what this is asked about.
    """
    try:
        run = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=where,
                             capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except Exception:
        return None
    out = (run.stdout or "").strip()
    if run.returncode or not out:
        return None
    return os.path.realpath(out if os.path.isabs(out) else os.path.join(where, out))


def nested_repository(where, root):
    """Whether this is a repository CHECKED OUT INSIDE the project the declaration
    was walked up to, rather than that project itself.

    A worktree of a project IS the project — it is where all the work is done —
    and a vendored dependency, a submodule or a nested clone is not, though both
    are a directory under the project root and the walk up finds the same
    declaration for either. The one git directory a checkout shares with its own
    worktrees tells them apart.

    Answered only when both are readable. A path that is no repository has no line
    to write to, and treating it as somebody else's would refuse commands that
    write nowhere.
    """
    mine, theirs = common_dir(where), common_dir(root)
    return bool(mine and theirs and mine != theirs)


def repo_named(argv):
    """The forge repository this command acts on, as owner/name, or "" for none.

    The everyday spelling names it with a switch, the raw call carries it in the
    path — and either way it may be a repository this checkout is not. The query
    endpoint names none: it carries a piece of work by an id that means nothing
    here, so the answer is UNREADABLE, which is a repository this checkout is
    not whatever this checkout is.
    """
    if argv[1:3] == ["pr", "merge"]:
        rest = argv[3:]
        for i, arg in enumerate(rest):
            name, eq, value = arg.partition("=")
            if name in ("-R", "--repo"):
                if not eq and i + 1 < len(rest):
                    value = rest[i + 1]
                return value
        return ""
    parts = api_call(argv[2:])[1].split("?")[0].strip("/").split("/")
    if parts and parts[-1] == "graphql":
        return UNREADABLE
    if "repos" in parts:
        at = parts.index("repos")
        if len(parts) > at + 2:
            return "/".join(parts[at + 1:at + 3])
    return ""


def repo_here(where):
    """The forge repository this checkout sends to, as owner/name, or ""."""
    try:
        run = subprocess.run(["git", "remote", "get-url", "origin"], cwd=where,
                             capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except Exception:
        return ""
    url = (run.stdout or "").strip()
    if not url:
        return ""
    url = url.split("//")[-1].split(":")[-1]
    if url.endswith(".git"):
        url = url[:-4]
    parts = url.strip("/").split("/")
    return "/".join(parts[-2:]) if len(parts) >= 2 else ""


def protected_by(where):
    """The lines the project holding this directory says an agent may not write to."""
    try:
        if nested_repository(where, project.root(where)):
            # Somebody else's repository, sitting inside one of ours. It has said
            # nothing about itself, and a permission it never gave is not its own.
            return frozenset(project.DEFAULT_PROTECTED)
        return project.of(where).protected
    except Exception:
        # A declaration that cannot be read is not permission. The default set is
        # what an undeclared project gets, and this is less known than that.
        return frozenset(project.DEFAULT_PROTECTED)


def routes(cmd, home):
    """Every write this command makes, as (verb, checkout, line, arguments), in
    running order.

    Walked command by command because one may step onto a line, or into a checkout,
    before it writes: stepping onto what a team ships from and folding into it is a
    single line of shell, and so is changing into somebody else's checkout and
    pushing it. Reading only where the shell started lets both straight through.
    """
    at, made, cwd, been, standing = {}, [], home, [], {}
    todo, read, scope = bc.split(cmd), 0, []
    if bc.piped_into_shell(cmd):
        # A shell handed its commands by a pipe runs a line nobody here can read.
        made.append(("read", home, UNREADABLE, []))

    def line_of(where):
        # Remembered against the checkout, never the directory: a subdirectory of
        # the same checkout stands on the same line, and looking it up under its
        # own name misses and asks git — which answers with the line that was
        # being stood on before the command moved.
        tree = tree_of(where)
        if tree not in at:
            # A directory that is no checkout — most often one this very line is
            # about to make — has a line nobody here can name, and reading that
            # as "writes to nothing" lets everything aimed at it straight past.
            at[tree] = standing_on(where) or (
                None if common_dir(where) else UNREADABLE)
        return at[tree]

    def stand(where, line):
        at[tree_of(where)] = line

    while todo and read < READ_CAP:
        (sep, seg), todo, read = todo[0], todo[1:], read + 1
        if sep == "(":
            # A subshell has a directory of its own, and what it changes there
            # does not outlive the brackets.
            scope.append((cwd, been, dict(standing)))
        elif sep == ")" and scope:
            cwd, been, standing = scope.pop()
        if not seg:
            continue
        # What a substitution holds runs too, wherever on the line it stands.
        todo = [("", inside) for inside in bc.grown_in(seg)] + todo
        put, argv = bc.plain(bc.words(seg))
        if argv[:1] == ["export"]:
            for word in argv[1:]:
                name, eq, value = word.partition("=")
                if eq:
                    put[name] = value
            argv = []
        if not argv and put:
            # A setting made on a command of its own stands for every command
            # after it on the line, and two of them aim git at another checkout.
            standing.update(put)
            continue
        put = dict(standing, **put)
        script = bc.handed_on(argv)
        if script is not None:
            # What a shell is handed is a command line, and is read as one.
            todo = bc.split(script) + todo
            continue
        if argv[:1] in (["cd"], ["pushd"], ["popd"]):
            # Changing into a checkout is the ordinary spelling of the reach that
            # `-C` spells as a switch, and every spelling of it must answer alike
            # — including the two that keep a stack, and the one that separates
            # the path with a double dash.
            named = [a for a in argv[1:] if a != "--"]
            if argv[0] == "popd":
                cwd = been[-1] if been else home
                been = been[:-1]
            else:
                if argv[0] == "pushd":
                    been = been + [cwd]
                cwd = under(cwd, named[0]) if named else home
            continue
        if forge_merge(argv):
            made.append(("gh", cwd, argv, argv))
            continue
        call = git_call(argv, cwd)
        if not call:
            continue

        for name, resolve in POINTERS:
            if put.get(name):
                call = (resolve(under(cwd, put[name])),) + call[1:]
                break
        where, verb, rest = call
        if passive(verb, rest):
            continue
        if verb == "worktree" and rest[:1] == ["add"]:
            # The second checkout does not exist until this runs, so asking git
            # there answers nothing — but the line it will stand on is named
            # right here, and what is committed in it next belongs to that line.
            made_tree = added_tree(rest, where)
            if made_tree:
                stand(made_tree[0], made_tree[1])
            continue
        if verb == "symbolic-ref":
            # Repointing the position by hand is stepping onto a line, spelled
            # without either of the words that usually say so.
            args = positionals(rest, verb)
            if len(args) > 1 and args[0] in HERE_NAMES:
                stand(where, line_named(args[1], line_of(where)))
            continue
        if verb in MOVE:
            if unknowable(seg):
                # A forced step does not only move: it points the line it lands
                # on at where you were standing. So a name nothing here can read
                # is an unreadable WRITE, not merely an unreadable position —
                # skipping the rest of the command hands back the same rewrite
                # the spelled-out form is refused for.
                if any(a in REMAKES for a in rest):
                    made.append((verb, where, UNREADABLE, rest))
                stand(where, UNREADABLE)
                continue
            made += [(verb, where, line, rest)
                     for line in remade_by(verb, rest, where)]
            stand(where, moved_to(verb, rest, where) or line_of(where))
        elif verb in WRITERS:
            if names_its_target(verb, rest) and (unknowable(seg) or bc.fed(seg)):
                # A name the shell works out as it runs is a name nothing here can
                # read. It is refused for being unreadable, not for being every
                # line — the two want different things said back.
                made.append((verb, where, UNREADABLE, rest))
            else:
                made += [(verb, where, line, rest)
                         for line in written_by(verb, rest, line_of(where), where)]
    if todo:
        # The tail of the line is where the refusal would have been.
        made.append(("read", cwd, UNENDING, []))
    return made


def main():
    data = json.load(sys.stdin)
    cmd = bc.said(data)
    home = bc.where(data)
    made = routes(cmd, home)
    if not made:
        return

    for verb, where, line, _ in made:
        guarded = protected_by(where)
        if verb == "gh":
            # Which line a waiting piece of work would land on is the forge's
            # answer, not this machine's, and asking costs a network call on every
            # command. A project that protects anything protects this.
            named = repo_named(line)
            if named and named.lower() != repo_here(where).lower():
                # A repository this checkout is not. Nothing here declares for
                # it, and the permission belongs to what is being written to —
                # which is the whole of what this change moved.
                guarded = frozenset(project.DEFAULT_PROTECTED)
            if guarded:
                deny(refusal("The line a waiting piece of work lands on", "it", where))
                return
        elif line == UNREADABLE:
            if guarded:
                deny(UNREAD)
                return
        elif line == UNENDING:
            if guarded:
                deny(TOO_MANY % READ_CAP)
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
    folds = [(verb, rest) for verb, where, line, rest in made
             if verb in ("merge", "rebase") and line == lands_on
             and bc.board_root(where) == root]
    if not folds:
        return
    # Asked of the fold being judged and never of the whole line: a fast-forward
    # switch on one command says nothing about the next one, and both of them land
    # on the line every close here is measured against.
    if any(verb == "merge" and FF_ONLY not in rest for verb, rest in folds):
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
