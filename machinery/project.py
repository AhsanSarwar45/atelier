#!/usr/bin/env python3
"""Which registered project a path belongs to, and what it answers about itself.

Project metadata is machine-local Atelier data beside the registry. Nothing is
written into a repository merely to let Atelier or an agent recognise it.

The board of the CHECKOUT THE WORK LANDS IN is what a gate judges against, never
the directory a session was started from. A commit made in one project while the
session's home is another is a commit in the first, and asking `CLAUDE_PROJECT_DIR`
answers with the second (cor-up1g).

A worktree is a checkout of the same project, so the walk starts at git's own
answer for where the repository really is. External registration then maps every
linked worktree back to the one shared project and board.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tomllib

HOME = os.path.dirname(os.path.realpath(__file__))


def atelier_data_dir():
    """The same personal data home the Atelier application uses."""
    override = (os.environ.get("ATELIER_DATA_DIR") or "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/com.weselow.atelier")
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~/AppData/Roaming")
        return os.path.join(base, "weselow", "atelier", "data")
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "atelier")


# Registration and inferred declarations are personal Atelier data, never files
# inside a project checkout or inside the installed rules bundle.
REGISTRY = os.path.join(atelier_data_dir(), "projects.toml")
LEGACY_REGISTRY = os.path.join(HOME, "projects.toml")
# The branch a project calls main when its declaration does not say.
DEFAULT_LANDS_ON = "main"
# The lines an agent may not write to in a project that has said nothing about
# itself. A checkout nobody has declared is the one most likely to be somebody
# else's, so silence means protected. Manager's ruling, 2026-08-16.
DEFAULT_PROTECTED = ("main", "master", "staging", "production", "release")
GIT_TIMEOUT = 10
BD_TIMEOUT = 30

# The two board states this machinery invented, named here because every tool and
# every gate that moves a card between them reads this file already.
#
# bd ships open, in_progress, blocked, deferred, closed, pinned and hooked, and
# refuses a move into any word it was not told about. So these are not free: a
# board is told about them once, by `machinery/join`, and a board that was never
# told refuses the whole review half of the run — one card at a time, and the
# refusal is swallowed by whatever asked for the move. `join --check` says which
# boards are missing them.
AGENT_REVIEW = "in_review"          # waiting on a reader who did not write it
MANAGER_REVIEW = "manager_review"   # waiting on the manager's own signature
REVIEW_STATES = (AGENT_REVIEW, MANAGER_REVIEW)
CUSTOM_KEY = "status.custom"        # where a board keeps the states it was told about

_ROOTS, _DECLS = {}, {}


def _git(args, cwd):
    try:
        run = subprocess.run(["git"] + args, cwd=cwd, capture_output=True,
                             text=True, timeout=GIT_TIMEOUT)
        return run.stdout.strip() if run.returncode == 0 else ""
    except Exception:
        return ""


def custom_states(root):
    """The card states this board was told about, beyond the ones bd ships with.

    Asked as JSON: what bd prints for a board that has none is the sentence
    "status.custom (not set)", and read as a list that is a state of that name.
    """
    try:
        run = subprocess.run(["bd", "config", "get", CUSTOM_KEY, "--json"],
                             cwd=root, capture_output=True, text=True,
                             timeout=BD_TIMEOUT)
        said = json.loads(run.stdout).get("value") if run.returncode == 0 else ""
    except Exception:
        return []
    return [w for w in (part.strip() for part in (said or "").split(",")) if w]


def untold(root):
    """The review states this board was never told about, so it refuses them."""
    return [s for s in REVIEW_STATES if s not in custom_states(root)]


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


def working_tree(path):
    """The particular checkout containing `path`, including a linked worktree."""
    here = (path or os.getcwd()).rstrip("/")
    if not os.path.isdir(here):
        here = os.path.dirname(here) or "/"
    return _git(["rev-parse", "--show-toplevel"], here) or here


def git_identity(path):
    """Stable identity shared by a Git repository and all of its worktrees."""
    common = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path)
    return os.path.realpath(common) if common else ""


def registered_root(path):
    """Registered main checkout containing path, including linked worktrees."""
    here = os.path.realpath(path)
    identity = git_identity(here)
    for known in registry().values():
        if os.path.realpath(known) == here:
            return known
        if identity and git_identity(known) == identity:
            return known
    return ""


def declaration_path(path):
    """Personal manifest path for one registered Git identity."""
    key = git_identity(path) or os.path.realpath(path)
    digest = hashlib.sha256(key.encode()).hexdigest()
    return os.path.join(os.path.dirname(REGISTRY), "projects", digest, "project.toml")


def repository_declaration_path(path):
    return os.path.join(working_tree(path), ".atelier", "project.toml")


def old_external_declaration_path(path):
    """The one-time migration source used by installations predating schema 1."""
    key = git_identity(path) or os.path.realpath(path)
    digest = hashlib.sha256(key.encode()).hexdigest()
    return os.path.join(os.path.dirname(REGISTRY), "projects", digest + ".toml")


def legacy_declaration_path(path):
    """The repository-local declaration used before personal metadata."""
    return os.path.join(working_tree(path), "machinery.toml")


def root(path=None):
    """The registered main checkout for path, or Git's checkout when unjoined."""
    here = os.path.abspath(path or os.getcwd())
    if here in _ROOTS:
        return _ROOTS[here]
    tree = checkout(here)
    found = registered_root(tree) or tree
    _ROOTS[here] = found
    return found


