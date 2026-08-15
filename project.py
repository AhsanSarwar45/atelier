#!/usr/bin/env python3
"""Which project a path belongs to, and what that project answers about itself.

Every tool and every gate here runs in more than one project, so nothing may be
written down twice: what differs by project is declared once, at the project's
own root, in `machinery.toml`. This file is the only reader of it.

The board of the CHECKOUT THE WORK LANDS IN is what a gate judges against, never
the directory a session was started from. A commit made in one project while the
session's home is another is a commit in the first, and asking `CLAUDE_PROJECT_DIR`
answers with the second (cor-up1g).

A worktree is a checkout of the same project, so the walk starts at git's own
answer for where the repository really is: `.beads` and `machinery.toml` are both
checked in, so a copy carries them and reading them there answers with a project
that has its own board and its own name.
"""
import os
import re
import subprocess
import tomllib

HOME = os.path.dirname(os.path.realpath(__file__))
# Every project that runs this machinery, by the name its own declaration gives
# it. `machinery/join` writes it; nothing else does.
REGISTRY = os.path.join(HOME, "projects.toml")
DECLARATION = "machinery.toml"
# The branch a project calls main when its declaration does not say.
DEFAULT_LANDS_ON = "main"
GIT_TIMEOUT = 10

_ROOTS, _DECLS = {}, {}


def _git(args, cwd):
    try:
        run = subprocess.run(["git"] + args, cwd=cwd, capture_output=True,
                             text=True, timeout=GIT_TIMEOUT)
        return run.stdout.strip() if run.returncode == 0 else ""
    except Exception:
        return ""


def checkout(path):
    """The main checkout of the repository holding `path`.

    git's own answer, because a worktree may sit anywhere — `worktrees/x` here,
    `.worktrees/x` in the next project — and a rule that reads the path spelling
    is a rule that stops working the day somebody cuts one somewhere else.
    """
    here = (path or os.getcwd()).rstrip("/")
    if not os.path.isdir(here):
        here = os.path.dirname(here) or "/"
    common = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"], here)
    if common:
        return os.path.dirname(common.rstrip("/")) or here
    # No git answer — the path is outside a repository, or git is not there.
    # The spelling every project here uses is the last thing left to read.
    return here.split("/worktrees/")[0].rstrip("/") or here


def root(path=None):
    """The project a path belongs to: the checkout, walked up to a declaration.

    A project that has not joined has no declaration, and the checkout itself is
    the answer — which is what every tool did before this file existed.
    """
    here = os.path.abspath(path or os.getcwd())
    if here in _ROOTS:
        return _ROOTS[here]
    tree = checkout(here)
    walk = tree
    while True:
        if os.path.exists(os.path.join(walk, DECLARATION)):
            break
        up = os.path.dirname(walk)
        if up == walk:
            walk = tree
            break
        walk = up
    _ROOTS[here] = walk
    return walk


class Declaration:
    """What one project answers. Every field has an answer for a project that
    declared nothing, so an unjoined checkout still runs rather than crashing."""

    def __init__(self, path, data):
        self.path = path
        self.name = data.get("name") or os.path.basename(path.rstrip("/"))
        self.prefix = data.get("prefix") or ""
        self.lands_on = data.get("lands_on") or DEFAULT_LANDS_ON
        self.areas = list(data.get("areas") or [])
        self.places = list(data.get("places") or [])
        self.brand = (data.get("brand") or "").upper()
        self.lands_elsewhere = list(data.get("lands_elsewhere") or [])
        # When this project's pour began asking a job why it drops a step. A job
        # poured before it was never asked and is not held to an answer; a project
        # that joined afterwards has no such jobs and leaves this empty.
        self.guard_asked_from = data.get("guard_asked_from") or ""
        review = data.get("review") or {}
        self.persona = review.get("persona") or self.name
        self.proves = review.get("proves") or ""
        self.declared = bool(data)

    @property
    def place_re(self):
        """One pattern for every extra way this project names somewhere to look.
        Never matches when the project named none — an empty alternation would
        match the empty string and call any line a place."""
        return re.compile("|".join("(?:%s)" % p for p in self.places), re.I) \
            if self.places else None


def _read(path):
    try:
        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except Exception:
        return {}


def of(path=None):
    """The declaration of the project holding `path`."""
    where = root(path)
    if where not in _DECLS:
        _DECLS[where] = Declaration(where, _read(os.path.join(where, DECLARATION)))
    return _DECLS[where]


def tool(decl, name, where="board"):
    """How a session standing in this project types one of these tools.

    A refusal that names a command an agent cannot run teaches nothing, and the
    machinery lives outside every project: a project carrying a forwarder at the
    old path is told that path, and one without is told the tool's own.
    """
    near = os.path.join("scripts", where, name)
    return near if os.path.exists(os.path.join(decl.path, near)) \
        else os.path.join(HOME, where, name)


def registry():
    """Every registered project, name to path. A path that is no longer on the
    disk is dropped: a project that moved is not a project whose commits can be
    looked for."""
    rows = (_read(REGISTRY).get("projects") or {})
    return {name: os.path.expanduser(path) for name, path in rows.items()
            if os.path.exists(os.path.expanduser(path))}


def reports_dir():
    """Where the shared report tools live, for a machine with no `report` on its
    path. One line in the machinery's own settings rather than in each project's
    declaration: the report tools are the same ones for every project."""
    said = (_read(REGISTRY).get("home") or {}).get("reports") or ""
    return os.path.expanduser(said) if said else ""


def named(name):
    """The declaration of a registered project, or None."""
    where = registry().get(name)
    return of(where) if where else None


def elsewhere(decl):
    """The checkouts a job in this project may say its change lands in, as
    {name: (path, the branch that one calls main)}.

    Read off this project's declaration and the registry together: a repository
    nobody registered is not somewhere a card's commit may hide, and one this
    project never declared is not somewhere its work goes.
    """
    known = registry()
    out = {}
    for name in decl.lands_elsewhere:
        if name in known:
            out[name] = (known[name], of(known[name]).lands_on)
    return out


def lands_here(decl):
    """Every registered project that declares its work may land in this one.

    The other direction of the same fact, and the reason a commit made in this
    checkout may carry another project's card id: the work is that project's, and
    it lands here by its own declaration.
    """
    return [name for name, path in registry().items()
            if name != decl.name and decl.name in of(path).lands_elsewhere]


def prefixes(decl):
    """Every card id prefix a commit in this checkout may name.

    This project's own, and that of any project whose work lands here.
    """
    out = [decl.prefix] + [of(registry()[n]).prefix for n in lands_here(decl)]
    return [p for p in dict.fromkeys(out) if p]


def env(decl, suffix):
    """The names one switch answers to: the machinery's own, and this project's
    branded spelling of it when it declared a brand.

    Two names rather than one because the branded spellings are already written
    into docs and into sessions that are running now, and a switch that stops
    answering to the name somebody knows is a switch nobody can find.
    """
    names = ["MACHINERY_" + suffix]
    if decl.brand:
        names.append(decl.brand + "_" + suffix)
    return names


def env_get(decl, suffix):
    """What one switch is set to, under whichever of its names is set."""
    for name in env(decl, suffix):
        value = os.environ.get(name)
        if value:
            return value
    return ""
