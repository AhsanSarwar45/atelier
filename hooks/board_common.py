#!/usr/bin/env python3
"""Per-session bookkeeping and board queries shared by the board hooks.

State is machine-local, never in the repo: the working tree is shared by every
session and worktree, so session bookkeeping written there would collide.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
import project  # noqa: E402

STATE_DIR = os.path.join(
    os.environ.get("CLAUDE_CODE_TMPDIR") or "/tmp", "board-sessions"
)
BD_TIMEOUT = 20  # seconds; a hook must never outlive a hung board

# Edits here are not project work and never demand a card.
IGNORED = ("/.beads/", "/scratchpad/", "/.git/", "/node_modules/", "/target/")


def board_root(cwd):
    """The project whose board answers for work done here.

    The checkout the work lands in, never the directory the session was started
    from: a commit made in one project by a session whose home is another belongs
    to the first, and `CLAUDE_PROJECT_DIR` answers with the second (cor-up1g).
    """
    return project.root(cwd)


def _brands():
    """Every name a switch of this machinery may be spelled with.

    The machinery's own, plus the brand each registered project declared. Read
    from the declarations so the list cannot drift from what a project calls
    itself, and cached: this stands in front of every tool call.
    """
    if not hasattr(_brands, "seen"):
        found = ["MACHINERY"]
        for path in project.registry().values():
            brand = project.of(path).brand
            if brand and brand not in found:
                found.append(brand)
        _brands.seen = found
    return _brands.seen


def switch(suffix):
    """What one of this machinery's switches is set to, under any of its names."""
    for brand in _brands():
        value = os.environ.get(brand + "_" + suffix)
        if value:
            return value
    return ""


def reviewing():
    """The review step a headless reviewer was fired at, if this is one.

    A reviewer is not a session doing work: it holds no card, changes no file,
    and must not be told whose cards are open — every board hook stands aside
    for it. `board/review` sets this.
    """
    return switch("REVIEWER")


# Where a job waits for the manager's own signature. A custom board status rather
# than a label, because a label can be taken off by whoever put it on.
MANAGER_REVIEW = "manager_review"

# What a goal wears to say its change lands somewhere else.
LANDS = "lands:"


def elsewhere(root):
    """The repositories a job here may say its change lands in, by the name it
    declares and the branch each one calls main.

    Two answers at once, and both are needed: the project's own declaration says
    where its work may go, and the registry says whether that project is on this
    machine. A repository nobody registered is not somewhere a card's commit may
    hide, and one this project never declared is not somewhere its work goes.
    """
    return project.elsewhere(project.of(root))


def declared(cid, root):
    """The other repositories the job owning this card says its change lands in.

    Read off the goal, so it is the job that declares it and not the card: a
    global list would let any card on the board close on the strength of a commit
    in a repository its job never touched.
    """
    goal = (cid or "").split(".")[0]
    if not goal:
        return []
    ok, out = bd(["show", goal, "--json"], root)
    if not ok:
        return []
    try:
        card = json.loads(out or "{}")
        card = card[0] if isinstance(card, list) else card
    except Exception:
        return []
    return [l[len(LANDS):] for l in card.get("labels") or [] if l.startswith(LANDS)]


def here(name, root):
    """Whether a declared repository is on this machine. `.git` is a file in a
    checkout that is itself a worktree, so its kind is not asked."""
    path = (elsewhere(root).get(name) or (None,))[0]
    return bool(path) and os.path.exists(os.path.join(path, ".git"))


def landings(root, cid=None):
    """Every (repository, main branch) this card's commit may have reached.

    This checkout always, on whatever branch this project calls main; one its job
    declared, when that one is on this machine. A card whose job declares nothing
    is judged here alone.
    """
    known = elsewhere(root)
    return [(root, project.of(root).lands_on)] \
        + [known[n] for n in declared(cid, root) if n in known]


def unreachable(cid, root):
    """Declared repositories this machine cannot answer for.

    Named rather than skipped: a card whose only proof is there would otherwise be
    refused as never landed, which is a different thing and sends the reader to
    look for a commit that exists.
    """
    return [n for n in declared(cid, root) if not here(n, root)]


def actor(session_id, cwd):
    """Board identity of one session: where it works, which session it is.

    A claim is exclusive per actor name, so two live sessions sharing a name
    would both believe they hold the same card.
    """
    place = re.search(r"/worktrees/([^/]+)", cwd or "")
    return "%s-%s" % (place.group(1) if place else "main", (session_id or "nosession")[:8])


def held_by(name, session_id):
    """Whether a board name recorded earlier belongs to this session.

    A name carries the tree it was made in, and one session works in two: it takes
    the merge slot inside its worktree and closes the teardown outside it, so the
    trees differ where the session does not. Compared by name, such a session can
    never recognise its own hold.
    """
    return bool(name) and name.rsplit("-", 1)[-1] == (session_id or "nosession")[:8]