class Declaration:
    """What one project answers. Every field has an answer for a project that
    declared nothing, so an unjoined checkout still runs rather than crashing."""

    def __init__(self, path, data):
        self.path = path
        shaped = data.get("project") or {}
        git = data.get("git") or {}
        beads = data.get("beads") or {}
        verify = data.get("verification") or {}
        review = data.get("review") or {}
        cross = data.get("cross_project") or {}
        modern = bool(shaped) or data.get("schema_version") == 1
        self.name = (shaped.get("display_name") if modern else data.get("name")) \
            or os.path.basename(path.rstrip("/"))
        self.use_beads = bool(shaped.get("use_beads")) if modern else True
        self.summary = shaped.get("summary") or ""
        self.prefix = (beads.get("issue_id_prefix") if modern else data.get("prefix")) or ""
        # A pre-external-metadata project still has an authoritative landing
        # checkout: use the branch currently checked out in its main tree.
        self.lands_on = (git.get("completed_work_branch") if modern else data.get("lands_on")) or \
            _git(["branch", "--show-current"], path) or DEFAULT_LANDS_ON
        self.areas = list((beads.get("work_areas") if modern else data.get("areas")) or [])
        self.places = list(data.get("places") or []) if not modern else []
        self.brand = (data.get("brand") or self.name).upper().replace("-", "_").replace(" ", "_")
        self.lands_elsewhere = list((cross.get("delivery_projects") if modern else data.get("lands_elsewhere")) or [])
        # Where this project's own quality-rule modules live, relative to its
        # root. Empty means `quality.py` runs with the shared measures only.
        self.rules = data.get("rules") or ""
        # The one command this project's own checks step runs: its tests, its
        # compile gate, whatever it holds a change to. Asked for once a job, in
        # front of the reader, so nothing here is paid per edit or per commit.
        # A project that declares none still runs the step; its note says what
        # was run by hand instead.
        commands = verify.get("commands") or []
        self.checks = (" && ".join(row.get("command", "") for row in commands
                                   if row.get("command")) if modern else data.get("checks")) or ""
        # Whether an agent may put work onto this project's shipping lines itself.
        # False everywhere it is not said, so a checkout that has never been
        # thought about is protected rather than open.
        self.agent_merges = bool(git.get("agents_may_merge_completed_work")) \
            if modern else bool(data.get("agent_merges"))
        # A project whose shipping lines are not called the usual things says so
        # here. Absent is not the same as empty: absent takes the default set,
        # empty would mean nothing is protected, which is what `agent_merges` is
        # for.
        self.data_protected = git.get("protected_branches") if modern else data.get("protected")
        self.persona = self.summary or review.get("persona") or self.name
        self.proves = review.get("evidence_requirements") or review.get("proves") or ""
        self.external_review = review.get("external_review") or "agent_decides"
        self.visual_proof = bool(verify.get("visual_proof_for_ui_changes"))
        self.development = data.get("development") or {}
        self.deployment = data.get("deployment") or {}
        self.declared = bool(data)

    @property
    def protected(self):
        """The lines an agent may not write to here, empty when it may.

        A project that names them is taken at its word. A team whose agents land
        on a line of their own, and whose manager alone moves that into what
        ships, has to be able to say so — and cannot if `lands_on` is added to
        whatever it names, because a card only closes once its change reaches
        `lands_on`. Silence adds it, so a project shipping from a line of its own
        name is covered without naming it twice.
        """
        if self.data_protected is not None:
            return frozenset(self.data_protected)
        return frozenset(DEFAULT_PROTECTED) | {self.lands_on}

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
    repository = repository_declaration_path(path or where)
    personal = declaration_path(where)
    source = repository if os.path.isfile(repository) else personal
    data = _read(source)
    declared_at = where
    key = ("external", where)
    if not data:
        # One-time upgrade sources. Runtime behavior is immediately projected
        # into the schema-1 Declaration above; writers publish only schema 1.
        declared_at = working_tree(path)
        key = ("legacy", os.path.realpath(declared_at))
        data = _read(old_external_declaration_path(where)) or \
            _read(legacy_declaration_path(declared_at))
    if key not in _DECLS:
        _DECLS[key] = Declaration(declared_at, data)
    return _DECLS[key]


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
    source = REGISTRY if os.path.exists(REGISTRY) else LEGACY_REGISTRY
    rows = (_read(source).get("projects") or {})
    return {name: os.path.expanduser(path) for name, path in rows.items()
            if os.path.exists(os.path.expanduser(path))}


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
