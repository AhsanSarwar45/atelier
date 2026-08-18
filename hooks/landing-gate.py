#!/usr/bin/env python3
"""reference-transaction — the landing line moves the way a landing moves it.

The session gates read a command before it runs, and they only see the commands
a session types into its own Bash tool. This one sits inside the shared checkout
and reads the ref write itself, so it answers the same question one layer lower:
whatever typed it, whatever tool ran it, does this move of the landing line look
like a landing?

Only `refs/heads/<lands_on>` is guarded, and nothing else here is touched — above
all `refs/dolt/data`, which the board itself syncs and which would take the whole
board down with it. Anything this cannot work out about another ref is allowed:
a guard that refuses what it does not understand, in a hook that runs on EVERY
ref write in the repository, is a repository nobody can use.

What each shape of move gets, worked out by watching git rather than by reading
the manual (bw-7e8.5):

  a symbolic ref written onto the line        refused outright
  a force update — git reports the old value  refused outright, and refused too
    as all-zeroes when the caller did not       where the line would not have
    ask it to check the current one, which      moved, because a write made
    is `update-ref`, `branch -f` and a          without looking is a hand write
    forced push or fetch                        whatever it names
  the line standing still, written by         allowed; `git stash` writes one of
    something that did ask what it held          these on every stash
  one new commit on top of the old tip,       allowed; this is the manager
    carried by no other ref                     committing in the shared checkout
  anything else that moves the line           allowed only while the merge slot
    — a fold, a rebase, a reset                 is held

The carve-out for an ordinary commit is the same one the session gate makes: the
slot exists so two sessions never resolve conflicts in the same tree at once, and
a commit resolves nothing with anybody. It is recognised by its shape rather than
by the verb, because a hook is told the move and never the command: a commit made
here has exactly one parent, that parent is the tip the line is being moved off,
and no other line in the repository carries it yet. A fold never looks like that
— it lands the tip of a branch, which is a branch that exists.

A person can stand this guard down deliberately by setting MACHINERY_LANDING_OPEN
(or <BRAND>_LANDING_OPEN, for a project that declared a brand) to anything at
all. That reopens nothing for an agent: the session gate refuses an agent the raw
spellings before they ever reach a ref, and an agent that sets the switch is an
agent that has said out loud what it is doing.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
import project  # noqa: E402

# A hook is handed git's own pointers in its environment, and everything below
# asks git and the board questions of ITS own, in the project root — so the
# pointers go first. Left in place they answer about whatever the transaction is
# pointing at, which during a push is a git directory and not the project at all:
# with GIT_DIR still set, reading the landing line from the project root fails,
# the guard reads that as a line that does not exist yet, and every push walks
# past it (watched happening — bw-7e8.5).
#
# The quarantine goes with them, and that one is deliberate rather than tidy: the
# objects a push is offering are not objects this repository has, and a push must
# never be able to look like a commit made here.
for _pointed in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
                 "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                 "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES",
                 "GIT_QUARANTINE_PATH"):
    os.environ.pop(_pointed, None)

GIT_TIMEOUT = 10
# The board is asked one short question and the answer decides a landing, so a
# board too busy to answer is a refusal rather than a wait.
BD_TIMEOUT = 20

# What git writes where an object name would go when the ref is being created, or
# when the caller asked for the write to happen whatever the ref currently holds.
# Read as "all zeroes" rather than as a literal, so a repository hashing with
# sha256 answers the same.
def zeroes(value):
    return bool(value) and set(value) == {"0"}


# How git spells a symbolic ref in the transaction it hands the hook.
SYMBOLIC = "ref:"

BY_HAND = """The landing gate: %(ref)s is the line this project's work lands on, and this
writes to it by hand — pointing it at a commit, at another line, or wiping it.
No landing is spelled any of those ways, so it is refused whether or not the
merge slot is held.

The one road onto it: rebase your work in your own tree, take the slot with
`bd merge-slot acquire`, fast-forward the line with `git merge --ff-only <your
branch>`, and give the slot back with `bd merge-slot release`."""

NO_SLOT = """The landing gate: this moves %(ref)s, the line this project's work lands on, and
nobody is holding the merge slot. Landings are serialised through it so two
sessions never resolve conflicts in the same tree at once.

Take it with `bd merge-slot acquire` (add `--wait` to queue), fast-forward the
line with `git merge --ff-only <your branch>`, then `bd merge-slot release`."""

NO_BOARD = """The landing gate: this moves %(ref)s, the line this project's work lands on, and
the board could not say whether the merge slot is held (%(why)s). A landing is
serialised through that slot, so a move it cannot vouch for is refused rather
than waved through.

Fix the board and try again, or set %(switch)s to move the line by hand."""

STUCK = """The landing gate: this moves %(ref)s, the line this project's work lands on, and
the guard could not work out what kind of move it is (%(why)s).