def _path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "nosession")
    return os.path.join(STATE_DIR, safe + ".json")


def load(session_id):
    try:
        with open(_path(session_id)) as fh:
            return json.load(fh)
    except Exception:
        return {"edits": [], "created": [], "last_stop": 0.0, "last_beat": 0.0}


def save(session_id, state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = _path(session_id) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, _path(session_id))


# Where the reading of the manager's own message leaves its answer, one file per
# prompt (hooks/habit-reading.py writes it, board-gate.py reads it back).
# A directory of its own: cost.py counts every loose `*.json` here as a session
# record it could not parse.
HABIT_DIR = os.path.join(STATE_DIR, "habit")
# The kill switch, in two reaches: the variable is one session's, the file is every
# session on this machine at once. docs/board.md#5 says which to use. The variable
# answers to its branded spelling in every project too (`switch`).
HABIT_OFF_VAR = "MACHINERY_NO_HABIT_GATE"
HABIT_OFF_FILE = os.path.join(STATE_DIR, "no-habit-gate")
HABIT_KEEP = 6 * 3600  # seconds an answer is kept before the next reading sweeps it


def habit_off():
    return bool(switch("NO_HABIT_GATE")) or os.path.exists(HABIT_OFF_FILE)


def habit_path(prompt_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", prompt_id or "noprompt")
    return os.path.join(HABIT_DIR, safe + ".json")


def habit_write(prompt_id, row):
    """Record what the reading knows so far. Never raises: this hook stands in front
    of every message the manager sends, and a full disk must not swallow one."""
    try:
        os.makedirs(HABIT_DIR, exist_ok=True)
        tmp = habit_path(prompt_id) + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(row, fh)
        os.replace(tmp, habit_path(prompt_id))
    except Exception:
        pass


def habit_read(prompt_id, wait=0.0):
    """The reading's answer, or `{}` for none.

    `wait` seconds are given to one still running. The reading is fired the moment
    the message arrives and a turn is normally far longer than it takes, so this is
    the short tail rather than the usual case. No answer, an unreadable one and one
    that never arrives are the same thing here, and all three let the turn end: a
    gate that cannot be sure must not refuse.
    """
    until = time.time() + max(0.0, wait)
    while True:
        try:
            with open(habit_path(prompt_id)) as fh:
                row = json.load(fh)
        except Exception:
            row = {}
        if not isinstance(row, dict):
            return {}
        if row.get("state") != "reading" or time.time() >= until:
            return row
        time.sleep(0.5)


def habit_sweep():
    """Drop answers older than the span above. Never raises."""
    try:
        for name in os.listdir(HABIT_DIR):
            full = os.path.join(HABIT_DIR, name)
            if time.time() - os.path.getmtime(full) > HABIT_KEEP:
                os.remove(full)
    except Exception:
        pass


def bd(args, cwd=None):
    """Run bd; return (ok, stdout). Never raises — a board hiccup must not take
    the session's tool call down with it."""
    try:
        run = subprocess.run(
            ["bd"] + args, capture_output=True, text=True,
            cwd=cwd or os.environ.get("CLAUDE_PROJECT_DIR") or None,
            timeout=BD_TIMEOUT,
        )
        return run.returncode == 0, run.stdout
    except Exception:
        return False, ""


def machine_name(cwd=None):
    """The name bd falls back to when a command escaped the actor stamp — shared
    by every session on this machine, so a claim under it owns nothing."""
    try:
        run = subprocess.run(["git", "config", "user.name"], capture_output=True,
                             text=True, cwd=cwd, timeout=5)
        return run.stdout.strip() or os.environ.get("USER") or ""
    except Exception:
        return os.environ.get("USER") or ""


def held(actor_name, cwd=None):
    """Cards this session holds in progress."""
    ok, out = bd(["list", "--status", "in_progress", "--assignee", actor_name,
                  "--brief", "--json"], cwd)
    if not ok:
        return None
    try:
        return [row["id"] for row in json.loads(out or "[]")]
    except Exception:
        return []


def _covered(cid, when, claims, closes, held):
    """Whether this card was standing over an edit made at `when`."""
    before = sorted(t for t in claims.get(cid, ()) if t <= when)
    if not before:
        # No claim on record: the card is still held, or its claim aged out of a
        # log that keeps the last 200 — trust it up to the moment it was closed.
        return cid in held or any(t >= when for t in closes.get(cid, ()))
    return not any(before[-1] <= t < when for t in closes.get(cid, ()))


def unowned(state, edits, held, since):
    """The edits no card was standing over at the moment they were made.

    A card is judged where the edit falls, never by what is left held when the
    turn ends: closing the last step of a job empties the held set while the
    turn's work stands, so a clean finish would otherwise look exactly like work
    done under no card at all. A claim made mid-turn covers the whole turn, which
    is the leniency the held-set answer had.
    """
    claims, closes = {}, {}
    for c in state.get("claims") or []:
        t = c.get("t") or 0
        claims.setdefault(c.get("id"), []).append(since if t >= since else t)
    for c in state.get("closed") or []:
        closes.setdefault(c.get("id"), []).append(c.get("t") or 0)
    held = set(held or [])
    cards = set(claims) | set(closes) | held
    return [e for e in edits
            if not any(_covered(c, e.get("t") or 0, claims, closes, held) for c in cards)]


def prefix(root):
    """Card id prefix this project issues.

    Declared, because a gate has to know it before it may run a board command and
    because it is the one fact every refusal is written against. A project that
    has not declared one is asked of its board, and that answer is cached: this
    runs behind every tool call.
    """
    said = project.of(root).prefix
    if said:
        return said
    cache = os.path.join(STATE_DIR, "prefix-" + re.sub(r"\W", "_", root))
    try:
        with open(cache) as fh:
            return fh.read().strip() or "bd"
    except Exception:
        pass
    ok, out = bd(["config", "get", "issue_prefix"], root)
    name = (out or "").strip() if ok else ""
    if name:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(cache, "w") as fh:
            fh.write(name)
    return name or "bd"


def project_edit(path, root):
    """True when a path is project work rather than bookkeeping or scratch."""
    if not path:
        return False
    full = path if os.path.isabs(path) else os.path.join(root, path)
    if not full.startswith(root.rstrip("/")):
        return False
    return not any(part in full for part in IGNORED)


def now():
    return time.time()


def tool(root, name, where="board"):
    """How a session standing in this project types one of the machinery's tools.

    A refusal that names a command the agent cannot run teaches nothing, and the
    tools live outside every project: one carrying a forwarder at the old path is
    told that path, one without is told the tool's own (`project.tool`).
    """
    return project.tool(project.of(root), name, where)


def prefixes(root):
    """Every card id prefix a commit made in this checkout may name.

    This project's own, and that of any project whose declaration says its work
    lands here. Both, because a change split across two repositories is one job:
    the card is the first project's and the commit is in the second.
    """
    return project.prefixes(project.of(root)) or [prefix(root)]


def reports_dir():
    """Where the shared report tools live. `report` on the path is a link into
    them, so the location is read from there rather than written down again; the
    machinery's own settings answer for a machine that has no such link."""
    exe = shutil.which("report")
    if exe:
        return os.path.dirname(os.path.dirname(os.path.realpath(exe)))
    return project.reports_dir()


# Cards on which nothing was finished, so no page is owed and no link with it:
# something merely noticed, a question put to the manager, a ruling he made.
# Read by the close gate and by the turn gate, which must agree or a card is
# refused a page by one and a link by the other.
UNREPORTED = ("find", "question", "decision")


def project_name(root):
    """The name this project's reports are filed under.

    Asked of the report tools rather than worked out here: a worktree is named
    after its branch, and only they know that the answer is the main checkout.
    """
    try:
        out = subprocess.run(
            ["python3", os.path.join(reports_dir(), "tools/project.py")],
            capture_output=True, text=True, cwd=root, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return os.path.basename(root.rstrip("/"))


def page_built(cards, project=None):
    """When a page carrying one of these cards was last written, or 0 for never.
    `cards` of None asks about any page; `project` narrows it to one project's own.

    The clock is the SPEC, because that is the file an agent writes. The board
    screen rebuilds the page every time someone opens it, so reading the built
    page would let a glance from the manager clear the refusal. The built page
    still has to exist and to be no older than the spec: that is what says the
    words were not merely typed but put through the builder.
    """
    when = 0.0
    where = os.path.join(reports_dir(), "pages", project or "*", "*.report.json")
    for spec in glob.glob(where):
        try:
            if cards is not None:
                with open(spec) as fh:
                    if ((json.load(fh) or {}).get("status") or {}).get("card") not in cards:
                        continue
            written = os.path.getmtime(spec)
            if os.path.getmtime(spec[: -len(".report.json")] + ".html") < written:
                continue
            when = max(when, written)
        except Exception:
            continue
    return when


def page_names(cid, card):
    """The cards a page may be about and still be this one's page.

    One page per piece of work, not per step: a step is carried by its job's page
    and a job by the goal above it, so a page names any of them.
    """
    names = {cid}
    goal = next((l[3:] for l in card.get("labels") or [] if l.startswith("of:")), None)
    if goal:
        names.add(goal)
    while "." in cid:
        cid = cid.rsplit(".", 1)[0]
        names.add(cid)
    return names