It refuses what it cannot read on that one line and lets every other ref past.
Set %(switch)s to move the line by hand."""

# The one line of every refusal that names the way out, so a person who set the
# switch once does not have to go looking for its name again.
SWITCH = "LANDING_OPEN"


def git(args, cwd=None):
    """Ask git something. Empty for a question it could not answer.

    Safe to call while the transaction is only prepared: the ref is locked but
    still readable, and what comes back is the value the line held BEFORE this
    move — which is exactly what the answers below are about (bw-7e8.5).
    """
    try:
        run = subprocess.run(["git"] + args, cwd=cwd, capture_output=True,
                             text=True, timeout=GIT_TIMEOUT)
    except Exception:
        return ""
    return run.stdout.strip() if run.returncode == 0 else ""


def commit_made_here(old, new, root):
    """Whether this move is one commit written onto the tip, and nothing else.

    A commit in the shared checkout is the manager's own and waits for nobody.
    It has one parent, that parent is the tip being moved off, and no other line
    carries it — it exists only as the thing about to become the tip. A landing
    fails all three: it moves the line onto the tip of a branch, and that branch
    is a ref that already exists.
    """
    walk = git(["rev-list", "--parents", "-n", "1", new], root).split()
    if len(walk) != 2 or walk[1] != old:
        return False
    carried = git(["for-each-ref", "--contains", new, "--format=%(refname)",
                   "refs/heads", "refs/remotes", "refs/tags"], root)
    return not carried.strip()


def slot_holder(root):
    """Who holds the board's merge slot, "" for nobody — or None when the board
    could not be asked at all, which is not the same answer.

    By whether anybody holds it rather than by who: a hook is handed a ref write
    and never a session, so there is nobody here to compare a name against. The
    session gate is the layer that knows whose hold it is.
    """
    try:
        run = subprocess.run(["bd", "merge-slot", "check", "--json"], cwd=root,
                             capture_output=True, text=True, timeout=BD_TIMEOUT)
        if run.returncode != 0:
            return None
        return json.loads(run.stdout or "{}").get("holder") or ""
    except Exception:
        return None


def why_refused(old, new, ref, root):
    """What to say about one move of the landing line, or "" to let it through."""
    now = git(["rev-parse", "--verify", "--quiet", ref], root)
    if not now:
        # A line that does not exist yet is being made, and making one takes
        # nothing away from anybody.
        return ""
    if new.startswith(SYMBOLIC) or zeroes(new) or zeroes(old):
        # Three spellings of the same thing: repointing the line by hand, wiping
        # it, or writing to it without asking what it currently holds. None of
        # them is a step of any landing.
        #
        # Asked before the standing-still case below, and that order is the whole
        # of how the two are told apart. Watched rather than read off the manual:
        # git hands this hook all-zeroes for the old value when the caller never
        # asked what the line held, which is what `git update-ref` does even when
        # it names the sha already there, and it hands the real old value for
        # everything of its own — a commit, a fast-forward, a push, a stash. So a
        # hand write that would not have moved the line is still refused, and the
        # stash below is still let past (bw-7e8.5).
        return BY_HAND % {"ref": ref}
    if new == now:
        # The line standing still, written by something that asked what it held
        # first. `git stash` writes one of these on every stash, and refusing it
        # would stop the checkout being tidied at all.
        return ""
    if commit_made_here(old, new, root):
        return ""
    held = slot_holder(root)
    if held is None:
        return NO_BOARD % {"ref": ref, "why": "bd merge-slot check gave no answer",
                           "switch": switch_name(root)}
    return "" if held else NO_SLOT % {"ref": ref}


def switch_name(root):
    """What this project calls the switch that stands the guard down."""
    try:
        return project.env(project.of(root), SWITCH)[-1]
    except Exception:
        return "MACHINERY_" + SWITCH


def updates(text):
    """The moves this transaction carries, as (old, new, ref)."""
    out = []
    for said in text.splitlines():
        parts = said.split(" ", 2)
        if len(parts) == 3:
            out.append((parts[0], parts[1], parts[2].strip()))
    return out


def main():
    # Only the prepared state can refuse: git ignores what the hook says in the
    # other two, and reading a transaction that has already happened would cost
    # every ref write in the repository a python start for nothing.
    if len(sys.argv) < 2 or sys.argv[1] != "prepared":
        return 0
    said = sys.stdin.read()
    guarding = []
    try:
        moving = [m for m in updates(said) if m[2].startswith("refs/heads/")]
        if not moving:
            # Nothing here can be anybody's landing line, and this is most of
            # what the hook is handed: the board's own sync, the stash, ORIG_HEAD,
            # the scratch ref a merge keeps its half-done tree in. Answered before
            # the project is even worked out, because working that out costs a
            # question to git and this runs on every ref write in the repository.
            return 0
        root = project.root(os.getcwd())
        decl = project.of(root)
        ref = "refs/heads/" + decl.lands_on
        guarding = [m for m in moving if m[2] == ref]
        if not guarding:
            # Every other ref in the repository, `refs/dolt/data` above all.
            return 0
        if project.env_get(decl, SWITCH):
            sys.stderr.write(
                "the landing gate is standing down: %s is set\n" % switch_name(root))
            return 0
        for old, new, moved in guarding:
            why = why_refused(old, new, moved, root)
            if why:
                sys.stderr.write(why + "\n")
                return 1
        return 0
    except Exception as broke:
        if not guarding:
            # Whatever went wrong, it went wrong before this knew the landing
            # line was in the transaction — so it knows nothing about what is
            # being written and refusing would be refusing at random.
            return 0
        sys.stderr.write(STUCK % {"ref": guarding[0][2], "why": broke,
                                  "switch": "MACHINERY_" + SWITCH} + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
